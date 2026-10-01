import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { looksLikeSecret, platformSpawn, runCommand } from "../src/evidence/commands.js";
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

describe("platformSpawn (Windows routing)", () => {
  it("spawns pathed executables directly, bare words via cmd", () => {
    if (process.platform !== "win32") return;
    assert.deepEqual(platformSpawn("C:\\Program Files\\Go\\bin\\go.exe", ["version"]), {
      exe: "C:\\Program Files\\Go\\bin\\go.exe",
      argv: ["version"],
    });
    const npm = platformSpawn("npm", ["test"]);
    assert.equal(npm.exe, "cmd.exe");
    assert.deepEqual(npm.argv, ["/d", "/s", "/c", "npm", "test"]);
  });
  it("spaced exe runs without quote-stripping", async () => {
    if (process.platform !== "win32") return;
    const r = await runCommand("C:\\Program Files\\Go\\bin\\go.exe", ["version"], { timeoutMs: 30000, maxChars: 200 });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("go version"));
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
    assert.deepEqual(s, { total: 13, passed: 12, failed: 1 });
  });
  it("parses node --test spec-reporter output", () => {
    const s = parseTestSummary(["x"], "ℹ tests 125\nℹ pass 125\nℹ fail 0\n");
    assert.deepEqual(s, { total: 125, passed: 125, failed: 0 });
  });
  it("parses cargo output", () => {
    const s = parseTestSummary(
      ["x"],
      "test result: ok. 12 passed; 0 failed; finished",
    );
    assert.deepEqual(s, { total: 12, passed: 12, failed: 0 });
  });
  it("returns nulls when unparseable", () => {
    assert.deepEqual(parseTestSummary(["x"], "hello"), {
      total: null,
      passed: null,
      failed: null,
    });
  });
});

describe("runTests", () => {
  it("runs a real npm test and records EXECUTED-grade metadata", async () => {
    const dir = await makeTempRepo({
      "package.json": JSON.stringify({ scripts: { test: "node check.js" } }),
      "check.js": "console.log('INNER_SUITE_OK');\n",
    });
    try {
      // NOTE: the inner suite is a plain node script, NOT node --test:
      // node skips nested `node --test` runs inside a test process
      // (recursive-runner guard), so nesting would prove nothing.
      const e = await runTests(dir, 60_000);
      assert.equal(e.discovered, true);
      assert.ok(e.result);
      assert.equal(e.result.exitCode, 0);
      assert.ok(e.result.stdout.includes("INNER_SUITE_OK"));
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
