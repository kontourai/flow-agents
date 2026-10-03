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
  const priorPath = process.env.PATH;
  try {
    const bin = path.join(fixture, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
    process.env.PATH = bin;
    process.env.GIT_DIR = path.join(foreign, ".git");
    process.env.GIT_WORK_TREE = foreign;
    process.env.Git_Common_Dir = path.join(foreign, ".git");
    process.env.GIT_CONFIG_GLOBAL = path.join(fixture, "attacker-config");
    assert.equal(resolveTrustedLocalGitCommit(target, "main"), targetSha);
  } finally {
    for (const key of Object.keys(process.env)) if (key.toUpperCase().startsWith("GIT_")) delete process.env[key];
    Object.assign(process.env, prior);
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("trusted Git suppresses repository diff drivers, text conversion and commit hooks", () => {
  if (process.platform === "win32") return;
  const fixture = makeFixtureDir("flow-agents-trusted-git-execution-");
  try {
    initializeRepository(fixture, "fixture\n");
    const marker = path.join(fixture, "repository-command-ran");
    const command = path.join(fixture, "repository-command.sh");
    fs.writeFileSync(command, `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\n`);
    fs.chmodSync(command, 0o755);
    execFileSync(systemGit, ["-C", fixture, "config", "diff.external", command]);
    execFileSync(systemGit, ["-C", fixture, "config", "diff.fixture.textconv", command]);
    fs.writeFileSync(path.join(fixture, ".gitattributes"), "README.md diff=fixture\n");
    fs.writeFileSync(path.join(fixture, "README.md"), "changed\n");
    assert.match(String(execTrustedGitSync(fixture, ["diff", "HEAD"])), /changed/);
    assert.equal(fs.existsSync(marker), false);
    for (const option of ["--ext-diff", "--textconv"]) {
      assert.throws(() => execTrustedGitSync(fixture, ["diff", option, "HEAD"]), /refuses external diff/);
    }
    fs.copyFileSync(command, path.join(fixture, ".git", "hooks", "pre-commit"));
    execTrustedGitSync(fixture, ["add", "README.md"]);
    execTrustedGitSync(fixture, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "trusted commit"]);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("trusted Git rejects an executable metadata change after execution even when prior identity fields match", () => {
  if (process.platform === "win32") return;
  const fixture = makeFixtureDir("flow-agents-trusted-git-identity-");
  try {
    initializeRepository(fixture, "fixture\n");
    // Kernel metadata observation changes after the real Git process. Keep this
    // fault in an isolated process; no product injection/export or system write.
    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { execTrustedGitSync } from ${JSON.stringify(new URL("../../build/src/lib/trusted-git.js", import.meta.url).href)};
      const original = fs.statSync;
      const git = fs.realpathSync('/usr/bin/git');
      let reads = 0;
      fs.statSync = (file, ...args) => {
        const stat = original(file, ...args);
        if (file === git && ++reads === 3) stat.ctimeMs += 1;
        return stat;
      };
      syncBuiltinESMExports();
      assert.throws(() => execTrustedGitSync(${JSON.stringify(fixture)}, ['rev-parse', 'HEAD']), /changed during operation/);
    `;
    execFileSync(process.execPath, ["--input-type=module", "-e", script]);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("trusted Git refuses uncertain namespace identity and write-access observations", () => {
  if (process.platform === "win32") return;
  const fixture = makeFixtureDir("flow-agents-trusted-git-observations-");
  initializeRepository(fixture, "fixture\n");
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { execTrustedGitSync } from ${JSON.stringify(new URL("../../build/src/lib/trusted-git.js", import.meta.url).href)};
    import { inspectEffectiveFlowAgentsConfig } from ${JSON.stringify(new URL("../../build/src/lib/effective-flow-agents-config.js", import.meta.url).href)};
    const read = fs.readFileSync, lstat = fs.lstatSync;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.getuid = () => 1002; process.getgid = () => 1004;
    let observation;
    process.geteuid = () => observation.euid ?? 1002;
    process.getegid = () => observation.egid ?? 1004;
    fs.readFileSync = (file, ...args) => file === '/proc/self/uid_map' ? observation.map
      : file === '/proc/sys/kernel/overflowuid' ? observation.overflow ?? '65534' : read(file, ...args);
    fs.lstatSync = (file, ...args) => {
      const stat = lstat(file, ...args);
      stat.uid = 65534;
      return stat;
    };
    fs.accessSync = () => {
      if (observation.access === 'allowed') return;
      throw Object.assign(new Error('private filesystem diagnostic must not escape'), { code: observation.access ?? 'EACCES' });
    };
    syncBuiltinESMExports();
    const cases = [
      {map:'0 0 4294967295', reason:/path ownership or permissions/},
      {map:'', reason:/UID mapping/},
      {map:'1002 0 nope', reason:/UID mapping/},
      {map:'1002 0 1\\n1003 1 1', reason:/UID mapping/},
      {map:'1002 0 2', reason:/caller mapping/},
      {map:'1003 0 1', reason:/caller mapping/},
      {map:'1002 4294967295 1', reason:/caller mapping/},
      {map:'1002 0 1', euid:0, reason:/caller mapping/},
      {map:'1002 0 1', egid:0, reason:/caller mapping/},
      {map:'1002 0 1', overflow:'1002', reason:/overflow UID is mapped/},
      {map:'1002 0 1', overflow:'invalid', reason:/invalid.*overflow UID/},
      {map:'1002 0 1', access:'allowed', reason:/writable by the caller/},
      {map:'1002 0 1', access:'EIO', reason:/EIO/},
      {map:'1002 0 1', access:'ENOENT', reason:/ENOENT/},
    ];
    for (observation of cases) {
      assert.throws(() => execTrustedGitSync(process.cwd(), ['--version']), observation.reason);
      const report = inspectEffectiveFlowAgentsConfig(${JSON.stringify(fixture)});
      assert.equal(report.fail_closed, true);
      assert.equal(report.core.state, 'invalid');
      const diagnostic = report.core.diagnostics.join('\\n');
      assert.match(diagnostic, observation.reason);
      assert.doesNotMatch(diagnostic, /private filesystem diagnostic/);
      assert.ok(diagnostic.length < 1024);
    }
  `;
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", script]);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("trusted Git rejects an unprotected lookup symlink even with a protected resolved executable", () => {
  if (process.platform === "win32") return;
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    import { execTrustedGitSync } from ${JSON.stringify(new URL("../../build/src/lib/trusted-git.js", import.meta.url).href)};
    const lstat = fs.lstatSync;
    fs.lstatSync = (file, ...args) => {
      const stat = lstat(file, ...args);
      if (path.basename(String(file)) === 'git') {
        stat.uid = 1;
        stat.isSymbolicLink = () => true;
      }
      return stat;
    };
    syncBuiltinESMExports();
    assert.throws(() => execTrustedGitSync(process.cwd(), ['--version']), /path ownership or permissions/);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script]);
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
