import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { formatPrompt, formatToolCall, formatError, formatAssistantText, formatEditDiff, renderTableToPng, extractTableSegments, mdToTelegramHtml } from "./index";

describe("formatPrompt", () => {
  it("returns a formatted prompt with emoji prefix", () => {
    assert.equal(formatPrompt("fix the login bug"), "💬 You: fix the login bug");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(formatPrompt("  hello world  "), "💬 You: hello world");
  });

  it("truncates long text with ellipsis", () => {
    const long = "a".repeat(500);
    const result = formatPrompt(long);
    assert.ok(result.startsWith("💬 You: "));
    assert.ok(result.endsWith("…"));
    assert.ok(result.length <= 410); // prefix + 400 chars + ellipsis
  });

  it("handles empty string", () => {
    assert.equal(formatPrompt(""), "💬 You: (empty)");
  });

  it("preserves multiline input", () => {
    assert.equal(
      formatPrompt("first line\nsecond line"),
      "💬 You: first line\nsecond line",
    );
  });

  it("puts prefix on its own line for blockquote lines", () => {
    assert.equal(formatPrompt("> hey"), "💬 You:\n> hey");
  });

  it("keeps inline prefix when no blockquote", () => {
    assert.equal(formatPrompt("hey"), "💬 You: hey");
  });

  it("puts prefix on its own line when any line is a blockquote", () => {
    assert.equal(
      formatPrompt("context\n> quote\nmore"),
      "💬 You:\ncontext\n> quote\nmore",
    );
  });
});

describe("formatToolCall", () => {
  it("formats bash tool call", () => {
    assert.equal(
      formatToolCall("bash", { command: "npm test" }),
      "💻 bash: `npm test`",
    );
  });

  it("truncates bash command to first line", () => {
    assert.equal(
      formatToolCall("bash", { command: "npm test\nsecond line" }),
      "💻 bash: `npm test`",
    );
  });

  it("formats read tool call", () => {
    assert.equal(
      formatToolCall("read", { path: "src/index.ts" }),
      "📄 read `src/index.ts`",
    );
  });

  it("formats edit tool call with edit count", () => {
    assert.equal(
      formatToolCall("edit", { path: "src/index.ts", edits: [{}, {}] }),
      "✏️ edit `src/index.ts` (2 edits)",
    );
  });

  it("formats edit tool call without edits", () => {
    assert.equal(
      formatToolCall("edit", { path: "src/index.ts" }),
      "✏️ edit `src/index.ts`",
    );
  });

  it("formats write tool call", () => {
    assert.equal(
      formatToolCall("write", { path: "src/new-file.ts" }),
      "📝 write `src/new-file.ts`",
    );
  });

  it("formats grep tool call", () => {
    assert.equal(
      formatToolCall("grep", { pattern: "TODO" }),
      "🔍 grep `TODO`",
    );
  });

  it("formats find tool call", () => {
    assert.equal(
      formatToolCall("find", { path: "src/" }),
      "📁 find `src/`",
    );
  });

  it("formats ls tool call", () => {
    assert.equal(
      formatToolCall("ls", { path: "src/" }),
      "📂 ls `src/`",
    );
  });

  it("formats custom tool call", () => {
    assert.equal(
      formatToolCall("telegram_attach", { paths: ["a.txt"] }),
      "🔧 telegram_attach",
    );
  });

  it("handles unknown tool name gracefully", () => {
    assert.equal(
      formatToolCall("unknown_tool", {}),
      "🔧 unknown_tool",
    );
  });

  it("handles empty params", () => {
    assert.equal(
      formatToolCall("bash", {}),
      "💻 bash",
    );
  });
});

describe("formatError", () => {
  it("formats an Error instance", () => {
    assert.equal(
      formatError(new Error("connection timeout")),
      "❌ Error: connection timeout",
    );
  });

  it("formats a string message", () => {
    assert.equal(
      formatError("something went wrong"),
      "❌ Error: something went wrong",
    );
  });

  it("handles unknown error types", () => {
    assert.equal(
      formatError(null),
      "❌ Error: unknown",
    );
  });

  it("handles undefined", () => {
    assert.equal(
      formatError(undefined),
      "❌ Error: unknown",
    );
  });
});

describe("formatAssistantText", () => {
  it("prefixes text with robot emoji", () => {
    assert.equal(
      formatAssistantText("Let me check that file."),
      "🤖 Let me check that file.",
    );
  });

  it("handles empty string", () => {
    assert.equal(formatAssistantText(""), "🤖 ");
  });

  it("preserves existing whitespace", () => {
    assert.equal(
      formatAssistantText("  hello  "),
      "🤖   hello  ",
    );
  });
});

describe("formatEditDiff", () => {
  it("wraps diff in markdown code block", () => {
    const diff = "- old line\n+ new line";
    const result = formatEditDiff(diff);
    assert.ok(result.startsWith("```diff\n"));
    assert.ok(result.endsWith("\n```"));
    assert.ok(result.includes(diff));
  });

  it("handles empty diff", () => {
    const result = formatEditDiff("");
    assert.ok(result.includes("(empty diff)"));
  });

  it("truncates long diffs", () => {
    const long = "a".repeat(4000);
    const result = formatEditDiff(long);
    assert.ok(result.length <= 3600);
    assert.ok(result.endsWith("\n...\n```"));
  });
});

describe("renderTableToPng", () => {
  it("creates a valid PNG file", async () => {
    const tmpPath = `/tmp/test-table-${Date.now()}.png`;
    await renderTableToPng(
      ["| Col A | Col B |", "|-------|-------|", "| val1  | val2  |"],
      tmpPath,
    );
    const s = await stat(tmpPath);
    assert.ok(s.isFile());
    assert.ok(s.size > 0);
  });

  it("renders readable text (dark pixels present)", async () => {
    const tmpPath = `/tmp/test-text-${Date.now()}.png`;
    await renderTableToPng(
      ["| Name | Role |", "|------|------|", "| Alice | Admin |"],
      tmpPath,
    );
    const img = await loadImage(tmpPath);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, img.width, img.height);
    let darkPixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r + g + b < 200) darkPixels++;
    }
    assert.ok(darkPixels > 100, `Expected >100 dark pixels, got ${darkPixels}`);
  });

  it("renders emojis (color pixels present)", async () => {
    const tmpPath = `/tmp/test-emoji-${Date.now()}.png`;
    await renderTableToPng(
      ["| Emoji | Meaning |", "|-------|---------|", "| ⭐ | Star |"],
      tmpPath,
    );
    const img = await loadImage(tmpPath);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, img.width, img.height);
    let colorPixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (!(Math.abs(r - g) < 15 && Math.abs(g - b) < 15)) colorPixels++;
    }
    assert.ok(colorPixels > 50, `Expected >50 color pixels, got ${colorPixels}`);
  });

  it("renders header with distinct background", async () => {
    const tmpPath = `/tmp/test-header-${Date.now()}.png`;
    await renderTableToPng(
      ["| H1 | H2 |", "|----|----|", "| A | B |"],
      tmpPath,
    );
    const img = await loadImage(tmpPath);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    // Sample top row (header) and second row
    const topRow = ctx.getImageData(0, 5, img.width, 1).data;
    const bodyRow = ctx.getImageData(0, Math.floor(img.height / 2), img.width, 1).data;
    let topAvg = 0, bodyAvg = 0;
    for (let i = 0; i < topRow.length; i += 4) topAvg += (topRow[i] + topRow[i + 1] + topRow[i + 2]) / 3;
    for (let i = 0; i < bodyRow.length; i += 4) bodyAvg += (bodyRow[i] + bodyRow[i + 1] + bodyRow[i + 2]) / 3;
    topAvg /= (topRow.length / 4);
    bodyAvg /= (bodyRow.length / 4);
    // Header should be darker than body
    assert.ok(topAvg < bodyAvg, `Header ${topAvg.toFixed(0)} should be darker than body ${bodyAvg.toFixed(0)}`);
  });
});

describe("mdToTelegramHtml", () => {
  it("escapes HTML special characters", () => {
    assert.equal(
      mdToTelegramHtml("1 < 2 & 3 > 0"),
      "1 &lt; 2 &amp; 3 &gt; 0",
    );
  });

  it("leaves plain text untouched", () => {
    assert.equal(mdToTelegramHtml("hello world"), "hello world");
  });

  it("converts bold", () => {
    assert.equal(
      mdToTelegramHtml("some **bold** text"),
      "some <b>bold</b> text",
    );
  });

  it("converts italic", () => {
    assert.equal(
      mdToTelegramHtml("some *italic* text"),
      "some <i>italic</i> text",
    );
  });

  it("converts inline code", () => {
    assert.equal(
      mdToTelegramHtml("use `npm test` to run"),
      "use <code>npm test</code> to run",
    );
  });

  it("converts code blocks with language", () => {
    assert.equal(
      mdToTelegramHtml("```js\nconsole.log(1)\n```"),
      "<pre><code class=\"language-js\">console.log(1)\n</code></pre>",
    );
  });

  it("converts code blocks without language", () => {
    assert.equal(
      mdToTelegramHtml("```\nhello\n```"),
      "<pre><code>hello\n</code></pre>",
    );
  });

  it("converts links", () => {
    assert.equal(
      mdToTelegramHtml("[click here](https://example.com)"),
      '<a href="https://example.com">click here</a>',
    );
  });

  it("converts blockquotes", () => {
    assert.equal(
      mdToTelegramHtml("> quoted text"),
      "<blockquote>quoted text</blockquote>",
    );
  });

  it("converts strikethrough", () => {
    assert.equal(
      mdToTelegramHtml("some ~~deleted~~ text"),
      "some <s>deleted</s> text",
    );
  });

  it("does not convert markdown inside inline code", () => {
    assert.equal(
      mdToTelegramHtml("use `**bold**` here"),
      "use <code>**bold**</code> here",
    );
  });

  it("does not convert markdown inside code blocks", () => {
    assert.equal(
      mdToTelegramHtml("```\n**not bold**\n```"),
      "<pre><code>**not bold**\n</code></pre>",
    );
  });

  it("handles bold+italic combo", () => {
    assert.equal(
      mdToTelegramHtml("***bold italic***"),
      "<b><i>bold italic</i></b>",
    );
  });

  it("converts headings to bold", () => {
    assert.equal(
      mdToTelegramHtml("# Title"),
      "<b>Title</b>",
    );
  });
});

describe("extractTableSegments", () => {
  it("returns single text segment when no table", async () => {
    const segments = await extractTableSegments("hello world");
    assert.equal(segments.length, 1);
    assert.equal(segments[0].type, "text");
    assert.equal((segments[0] as { type: "text"; text: string }).text, "hello world");
  });

  it("extracts a table segment", async () => {
    const segments = await extractTableSegments("| a | b |\n|---|---|\n| 1 | 2 |");
    assert.equal(segments.length, 1);
    assert.equal(segments[0].type, "table");
    assert.deepEqual((segments[0] as { type: "table"; lines: string[] }).lines, ["| a | b |", "|---|---|", "| 1 | 2 |"]);
  });

  it("splits text and table", async () => {
    const segments = await extractTableSegments("intro\n| a |\n| 1 |\noutro");
    assert.equal(segments.length, 3);
    assert.equal(segments[0].type, "text");
    assert.equal(segments[1].type, "table");
    assert.equal(segments[2].type, "text");
  });

  it("ignores table-like lines inside code blocks", async () => {
    const segments = await extractTableSegments("```\n| a |\n```");
    assert.equal(segments.length, 1);
    assert.equal(segments[0].type, "text");
    assert.ok((segments[0] as { type: "text"; text: string }).text.includes("| a |"));
  });
});
