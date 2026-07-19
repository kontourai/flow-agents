import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveTrustedLocalGitCommit } from "../../build/src/lib/trusted-git.js";

const systemGit = process.platform === "win32" ? "git" : "/usr/bin/git";

function initializeRepository(root, content) {
  fs.mkdirSync(root, { recursive: true });
  execFileSync(systemGit, ["init", "-q", "-b", "main", root]);
  fs.writeFileSync(path.join(root, "README.md"), content);
  execFileSync(systemGit, ["-C", root, "add", "README.md"]);
  execFileSync(systemGit, ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "fixture"]);
  return execFileSync(systemGit, ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim().toLowerCase();
}

test("trusted Git resolution ignores ambient repository and configuration control variables", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-trusted-git-"));
  const target = path.join(fixture, "target");
  const foreign = path.join(fixture, "foreign");
  const targetSha = initializeRepository(target, "target\n");
  const foreignSha = initializeRepository(foreign, "foreign\n");
  assert.notEqual(targetSha, foreignSha);
  const prior = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GIT_")));
  try {
    process.env.GIT_DIR = path.join(foreign, ".git");
    process.env.GIT_WORK_TREE = foreign;
    process.env.GIT_CONFIG_GLOBAL = path.join(fixture, "attacker-config");
    assert.equal(resolveTrustedLocalGitCommit(target, "main"), targetSha);
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
    Object.assign(process.env, prior);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
