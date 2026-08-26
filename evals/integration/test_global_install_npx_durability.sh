#!/usr/bin/env bash
# test_global_install_npx_durability.sh — kontourai/flow-agents#945
#
# `npx @kontourai/flow-agents init --global --runtime claude-code` must keep working
# indefinitely after the invoking npx's package cache entry is evicted, because the hook
# and statusline runtime is vendored into a durable, destination-owned location
# (<dest>/.flow-agents/runtime/) instead of being pinned to the ephemeral npx-cache/
# source-checkout path the installer happened to run from.
#
# Covers:
#   AC1: fresh npx-style global install keeps hooks+statusline working after the
#        simulated npx-cache directory is deleted.
#   AC5: a simulated vendoring failure (poisoned destination) exits non-zero with an
#        actionable message and leaves settings.json byte-identical to its pre-run content.
#   SEC: a destination path containing shell metacharacters must not inject shell into the
#        persisted hook commands, and must still resolve (a real home dir may contain an
#        apostrophe, e.g. /Users/o'brien) -- review finding, kontourai/flow-agents#945.
#
# AC2 (zero _npx occurrences), AC3 (idempotent re-run), and AC4 (version stamp) are
# covered by Scenario 5 in evals/integration/test_install_merge.sh, which already
# exercises the --global merge path end-to-end.
#
# Harness note (disclosed, see plan §5 Risk 3): the "simulated npx cache" below copies
# this checkout's pre-built build/+dist/+scripts/ etc. into a throwaway directory rather
# than exercising the real npx binary (real npx execution in a test harness is
# unreliable/slow and needs network or a local registry). This proves the code path is
# durable against "the directory this process launched from disappears" -- the actual
# mechanism of the bug -- but does not prove npx's specific cache-naming/eviction-timing
# behavior beyond that.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMPDIR_EVAL="$(mktemp -d /tmp/global-install-durability.XXXXXX)"
pass=0
fail=0

cleanup() {
  # Never let cleanup decide the verdict: this runs as the last EXIT-trap command,
  # so a non-zero rm would clobber the script's real exit code.
  rm -rf "$TMPDIR_EVAL" 2>/dev/null || true
}
trap cleanup EXIT

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Global Claude-Code Install: npx-cache Durability + Vendoring Failure (#945) ==="
echo ""

# Ensure bundles are built (source-of-truth checkout; the simulated npx cache below is a
# copy of this checkout's build output).
echo "--- Build ---"
if (cd "$ROOT_DIR" && npm run build:bundles >/dev/null 2>&1); then
  _pass "bundle build completed"
else
  _fail "bundle build failed"
  echo "Results: 0/$((pass + fail + 1)) passed, $((fail + 1)) failed"
  exit 1
fi
echo ""

# ─── AC1: fresh npx-style install survives cache eviction ────────────────────
echo "--- AC1: fresh npx-style global install keeps hooks+statusline working after cache eviction ---"

# Simulate the npx package cache: a self-contained copy of the built package's minimal
# runtime surface -- NOT a full node_modules closure (see plan §1.2's dependency-free-CJS
# verification: the shipped hook path never live-requires node_modules; it only needs
# build/, scripts/, and their siblings).
NPX_CACHE_SIM="$TMPDIR_EVAL/npx-cache-sim"
mkdir -p "$NPX_CACHE_SIM"
for entry in build dist scripts packaging schemas kits context package.json; do
  cp -R "$ROOT_DIR/$entry" "$NPX_CACHE_SIM/$entry"
done
# The CLI's own compiled ESM module graph (build/src/cli.js) statically resolves real
# npm dependencies (e.g. @kontourai/flow) at load time -- real npx installs those
# alongside the package before running its bin, so they are genuinely present during
# the initial install. Symlink (not copy) this checkout's node_modules for that step
# only: `rm -rf "$NPX_CACHE_SIM"` below unlinks the symlink without touching the real
# node_modules, and every command exercised AFTER eviction is a vendored, dependency-
# free CJS script invoked directly (never through this symlink) -- see plan §1.2.
ln -s "$ROOT_DIR/node_modules" "$NPX_CACHE_SIM/node_modules"

GLOBAL_DEST="$TMPDIR_EVAL/claude-global"
AC1_INSTALL_OUT="$TMPDIR_EVAL/ac1-install.out"
if FLOW_AGENTS_USER_CLAUDE_SETTINGS="$GLOBAL_DEST/settings.json" \
  node "$NPX_CACHE_SIM/build/src/cli.js" init --runtime claude-code --global --yes >"$AC1_INSTALL_OUT" 2>&1
then
  _pass "AC1: initial global install from the simulated npx cache succeeded"
else
  _fail "AC1: initial global install from the simulated npx cache failed"
  cat "$AC1_INSTALL_OUT"
fi

# Simulate npx cache eviction: the directory this process launched from disappears.
rm -rf "$NPX_CACHE_SIM"

GLOBAL_SETTINGS_JSON="$GLOBAL_DEST/settings.json"
if [[ -f "$GLOBAL_SETTINGS_JSON" ]] && node - "$GLOBAL_SETTINGS_JSON" << 'NODE'
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const settingsPath = process.argv[2];
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));

// Post-#1101 hooks are exec form (`command: "node"` + an `args` argv vector spawned with
// no shell); only statusLine is still a shell string. Matching on `h.command` alone would
// match the bare string "node" for every hook and prove nothing about the vendored path,
// so exec-form entries are identified by their args and spawned as argv.
const targets = [];
for (const [event, groups] of Object.entries(settings.hooks || {})) {
  for (const group of groups || []) {
    for (const h of (group.hooks || [])) {
      const args = Array.isArray(h.args) ? h.args.map(String) : [];
      const haystack = [String(h.command || ""), ...args].join(" ");
      if (haystack.includes("claude-hook-adapter.js") || haystack.includes("claude-telemetry-hook.js")) {
        targets.push({ label: `${event} hook (${h.statusMessage || "unlabeled"})`, command: h.command, args, event, isStatusLine: false });
      }
    }
  }
}
const execFormCount = targets.filter((t) => t.args.length > 0).length;
if (execFormCount === 0) throw new Error("no exec-form FA hook entries found in settings.json to exercise");
if (settings.statusLine && typeof settings.statusLine.command === "string") {
  targets.push({ label: "statusLine", command: settings.statusLine.command, args: [], event: "SessionStart", isStatusLine: true });
} else {
  throw new Error("no statusLine command found in settings.json to exercise");
}

const env = { ...process.env };
delete env.CLAUDE_PROJECT_DIR; // must not depend on this -- that is the entire point of #945
// Telemetry otherwise spawns a detached writer that can write back into this eval's temp tree
// after the cleanup trap has run, leaking directories across runs.
env.FLOW_AGENTS_CLAUDE_TELEMETRY_FOREGROUND = "true";
const failures = [];
for (const target of targets) {
  const payload = JSON.stringify({ hook_event_name: target.event, cwd: process.cwd() });
  // Exec form spawns argv directly (no shell); statusLine goes through a shell, as the host does.
  const result = target.args.length > 0
    ? spawnSync(target.command, target.args, { input: payload, env, encoding: "utf8", timeout: 30000 })
    : spawnSync(target.command, { input: payload, env, shell: true, encoding: "utf8", timeout: 30000 });
  const stderr = String(result.stderr || "");
  const stdout = String(result.stdout || "");
  if (result.status !== 0) {
    failures.push(`${target.label}: exited ${result.status} (signal ${result.signal || "none"}); stderr: ${stderr.slice(0, 400)}`);
    continue;
  }
  if (/Cannot find module|MODULE_NOT_FOUND/.test(stderr)) {
    failures.push(`${target.label}: stderr references a missing module (durability regression): ${stderr.slice(0, 400)}`);
  }
  if (target.isStatusLine && !stdout.trim()) {
    failures.push(`${target.label}: produced empty stdout`);
  }
}
if (failures.length > 0) throw new Error(`post-eviction hook/statusline invocation failures:\n${failures.join("\n")}`);
console.log(`ok: exercised ${targets.length} command(s) post-eviction`);
NODE
then
  _pass "AC1: hook + statusLine commands still resolve and run after simulated npx-cache eviction"
else
  _fail "AC1: hook + statusLine commands failed to resolve after simulated npx-cache eviction (durability regression)"
fi

echo ""

# ─── AC5: simulated vendoring failure ─────────────────────────────────────────
echo "--- AC5: simulated vendoring failure exits non-zero, actionable message, settings.json unchanged ---"

POISON_DEST="$TMPDIR_EVAL/claude-global-poisoned"
mkdir -p "$POISON_DEST"
cat > "$POISON_DEST/settings.json" << 'JSON'
{"sentinel": "must-not-change"}
JSON
PRE_HASH=$(shasum -a 256 "$POISON_DEST/settings.json" | awk '{print $1}')

# Force a deterministic, portable vendoring failure: pre-create .flow-agents as a plain
# FILE so install-owned-files.js's ensureSafeParent fails cleanly regardless of whether
# the test runs as root (a chmod-0000 failure injection is not reliable under root/CI --
# see plan §5 Risk 4).
touch "$POISON_DEST/.flow-agents"

POISON_STDERR="$TMPDIR_EVAL/ac5-install.err"
if FLOW_AGENTS_USER_CLAUDE_SETTINGS="$POISON_DEST/settings.json" \
  node "$ROOT_DIR/build/src/cli.js" init --runtime claude-code --global --yes >/dev/null 2>"$POISON_STDERR"
then
  _fail "AC5: init --global unexpectedly exited 0 despite a poisoned .flow-agents destination"
else
  _pass "AC5: init --global exited non-zero when vendoring fails"
fi

if grep -q "could not vendor the claude-code hook runtime" "$POISON_STDERR"; then
  _pass "AC5: stderr contains an actionable, non-empty message"
else
  _fail "AC5: stderr did not contain the expected actionable vendoring-failure message"
  cat "$POISON_STDERR"
fi

# The actionable init.ts-level message must wrap install-owned-files.js's own clean
# fail() line, not a raw multi-line V8 stack trace (plan §5 Risk 4) -- a stack trace has
# "\n    at " frame lines.
#
# Asserted structurally rather than by pinning one literal: install-owned-files.js has
# several fail() sites that can legitimately catch a poisoned .flow-agents first (it
# moved from ensureSafeParent's "destination component is not a directory" to the
# manifest read's "unable to inspect destination entry" when #1231 added an earlier
# manifest lstat). What must hold is that the surfaced text IS one of the installer's
# own `install-owned-files: ` fail() lines AND names the offending path -- if init.ts
# fell back to its bare "failed with exit code N" message, or dumped a stack, neither
# the prefix nor the path would be there.
if grep -q "install-owned-files: " "$POISON_STDERR" \
   && grep -q "claude-global-poisoned/\.flow-agents" "$POISON_STDERR" \
   && ! grep -qE '^\s+at ' "$POISON_STDERR"; then
  _pass "AC5: underlying failure is install-owned-files.js's clean fail() message naming the path, not a raw stack trace"
else
  _fail "AC5: underlying failure message is missing, unattributed, or looks like a raw stack trace"
  cat "$POISON_STDERR"
fi

POST_HASH=$(shasum -a 256 "$POISON_DEST/settings.json" | awk '{print $1}')
if [[ "$PRE_HASH" == "$POST_HASH" ]]; then
  _pass "AC5: settings.json is byte-identical to its pre-run content (not modified by the failed install)"
else
  _fail "AC5: settings.json was modified despite the vendoring failure"
fi


# ---------------------------------------------------------------------------
# SEC: shell-metacharacter destination must not become command injection.
#
# Post-#1101 the claude-code hooks are exec form (`command: "node"` + an `args` argv
# vector, never shell-parsed) and `statusLine` is the only shell-form entry left:
# `node "<root>/scripts/statusline/..."`, with the substituted root inside double quotes.
# An unescaped `$`, backtick or `"` in the destination breaks out of that quoted region
# and injects arbitrary shell that the host would then execute on every session.
# This scenario executes EVERY persisted FA entry (both forms) and asserts the marker
# is never created.
# ---------------------------------------------------------------------------
echo ""
echo "--- SEC: metacharacter destination does not inject shell into hook commands ---"

INJECT_ROOT="$TMPDIR_EVAL/inject"
INJECT_CWD="$INJECT_ROOT/exec-cwd"
INJECT_MARKER="$INJECT_CWD/INJECTED"
mkdir -p "$INJECT_CWD"
# A destination that closes the single quote, runs a command, and reopens it. The payload
# uses a RELATIVE marker name: an absolute path would make mkdir -p (and the installer's own
# recursive mkdir) treat its slashes as separators, building a nested tree instead of the
# single weirdly-named directory this scenario needs -- which in turn left the tree deep
# enough that cleanup failed and clobbered the exit code (flaky false FAIL in a required lane).
INJECT_DEST="$INJECT_ROOT/o'brien; touch INJECTED; echo 'x"
mkdir -p "$INJECT_DEST"

if FLOW_AGENTS_USER_CLAUDE_SETTINGS="$INJECT_DEST/settings.json" \
   node "$ROOT_DIR/build/src/cli.js" init --runtime claude-code --global --yes \
   --dest "$INJECT_DEST" > "$TMPDIR_EVAL/inject-init.log" 2>&1; then
  _pass "SEC: install succeeds with a metacharacter destination"
else
  _fail "SEC: install failed outright for a metacharacter destination"
  tail -5 "$TMPDIR_EVAL/inject-init.log"
fi

# Execute every persisted FA entry the way its host would, and assert BOTH directions:
# nothing injected, and every script path still resolves.
#
# Post-#1101 there are two entry shapes and they must be driven differently, or this
# scenario silently loses its teeth: exec-form hooks carry `command: "node"` plus an
# `args` argv vector (spawned directly, NEVER shell-parsed), so feeding `hook.command`
# to a shell would just run a bare `node` REPL and prove nothing about the substituted
# path. `statusLine` is the only shell-form entry left, and is therefore the only
# injection-relevant one -- it is run through `sh -c` exactly as the host does.
INJECT_RESOLVE_STATUS=0
INJECT_SETTINGS="$INJECT_DEST/settings.json" \
INJECT_CWD="$INJECT_CWD" \
node - > "$TMPDIR_EVAL/inject-run.err" 2>&1 <<'NODE' || INJECT_RESOLVE_STATUS=$?
const fs = require("fs");
const { spawnSync } = require("child_process");

const settings = JSON.parse(fs.readFileSync(process.env.INJECT_SETTINGS, "utf8"));
const cwd = process.env.INJECT_CWD;
const env = { ...process.env, FLOW_AGENTS_CLAUDE_TELEMETRY_FOREGROUND: "true" };
delete env.CLAUDE_PROJECT_DIR;
const payload = JSON.stringify({ hook_event_name: "SessionStart" });

const execForm = [];
for (const groups of Object.values(settings.hooks ?? {})) {
  for (const group of groups ?? []) {
    for (const hook of group.hooks ?? []) {
      if (Array.isArray(hook.args) && hook.args.length > 0) execForm.push(hook);
    }
  }
}
if (execForm.length === 0) throw new Error("no exec-form FA hook entries found to exercise");
const statusLine = settings.statusLine?.command;
if (!statusLine) throw new Error("no statusLine command found to exercise");

const unresolved = [];
// Exec form: spawn directly, no shell. Proves args[0] (the substituted vendored path)
// really resolves for a destination full of shell metacharacters.
for (const hook of execForm) {
  const r = spawnSync(hook.command, hook.args, { input: payload, cwd, env, encoding: "utf8", timeout: 30000 });
  const stderr = String(r.stderr || "");
  if (/Cannot find module|MODULE_NOT_FOUND/.test(stderr)) {
    unresolved.push(`exec-form ${hook.args[0]}: ${stderr.slice(0, 300)}`);
  }
}
// Shell form: run statusLine exactly as the host does. This is the injection surface.
const sl = spawnSync(statusLine, { shell: true, input: payload, cwd, env, encoding: "utf8", timeout: 30000 });
const slErr = String(sl.stderr || "");
if (/Cannot find module|MODULE_NOT_FOUND/.test(slErr)) {
  unresolved.push(`statusLine: ${slErr.slice(0, 300)}`);
}
if (unresolved.length > 0) throw new Error(`escaped destination did not resolve:\n${unresolved.join("\n")}`);
console.log(`ok: exercised ${execForm.length} exec-form entr(ies) + statusLine`);
NODE

if [[ -e "$INJECT_MARKER" ]]; then
  _fail "SEC: INJECTION -- executing the persisted entries ran attacker-supplied shell"
else
  _pass "SEC: executing every persisted FA entry (exec-form hooks + statusLine) ran no injected shell"
fi

# Neutralizing the metacharacters is not enough: the escaped path must still resolve,
# or a legitimate apostrophe home directory would silently break every hook.
if [[ "$INJECT_RESOLVE_STATUS" -eq 0 ]]; then
  _pass "SEC: the escaped destination still resolves and the entries run"
else
  _fail "SEC: escaped destination did not resolve; entries could not load their runtime"
  head -8 "$TMPDIR_EVAL/inject-run.err"
fi

echo ""
echo "==========================="
total=$((pass + fail))
echo "Results: ${pass}/${total} passed, ${fail} failed"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
