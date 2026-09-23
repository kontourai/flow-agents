import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { installCodexGovernanceHook } from "../../build/src/cli/codex-governance-hook.js";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repository(parent, name) {
  const root = path.join(parent, name);
  fs.mkdirSync(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Hook Test");
  git(root, "config", "user.email", "hook@example.invalid");
  fs.mkdirSync(path.join(root, ".veritas"));
  fs.writeFileSync(path.join(root, ".veritas", "repo-map.json"), "{}\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture-governed" }));
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  return root;
}

test("Codex user hook follows Git worktrees, stays quiet elsewhere, and carries a Conduit receipt", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "flow-codex-governance-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = repository(parent, "station");
  const worktree = path.join(parent, "station-worktree");
  git(root, "worktree", "add", "-qb", "test-worktree", worktree);
  const other = repository(parent, "other");
  const home = path.join(parent, "codex-home");
  fs.mkdirSync(home);
  const bin = path.join(parent, "bin");
  fs.mkdirSync(bin);
  const capture = path.join(parent, "capture.json");
  const fakeNpm = path.join(bin, "npm");
  fs.writeFileSync(fakeNpm, '#!/bin/sh\ncat > "$FLOW_HOOK_CAPTURE"\nprintf "{\\"hookSpecificOutput\\":{\\"hookEventName\\":\\"PreToolUse\\"}}\\n"\n');
  fs.chmodSync(fakeNpm, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.FLOW_HOOK_CAPTURE = capture;
  t.after(() => {
    process.env.PATH = previousPath;
    delete process.env.FLOW_HOOK_CAPTURE;
  });
  fs.writeFileSync(path.join(home, "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [
    { matcher: "Bash", hooks: [
      { type: "command", command: "existing-hook" },
      { type: "command", command: "old-managed-hook", statusMessage: "Flow Agents: Veritas guidance for this repository" },
    ] },
  ] } }));

  const receipt = await installCodexGovernanceHook(root, home);
  const bytes = fs.readFileSync(path.join(home, "hooks.json"));
  assert.equal(receipt.hostId, "codex");
  assert.equal(receipt.installed[0].digest, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  const groups = JSON.parse(bytes.toString()).hooks.PreToolUse;
  assert.equal(groups.length, 2);
  assert.equal(groups[0].hooks[0].command, "existing-hook");
  assert.equal(groups[0].hooks.length, 1);
  const command = groups[1].hooks[0].command;
  const again = await installCodexGovernanceHook(root, home);
  assert.deepEqual(fs.readFileSync(path.join(home, "hooks.json")), bytes);
  assert.equal(again.installed[0].digest, receipt.installed[0].digest);
  const cli = spawnSync(process.execPath, ["build/src/cli.js", "codex-governance-hook", "install", root], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, CODEX_HOME: home },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).receipt.installed[0].digest, receipt.installed[0].digest);
  fs.unlinkSync(capture);
  const run = (cwd) => spawnSync("sh", ["-c", command], {
    cwd,
    input: JSON.stringify({ cwd, hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { patch: "test" } }),
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FLOW_HOOK_CAPTURE: capture },
  });
  const matched = run(worktree);
  assert.equal(matched.status, 0, matched.stderr);
  assert.match(matched.stdout, /hookSpecificOutput/);
  assert.equal(JSON.parse(fs.readFileSync(capture, "utf8")).cwd, worktree);
  fs.unlinkSync(capture);
  const unmatched = run(other);
  assert.equal(unmatched.status, 0, unmatched.stderr);
  assert.equal(unmatched.stdout, "");
  assert.equal(fs.existsSync(capture), false);
});

test("installer refuses a Veritas hook whose allow response current Codex rejects", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "flow-codex-old-veritas-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = repository(parent, "station");
  const home = path.join(parent, "codex-home");
  const bin = path.join(parent, "bin");
  fs.mkdirSync(bin);
  const fakeNpm = path.join(bin, "npm");
  fs.writeFileSync(fakeNpm, '#!/bin/sh\ncat >/dev/null\nprintf "{\\"decision\\":\\"approve\\"}\\n"\n');
  fs.chmodSync(fakeNpm, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });
  await assert.rejects(() => installCodexGovernanceHook(root, home), /fields current Codex rejects/);
  assert.equal(fs.existsSync(path.join(home, "hooks.json")), false);
});
