import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, flagString, flagList } from "../lib/args.js";
import { root } from "../tools/common.js";

/**
 * flow-agents verify — CI trust anchor for downstream repos.
 *
 * Re-runs canonical verification FRESH in the current environment, then reconciles
 * a delivered trust.bundle's claimed passes against those fresh results. Exits 1
 * on divergence, fresh-verify failure, laundered commands, or no verify configured.
 * Exits 0 on clean pass.
 *
 * This is a thin wrapper around scripts/ci/trust-reconcile.js: it resolves the
 * script from the installed package root (via createRequire) and calls the exported
 * runTrustReconcile() function directly so all output goes to the same process
 * stdout/stderr without an extra subprocess layer.
 *
 * The script ships in the npm package `files` list, so downstream repos always have
 * access to it at the same relative path from the package root.
 */

const _require = createRequire(import.meta.url);

type RunTrustReconcileFn = (opts: {
  bundle?: string | null;
  commands?: string[];
  repoRoot?: string | null;
}) => number;

function usage(): void {
  process.stderr.write(
    "usage: flow-agents verify [--commands <cmd[,cmd...]>] [--bundle <path>] [--repo-root <path>]\n" +
    "\n" +
    "Re-runs canonical verification fresh and reconciles a delivered trust.bundle's\n" +
    "claimed passes against CI results. Exits 1 on divergence, fresh-verify failure,\n" +
    "compile-only/no-verify, or laundered commands. Exits 0 on clean pass.\n" +
    "\n" +
    "Options:\n" +
    "  --commands <cmd,...>  Canonical verify command(s). Comma-separated or repeated.\n" +
    "                        Falls back to TRUST_RECONCILE_COMMANDS env or\n" +
    "                        package.json scripts['trust-reconcile-verify'].\n" +
    "                        No-commands → fail-closed (compile-only refused).\n" +
    "  --bundle <path>       Delivered trust.bundle or trust.checkpoint.json path.\n" +
    "                        Falls back to TRUST_RECONCILE_BUNDLE env, then auto-\n" +
    "                        discovers delivery/trust.bundle or delivery/trust.checkpoint.json.\n" +
    "                        Absent bundle: only fresh verify is enforced (fail-open).\n" +
    "  --repo-root <path>    Repository root. Default: TRUST_RECONCILE_REPO_ROOT env or cwd.\n" +
    "\n" +
    "Examples:\n" +
    "  # Re-run build+test fresh; reconcile against a delivered bundle:\n" +
    "  flow-agents verify --commands 'npm run build,npm test' --bundle delivery/trust.bundle\n" +
    "\n" +
    "  # Fresh-verify only (no bundle), using package.json trust-reconcile-verify script:\n" +
    "  flow-agents verify\n"
  );
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    return 0;
  }

  const { flags } = parseArgs(argv);

  // --commands may be specified multiple times or comma-separated within a single value.
  const commandsRaw = flagList(flags, "commands");
  const commands = commandsRaw.flatMap((c) => c.split(",").map((s) => s.trim()).filter(Boolean));

  const bundle = flagString(flags, "bundle") ?? null;
  const repoRoot = flagString(flags, "repo-root") ?? null;

  // Resolve the trust-reconcile.js script from the installed package root.
  // `root` (from tools/common.ts) walks up from this compiled file's directory until
  // it finds a directory with both package.json and packaging/ — the package root.
  // In a downstream installed package: node_modules/@kontourai/flow-agents/
  // In the dev repo: the repo root itself.
  // scripts/ci/trust-reconcile.js ships in the npm package `files` list.
  const reconcilePath = path.join(root, "scripts", "ci", "trust-reconcile.js");

  if (!fs.existsSync(reconcilePath)) {
    process.stderr.write(
      `[flow-agents verify] error: trust-reconcile.js not found at ${reconcilePath}\n` +
      "[flow-agents verify] Is the package correctly installed? Expected scripts/ci/trust-reconcile.js.\n"
    );
    return 1;
  }

  const { runTrustReconcile } = _require(reconcilePath) as { runTrustReconcile: RunTrustReconcileFn };

  return runTrustReconcile({ bundle, commands, repoRoot });
}

// Direct-script guard (mirrors pattern from other CLI subcommands).
const _selfReal = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1Real = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfReal === _argv1Real) { process.exitCode = await main(); }
