import test from "node:test";
import assert from "node:assert/strict";
import {
  contextWindowForModelId,
  DEFAULT_CONTEXT_WINDOW,
  extractContextWindow,
} from "../providers/models";

test("extractContextWindow reads OpenRouter-style fields", () => {
  assert.equal(extractContextWindow({ context_length: 200_000 }), 200_000);
  assert.equal(
    extractContextWindow({ top_provider: { context_length: 65_536 } }),
    65_536
  );
  assert.equal(extractContextWindow({ inputTokenLimit: 1_048_576 }), 1_048_576);
});

test("extractContextWindow reads Ollama model_info keys", () => {
  assert.equal(
    extractContextWindow({
      model_info: { "llama.context_length": 8192 },
    }),
    8192
  );
  assert.equal(
    extractContextWindow({
      model_info: { "foo.context_length": 32768 },
    }),
    32768
  );
});

test("extractContextWindow ignores tiny/invalid values", () => {
  assert.equal(extractContextWindow({ context_length: 512 }), undefined);
  assert.equal(extractContextWindow({ context_length: "nope" }), undefined);
  assert.equal(extractContextWindow(null), undefined);
});

test("contextWindowForModelId prefers API value", () => {
  assert.equal(contextWindowForModelId("gpt-4o", 64_000), 64_000);
});

test("contextWindowForModelId uses curated map", () => {
  assert.equal(contextWindowForModelId("claude-sonnet-4-20250514"), 200_000);
  assert.equal(contextWindowForModelId("gpt-4.1-mini"), 1_047_576);
  assert.equal(contextWindowForModelId("gemini-2.0-flash"), 1_048_576);
  assert.equal(contextWindowForModelId("llama3.1:8b"), 128_000);
});

test("contextWindowForModelId falls back to default", () => {
  assert.equal(contextWindowForModelId("totally-unknown-model-xyz"), DEFAULT_CONTEXT_WINDOW);
});
