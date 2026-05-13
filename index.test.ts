import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatPrompt, formatToolCall, formatError, formatAssistantText, formatEditDiff } from "./index";

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
