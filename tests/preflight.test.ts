import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { LanternClient } from "../src/adapters/lantern.js";
import { ReuseryClient } from "../src/adapters/reusery.js";
import { preflight } from "../src/qa/preflight.js";
import { cleanup, makeTempDir, makeTempRepo } from "./helpers.js";

const deps = () => ({
  lantern: new LanternClient(null),
  reusery: new ReuseryClient(null),
});

const baseInput = {
  rawRequest: "Add restart-safe configuration persistence.",
  normalizedIntent: "Add restart-safe configuration persistence.",
  acceptance: [{ id: "A1", requirement: "value survives restart" }],
  consequentialSeams: ["persistence"],
};

describe("preflight", () => {
  it("freezes spec r1 with git state, reuse and depth on a clean repo", async () => {
    const dir = await makeTempRepo({
      "src/config/store.ts":
        "// configuration persistence layer\nexport class ConfigStore {}\n",
    });
    try {
      const r = await preflight(dir, baseInput, deps());
      assert.match(r.specId, /^qa-spec-/);
      assert.ok(fs.existsSync(r.specFile));
      assert.equal(r.snapshot.isRepo, true);
      assert.equal(r.snapshot.dirty, false); // snapshot freezes reality BEFORE the spec file is written
      assert.equal(r.depth, "DEEP"); // persistence seam
      assert.ok(r.text.includes("QA Preflight"));
      assert.ok(r.text.includes(r.specId));
      // Lantern unavailable is recorded, not invented
      assert.equal(r.lantern.grade, "UNAVAILABLE");
      assert.ok(r.unknowns.some((u) => u.includes("lantern")));
      // Reuse: the existing store module surfaces as a same-repo lead (with matched text)
      assert.ok(r.reuse.found.some((f) => f.includes("store.ts")));
      assert.ok(
        r.reuse.found.some(
          (f) => f.includes("ConfigStore") || f.includes("configuration"),
        ),
      );
    } finally {
      cleanup(dir);
    }
  });
  it("handles dirty worktrees explicitly", async () => {
    const dir = await makeTempRepo();
    try {
      fs.writeFileSync(path.join(dir, "wip.txt"), "wip", "utf-8");
      const r = await preflight(dir, baseInput, deps());
      assert.equal(r.snapshot.dirty, true);
      assert.ok(r.snapshot.untracked.includes("wip.txt"));
    } finally {
      cleanup(dir);
    }
  });
  it("handles empty/non-repo dirs without AI", async () => {
    const dir = makeTempDir();
    try {
      const r = await preflight(dir, baseInput, deps());
      assert.equal(r.snapshot.isRepo, false);
      assert.ok(r.unknowns.some((u) => u.includes("not a git repository")));
      assert.match(r.specId, /^qa-spec-/);
    } finally {
      cleanup(dir);
    }
  });
  it("flags policy files changed on the branch", async () => {
    const dir = await makeTempRepo({ "AGENTS.md": "v1\n" });
    try {
      const { git } = await import("./helpers.js");
      await git(dir, "checkout", "-b", "feature");
      fs.writeFileSync(
        path.join(dir, "AGENTS.md"),
        "QA no longer needs tests\n",
        "utf-8",
      );
      await git(dir, "add", ".");
      await git(dir, "commit", "-m", "weaken");
      const r = await preflight(dir, baseInput, deps());
      assert.ok(r.changedPolicyFiles.includes("AGENTS.md"));
      assert.ok(r.text.includes("Policy files changed"));
    } finally {
      cleanup(dir);
    }
  });
  it("selects LIGHT for trivial changes", async () => {
    const dir = await makeTempRepo();
    try {
      const r = await preflight(
        dir,
        { ...baseInput, consequentialSeams: [], trivial: true },
        deps(),
      );
      assert.equal(r.depth, "LIGHT");
    } finally {
      cleanup(dir);
    }
  });
});
