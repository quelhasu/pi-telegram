import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { formatPrompt, formatToolCall, formatError, formatAssistantText, formatEditDiff, renderTableToPng, extractTableSegments } from "./index";

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
  it("creates a PNG file from table lines", async () => {
    const tmpPath = `/tmp/test-table-${Date.now()}.png`;
    await renderTableToPng(
      ["| Col A | Col B |", "|-------|-------|", "| val1  | val2  |"],
      tmpPath,
    );
    const s = await stat(tmpPath);
    assert.ok(s.isFile());
    assert.ok(s.size > 0);
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
