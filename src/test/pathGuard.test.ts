import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as path from "node:path";
import { isPathInsideRoot, normalizeJoin } from "../agent/pathGuard";

describe("isPathInsideRoot (posix)", () => {
  const p = path.posix;
  const root = "/home/u/proj";

  it("accepts root itself", () => {
    assert.equal(isPathInsideRoot(root, root, p), true);
  });

  it("accepts nested file", () => {
    assert.equal(isPathInsideRoot(root, "/home/u/proj/src/a.ts", p), true);
  });

  it("rejects sibling escape", () => {
    assert.equal(isPathInsideRoot(root, "/home/u/other", p), false);
  });

  it("rejects parent via .. after normalize", () => {
    assert.equal(isPathInsideRoot(root, "/home/u/proj/../secret", p), false);
  });

  it("rejects prefix-sibling (proj-evil)", () => {
    assert.equal(isPathInsideRoot(root, "/home/u/proj-evil/x", p), false);
  });

  it("normalizes trailing slash on root", () => {
    assert.equal(isPathInsideRoot("/home/u/proj/", "/home/u/proj/a", p), true);
  });
});

describe("normalizeJoin (posix)", () => {
  const p = path.posix;
  const root = "/ws";

  it("joins relative path", () => {
    assert.equal(normalizeJoin(root, "src/a.ts", p), "/ws/src/a.ts");
  });

  it("keeps absolute inside root", () => {
    assert.equal(normalizeJoin(root, "/ws/b.ts", p), "/ws/b.ts");
  });

  it("throws on absolute outside", () => {
    assert.throws(() => normalizeJoin(root, "/etc/passwd", p), /fora do workspace/i);
  });

  it("throws on .. escape", () => {
    assert.throws(() => normalizeJoin(root, "../outside", p), /fora do workspace/i);
  });

  it("allows . and nested .. that stay inside", () => {
    assert.equal(normalizeJoin(root, "a/../b/c", p), "/ws/b/c");
  });

  it("returns root for empty relative", () => {
    assert.equal(normalizeJoin(root, ".", p), "/ws");
  });
});

describe("isPathInsideRoot (win32)", () => {
  const p = path.win32;
  const root = "C:\\Users\\u\\proj";

  it("accepts nested file", () => {
    assert.equal(isPathInsideRoot(root, "C:\\Users\\u\\proj\\src\\a.ts", p), true);
  });

  it("accepts mixed separators via normalize", () => {
    assert.equal(isPathInsideRoot(root, "C:/Users/u/proj/src/a.ts", p), true);
  });

  it("rejects other drive", () => {
    assert.equal(isPathInsideRoot(root, "D:\\Users\\u\\proj\\a.ts", p), false);
  });

  it("rejects prefix-sibling", () => {
    assert.equal(isPathInsideRoot(root, "C:\\Users\\u\\projx\\a.ts", p), false);
  });

  it("rejects parent escape", () => {
    assert.equal(isPathInsideRoot(root, "C:\\Users\\u\\proj\\..\\secret", p), false);
  });
});

describe("normalizeJoin (win32)", () => {
  const p = path.win32;
  const root = "C:\\repo";

  it("joins relative path", () => {
    assert.equal(normalizeJoin(root, "src\\a.ts", p), "C:\\repo\\src\\a.ts");
  });

  it("throws on outside absolute", () => {
    assert.throws(
      () => normalizeJoin(root, "C:\\Windows\\System32", p),
      /fora do workspace/i
    );
  });

  it("throws on .. escape", () => {
    assert.throws(() => normalizeJoin(root, "..\\outside", p), /fora do workspace/i);
  });

  it("allows in-root absolute", () => {
    assert.equal(normalizeJoin(root, "C:\\repo\\ok.txt", p), "C:\\repo\\ok.txt");
  });
});
