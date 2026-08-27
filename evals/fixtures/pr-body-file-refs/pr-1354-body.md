Closes #1343, closes #1344, closes #1345.

Three defects in the **project (`--dest`) install path**, found during a live Phase-5 install into a real consumer repo. **#1342 — the install shape itself — is deliberately not in this change** and is split to its own PR; see the correction recorded on that issue, which materially changed what that fix has to be.

## What was wrong, and why each mattered

**#1345 — permissive permission defaults.** The project install wrote `permissions.defaultMode: "auto"` and `skipDangerousModePermissionPrompt: true` into each consumer repo's own `.claude/settings.json`. Root cause was **not** where the issue guessed: `install.sh`'s merge block feeds the bundle's settings to `install-merge.js`, so `init.ts` could not strip them the way `--global` and `dogfood` do.

Fixed by threading a new `--omit-managed-key` through `build-universal-bundles.ts` → `install.sh` → `install-merge.js`, applied to the managed object **before** the merge so `installedValues()` never records the keys as ours. Default **off**; the permissive behaviour survives as a **named opt-in** (`--permissive-workspace`, recorded as `permissive_workspace: true` in the install record) because it is defensible for a dedicated agent workspace and indefensible as a silent default of every install. `uninstall.ts:88`'s owned-value removal is untouched, so existing installs still clean up.

The argument that decided it is durability, not present risk: **project settings take precedence over user settings**, so N repo-level copies would silently override a later decision to tighten the global default — in N places, each invisible until someone opens that repo's settings file.

**#1343 — `CLAUDE.md` written outside the ownership manifest.** Install wrote it, the manifest disclaimed it, and uninstall left it behind while reporting `Preserved — modified or unknown (0)` — a truthful-looking zero that was not zero. This is the mirror of #1238's *removal requires positive provenance*: **creation requires manifest registration.** Fixed as one mechanism rather than a special case — `bundleInstallExcludeRel()` deletes the runtime's own instruction file from the plan's exclude set, mirrored from `BUNDLE_CAPABILITIES.instructionPath` (codex ships none). `install.sh` unchanged.

**#1344 — the Console summary.** The mechanism is worse than the issue stated. `resolveTelemetryConfigFile()` falls back to `~/.flow-agents/telemetry-console.conf`, which **exists on the dev host** with url/token/tenant set — so the summary was reporting *ambient machine-wide resolution* as the install's outcome. Locally true, globally misleading: on a machine without that file the identical command produces a materially different install with no visible difference in the summary.

Fixed by deriving — `tokenSource`/`tenantSource`/`urlSource` provenance on `DoctorReport.console`, `ConsoleStatus` split into four non-collapsed outcomes (`verified` / `unverified-failed` / `unverified-not-attempted` / `not-configured`), and the summary now prints the selected sink as the primary fact, names the resolved config file, and flags when this install did not write it.

## The safety net is the point

`test_init_uninstall.sh` **already had** a `tree_snapshot()` round-trip equality assertion — but every existing use targeted a `$HOME`/global path and **none targeted a project `--dest`**. That is precisely why #1343 survived while the `--global` path stayed correct: a well-built assertion aimed one directory over.

New **Scenario N** applies the same assertion to a project destination, with its two residue filters **bound to the uninstall's own retention declaration** (a separate assertion fails if uninstall stops declaring `.kontourai` as retained), so the filter cannot drift into hiding a real divergence.

## Verification

| Check | Result |
|---|---|
| `npm run build` | `exit=0` |
| `npx tsc -p tsconfig.json --noEmit` | `exit=0` |
| `node --test src/cli/console-connect-options.test.mjs` | 34 pass, 0 fail, `exit=0` |
| `bash evals/integration/test_init_uninstall.sh` | **101/101 passed, 0 failed**, `exit=0` (was 89 scenarios) |
| `npm run eval:static` | `exit=0`, zero failing assertions |

Behaviour proven by a **real end-to-end install into a `git init` scratch repo**, not a fixture — reading the written file: `.claude/settings.json` top-level keys are exactly `["statusLine","hooks"]`, and a grep for either permissive key exits 1.

### Fault injection — two, both caught

Committed clean tree, `git status --short | wc -l` = 0 asserted before each, and the build exited 0 first each time so a red could not be a build error reading as a catch.

**A — reverted the one `bundleInstallExcludeRel` line**, reproducing the *real* pre-fix #1343 defect (stronger than a synthetic mutation, because it is the actual historical failure). Caught with 3 reds:

```
✗ CLAUDE.md is NOT registered in the ownership manifest (#1343)
✗ project round-trip: destination diverged from its pre-install path set
✗ user-modified CLAUDE.md was deleted or not reported as preserved
```

The middle one is the important one — the **general** net fired, which is what makes it catch any future unowned write rather than this one file.

**B — disabled the omit-managed-key loop**, reproducing pre-fix #1345. Caught with exactly **1** red naming the keys, every other assertion staying green — so it discriminates rather than breaking bluntly.

Both restored via `git checkout --`, dirty count back to 0, rebuilt, **101/101 green**.

## NOT VERIFIED

- **No independent report-only review has run on this branch.**
- The implementation lane reported one `eval:static` red (`bundle generation is not reproducible from clean output directories`, ENOENT on a transient probe file the `validate:source` negative-probe test creates and deletes in the same run) and did not re-run it. **It has now been re-run on a recovered host and is green**, so the environmental attribution is confirmed rather than assumed — the red does not reproduce when the host is not starved.

