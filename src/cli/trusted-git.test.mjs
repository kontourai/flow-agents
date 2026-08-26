import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { execTrustedGitSync, isExactLowercaseCommitSha, readTrustedGitBlobSync, resolveTrustedLocalGitCommit } from "../../build/src/lib/trusted-git.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

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
  const fixture = makeFixtureDir("flow-agents-trusted-git-");
  const target = path.join(fixture, "target");
  const foreign = path.join(fixture, "foreign");
  const targetSha = initializeRepository(target, "target\n");
  const foreignSha = initializeRepository(foreign, "foreign\n");
  assert.notEqual(targetSha, foreignSha);
  const prior = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GIT_")));
  try {
    process.env.GIT_DIR = path.join(foreign, ".git");
    process.env.GIT_WORK_TREE = foreign;
    process.env.Git_Common_Dir = path.join(foreign, ".git");
    process.env.GIT_CONFIG_GLOBAL = path.join(fixture, "attacker-config");
    assert.equal(resolveTrustedLocalGitCommit(target, "main"), targetSha);
  } finally {
    for (const key of Object.keys(process.env)) if (key.toUpperCase().startsWith("GIT_")) delete process.env[key];
    Object.assign(process.env, prior);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("trusted immutable blob reads ignore replacement objects and ambient Git redirection", () => {
  const fixture = makeFixtureDir("flow-agents-trusted-blob-");
  const target = path.join(fixture, "target");
  const foreign = path.join(fixture, "foreign");
  try {
    const targetSha = initializeRepository(target, "committed policy\n");
    initializeRepository(foreign, "foreign\n");
    const originalBlob = execFileSync(systemGit, ["-C", target, "rev-parse", "HEAD:README.md"], { encoding: "utf8" }).trim();
    const replacement = execFileSync(systemGit, ["-C", target, "hash-object", "-w", "--stdin"], { input: "hostile replacement\n", encoding: "utf8" }).trim();
    execFileSync(systemGit, ["-C", target, "replace", originalBlob, replacement]);
    const prior = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(foreign, ".git");
    try {
      assert.equal(readTrustedGitBlobSync(target, targetSha, "README.md").toString("utf8"), "committed policy\n");
    } finally {
      if (prior === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prior;
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("trusted commit call surfaces reject non-fixed-width commit identifiers", () => {
  const fixture = makeFixtureDir("flow-agents-trusted-sha-width-");
  try {
    initializeRepository(fixture, "fixture\n");
    for (const length of [41, 63]) {
      const malformed = "a".repeat(length);
      assert.equal(isExactLowercaseCommitSha(malformed), false);
      assert.throws(() => readTrustedGitBlobSync(fixture, malformed, "README.md"), /unsafe immutable Git blob reference/);
      assert.throws(() => resolveTrustedLocalGitCommit(fixture, malformed), /could not resolve ref to an immutable local commit/);
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("trusted Git never launches a repository-local fsmonitor command", () => {
  if (process.platform === "win32") return;
  const fixture = makeFixtureDir("flow-agents-trusted-git-fsmonitor-");
  try {
    initializeRepository(fixture, "fixture\n");
    const marker = path.join(fixture, "fsmonitor-ran");
    const monitor = path.join(fixture, "fsmonitor.sh");
    fs.writeFileSync(monitor, `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\n`);
    fs.chmodSync(monitor, 0o755);
    execFileSync(systemGit, ["-C", fixture, "config", "core.fsmonitor", monitor]);

    execTrustedGitSync(fixture, ["status", "--porcelain=v1"]);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
