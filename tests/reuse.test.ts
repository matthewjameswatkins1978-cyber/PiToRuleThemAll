import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { cloneSearch } from "../src/reuse/clone-search.js";
import { resolveReuse } from "../src/reuse/resolver.js";
import {
  patternsForTask,
  structuralSearch,
} from "../src/reuse/structural-search.js";
import { queriesForTask, textSearch } from "../src/reuse/text-search.js";
import { cleanup, makeTempRepo } from "./helpers.js";

describe("textSearch", () => {
  it("finds existing symbols and reports no-match cleanly", async () => {
    const dir = await makeTempRepo({
      "src/util.ts": "export function retryWithBackoff() {}\n",
    });
    try {
      const hit = await textSearch(dir, "retryWithBackoff");
      assert.equal(hit.executed, true);
      assert.ok(hit.hits.length > 0);
      assert.ok(hit.hits[0]?.file.includes("util.ts"));
      const miss = await textSearch(dir, "definitelyNotHereZZZ");
      assert.equal(miss.executed, true);
      assert.deepEqual(miss.hits, []);
    } finally {
      cleanup(dir);
    }
  });
  it("queriesForTask extracts identifiers", () => {
    const q = queriesForTask(
      "Add retry_with_backoff to the ConfigStore persistence layer",
    );
    assert.ok(q.includes("retry_with_backoff"));
    assert.ok(q.length <= 8);
  });
});

describe("structuralSearch", () => {
  it("injectable resolver: missing binary is an honest named error", async () => {
    const dir = await makeTempRepo({ "a.ts": "const x = fetch(url);\n" });
    try {
      const r = await structuralSearch(dir, "fetch($$$)", {
        lang: "ts",
        resolver: async () => ({
          exe: "definitely-not-ast-grep-zzz",
          source: "fake",
        }),
      });
      assert.equal(r.executed, false);
      assert.ok(r.error?.includes("definitely-not-ast-grep-zzz"));
    } finally {
      cleanup(dir);
    }
  });
  it("injectable resolver: null means neither executable exists", async () => {
    const dir = await makeTempRepo({ "a.ts": "const x = 1;\n" });
    try {
      const r = await structuralSearch(dir, "x", {
        resolver: async () => null,
      });
      assert.equal(r.executed, false);
      assert.ok(r.error?.includes("neither sg nor ast-grep"));
    } finally {
      cleanup(dir);
    }
  });
  it("LIVE smoke: installed sg/ast-grep must EXECUTE, never UNAVAILABLE", { skip: process.env["PI_QA_LIVE_SG"] !== "1" && "needs a real sg/ast-grep binary (run with --live)" }, async () => {
    const { resolveAstGrep, resetAstGrepCache } =
      await import("../src/reuse/tool-discovery.js");
    resetAstGrepCache();
    const resolved = await resolveAstGrep();
    if (!resolved) {
      assert.fail(
        "neither sg nor ast-grep on PATH: install one or this suite cannot prove structural search",
      );
    }
    const dir = await makeTempRepo({ "a.ts": "const x = fetch(url);\n" });
    try {
      const r = await structuralSearch(dir, "fetch($$$)", { lang: "ts" });
      assert.equal(
        r.executed,
        true,
        `expected EXECUTED via ${resolved.exe}, got: ${r.error}`,
      );
      assert.ok(r.hits.length > 0);
      assert.ok(r.executable?.includes(resolved.exe));
    } finally {
      cleanup(dir);
    }
  });
  it("patternsForTask suggests retry shapes", () => {
    const p = patternsForTask("add retry with backoff");
    assert.ok(p.length > 0);
  });
});

describe("cloneSearch", () => {
  it("detects duplicated blocks across files", async () => {
    const block =
      Array.from({ length: 14 }, (_, i) => `const v${i} = compute(${i});`).join(
        "\n",
      ) + "\n";
    const dir = await makeTempRepo({ "a.ts": block, "b.ts": block });
    try {
      const r = await cloneSearch(dir);
      assert.equal(r.executed, true);
      assert.equal(r.filesScanned, 2);
      assert.ok(r.clones.length > 0);
      const files =
        r.clones[0]?.locations.map((l) => path.basename(l.file)) ?? [];
      assert.ok(files.includes("a.ts") && files.includes("b.ts"));
    } finally {
      cleanup(dir);
    }
  });
  it("stays quiet on unique code", async () => {
    const dir = await makeTempRepo({ "a.ts": "const alpha = 1;\n" });
    try {
      const r = await cloneSearch(dir);
      assert.deepEqual(r.clones, []);
    } finally {
      cleanup(dir);
    }
  });
});

describe("resolveReuse", () => {
  it("reports searched/found/not_checked without claiming universal absence", async () => {
    const dir = await makeTempRepo({
      "src/store.ts": "export class ConfigStore {}\n",
    });
    try {
      const r = await resolveReuse(dir, "persist ConfigStore to disk");
      assert.equal(r.searched["text"], "EXECUTED");
      assert.ok(r.found.some((f) => f.includes("ConfigStore")));
      assert.ok(r.not_checked.some((n) => n.includes("sibling")));
      assert.ok(r.not_checked.some((n) => n.includes("reusery")));
      // Absence phrasing: never "nothing reusable exists"
      assert.ok(!JSON.stringify(r).includes("nothing reusable exists"));
    } finally {
      cleanup(dir);
    }
  });
  it("records unavailable grades instead of inventing", async () => {
    const dir = await makeTempRepo();
    try {
      const r = await resolveReuse(dir, "do the thing", {
        lanternGrade: "UNAVAILABLE",
        reuseryGrade: "UNAVAILABLE",
      });
      assert.equal(r.searched["lantern"], "UNAVAILABLE");
      assert.equal(r.searched["reusery"], "UNAVAILABLE");
    } finally {
      cleanup(dir);
    }
  });
  it("writes only bounded command records", async () => {
    const dir = await makeTempRepo();
    try {
      const r = await resolveReuse(dir, "x".repeat(10));
      for (const c of r.commands) {
        assert.ok(
          typeof c.command === "string" && typeof c.exit_code === "number",
        );
      }
    } finally {
      cleanup(dir);
    }
  });
});

describe("clone-search file scoping", () => {
  it("scans only the focus file when given", async () => {
    const dir = await makeTempRepo({
      "a.ts": "const a = 1;\n",
      "sub/b.ts": "const b = 2;\n",
    });
    try {
      const r = await cloneSearch(dir, [path.join(dir, "a.ts")]);
      assert.equal(r.filesScanned, 1);
    } finally {
      cleanup(dir);
    }
  });
});
