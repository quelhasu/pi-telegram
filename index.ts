import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface TelegramConfig {
	botToken?: string;
	botUsername?: string;
	botId?: number;
	allowedUserId?: number;
	lastUpdateId?: number;
}

interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
}

interface TelegramUser {
	id: number;
	is_bot: boolean;
	first_name: string;
	username?: string;
}

interface TelegramChat {
	id: number;
	type: string;
}

interface TelegramPhotoSize {
	file_id: string;
	file_size?: number;
}

interface TelegramDocument {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramVideo {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramAudio {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramVoice {
	file_id: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramAnimation {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramSticker {
	file_id: string;
	emoji?: string;
}

interface TelegramFileInfo {
	file_id: string;
	fileName: string;
	mimeType?: string;
	isImage: boolean;
}

interface TelegramMessage {
	message_id: number;
	chat: TelegramChat;
	from?: TelegramUser;
	text?: string;
	caption?: string;
	media_group_id?: string;
	photo?: TelegramPhotoSize[];
	document?: TelegramDocument;
	video?: TelegramVideo;
	audio?: TelegramAudio;
	voice?: TelegramVoice;
	animation?: TelegramAnimation;
	sticker?: TelegramSticker;
}

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
}

interface TelegramGetFileResult {
	file_path: string;
}

interface TelegramSentMessage {
	message_id: number;
}

interface DownloadedTelegramFile {
	path: string;
	fileName: string;
	isImage: boolean;
	mimeType?: string;
}

interface PendingTelegramTurn {
	chatId: number;
	replyToMessageId: number;
	queuedAttachments: QueuedAttachment[];
	content: Array<TextContent | ImageContent>;
	historyText: string;
}

type ActiveTelegramTurn = PendingTelegramTurn;

interface QueuedAttachment {
	path: string;
	fileName: string;
}

interface TelegramPreviewState {
	mode: "draft" | "message";
	draftId?: number;
	messageId?: number;
	pendingText: string;
	lastSentText: string;
	flushTimer?: ReturnType<typeof setTimeout>;
}

interface TelegramMediaGroupState {
	messages: TelegramMessage[];
	flushTimer?: ReturnType<typeof setTimeout>;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "telegram.json");
const TEMP_DIR = join(homedir(), ".pi", "agent", "tmp", "telegram");
const EMOJI_CACHE_DIR = join(TEMP_DIR, "assets", "emoji");
const TWEMOJI_CDN = "https://cdn.jsdelivr.net/gh/twitter/twemoji@14/assets/72x72";
const TELEGRAM_PREFIX = "[telegram]";
const MAX_MESSAGE_LENGTH = 4096;
const MAX_ATTACHMENTS_PER_TURN = 10;
const PREVIEW_THROTTLE_MS = 750;
const TELEGRAM_DRAFT_ID_MAX = 2_147_483_647;
const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 1200;

const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge extension is active.
- Messages forwarded from Telegram are prefixed with "[telegram]".
- [telegram] messages may include local temp file paths for Telegram attachments. Read those files as needed.
- If a [telegram] user asked for a file or generated artifact, use the telegram_attach tool with the local file path so the extension can send it with your next final reply.
- Do not assume mentioning a local file path in plain text will send it to Telegram. Use telegram_attach.`;

export function formatPrompt(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length === 0) return "💬 You: (empty)";
	const hasBlockquote = trimmed.split("\n").some((line) => line.trimStart().startsWith(">"));
	const prefix = "💬 You:";
	const separator = hasBlockquote ? "\n" : " ";
	const MAX_PROMPT = 400;
	if (trimmed.length > MAX_PROMPT) {
		return `${prefix}${separator}${trimmed.slice(0, MAX_PROMPT)}…`;
	}
	return `${prefix}${separator}${trimmed}`;
}

export function formatToolCall(toolName: string, args: Record<string, unknown>): string {
	const label = formatToolLabel(toolName, args);
	const emoji = TOOL_EMOJI[toolName] ?? "🔧";
	return `${emoji} ${label}`;
}

const TOOL_EMOJI: Record<string, string> = {
	bash: "💻",
	read: "📄",
	edit: "✏️",
	write: "📝",
	grep: "🔍",
	find: "📁",
	ls: "📂",
};

function formatToolLabel(toolName: string, args: Record<string, unknown>): string {
	const path = typeof args.path === "string" ? args.path : undefined;
	switch (toolName) {
		case "bash": {
			const cmd = typeof args.command === "string" ? args.command.split("\n")[0]! : "";
			return cmd.length > 0 ? `bash: \`${cmd}\`` : "bash";
		}
		case "read":
			return path ? `read \`${path}\`` : "read";
		case "edit": {
			const edits = Array.isArray(args.edits) ? args.edits.length : 0;
			const base = path ? `edit \`${path}\`` : "edit";
			return edits > 0 ? `${base} (${edits} edits)` : base;
		}
		case "write":
			return path ? `write \`${path}\`` : "write";
		case "grep": {
			const pattern = typeof args.pattern === "string" ? args.pattern : "";
			return pattern.length > 0 ? `grep \`${pattern}\`` : "grep";
		}
		case "find":
			return path ? `find \`${path}\`` : "find";
		case "ls":
			return path ? `ls \`${path}\`` : "ls";
		default:
			return toolName;
	}
}

export function formatError(error: unknown): string {
	const message =
		error instanceof Error ? error.message :
		typeof error === "string" ? error :
		"unknown";
	return `❌ Error: ${message}`;
}

export function formatAssistantText(text: string): string {
	return `🤖 ${text}`;
}

export function mdToTelegramHtml(text: string): string {
	// Strategy: process code blocks and inline code first (protect from further transformation),
	// then apply markdown → HTML conversions on the remaining text.
	//
	// We use placeholder tokens to protect code spans from markdown transformations.
	const CODE_PLACEHOLDER = "\x00CODE";
	const protectedSpans: string[] = [];

	const protect = (html: string): string => {
		const idx = protectedSpans.length;
		protectedSpans.push(html);
		return `${CODE_PLACEHOLDER}${idx}\x00`;
	};

	const escapeHtml = (s: string): string =>
		s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

	// 1. Extract and protect fenced code blocks
	let result = text.replace(/```([\w.-]*)\n([\s\S]*?)```/g, (_match, lang: string, code: string) => {
		const escaped = escapeHtml(code);
		if (lang) {
			return protect(`<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>`);
		}
		return protect(`<pre><code>${escaped}</code></pre>`);
	});

	// 2. Extract and protect inline code
	result = result.replace(/`([^`]+)`/g, (_match, code: string) => {
		return protect(`<code>${escapeHtml(code)}</code>`);
	});

	// 3. Escape HTML in the remaining text
	result = escapeHtml(result);

	// 4. Convert markdown constructs (order matters: bold+italic before bold/italic)
	// Bold + italic: ***text***
	result = result.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");
	// Bold: **text**
	result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
	// Italic: *text*
	result = result.replace(/\*(.+?)\*/g, "<i>$1</i>");
	// Strikethrough: ~~text~~
	result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");
	// Links: [text](url)
	result = result.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
	// Headings: # through ######
	result = result.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
	// Blockquotes: > text (only at start of line)
	result = result.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>");

	// 5. Restore protected code spans
	result = result.replace(/\x00CODE(\d+)\x00/g, (_match, idx: string) => {
		return protectedSpans[Number(idx)] ?? "";
	});

	return result;
}

export function formatEditDiff(diff: string): string {
	const MAX_DIFF = 3500;
	const trimmed = diff.trim();
	if (trimmed.length === 0) return "```diff\n(empty diff)\n```";
	if (trimmed.length <= MAX_DIFF) return `\`\`\`diff\n${trimmed}\n\`\`\``;
	const truncated = trimmed.slice(0, MAX_DIFF);
	return `\`\`\`diff\n${truncated}\n...\n\`\`\``;
}

function parseMarkdownCells(lines: string[]): string[][] {
	return lines
		.filter((l) => l.trim().startsWith("|"))
		.filter((l) => !/^\|[\s:-]+\|/.test(l)) // skip separator
		.map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
}

type MarkdownRegion =
	| { type: "text"; lines: string[] }
	| { type: "table"; lines: string[] };

function extractMarkdownRegions(text: string): MarkdownRegion[] {
	const lines = text.split("\n");
	const regions: MarkdownRegion[] = [];
	let textBuffer: string[] = [];
	let tableBuffer: string[] = [];
	let inCodeBlock = false;

	const flushText = (): void => {
		if (textBuffer.length > 0) {
			regions.push({ type: "text", lines: textBuffer });
			textBuffer = [];
		}
	};

	const flushTable = (): void => {
		if (tableBuffer.length > 0) {
			regions.push({ type: "table", lines: tableBuffer });
			tableBuffer = [];
		}
	};

	for (const line of lines) {
		if (line.trim().startsWith("```")) {
			if (tableBuffer.length > 0) flushTable();
			inCodeBlock = !inCodeBlock;
			textBuffer.push(line);
			continue;
		}
		if (inCodeBlock) {
			textBuffer.push(line);
			continue;
		}
		const isTableRow = /^\s*\|/.test(line) || /^\s*\+[-+]/.test(line);
		if (isTableRow) {
			flushText();
			tableBuffer.push(line);
			continue;
		}
		if (tableBuffer.length > 0) flushTable();
		textBuffer.push(line);
	}
	flushText();
	flushTable();
	return regions;
}

const emojiImageCache = new Map<string, ReturnType<typeof loadImage> | null>();

async function loadEmojiImage(ch: string): Promise<ReturnType<typeof loadImage> | null> {
	const cp = [...ch].map((c) => c.codePointAt(0)!.toString(16)).join("-");
	const cached = emojiImageCache.get(cp);
	if (cached !== undefined) return cached;

	// Fast skip: ASCII letters/digits/whitespace/punctuation are never emojis
	const code = ch.codePointAt(0)!;
	if (code < 0x80 && /[a-zA-Z0-9\s,.;:!?()\[\]{}"'_\/\\<>=@~`^|&%$\-+]/.test(ch)) {
		emojiImageCache.set(cp, null);
		return null;
	}

	// Try cached dir first, then bundled assets, then CDN
	const paths = [
		join(EMOJI_CACHE_DIR, `${cp}.png`),
		join(process.cwd(), "assets", "emoji", `${cp}.png`),
	];
	for (const path of paths) {
		try {
			const img = await loadImage(path);
			emojiImageCache.set(cp, img);
			return img;
		} catch { /* continue */ }
	}

	// Download from Twemoji CDN
	try {
		const url = `${TWEMOJI_CDN}/${cp}.png`;
		const response = await fetch(url);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const buffer = Buffer.from(await response.arrayBuffer());
		await mkdir(EMOJI_CACHE_DIR, { recursive: true });
		await writeFile(join(EMOJI_CACHE_DIR, `${cp}.png`), buffer);
		const img = await loadImage(join(EMOJI_CACHE_DIR, `${cp}.png`));
		emojiImageCache.set(cp, img);
		return img;
	} catch {
		emojiImageCache.set(cp, null);
		return null;
	}
}

function registerSystemFonts(): void {
	// Use system sans-serif fonts — no bundled fonts needed
	// @napi-rs/canvas will use font-kit to find sans-serif on the system
}

async function renderTableToCanvas(rows: string[][]): Promise<ReturnType<typeof createCanvas>> {
	if (rows.length === 0) return createCanvas(1, 1);

	const FONT_SIZE = 15;
	const PADDING_X = 14;
	const PADDING_Y = 10;
	const HEADER_BG = "#374151";
	const HEADER_FG = "#f9fafb";
	const ROW_EVEN_BG = "#ffffff";
	const ROW_ODD_BG = "#f9fafb";
	const TEXT_COLOR = "#1f2937";
	const BORDER_COLOR = "#d1d5db";

	const numCols = rows[0].length;
	const fontText = `${FONT_SIZE}px "System Sans", sans-serif`;
	const fontBold = `bold ${FONT_SIZE}px "System Sans", sans-serif`;

	// Pre-load all emoji images and build per-cell emoji maps
	const cellEmojis: Array<Array<{ ch: string; img: ReturnType<typeof loadImage> | null }>> = [];
	for (let r = 0; r < rows.length; r++) {
		cellEmojis[r] = [];
		for (let c = 0; c < rows[r].length && c < numCols; c++) {
			cellEmojis[r][c] = [];
			for (const ch of rows[r][c]) {
				const img = await loadEmojiImage(ch);
				cellEmojis[r][c].push({ ch, img });
			}
		}
	}

	// Measure columns
	const probe = createCanvas(1, 1);
	const pctx = probe.getContext("2d");
	const colWidths = Array(numCols).fill(0);

	for (let r = 0; r < rows.length; r++) {
		for (let c = 0; c < rows[r].length && c < numCols; c++) {
			pctx.font = r === 0 ? fontBold : fontText;
			let width = 0;
			for (const { ch, img } of cellEmojis[r][c]) {
				if (img) {
					width += FONT_SIZE;
				} else {
					width += pctx.measureText(ch).width;
				}
			}
			width += PADDING_X * 2;
			if (width > colWidths[c]) colWidths[c] = width;
		}
	}

	const lineHeight = FONT_SIZE + PADDING_Y * 2;
	const totalWidth = colWidths.reduce((a, b) => a + b, 0) + 2;
	const totalHeight = rows.length * lineHeight;

	const canvas = createCanvas(Math.ceil(totalWidth), Math.ceil(totalHeight));
	const ctx = canvas.getContext("2d");
	ctx.textBaseline = "middle";

	let y = 0;
	for (let r = 0; r < rows.length; r++) {
		const isHeader = r === 0;
		let x = 1;

		for (let c = 0; c < rows[r].length && c < numCols; c++) {
			const cell = rows[r][c];
			const cw = colWidths[c];

			// Cell background
			ctx.fillStyle = isHeader ? HEADER_BG : r % 2 === 0 ? ROW_EVEN_BG : ROW_ODD_BG;
			ctx.fillRect(x, y, cw, lineHeight);

			// Draw content: each char is either image (emoji) or text
			let cursorX = x + PADDING_X;
			const textColorApplied = isHeader ? HEADER_FG : TEXT_COLOR;
			let textBuffer = "";

			const flushText = (): void => {
				if (textBuffer.length > 0) {
					ctx.font = isHeader ? fontBold : fontText;
					ctx.fillStyle = textColorApplied;
					ctx.fillText(textBuffer, cursorX, y + lineHeight / 2);
					cursorX += ctx.measureText(textBuffer).width;
					textBuffer = "";
				}
			};

			for (const { ch, img } of cellEmojis[r][c]) {
				if (img) {
					flushText();
					const emojiH = FONT_SIZE + 4;
					ctx.drawImage(img, cursorX, y + (lineHeight - emojiH) / 2, emojiH, emojiH);
					cursorX += FONT_SIZE;
				} else {
					textBuffer += ch;
				}
			}
			flushText();

			// Right border
			ctx.strokeStyle = BORDER_COLOR;
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(x + cw, y);
			ctx.lineTo(x + cw, y + lineHeight);
			ctx.stroke();

			x += cw;
		}

		// Bottom border
		ctx.strokeStyle = BORDER_COLOR;
		ctx.lineWidth = isHeader ? 2 : 1;
		ctx.beginPath();
		ctx.moveTo(0, y + lineHeight);
		ctx.lineTo(totalWidth, y + lineHeight);
		ctx.stroke();

		y += lineHeight;
	}

	return canvas;
}

export async function renderTableToPng(tableLines: string[], outputPath: string): Promise<void> {
	const rows = parseMarkdownCells(tableLines);
	registerSystemFonts();
	await mkdir(dirname(outputPath), { recursive: true });
	const canvas = await renderTableToCanvas(rows);
	await writeFile(outputPath, canvas.toBuffer("image/png"));
}

export async function extractTableSegments(text: string): Promise<Array<{ type: "text"; text: string } | { type: "table"; lines: string[] }>> {
	const regions = extractMarkdownRegions(text);
	const segments: Array<{ type: "text"; text: string } | { type: "table"; lines: string[] }> = [];
	for (const region of regions) {
		if (region.type === "table") {
			segments.push({ type: "table", lines: region.lines });
		} else {
			const trimmed = region.lines.join("\n").trim();
			if (trimmed.length > 0) segments.push({ type: "text", text: trimmed });
		}
	}
	return segments;
}

function isTelegramPrompt(prompt: string): boolean {
	return prompt.trimStart().startsWith(TELEGRAM_PREFIX);
}

function sanitizeFileName(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function guessExtensionFromMime(mimeType: string | undefined, fallback: string): string {
	if (!mimeType) return fallback;
	const normalized = mimeType.toLowerCase();
	if (normalized === "image/jpeg") return ".jpg";
	if (normalized === "image/png") return ".png";
	if (normalized === "image/webp") return ".webp";
	if (normalized === "image/gif") return ".gif";
	if (normalized === "audio/ogg") return ".ogg";
	if (normalized === "audio/mpeg") return ".mp3";
	if (normalized === "audio/wav") return ".wav";
	if (normalized === "video/mp4") return ".mp4";
	if (normalized === "application/pdf") return ".pdf";
	return fallback;
}

function guessMediaType(path: string): string | undefined {
	const ext = extname(path).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".png") return "image/png";
	if (ext === ".webp") return "image/webp";
	if (ext === ".gif") return "image/gif";
	return undefined;
}

function isImageMimeType(mimeType: string | undefined): boolean {
	return mimeType?.toLowerCase().startsWith("image/") ?? false;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function chunkParagraphs(text: string): string[] {
	if (text.length <= MAX_MESSAGE_LENGTH) return [text];

	const normalized = text.replace(/\r\n/g, "\n");
	const paragraphs = normalized.split(/\n\n+/);
	const chunks: string[] = [];
	let current = "";

	const flushCurrent = (): void => {
		if (current.trim().length > 0) chunks.push(current);
		current = "";
	};

	const splitLongBlock = (block: string): string[] => {
		if (block.length <= MAX_MESSAGE_LENGTH) return [block];
		const lines = block.split("\n");
		const lineChunks: string[] = [];
		let lineCurrent = "";
		for (const line of lines) {
			const candidate = lineCurrent.length === 0 ? line : `${lineCurrent}\n${line}`;
			if (candidate.length <= MAX_MESSAGE_LENGTH) {
				lineCurrent = candidate;
				continue;
			}
			if (lineCurrent.length > 0) {
				lineChunks.push(lineCurrent);
				lineCurrent = "";
			}
			if (line.length <= MAX_MESSAGE_LENGTH) {
				lineCurrent = line;
				continue;
			}
			for (let i = 0; i < line.length; i += MAX_MESSAGE_LENGTH) {
				lineChunks.push(line.slice(i, i + MAX_MESSAGE_LENGTH));
			}
		}
		if (lineCurrent.length > 0) lineChunks.push(lineCurrent);
		return lineChunks;
	};

	for (const paragraph of paragraphs) {
		if (paragraph.length === 0) continue;
		const parts = splitLongBlock(paragraph);
		for (const part of parts) {
			const candidate = current.length === 0 ? part : `${current}\n\n${part}`;
			if (candidate.length <= MAX_MESSAGE_LENGTH) {
				current = candidate;
			} else {
				flushCurrent();
				current = part;
			}
		}
	}
	flushCurrent();
	return chunks;
}

async function readConfig(): Promise<TelegramConfig> {
	try {
		const content = await readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(content) as TelegramConfig;
		return parsed;
	} catch {
		return {};
	}
}

async function writeConfig(config: TelegramConfig): Promise<void> {
	await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
	await writeFile(CONFIG_PATH, JSON.stringify(config, null, "\t") + "\n", "utf8");
}

export default function (pi: ExtensionAPI) {
	let config: TelegramConfig = {};
	let pollingController: AbortController | undefined;
	let pollingPromise: Promise<void> | undefined;
	let queuedTelegramTurns: PendingTelegramTurn[] = [];
	let activeTelegramTurn: ActiveTelegramTurn | undefined;
	let typingInterval: ReturnType<typeof setInterval> | undefined;
	let currentAbort: (() => void) | undefined;
	let preserveQueuedTurnsAsHistory = false;
	let isMirrorTurn = false;
	let setupInProgress = false;
	const mirrorToolMessages = new Map<string, number>();
	let draftSupport: "unknown" | "supported" | "unsupported" = "unknown";
	let nextDraftId = 0;
	const mediaGroups = new Map<string, TelegramMediaGroupState>();

	function allocateDraftId(): number {
		nextDraftId = nextDraftId >= TELEGRAM_DRAFT_ID_MAX ? 1 : nextDraftId + 1;
		return nextDraftId;
	}

	function updateStatus(ctx: ExtensionContext, error?: string): void {
		const theme = ctx.ui.theme;
		const label = theme.fg("accent", "telegram");
		if (error) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("error", "error")} ${theme.fg("muted", error)}`);
			return;
		}
		if (!config.botToken) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "not configured")}`);
			return;
		}
		if (!pollingPromise) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "disconnected")}`);
			return;
		}
		if (!config.allowedUserId) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("warning", "awaiting pairing")}`);
			return;
		}
		if (activeTelegramTurn || queuedTelegramTurns.length > 0) {
			const queued = queuedTelegramTurns.length > 0 ? theme.fg("muted", ` +${queuedTelegramTurns.length} queued`) : "";
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("accent", "processing")}${queued}`);
			return;
		}
		ctx.ui.setStatus("telegram", `${label} ${theme.fg("success", "connected")}`);
	}

	async function callTelegram<TResponse>(
		method: string,
		body: Record<string, unknown>,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: options?.signal,
		});
			const data = (await response.json()) as TelegramApiResponse<TResponse>;
		if (!data.ok || data.result === undefined) {
			throw new Error(data.description || `Telegram API ${method} failed`);
		}
		return data.result;
	}

	async function callTelegramMultipart<TResponse>(
		method: string,
		fields: Record<string, string>,
		fileField: string,
		filePath: string,
		fileName: string,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const form = new FormData();
		for (const [key, value] of Object.entries(fields)) {
			form.set(key, value);
		}
		const buffer = await readFile(filePath);
		form.set(fileField, new Blob([buffer]), fileName);
		const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
			method: "POST",
			body: form,
			signal: options?.signal,
		});
		const data = (await response.json()) as TelegramApiResponse<TResponse>;
		if (!data.ok || data.result === undefined) {
			throw new Error(data.description || `Telegram API ${method} failed`);
		}
		return data.result;
	}

	async function downloadTelegramFile(fileId: string, suggestedName: string): Promise<string> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const file = await callTelegram<TelegramGetFileResult>("getFile", { file_id: fileId });
		await mkdir(TEMP_DIR, { recursive: true });
		const targetPath = join(TEMP_DIR, `${Date.now()}-${sanitizeFileName(suggestedName)}`);
		const response = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
		if (!response.ok) throw new Error(`Failed to download Telegram file: ${response.status}`);
		const arrayBuffer = await response.arrayBuffer();
		await writeFile(targetPath, Buffer.from(arrayBuffer));
		return targetPath;
	}

	function startTypingLoop(ctx: ExtensionContext, chatId?: number): void {
		const targetChatId = chatId ?? activeTelegramTurn?.chatId;
		if (typingInterval || targetChatId === undefined) return;

		const sendTyping = async (): Promise<void> => {
			try {
				await callTelegram("sendChatAction", { chat_id: targetChatId, action: "typing" });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				updateStatus(ctx, `typing failed: ${message}`);
			}
		};

		void sendTyping();
		typingInterval = setInterval(() => {
			void sendTyping();
		}, 4000);
	}

	function stopTypingLoop(): void {
		if (!typingInterval) return;
		clearInterval(typingInterval);
		typingInterval = undefined;
	}

	function isAssistantMessage(message: AgentMessage): boolean {
		return (message as unknown as { role?: string }).role === "assistant";
	}

	function getMessageText(message: AgentMessage): string {
		const value = message as unknown as Record<string, unknown>;
		const content = Array.isArray(value.content) ? value.content : [];
		return content
			.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string)
			.join("")
			.trim();
	}



	async function sendWithMarkdown<TResponse>(
		method: string,
		body: Record<string, unknown>,
	): Promise<TResponse> {
		const processedBody = { ...body };
		if (typeof processedBody.text === "string") {
			processedBody.text = mdToTelegramHtml(formatTablesForTelegram(processedBody.text));
		}
		try {
			return await callTelegram<TResponse>(method, { ...processedBody, parse_mode: "HTML" });
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("can't parse entities") || msg.includes("parse")) {
				console.error("[telegram] HTML parse failed, falling back to plain text:", msg);
				const { parse_mode: _, ...plainBody } = processedBody;
				return await callTelegram<TResponse>(method, plainBody);
			}
			throw error;
		}
	}

	function formatTablesForTelegram(text: string): string {
		return extractMarkdownRegions(text)
			.flatMap((region) => {
				if (region.type === "table") {
					return ["```", ...region.lines, "```"];
				}
				return region.lines;
			})
			.join("\n");
	}

	async function sendFinalMessage(chatId: number, text: string, replyToMessageId?: number): Promise<number | undefined> {
		const segments = await extractTableSegments(text);
		let lastMessageId: number | undefined;
		let replyTo = replyToMessageId;
		for (const segment of segments) {
			const replyParam = replyTo !== undefined ? { reply_to_message_id: replyTo } : {};
			if (segment.type === "table") {
				const tmpPath = join(TEMP_DIR, `table-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
				await mkdir(TEMP_DIR, { recursive: true });
				await renderTableToPng(segment.lines, tmpPath);
				try {
					const sent = await callTelegramMultipart<TelegramSentMessage>(
						"sendPhoto",
						{ chat_id: String(chatId), ...replyParam },
						"photo",
						tmpPath,
						"table.png",
					);
					lastMessageId = sent.message_id;
				} finally {
					try {
						await unlink(tmpPath);
					} catch {
						/* ignore cleanup errors */
					}
				}
			} else {
				const chunks = chunkParagraphs(segment.text);
				for (const chunk of chunks) {
					const sent = await sendWithMarkdown<TelegramSentMessage>("sendMessage", {
						chat_id: chatId,
						text: chunk,
						...replyParam,
					});
					lastMessageId = sent.message_id;
				}
			}
			if (replyTo !== undefined) replyTo = undefined;
		}
		return lastMessageId;
	}

	async function sendFormattedText(chatId: number, text: string): Promise<number | undefined> {
		return sendFinalMessage(chatId, text);
	}

	async function sendQueuedAttachments(turn: ActiveTelegramTurn): Promise<void> {
		for (const attachment of turn.queuedAttachments) {
			try {
				const mediaType = guessMediaType(attachment.path);
				const method = mediaType ? "sendPhoto" : "sendDocument";
				const fieldName = mediaType ? "photo" : "document";
				await callTelegramMultipart<TelegramSentMessage>(
					method,
					{
						chat_id: String(turn.chatId),
					},
					fieldName,
					attachment.path,
					attachment.fileName,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await sendFormattedText(turn.chatId, `Failed to send attachment ${attachment.fileName}: ${message}`);
			}
		}
	}

	function extractAssistantText(messages: AgentMessage[]): { text?: string; stopReason?: string; errorMessage?: string } {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i] as unknown as Record<string, unknown>;
			if (message.role !== "assistant") continue;
			const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
			const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
			const content = Array.isArray(message.content) ? message.content : [];
			const text = content
				.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
				.filter((block) => block.type === "text" && typeof block.text === "string")
				.map((block) => block.text as string)
				.join("")
				.trim();
			return { text: text || undefined, stopReason, errorMessage };
		}
		return {};
	}

	// --- Preview manager ---
	// Encapsulates the draft/message streaming preview lifecycle.
	// Instantiated once for active telegram turns and once for mirror turns.
	function createPreviewManager() {
		let state: TelegramPreviewState | undefined;

		function isActive(): boolean {
			return state !== undefined;
		}

		function hasContent(): boolean {
			return state !== undefined && (state.pendingText.trim().length > 0 || state.lastSentText.trim().length > 0);
		}

		function getPendingText(): string {
			return state?.pendingText ?? "";
		}

		function setPendingText(text: string): void {
			if (state) state.pendingText = text;
		}

		function reset(): void {
			if (state?.flushTimer) clearTimeout(state.flushTimer);
			state = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
		}

		function discard(): void {
			if (state?.flushTimer) clearTimeout(state.flushTimer);
			state = undefined;
		}

		async function clear(chatId: number): Promise<void> {
			const s = state;
			if (!s) return;
			if (s.flushTimer) clearTimeout(s.flushTimer);
			state = undefined;
			if (s.mode === "draft" && s.draftId !== undefined) {
				try {
					await callTelegram("sendMessageDraft", { chat_id: chatId, draft_id: s.draftId, text: "" });
				} catch {
					// ignore
				}
			}
		}

		async function flush(chatId: number): Promise<void> {
			const s = state;
			if (!s) return;
			s.flushTimer = undefined;
			const text = s.pendingText.trim();
			if (!text || text === s.lastSentText) return;
			const truncated = text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH) : text;

			if (draftSupport !== "unsupported") {
				const draftId = s.draftId ?? allocateDraftId();
				s.draftId = draftId;
				try {
					await sendWithMarkdown("sendMessageDraft", { chat_id: chatId, draft_id: draftId, text: truncated });
					draftSupport = "supported";
					s.mode = "draft";
					s.lastSentText = truncated;
					return;
				} catch {
					draftSupport = "unsupported";
				}
			}

			if (s.messageId === undefined) {
				const sent = await sendWithMarkdown<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: truncated });
				s.messageId = sent.message_id;
				s.mode = "message";
				s.lastSentText = truncated;
				return;
			}
			await sendWithMarkdown("editMessageText", { chat_id: chatId, message_id: s.messageId, text: truncated });
			s.mode = "message";
			s.lastSentText = truncated;
		}

		function scheduleFlush(chatId: number): void {
			if (!state || state.flushTimer) return;
			state.flushTimer = setTimeout(() => {
				void flush(chatId);
			}, PREVIEW_THROTTLE_MS);
		}

		function updateText(text: string, chatId: number): void {
			if (!state) {
				state = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
			}
			state.pendingText = text;
			scheduleFlush(chatId);
		}

		async function finalize(chatId: number): Promise<boolean> {
			const s = state;
			if (!s) return false;
			await flush(chatId);
			const finalText = (s.pendingText.trim() || s.lastSentText).trim();
			if (!finalText) {
				await clear(chatId);
				return false;
			}
			if (s.mode === "draft") {
				await sendFinalMessage(chatId, finalText);
				await clear(chatId);
				return true;
			}
			state = undefined;
			return s.messageId !== undefined;
		}

		return { isActive, hasContent, getPendingText, setPendingText, reset, discard, clear, flush, scheduleFlush, updateText, finalize };
	}

	const activePreview = createPreviewManager();
	const mirrorPreview = createPreviewManager();

	function collectTelegramFileInfos(messages: TelegramMessage[]): TelegramFileInfo[] {
		const files: TelegramFileInfo[] = [];
		for (const message of messages) {
			if (Array.isArray(message.photo) && message.photo.length > 0) {
				const photo = [...message.photo].sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0)).pop();
				if (photo) {
					files.push({
						file_id: photo.file_id,
						fileName: `photo-${message.message_id}.jpg`,
						mimeType: "image/jpeg",
						isImage: true,
					});
				}
			}
			if (message.document) {
				const fileName = message.document.file_name || `document-${message.message_id}${guessExtensionFromMime(message.document.mime_type, "")}`;
				files.push({
					file_id: message.document.file_id,
					fileName,
					mimeType: message.document.mime_type,
					isImage: isImageMimeType(message.document.mime_type),
				});
			}
			if (message.video) {
				const fileName = message.video.file_name || `video-${message.message_id}${guessExtensionFromMime(message.video.mime_type, ".mp4")}`;
				files.push({
					file_id: message.video.file_id,
					fileName,
					mimeType: message.video.mime_type,
					isImage: false,
				});
			}
			if (message.audio) {
				const fileName = message.audio.file_name || `audio-${message.message_id}${guessExtensionFromMime(message.audio.mime_type, ".mp3")}`;
				files.push({
					file_id: message.audio.file_id,
					fileName,
					mimeType: message.audio.mime_type,
					isImage: false,
				});
			}
			if (message.voice) {
				files.push({
					file_id: message.voice.file_id,
					fileName: `voice-${message.message_id}${guessExtensionFromMime(message.voice.mime_type, ".ogg")}`,
					mimeType: message.voice.mime_type,
					isImage: false,
				});
			}
			if (message.animation) {
				const fileName = message.animation.file_name || `animation-${message.message_id}${guessExtensionFromMime(message.animation.mime_type, ".mp4")}`;
				files.push({
					file_id: message.animation.file_id,
					fileName,
					mimeType: message.animation.mime_type,
					isImage: false,
				});
			}
			if (message.sticker) {
				files.push({
					file_id: message.sticker.file_id,
					fileName: `sticker-${message.message_id}.webp`,
					mimeType: "image/webp",
					isImage: true,
				});
			}
		}
		return files;
	}

	async function buildTelegramFiles(messages: TelegramMessage[]): Promise<DownloadedTelegramFile[]> {
		const downloaded: DownloadedTelegramFile[] = [];
		for (const file of collectTelegramFileInfos(messages)) {
			const path = await downloadTelegramFile(file.file_id, file.fileName);
			downloaded.push({ path, fileName: file.fileName, isImage: file.isImage, mimeType: file.mimeType });
		}
		return downloaded;
	}

	async function promptForConfig(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || setupInProgress) return;
		setupInProgress = true;
		try {
			const token = await ctx.ui.input("Telegram bot token", "123456:ABCDEF...");
			if (!token) return;

			const nextConfig: TelegramConfig = { ...config, botToken: token.trim() };
			const response = await fetch(`https://api.telegram.org/bot${nextConfig.botToken}/getMe`);
			const data = (await response.json()) as TelegramApiResponse<TelegramUser>;
			if (!data.ok || !data.result) {
				ctx.ui.notify(data.description || "Invalid Telegram bot token", "error");
				return;
			}

			nextConfig.botId = data.result.id;
			nextConfig.botUsername = data.result.username;
			config = nextConfig;
			await writeConfig(config);
			ctx.ui.notify(`Telegram bot connected: @${config.botUsername ?? "unknown"}`, "info");
			ctx.ui.notify("Send /start to your bot in Telegram to pair this extension with your account.", "info");
			await startPolling(ctx);
			updateStatus(ctx);
		} finally {
			setupInProgress = false;
		}
	}

	async function stopPolling(): Promise<void> {
		stopTypingLoop();
		pollingController?.abort();
		pollingController = undefined;
		await pollingPromise?.catch(() => undefined);
		pollingPromise = undefined;
	}

	function formatTelegramHistoryText(rawText: string, files: DownloadedTelegramFile[]): string {
		let summary = rawText.length > 0 ? rawText : "(no text)";
		if (files.length > 0) {
			summary += `\nAttachments:`;
			for (const file of files) {
				summary += `\n- ${file.path}`;
			}
		}
		return summary;
	}

	async function createTelegramTurn(
		messages: TelegramMessage[],
		historyTurns: PendingTelegramTurn[] = [],
	): Promise<PendingTelegramTurn> {
		const firstMessage = messages[0];
		if (!firstMessage) throw new Error("Missing Telegram message for turn creation");
		const rawText = messages.map((message) => (message.text || message.caption || "").trim()).filter(Boolean).join("\n\n");
		const files = await buildTelegramFiles(messages);
		const content: Array<TextContent | ImageContent> = [];
		let prompt = `${TELEGRAM_PREFIX}`;

		if (historyTurns.length > 0) {
			prompt += `\n\nEarlier Telegram messages arrived after an aborted turn. Treat them as prior user messages, in order:`;
			for (const [index, turn] of historyTurns.entries()) {
				prompt += `\n\n${index + 1}. ${turn.historyText}`;
			}
			prompt += `\n\nCurrent Telegram message:`;
		}

		if (rawText.length > 0) {
			prompt += historyTurns.length > 0 ? `\n${rawText}` : ` ${rawText}`;
		}
		if (files.length > 0) {
			prompt += `\n\nTelegram attachments were saved locally:`;
			for (const file of files) {
				prompt += `\n- ${file.path}`;
			}
		}
		content.push({ type: "text", text: prompt });

		for (const file of files) {
			if (!file.isImage) continue;
			const mediaType = file.mimeType || guessMediaType(file.path);
			if (!mediaType) continue;
			const buffer = await readFile(file.path);
			content.push({
				type: "image",
				data: buffer.toString("base64"),
				mimeType: mediaType,
			});
		}

		return {
			chatId: firstMessage.chat.id,
			replyToMessageId: firstMessage.message_id,
			queuedAttachments: [],
			content,
			historyText: formatTelegramHistoryText(rawText, files),
		};
	}

	async function dispatchAuthorizedTelegramMessages(messages: TelegramMessage[], ctx: ExtensionContext): Promise<void> {
		const firstMessage = messages[0];
		if (!firstMessage) return;
		const rawText = messages.map((message) => (message.text || message.caption || "").trim()).find((text) => text.length > 0) || "";
		const lower = rawText.toLowerCase();

		if (lower === "stop" || lower === "/stop") {
			if (currentAbort) {
				if (queuedTelegramTurns.length > 0) {
					preserveQueuedTurnsAsHistory = true;
				}
				currentAbort();
				updateStatus(ctx);
				await sendFormattedText(firstMessage.chat.id, "Aborted current turn.");
			} else {
				await sendFormattedText(firstMessage.chat.id, "No active turn.");
			}
			return;
		}

		if (lower === "/compact") {
			if (!ctx.isIdle()) {
				await sendFormattedText(firstMessage.chat.id, "Cannot compact while pi is busy. Send \"stop\" first.");
				return;
			}
			ctx.compact({
				onComplete: () => {
					void sendFormattedText(firstMessage.chat.id, "Compaction completed.");
				},
				onError: (error) => {
					const message = error instanceof Error ? error.message : String(error);
					void sendFormattedText(firstMessage.chat.id, `Compaction failed: ${message}`);
				},
			});
			await sendFormattedText(firstMessage.chat.id, "Compaction started.");
			return;
		}

		if (lower === "/status") {
			let totalInput = 0;
			let totalOutput = 0;
			let totalCacheRead = 0;
			let totalCacheWrite = 0;
			let totalCost = 0;

			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;
			}

			const usage = ctx.getContextUsage();
			const lines: string[] = [];
			if (ctx.model) {
				lines.push(`Model: ${ctx.model.provider}/${ctx.model.id}`);
			}
			const tokenParts: string[] = [];
			if (totalInput) tokenParts.push(`↑${formatTokens(totalInput)}`);
			if (totalOutput) tokenParts.push(`↓${formatTokens(totalOutput)}`);
			if (totalCacheRead) tokenParts.push(`R${formatTokens(totalCacheRead)}`);
			if (totalCacheWrite) tokenParts.push(`W${formatTokens(totalCacheWrite)}`);
			if (tokenParts.length > 0) {
				lines.push(`Usage: ${tokenParts.join(" ")}`);
			}
			const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
			if (totalCost || usingSubscription) {
				lines.push(`Cost: $${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
			}
			if (usage) {
				const contextWindow = usage.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const percent = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
				lines.push(`Context: ${percent}/${formatTokens(contextWindow)}`);
			} else {
				lines.push("Context: unknown");
			}
			const mirrorState = !config.allowedUserId
				? "off (not paired)"
				: isMirrorTurn
				? "active"
				: "idle";
			lines.push(`Mirror: ${mirrorState}`);
			if (lines.length === 0) {
				lines.push("No usage data yet.");
			}
			await sendFormattedText(firstMessage.chat.id, lines.join("\n"));
			return;
		}

		if (lower === "/help" || lower === "/start") {
			await sendFormattedText(
				firstMessage.chat.id,
				`Send me a message and I will forward it to pi. Commands: /status, /compact, stop.`,
			);
			if (config.allowedUserId === undefined && firstMessage.from) {
				config.allowedUserId = firstMessage.from.id;
				await writeConfig(config);
				updateStatus(ctx);
			}
			return;
		}

		const historyTurns = preserveQueuedTurnsAsHistory ? queuedTelegramTurns.splice(0) : [];
		preserveQueuedTurnsAsHistory = false;
		const turn = await createTelegramTurn(messages, historyTurns);
		queuedTelegramTurns.push(turn);
		if (ctx.isIdle()) {
			startTypingLoop(ctx, turn.chatId);
			updateStatus(ctx);
			pi.sendUserMessage(turn.content);
		}
	}

	async function handleAuthorizedTelegramMessage(message: TelegramMessage, ctx: ExtensionContext): Promise<void> {
		if (message.media_group_id) {
			const key = `${message.chat.id}:${message.media_group_id}`;
			const existing = mediaGroups.get(key) ?? { messages: [] };
			existing.messages.push(message);
			if (existing.flushTimer) clearTimeout(existing.flushTimer);
			existing.flushTimer = setTimeout(() => {
				const state = mediaGroups.get(key);
				mediaGroups.delete(key);
				if (!state) return;
				void dispatchAuthorizedTelegramMessages(state.messages, ctx);
			}, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS);
			mediaGroups.set(key, existing);
			return;
		}

		await dispatchAuthorizedTelegramMessages([message], ctx);
	}

	async function handleUpdate(update: TelegramUpdate, ctx: ExtensionContext): Promise<void> {
		const message = update.message || update.edited_message;
		if (!message || message.chat.type !== "private" || !message.from || message.from.is_bot) return;

		if (config.allowedUserId === undefined) {
			config.allowedUserId = message.from.id;
			await writeConfig(config);
			updateStatus(ctx);
			await sendFormattedText(message.chat.id, "Telegram bridge paired with this account.");
		}

		if (message.from.id !== config.allowedUserId) {
			await sendFormattedText(message.chat.id, "This bot is not authorized for your account.");
			return;
		}

		await handleAuthorizedTelegramMessage(message, ctx);
	}

	async function pollLoop(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
		if (!config.botToken) return;

		try {
			await callTelegram("deleteWebhook", { drop_pending_updates: false }, { signal });
		} catch {
			// ignore
		}

		if (config.lastUpdateId === undefined) {
			try {
				const updates = await callTelegram<TelegramUpdate[]>("getUpdates", { offset: -1, limit: 1, timeout: 0 }, { signal });
				const last = updates.at(-1);
				if (last) {
					config.lastUpdateId = last.update_id;
					await writeConfig(config);
				}
			} catch {
				// ignore
			}
		}

		while (!signal.aborted) {
			try {
				const updates = await callTelegram<TelegramUpdate[]>(
					"getUpdates",
					{
						offset: config.lastUpdateId !== undefined ? config.lastUpdateId + 1 : undefined,
						limit: 10,
						timeout: 30,
						allowed_updates: ["message", "edited_message"],
					},
					{ signal },
				);
				for (const update of updates) {
					config.lastUpdateId = update.update_id;
					await writeConfig(config);
					await handleUpdate(update, ctx);
				}
			} catch (error) {
				if (signal.aborted) return;
				if (error instanceof DOMException && error.name === "AbortError") return;
				const message = error instanceof Error ? error.message : String(error);
				updateStatus(ctx, message);
				await new Promise((resolve) => setTimeout(resolve, 3000));
				updateStatus(ctx);
			}
		}
	}

	async function startPolling(ctx: ExtensionContext): Promise<void> {
		if (!config.botToken || pollingPromise) return;
		pollingController = new AbortController();
		pollingPromise = pollLoop(ctx, pollingController.signal).finally(() => {
			pollingPromise = undefined;
			pollingController = undefined;
			updateStatus(ctx);
		});
		updateStatus(ctx);
	}

	pi.registerTool({
		name: "telegram_attach",
		label: "Telegram Attach",
		description: "Queue one or more local files to be sent with the next Telegram reply.",
		promptSnippet: "Queue local files to be sent with the next Telegram reply.",
		promptGuidelines: [
			"When handling a [telegram] message and the user asked for a file or generated artifact, call telegram_attach with the local path instead of only mentioning the path in text.",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String({ description: "Local file path to attach" }), { minItems: 1, maxItems: MAX_ATTACHMENTS_PER_TURN }),
		}),
		async execute(_toolCallId, params) {
			if (!activeTelegramTurn) {
				throw new Error("telegram_attach can only be used while replying to an active Telegram turn");
			}
			const added: string[] = [];
			for (const inputPath of params.paths) {
				const stats = await stat(inputPath);
				if (!stats.isFile()) {
					throw new Error(`Not a file: ${inputPath}`);
				}
				if (activeTelegramTurn.queuedAttachments.length >= MAX_ATTACHMENTS_PER_TURN) {
					throw new Error(`Attachment limit reached (${MAX_ATTACHMENTS_PER_TURN})`);
				}
				activeTelegramTurn.queuedAttachments.push({ path: inputPath, fileName: basename(inputPath) });
				added.push(inputPath);
			}
			return {
				content: [{ type: "text", text: `Queued ${added.length} Telegram attachment(s).` }],
				details: { paths: added },
			};
		},
	});

	pi.registerCommand("telegram-setup", {
		description: "Configure Telegram bot token",
		handler: async (_args, ctx) => {
			await promptForConfig(ctx);
		},
	});

	pi.registerCommand("telegram-status", {
		description: "Show Telegram bridge status",
		handler: async (_args, ctx) => {
			const mirrorState = !config.allowedUserId
				? "off (not paired)"
				: isMirrorTurn
				? "active"
				: "idle";
			const status = [
				`bot: ${config.botUsername ? `@${config.botUsername}` : "not configured"}`,
				`allowed user: ${config.allowedUserId ?? "not paired"}`,
				`polling: ${pollingPromise ? "running" : "stopped"}`,
				`mirror: ${mirrorState}`,
				`active telegram turn: ${activeTelegramTurn ? "yes" : "no"}`,
				`queued telegram turns: ${queuedTelegramTurns.length}`,
			];
			ctx.ui.notify(status.join(" | "), "info");
		},
	});

	pi.registerCommand("telegram-connect", {
		description: "Start the Telegram bridge in this pi session",
		handler: async (_args, ctx) => {
			config = await readConfig();
			if (!config.botToken) {
				await promptForConfig(ctx);
				return;
			}
			await startPolling(ctx);
			// If the agent is already running (not a Telegram-initiated turn),
			// activate mirror immediately so the user can follow from this point on.
			if (!ctx.isIdle() && !activeTelegramTurn && config.allowedUserId !== undefined) {
				isMirrorTurn = true;
				startTypingLoop(ctx, config.allowedUserId);
			}
			updateStatus(ctx);
		},
	});

	pi.registerCommand("telegram-disconnect", {
		description: "Stop the Telegram bridge in this pi session",
		handler: async (_args, ctx) => {
			await stopPolling();
			updateStatus(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		config = await readConfig();
		await mkdir(TEMP_DIR, { recursive: true });
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		queuedTelegramTurns = [];
		isMirrorTurn = false;
		for (const state of mediaGroups.values()) {
			if (state.flushTimer) clearTimeout(state.flushTimer);
		}
		mediaGroups.clear();
		mirrorToolMessages.clear();
		if (mirrorPreview.isActive() && config.allowedUserId !== undefined) {
			await mirrorPreview.clear(config.allowedUserId);
		}
		mirrorPreview.discard();
		if (activeTelegramTurn) {
			await activePreview.clear(activeTelegramTurn.chatId);
		}
		activePreview.discard();
		activeTelegramTurn = undefined;
		currentAbort = undefined;
		preserveQueuedTurnsAsHistory = false;
		await stopPolling();
	});

	pi.on("input", async (event, ctx) => {
		if (!pollingPromise) return;
		const mirrorChatId = config.allowedUserId;
		if (mirrorChatId === undefined) return;
		if (event.source === "extension") {
			isMirrorTurn = false;
			return;
		}
		isMirrorTurn = true;
		startTypingLoop(ctx, mirrorChatId);
		const text = formatPrompt(event.text);
		try {
			await sendFinalMessage(mirrorChatId, text);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error("[telegram mirror] input send failed:", message);
		}
	});

	pi.on("tool_call", async (event) => {
		if (!isMirrorTurn) return;
		if (activeTelegramTurn) return;
		const mirrorChatId = config.allowedUserId;
		if (mirrorChatId === undefined) return;
		const text = formatToolCall(event.toolName, event.input as Record<string, unknown>);
		try {
			const sent = await sendFinalMessage(mirrorChatId, text);
			if (sent !== undefined) {
				mirrorToolMessages.set(event.toolCallId, sent);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error("[telegram mirror] tool_call send failed:", message);
		}
	});

	pi.on("tool_result", async (event) => {
		if (!isMirrorTurn) return;
		if (activeTelegramTurn) return;
		const mirrorChatId = config.allowedUserId;
		if (mirrorChatId === undefined) return;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const details = (event as any).details;
		if (!details || typeof details.diff !== "string") return;
		const diffText = formatEditDiff(details.diff);
		const replyTo = mirrorToolMessages.get(event.toolCallId);
		try {
			await sendFinalMessage(mirrorChatId, diffText, replyTo);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error("[telegram mirror] edit diff send failed:", message);
		}
		mirrorToolMessages.delete(event.toolCallId);
	});

	pi.on("before_agent_start", async (event) => {
		const suffix = isTelegramPrompt(event.prompt)
			? `${SYSTEM_PROMPT_SUFFIX}\n- The current user message came from Telegram.`
			: SYSTEM_PROMPT_SUFFIX;
		return {
			systemPrompt: event.systemPrompt + suffix,
		};
	});

	pi.on("agent_start", async (_event, ctx) => {
		currentAbort = () => ctx.abort();
		if (!activeTelegramTurn && queuedTelegramTurns.length > 0) {
			const nextTurn = queuedTelegramTurns.shift();
			if (nextTurn) {
				activeTelegramTurn = { ...nextTurn };
				activePreview.reset();
				startTypingLoop(ctx);
			}
		}
		updateStatus(ctx);
	});

	pi.on("message_start", async (event, _ctx) => {
		if (activeTelegramTurn && isAssistantMessage(event.message)) {
			if (activePreview.hasContent()) {
				await activePreview.finalize(activeTelegramTurn.chatId);
			}
			activePreview.reset();
			return;
		}
		if (!activeTelegramTurn && isMirrorTurn && isAssistantMessage(event.message)) {
			const mirrorChatId = config.allowedUserId;
			if (mirrorChatId === undefined) return;
			if (mirrorPreview.hasContent()) {
				await mirrorPreview.finalize(mirrorChatId);
			}
			mirrorPreview.reset();
		}
	});

	pi.on("message_update", async (event, _ctx) => {
		if (activeTelegramTurn && isAssistantMessage(event.message)) {
			activePreview.updateText(getMessageText(event.message), activeTelegramTurn.chatId);
			return;
		}
		if (!activeTelegramTurn && isMirrorTurn && isAssistantMessage(event.message)) {
			const mirrorChatId = config.allowedUserId;
			if (mirrorChatId === undefined) return;
			mirrorPreview.updateText(formatAssistantText(getMessageText(event.message)), mirrorChatId);
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		const turn = activeTelegramTurn;
		isMirrorTurn = false;
		currentAbort = undefined;
		stopTypingLoop();
		activeTelegramTurn = undefined;
		updateStatus(ctx);

		// Mirror finalization (terminal/RPC-initiated turns)
		if (!turn) {
			const mirrorChatId = config.allowedUserId;
			if (mirrorChatId !== undefined && mirrorPreview.isActive()) {
				const assistant = extractAssistantText(event.messages);
				if (assistant.stopReason === "aborted" || assistant.stopReason === "error") {
					await mirrorPreview.clear(mirrorChatId);
					return;
				}
				const rawText = assistant.text;
				const finalText = rawText !== undefined
					? formatAssistantText(rawText)
					: mirrorPreview.getPendingText() || "";
				mirrorPreview.setPendingText(finalText);
				if (finalText && finalText.length <= MAX_MESSAGE_LENGTH) {
					await mirrorPreview.finalize(mirrorChatId);
				} else {
					await mirrorPreview.clear(mirrorChatId);
					if (finalText) {
						const chunks = chunkParagraphs(finalText);
						for (const chunk of chunks) {
							try {
								await sendFinalMessage(mirrorChatId, chunk);
							} catch (error) {
								const message = error instanceof Error ? error.message : String(error);
								console.error("[telegram mirror] final response chunk send failed:", message);
							}
						}
					}
				}
			}
			return;
		}

		const assistant = extractAssistantText(event.messages);
		if (assistant.stopReason === "aborted") {
			await activePreview.clear(turn.chatId);
			return;
		}
		if (assistant.stopReason === "error") {
			await activePreview.clear(turn.chatId);
			await sendFormattedText(turn.chatId, assistant.errorMessage || "Telegram bridge: pi failed while processing the request.");
			return;
		}

		const finalText = assistant.text;
		if (finalText !== undefined) {
			activePreview.setPendingText(finalText);
		}

		if (finalText && finalText.length <= MAX_MESSAGE_LENGTH) {
			const finalized = await activePreview.finalize(turn.chatId);
			if (!finalized && turn.queuedAttachments.length > 0 && !finalText) {
				await sendFormattedText(turn.chatId, "Attached requested file(s).");
			}
		} else {
			await activePreview.clear(turn.chatId);
			if (finalText) {
				await sendFormattedText(turn.chatId, finalText);
			} else if (turn.queuedAttachments.length > 0) {
				await sendFormattedText(turn.chatId, "Attached requested file(s).");
			}
		}

		await sendQueuedAttachments(turn);

		if (queuedTelegramTurns.length > 0 && !preserveQueuedTurnsAsHistory) {
			const nextTurn = queuedTelegramTurns[0];
			startTypingLoop(ctx, nextTurn.chatId);
			updateStatus(ctx);
			pi.sendUserMessage(nextTurn.content);
		}
	});
}
