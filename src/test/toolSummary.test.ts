import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  previewToolOutput,
  sanitizeArgsForUi,
  summarizeToolRequest,
  summarizeToolResult,
} from "../agent/toolSummary";

describe("summarizeToolRequest", () => {
  it("labels read/write/edit with path", () => {
    assert.equal(summarizeToolRequest("read_file", { path: "a.ts" }), "Read a.ts");
    assert.equal(summarizeToolRequest("write_file", { path: "b.ts" }), "Write b.ts");
    assert.equal(summarizeToolRequest("apply_edit", { path: "c.ts" }), "Edit c.ts");
  });

  it("handles list/search/terminal", () => {
    assert.equal(summarizeToolRequest("list_dir", {}), "List .");
    assert.equal(summarizeToolRequest("search", { pattern: "TODO" }), "Search TODO");
    assert.equal(
      summarizeToolRequest("run_terminal", { command: "npm test" }),
      "Ran npm test"
    );
  });

  it("falls back for unknown tools", () => {
    assert.equal(summarizeToolRequest("custom_tool", {}), "custom_tool");
  });
});

describe("summarizeToolResult", () => {
  it("reports failure prefix", () => {
    assert.match(summarizeToolResult("read_file", "ERROR: missing"), /^Failed/);
  });

  it("summarizes read_file lines/chars", () => {
    const out = summarizeToolResult("read_file", "a\nb\nc");
    assert.match(out, /3 lines/);
    assert.match(out, /chars/);
  });

  it("counts list_dir entries", () => {
    assert.equal(summarizeToolResult("list_dir", "a\nb\n"), "2 entries");
  });

  it("parses terminal exit code", () => {
    assert.match(
      summarizeToolResult("run_terminal", "ok\nexit code: 0\n"),
      /exit 0/
    );
  });
});

describe("sanitizeArgsForUi / previewToolOutput", () => {
  it("truncates long content fields", () => {
    const long = "x".repeat(100);
    const out = sanitizeArgsForUi({ content: long, path: "f.ts" });
    assert.equal(out.path, "f.ts");
    assert.match(String(out.content), /…/);
  });

  it("previews long output", () => {
    const big = "y".repeat(600);
    const preview = previewToolOutput(big, 500);
    assert.ok(preview.length < big.length);
    assert.match(preview, /…/);
  });
});
