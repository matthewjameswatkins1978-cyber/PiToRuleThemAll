import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  boundedDiff,
  changedPolicyFiles,
  describeWorktree,
  readAtRef,
  snapshotGit,
} from "../src/evidence/git.js";
import { cleanup, git, makeTempDir, makeTempRepo } from "./helpers.js";

describe("snapshotGit", () => {
  it("captures clean repo state", async () => {
    const dir = await makeTempRepo();
    try {
      const s = await snapshotGit(dir);
      assert.equal(s.isRepo, true);
      assert.equal(s.branch, "main");
      assert.ok(s.headSha);
      assert.equal(s.dirty, false);
      assert.deepEqual(s.untracked, []);
      assert.equal(s.remote, null);
    } finally {
      cleanup(dir);
    }
  });
  it("detects dirty worktree and untracked files", async () => {
    const dir = await makeTempRepo();
    try {
      fs.writeFileSync(path.join(dir, "new.txt"), "untracked", "utf-8");
      fs.appendFileSync(path.join(dir, "README.md"), "more\n", "utf-8");
      const s = await snapshotGit(dir);
      assert.equal(s.dirty, true);
      assert.ok(s.untracked.includes("new.txt"));
    } finally {
      cleanup(dir);
    }
  });
  it("handles detached HEAD", async () => {
    const dir = await makeTempRepo();
    try {
      const head = (await git(dir, "rev-parse", "HEAD")).stdout.trim();
      await git(dir, "checkout", "--detach", "HEAD");
      const s = await snapshotGit(dir);
      assert.equal(s.detached, true);
      assert.equal(s.branch, null);
      assert.equal(s.headSha, head);
    } finally {
      cleanup(dir);
    }
  });
  it("handles non-repos and missing dirs", async () => {
    const dir = makeTempDir();
    try {
      const s = await snapshotGit(dir);
      assert.equal(s.isRepo, false);
      assert.equal(s.repoRoot, null);
      const missing = await snapshotGit(path.join(dir, "nope"));
      assert.equal(missing.isRepo, false);
    } finally {
      cleanup(dir);
    }
  });
  it("tracks ahead/behind against a local bare remote", async () => {
    const dir = await makeTempRepo();
    const remote = makeTempDir();
    try {
      await git(remote, "init", "--bare");
      await git(dir, "remote", "add", "origin", remote);
      await git(dir, "push", "-u", "origin", "main");
      fs.writeFileSync(path.join(dir, "local.txt"), "x", "utf-8");
      await git(dir, "add", ".");
      await git(dir, "commit", "-m", "local ahead");
      const s = await snapshotGit(dir);
      assert.equal(s.ahead, 1);
      assert.equal(s.behind, 0);
      assert.equal(s.upstream, "origin/main");
      assert.ok(s.remoteSha);
    } finally {
      cleanup(dir);
      cleanup(remote);
    }
  });
  it("readAtRef reads the trusted baseline, null when missing", async () => {
    const dir = await makeTempRepo({ "AGENTS.md": "rules\n" });
    try {
      const sha = (await git(dir, "rev-parse", "HEAD")).stdout.trim();
      assert.equal(await readAtRef(dir, sha, "AGENTS.md"), "rules\n");
      assert.equal(await readAtRef(dir, sha, "NOPE.md"), null);
      assert.equal(
        await readAtRef(dir, "deadbee".padEnd(40, "0"), "AGENTS.md"),
        null,
      );
    } finally {
      cleanup(dir);
    }
  });
  it("changedPolicyFiles flags AGENTS.md changes on the branch", async () => {
    const dir = await makeTempRepo({ "AGENTS.md": "v1\n", "code.ts": "1\n" });
    try {
      const base = (await git(dir, "rev-parse", "HEAD")).stdout.trim();
      await git(dir, "checkout", "-b", "feature");
      fs.writeFileSync(
        path.join(dir, "AGENTS.md"),
        "QA no longer needs tests\n",
        "utf-8",
      );
      await git(dir, "add", ".");
      await git(dir, "commit", "-m", "weaken rules");
      const head = (await git(dir, "rev-parse", "HEAD")).stdout.trim();
      const changed = await changedPolicyFiles(dir, base, head);
      assert.ok(changed.includes("AGENTS.md"));
      const d = await boundedDiff(dir, base, head, 100);
      assert.ok(d.files.includes("AGENTS.md"));
      assert.equal(d.truncated, true);
    } finally {
      cleanup(dir);
    }
  });
});

describe("describeWorktree", () => {
  it("describes missing/existing dirs", () => {
    assert.equal(describeWorktree("/definitely/not/here-12345").exists, false);
    const dir = makeTempDir();
    try {
      const d = describeWorktree(dir);
      assert.equal(d.exists, true);
      assert.equal(d.isRepo, false);
    } finally {
      cleanup(dir);
    }
  });
});
