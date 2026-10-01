import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createSpec,
  latestSpec,
  loadSpec,
  reviseSpec,
  saveSpec,
} from "../src/qa/spec.js";
import { cleanup, makeTempDir, makeTempRepo } from "./helpers.js";

const input = {
  rawRequest: "Add X",
  normalizedIntent: "Add X",
  acceptance: [{ id: "A1", requirement: "X works" }],
  repoRoot: "/tmp/r",
  branch: "main",
  baseSha: "abc",
};

describe("spec lifecycle", () => {
  it("creates revision 1 with an id", () => {
    const s = createSpec(input);
    assert.equal(s.revision, 1);
    assert.match(s.id, /^qa-spec-/);
    assert.equal(s.schema, "mattspi.qa.spec.v1");
  });
  it("reviseSpec bumps revision and records supersedes, keeping raw intent", () => {
    const s = createSpec(input);
    const n = reviseSpec(s, { normalizedIntent: "Add X and Y" });
    assert.equal(n.revision, 2);
    assert.equal(n.supersedes, `${s.id}#r1`);
    assert.equal(n.task.raw_request, "Add X");
    assert.equal(n.task.normalized_intent, "Add X and Y");
    assert.equal(n.id, s.id);
  });
  it("save/load round-trips through validation", () => {
    const dir = makeTempDir();
    try {
      const s = createSpec({ ...input, repoRoot: dir });
      const file = saveSpec(dir, s);
      assert.ok(fs.existsSync(file));
      const loaded = loadSpec(dir, s.id);
      assert.equal(loaded.id, s.id);
      assert.equal(loaded.revision, 1);
    } finally {
      cleanup(dir);
    }
  });
  it("loadSpec throws helpfully when no preflight ran", () => {
    const dir = makeTempDir();
    try {
      assert.throws(
        () => loadSpec(dir, "qa-spec-nope"),
        /Run \/qa preflight first/,
      );
    } finally {
      cleanup(dir);
    }
  });
  it("loadSpec rejects a corrupted spec file", () => {
    const dir = makeTempDir();
    try {
      const specDir = path.join(dir, ".pi", "qa", "specs");
      fs.mkdirSync(specDir, { recursive: true });
      fs.writeFileSync(
        path.join(specDir, "qa-spec-bad.json"),
        JSON.stringify({ schema: "nope" }),
        "utf-8",
      );
      assert.throws(() => loadSpec(dir, "qa-spec-bad"), /invalid/);
    } finally {
      cleanup(dir);
    }
  });
  it("latestSpec returns null with no specs, newest otherwise", async () => {
    const dir = await makeTempRepo();
    try {
      assert.equal(latestSpec(dir), null);
      const a = createSpec(
        { ...input, repoRoot: dir },
        new Date("2026-01-01T00:00:00Z"),
      );
      saveSpec(dir, a);
      const b = createSpec(
        { ...input, repoRoot: dir },
        new Date("2026-02-01T00:00:00Z"),
      );
      saveSpec(dir, b);
      assert.equal(latestSpec(dir)?.id, b.id);
    } finally {
      cleanup(dir);
    }
  });
});
