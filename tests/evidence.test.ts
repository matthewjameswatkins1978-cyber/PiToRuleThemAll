import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { looksLikeSecret, runCommand } from "../src/evidence/commands.js";
import {
  discoverTestCommand,
  parseTestSummary,
  runTests,
} from "../src/evidence/tests.js";
import { restartProbe } from "../src/qa/adversarial.js";
import { cleanup, makeTempDir, makeTempRepo } from "./helpers.js";

describe("runCommand", () => {
  it("captures exit codes and truncates bounded output", async () => {
    const ok = await runCommand("git", ["--version"]);
    assert.equal(ok.exitCode, 0);
    assert.ok(ok.stdout.includes("git version"));
    const fail = await runCommand("git", [
      "rev-parse",
      "definitely-not-a-ref-zzz",
    ]);
    assert.notEqual(fail.exitCode, 0);
  });
  it("caps long output with a marker", async () => {
    const r = await runCommand("git", ["--version"], { maxChars: 5 });
    assert.equal(r.truncated, true);
    assert.ok(r.stdout.includes("truncated"));
  });
});

describe("looksLikeSecret", () => {
  it("spots common secret shapes", () => {
    assert.equal(looksLikeSecret("token ghp_abc123XYZ"), true);
    assert.equal(looksLikeSecret("-----BEGIN RSA PRIVATE KEY-----"), true);
    assert.equal(looksLikeSecret("all clear, exit 0"), false);
  });
});

describe("discoverTestCommand", () => {
  it("finds npm test from package.json", async () => {
    const dir = await makeTempRepo({
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    });
    try {
      assert.deepEqual(discoverTestCommand(dir), ["npm", "test", "--silent"]);
    } finally {
      cleanup(dir);
    }
  });
  it("returns null when no harness is recognised", async () => {
    const dir = await makeTempRepo({ "notes.txt": "hi" });
    try {
      assert.equal(discoverTestCommand(dir), null);
    } finally {
      cleanup(dir);
    }
  });
});

describe("parseTestSummary", () => {
  it("parses node --test output", () => {
    const s = parseTestSummary(["x"], "# pass 12\n# fail 1\n");
    assert.deepEqual(s, { passed: 12, failed: 1 });
  });
  it("parses cargo output", () => {
    const s = parseTestSummary(
      ["x"],
      "test result: ok. 12 passed; 0 failed; finished",
    );
    assert.deepEqual(s, { passed: 12, failed: 0 });
  });
  it("returns nulls when unparseable", () => {
    assert.deepEqual(parseTestSummary(["x"], "hello"), {
      passed: null,
      failed: null,
    });
  });
});

describe("runTests", () => {
  it("runs a real npm test and records EXECUTED-grade metadata", async () => {
    const dir = await makeTempRepo({
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "a.test.js": "const t=require('node:test');t.test('x',()=>{});\n",
    });
    try {
      const e = await runTests(dir, 60_000);
      assert.equal(e.discovered, true);
      assert.ok(e.result);
      assert.equal(e.result.exitCode, 0);
    } finally {
      cleanup(dir);
    }
  });
});

describe("restartProbe", () => {
  it("passes when the value survives the round-trip", async () => {
    const dir = makeTempDir();
    try {
      const file = path.join(dir, "cfg.json");
      const d = await restartProbe({
        workDir: dir,
        expected: { a: 1 },
        write: async () => {
          fs.writeFileSync(file, JSON.stringify({ a: 1 }), "utf-8");
        },
        read: async () => JSON.parse(fs.readFileSync(file, "utf-8")) as unknown,
      });
      assert.equal(d.detected, false);
    } finally {
      cleanup(dir);
    }
  });
  it("detects a persistence failure", async () => {
    const dir = makeTempDir();
    try {
      const d = await restartProbe({
        workDir: dir,
        expected: { a: 1 },
        write: async () => {},
        read: async () => ({ a: 2 }),
      });
      assert.equal(d.detected, true);
      assert.equal(d.signal, "restart-persistence");
    } finally {
      cleanup(dir);
    }
  });
});
