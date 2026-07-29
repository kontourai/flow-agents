#!/usr/bin/env node
/**
 * windows-hook-smoke.mjs — asserts that the hook layer actually FIRES from the
 * generated bundles, on the platform this runs on. Exists for the windows-latest
 * CI lane (ops Windows support / #1098): the emitted hook wrappers used to be
 * `bash -lc …`, which on stock Windows resolves to the WSL2 shim — no Windows
 * `node` on PATH, no view of `C:\` paths — so every hook exited 127 and nothing
 * anywhere noticed. This smoke is the assertion that would have caught that.
 *
 * What it checks, from dist/ (run `npm run build:bundles` first):
 *   1. No emitted hook command routes through bash, except the one declared
 *      exception (codex PermissionRequest telemetry, which invokes the bash
 *      telemetry pipeline itself and is a disclosed Windows gap).
 *   2. Claude Code exec-form hooks fire when spawned per the documented host
 *      contract: `command` spawned directly with `args`, `${CLAUDE_PROJECT_DIR}`
 *      substituted into each element as a plain string, NO shell.
 *   3. The codex `node -e` trampoline command string fires through the shells a
 *      no-Git-Bash Windows host would actually use (cmd.exe and PowerShell), and
 *      through plain POSIX sh elsewhere — never through bash.
 *
 * Green-or-honest: any failure exits non-zero with the command and its output.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = process.env.FLOW_AGENTS_DIST_DIR ? path.resolve(process.env.FLOW_AGENTS_DIST_DIR) : path.join(root, "dist");
const claudeBundle = path.join(dist, "claude-code");
const codexBundle = path.join(dist, "codex");
const isWindows = process.platform === "win32";

let failures = 0;
function pass(msg) {
  console.log(`  ok: ${msg}`);
}
function fail(msg) {
  console.error(`  FAIL: ${msg}`);
  failures += 1;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function hookEntries(hooksObject) {
  return Object.entries(hooksObject).flatMap(([event, groups]) =>
    groups.flatMap((group) => (group.hooks || []).map((hook) => ({ event, hook }))),
  );
}

const claudeSettings = loadJson(path.join(claudeBundle, ".claude", "settings.json"));
const codexHooks = loadJson(path.join(codexBundle, ".codex", "hooks.json"));

// ---------------------------------------------------------------------------
console.log("== 1. no bash in the hook path");
const allEntries = [
  ...hookEntries(claudeSettings.hooks).map((e) => ({ ...e, runtime: "claude-code" })),
  ...hookEntries(codexHooks.hooks).map((e) => ({ ...e, runtime: "codex" })),
];
const DECLARED_BASH_EXCEPTIONS = new Set(["codex:PermissionRequest"]);
for (const { runtime, event, hook } of allEntries) {
  const key = `${runtime}:${event}`;
  const usesBash = /(^|[^a-z])bash($|[^a-z])/.test(String(hook.command));
  if (usesBash && !DECLARED_BASH_EXCEPTIONS.has(key)) {
    fail(`${key} routes through bash: ${String(hook.command).slice(0, 120)}`);
  }
}
if (failures === 0) pass(`no undeclared bash usage across ${allEntries.length} hook entries`);
const statuslineCommand = String(claudeSettings.statusLine?.command || "");
if (/(^|[^a-z])bash($|[^a-z])/.test(statuslineCommand)) fail(`statusLine routes through bash: ${statuslineCommand}`);
else pass("statusLine does not route through bash");

// ---------------------------------------------------------------------------
console.log("== 2. claude exec-form hooks fire (direct spawn, placeholder substituted, no shell)");
function runClaudeExecForm(entry, payload) {
  const args = (entry.hook.args || []).map((a) => String(a).split("${CLAUDE_PROJECT_DIR}").join(claudeBundle));
  return spawnSync(String(entry.hook.command), args, {
    input: JSON.stringify(payload),
    encoding: "utf8",
    cwd: claudeBundle,
    timeout: 30000,
  });
}
const claudeEntries = hookEntries(claudeSettings.hooks);
const policyEntry = claudeEntries.find(
  ({ event, hook }) => event === "PreToolUse" && (hook.args || []).some((a) => String(a).includes("claude-hook-adapter.js")),
);
const telemetryEntry = claudeEntries.find(
  ({ event, hook }) => event === "SessionStart" && (hook.args || []).some((a) => String(a).includes("claude-telemetry-hook.js")),
);
const stopEntry = claudeEntries.find(({ event, hook }) => event === "Stop" && (hook.args || []).some((a) => String(a).startsWith("--env-default=")));

if (!policyEntry) fail("no exec-form PreToolUse policy hook found in claude settings");
else {
  const r = runClaudeExecForm(policyEntry, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo smoke" } });
  if (r.status === 0 && r.stdout.includes('"continue"')) pass("PreToolUse policy hook fired and returned hook JSON");
  else fail(`PreToolUse policy hook rc=${r.status} error=${r.error ?? ""} stdout=${r.stdout} stderr=${r.stderr}`);
}
if (!telemetryEntry) fail("no exec-form SessionStart telemetry hook found in claude settings");
else {
  const r = runClaudeExecForm(telemetryEntry, { hook_event_name: "SessionStart" });
  if (r.status === 0 && r.stdout.includes('"continue"')) pass("SessionStart telemetry hook fired and returned hook JSON (record emission may fail open without bash)");
  else fail(`SessionStart telemetry hook rc=${r.status} error=${r.error ?? ""} stdout=${r.stdout} stderr=${r.stderr}`);
}
if (!stopEntry) fail("no Stop hook carrying --env-default found in claude settings");
else {
  const r = runClaudeExecForm(stopEntry, { hook_event_name: "Stop" });
  if ((r.status === 0 || r.status === 2) && !r.error) pass(`Stop goal-fit hook fired with --env-default (rc=${r.status})`);
  else fail(`Stop hook rc=${r.status} error=${r.error ?? ""} stdout=${r.stdout} stderr=${r.stderr}`);
}

// ---------------------------------------------------------------------------
console.log("== 3. codex trampoline fires through the shells a stock host uses");
const codexEntries = hookEntries(codexHooks.hooks);
const codexPolicyEntry = codexEntries.find(({ event, hook }) => event === "SessionStart" && String(hook.command).includes("codex-hook-adapter.js"));
if (!codexPolicyEntry) {
  fail("no codex SessionStart policy trampoline found in hooks.json");
} else {
  const command = String(codexPolicyEntry.hook.command);
  const payload = JSON.stringify({ hook_event_name: "SessionStart" });
  const env = { ...process.env, CODEX_HOME: codexBundle };
  // cmd.exe needs windowsVerbatimArguments: without it Node re-quotes the
  // command tail (it contains spaces), nesting quotes and corrupting the
  // `node -e "…"` string. Verified against real cmd.exe on a physical Windows
  // host (desktop-win, 2026-07-29): the literal command line runs the hook and
  // exits 0 there; only the naive nested spawn mangles it.
  const shells = isWindows
    ? [
        { label: "cmd.exe", exe: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command], options: { windowsVerbatimArguments: true } },
        { label: "powershell", exe: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", command], options: {} },
      ]
    : [{ label: "sh", exe: "sh", args: ["-c", command], options: {} }];
  for (const shell of shells) {
    const r = spawnSync(shell.exe, shell.args, { input: payload, encoding: "utf8", env, cwd: os.tmpdir(), timeout: 30000, ...shell.options });
    if (r.status === 0 && r.stdout.includes('"continue"')) pass(`codex trampoline fired via ${shell.label}`);
    else fail(`codex trampoline via ${shell.label} rc=${r.status} error=${r.error ?? ""} stdout=${r.stdout} stderr=${r.stderr}`);
  }
}

// ---------------------------------------------------------------------------
console.log("");
if (failures > 0) {
  console.error(`WINDOWS_HOOK_SMOKE_FAILED: ${failures} failure(s)`);
  process.exit(1);
}
console.log("WINDOWS_HOOK_SMOKE_PASSED");
