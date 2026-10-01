import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resetAstGrepCache, resolveAstGrep } from "../src/reuse/tool-discovery.js";

describe("resolveAstGrep (defect H)", () => {
  it("prefers sg over ast-grep", async () => {
    resetAstGrepCache();
    const r = await resolveAstGrep({
      which: async (exe) => (exe === "sg" ? "C:\\bin\\sg.exe" : exe === "ast-grep" ? "C:\\bin\\ast-grep.exe" : null),
    });
    assert.equal(r?.exe, "sg");
    assert.ok(r?.source.includes("sg"));
  });
  it("falls back to ast-grep when sg is absent", async () => {
    resetAstGrepCache();
    const r = await resolveAstGrep({ which: async (exe) => (exe === "ast-grep" ? "/usr/bin/ast-grep" : null) });
    assert.equal(r?.exe, "ast-grep");
  });
  it("returns null when neither exists", async () => {
    resetAstGrepCache();
    assert.equal(await resolveAstGrep({ which: async () => null }), null);
  });
  it("caches the selection for one QA run", async () => {
    resetAstGrepCache();
    let calls = 0;
    const which = async (exe: string) => {
      calls++;
      return exe === "sg" ? "sg" : null;
    };
    await resolveAstGrep({ which });
    await resolveAstGrep({ which });
    assert.equal(calls, 1);
    resetAstGrepCache();
  });
});
