## What

On stock Windows, `bash` resolves to the WSL2 shim — a different OS with no Windows `node` on PATH and no view of `C:\` paths — so every emitted `bash -lc` hook wrapper exited 127 and the policy layer silently never fired on the platform Station already ships. Root cause probed on a physical Windows host; see the internal Windows-support tracking issue and #1098.

The only thing the shell wrapper did was resolve `$root`. This PR takes the shell out of the hook path:

- **Claude Code**: exec-form hooks — `command: "node"` + `args` vector; Claude Code substitutes `${CLAUDE_PROJECT_DIR}` into each element and spawns directly, no shell on any platform (documented contract; requires Claude Code >= 2.1.139, released 2026-05-11). `statusLine` stays shell-form (no exec form exists) but drops `bash -lc` for a plain `node` string.
- **Codex**: a shell-neutral `node -e` trampoline that ports the CODEX_HOME → git toplevel → cwd → `~/.codex` search to JS and `require()`s the adapter in-process. The string is restricted to characters that behave identically under sh, Git Bash, PowerShell, and cmd.
- **Env defaulting** (`FLOW_AGENTS_GOAL_FIT_MODE=block` for shipped L2 runtimes) moves from shell prefix to `--env-default=KEY=VALUE` adapter args — same operator-override-wins semantics, proven by unit tests and a clean-env end-to-end probe.
- **`init --global`** rewrites exec-form args elements to absolute paths (the same job it did for the old shell strings).
- **New `windows-hook-smoke` CI lane** (windows-latest, hard-failing): asserts no undeclared bash in any emitted hook, exec-form hooks fire when spawned per the documented contract, config-protection actually DENIES a gate-tampering payload (execution proof — fail-open means success JSON alone proves nothing), and the codex trampoline fires through cmd.exe and PowerShell.

## Evidence

- **Real Windows host (desktop-win, stock-ish Win11 + WSL2 bash shim)**: full smoke green — exec-form policy + telemetry + Stop hooks fire; deny control refuses tampering; trampoline works under real cmd.exe and PowerShell. The trampoline was also run under real `cmd /c` directly (bypassing the harness) — hook JSON + exit 0.
- **Local (macOS, POSIX sh)**: smoke green; all three codex resolution paths (CODEX_HOME, ~/.codex fallback, graceful-skip) exercised via `sh -c`, not bash.
- **Fault injection** (each caught, then restored green by rebuild): bash -lc reintroduced into an entry; script path broken at finder level; script path broken at exec level; missing policy script against the deny control (the false-green independent review found).
- **Suites**: `test:unit` 1348/0 fail; `eval:static` fully green on a clean run; `test_codex_hook_resolution`, `test_install_merge`, `test_bundle_lifecycle` green. `test_bundle_install` has 3 remaining failures that reproduce **identically on clean origin/main** (pre-existing: G3 summary block ×2, packed-npm Builder workflow contract).
- **Independent review, round 1** (Codex, report-only, 2026-07-29): no HIGH; both MEDs fixed (`test_bundle_install.sh` command-only consumers; smoke fail-open blind spot), both LOWs fixed (event-wide bash exception narrowed + args-aware scan; spec checklist wording). Fixes landed in `d19669e`.
- **Independent review, round 2** (report-only, on this merged head): confirmed all six sites converted with no seventh and no `shell: true` in `src/` or `scripts/`; confirmed the guard's rejection path really executes (`windows-hook-smoke.mjs:180` is `process.exit(1)`, not `process.exitCode`). It also **disproved a claim this PR previously made**: the declared-bash exception keys on the entry name AND the telemetry.sh path, but only the *name* factor has teeth — the emitted command mentions `telemetry.sh` six times, so retargeting only the final invocation leaves both guards green. The guard checks that the command *mentions* telemetry.sh, not that telemetry.sh *runs* (**#1380**). Filed not fixed: **#1381** (codex policy hooks have no execution proof — the codex analogue of the Claude fix already made as check 2b) and **#1382** (`stop-goal-fit.js:1417/:1428` still spawn `bash -lc` with no win32 branch, inside the goal-fit gate's own recheck).
- **What the `windows-latest` lane does NOT prove**: that image ships Git for Windows with `bash` on PATH and **no WSL distribution**, so there `bash` is Git Bash — a working POSIX shell that can see Windows `node`. The lane genuinely proves exec-form hooks spawn and execute under Windows node, that the deny control refuses tampering, and that the trampoline survives cmd.exe and PowerShell. It **cannot reproduce #1098's WSL2 case**; that evidence is the physical-host probe above.

## Disclosed gaps

- Telemetry **record emission** still shells to bash internally (`scripts/telemetry/telemetry.sh`) and fails open on Windows — hooks fire and return valid JSON, records are lost. Needs a node port of the telemetry pipeline (follow-up). The codex PermissionRequest telemetry entry is the one remaining `bash -lc` site for the same reason, declared as the single exception in the smoke.
- No runtime version detection for Claude Code < 2.1.139: accepted with rationale — older clients fail per-hook with a visible error (not silently), Claude Code self-updates, and the floor is documented in the spec, install docs, and emitter comments.
- statusLine on a Windows host with no Git Bash (PowerShell shell-form): does not display — cosmetic surface, documented in the emitter.

Closes #1098.

https://claude.ai/code/session_01PQzSKLi5TZ8tQJvojD9LZR
