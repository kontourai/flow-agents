import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { codexGovernanceCommand, installCodexGovernanceHook } from "../../build/src/cli/codex-governance-hook.js";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixtureVeritas(root, response = { hookSpecificOutput: { hookEventName: "PreToolUse" } }) {
  const packageRoot = path.join(root, "node_modules", "@kontourai", "veritas");
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@kontourai/veritas", bin: { veritas: "bin/veritas.mjs" } }));
  fs.writeFileSync(path.join(packageRoot, "bin", "veritas.mjs"), [
    'import fs from "node:fs";',
    'const input = fs.readFileSync(0, "utf8");',
    'if (process.env.FLOW_HOOK_CAPTURE) fs.writeFileSync(process.env.FLOW_HOOK_CAPTURE, input);',
    `process.stdout.write(${JSON.stringify(JSON.stringify(response) + "\n")});`,
  ].join("\n"));
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
  fixtureVeritas(root);
  return root;
}

test("Codex user hook follows Git worktrees, stays quiet elsewhere, and carries a Conduit receipt", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "flow-codex-governance-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = repository(parent, "station");
  const worktree = path.join(parent, "station-worktree");
  git(root, "worktree", "add", "-qb", "test-worktree", worktree);
  fixtureVeritas(worktree);
  const other = repository(parent, "other");
  const home = path.join(parent, "codex-home");
  fs.mkdirSync(home);
  const capture = path.join(parent, "capture.json");
  process.env.FLOW_HOOK_CAPTURE = capture;
  t.after(() => { delete process.env.FLOW_HOOK_CAPTURE; });
  fs.writeFileSync(path.join(home, "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [
    { matcher: "Bash", hooks: [
      { type: "command", command: "existing-hook" },
      { type: "command", command: codexGovernanceCommand(root), statusMessage: "Flow Agents: Veritas guidance for this repository" },
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
  assert.match(groups[1].hooks[0].commandWindows, /^node -e "eval\(Buffer\.from\('/);
  const again = await installCodexGovernanceHook(root, home);
  assert.deepEqual(fs.readFileSync(path.join(home, "hooks.json")), bytes);
  assert.equal(again.installed[0].digest, receipt.installed[0].digest);
  const cli = spawnSync(process.execPath, ["build/src/cli.js", "codex-governance-hook", "install", root], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, CODEX_HOME: home },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).receipt.installed[0].digest, receipt.installed[0].digest);
  fs.unlinkSync(capture);
  const invoke = (hook, cwd) => spawnSync(process.platform === "win32" ? "cmd.exe" : "sh",
    process.platform === "win32" ? ["/d", "/s", "/c", hook.commandWindows] : ["-c", hook.command], {
    cwd,
    input: JSON.stringify({ cwd, hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { patch: "test" } }),
    encoding: "utf8",
    env: { ...process.env, FLOW_HOOK_CAPTURE: capture },
  });
  const matched = invoke(groups[1].hooks[0], worktree);
  assert.equal(matched.status, 0, matched.stderr);
  assert.match(matched.stdout, /hookSpecificOutput/);
  assert.equal(JSON.parse(fs.readFileSync(capture, "utf8")).cwd, worktree);
  fs.unlinkSync(capture);
  if (process.platform !== "win32") {
    const windowsForm = spawnSync("sh", ["-c", groups[1].hooks[0].commandWindows], {
      cwd: worktree,
      input: JSON.stringify({ cwd: worktree, tool_name: "apply_patch", tool_input: { command: "test" } }),
      encoding: "utf8",
      env: { ...process.env, FLOW_HOOK_CAPTURE: capture },
    });
    assert.equal(windowsForm.status, 0, windowsForm.stderr);
    assert.match(windowsForm.stdout, /hookSpecificOutput/);
    fs.unlinkSync(capture);
  }
  const unmatched = invoke(groups[1].hooks[0], other);
  assert.equal(unmatched.status, 0, unmatched.stderr);
  assert.equal(unmatched.stdout, "");
  assert.equal(fs.existsSync(capture), false);

  await installCodexGovernanceHook(other, home);
  const both = JSON.parse(fs.readFileSync(path.join(home, "hooks.json"), "utf8")).hooks.PreToolUse;
  assert.equal(both.length, 3, "installing another repository must retain Station's handler and the user's hook");
  assert.equal(both[1].hooks[0].command, command);
  assert.notEqual(both[1].hooks[0].statusMessage, both[2].hooks[0].statusMessage);
  fs.unlinkSync(capture);
  const otherCommandInStation = invoke(both[2].hooks[0], worktree);
  assert.equal(otherCommandInStation.status, 0);
  assert.equal(otherCommandInStation.stdout, "");
  assert.equal(fs.existsSync(capture), false);
});

test("installer refuses a Veritas hook whose allow response current Codex rejects", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "flow-codex-old-veritas-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = repository(parent, "station");
  const home = path.join(parent, "codex-home");
  fixtureVeritas(root, { decision: "approve" });
  await assert.rejects(() => installCodexGovernanceHook(root, home), /fields current Codex rejects/);
  assert.equal(fs.existsSync(path.join(home, "hooks.json")), false);
});

test("same status label does not authorize removal of an unrelated user handler", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "flow-codex-marker-collision-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = repository(parent, "station");
  const home = path.join(parent, "codex-home");
  await installCodexGovernanceHook(root, home);
  const target = path.join(home, "hooks.json");
  const config = JSON.parse(fs.readFileSync(target, "utf8"));
  const managed = config.hooks.PreToolUse[0].hooks[0];
  config.hooks.PreToolUse[0].hooks.unshift({ type: "command", command: "echo user-owned", statusMessage: managed.statusMessage });
  fs.writeFileSync(target, JSON.stringify(config));

  await installCodexGovernanceHook(root, home);
  const after = JSON.parse(fs.readFileSync(target, "utf8"));
  const commands = after.hooks.PreToolUse.flatMap((group) => group.hooks.map((handler) => handler.command));
  assert.deepEqual(commands, ["echo user-owned", managed.command]);
});
