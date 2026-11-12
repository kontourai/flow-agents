#!/usr/bin/env node
/**
 * Command-line entry for the dream run (#671): the thing a host scheduler or the
 * opt-in hook trigger invokes. An installed package reaches it as
 * `flow-agents dream run ...` (src/cli/dream.ts forwards here).
 *
 *   node dream/cli.js run --config /abs/dream.config.json [--dry-run] [--trigger NAME]
 *
 * Disabled unless the config says `"enabled": true`. The config's `host` is an
 * operator-owned module exporting `createDreamHost({ config })`, which returns
 * the host-composed pieces the run must not discover for itself (`dryRun` is true
 * under `--dry-run`, and the host must then create and write nothing; a host whose
 * memory root does not exist yet returns no `store` then, see storeForMissingRoot):
 *   { store, registerRoot, root, rootName, publish, runtime?, extract?, reviewDecisions? }
 * With neither `runtime` nor `extract`, the model is the config's `runtime` (the
 * Claude Code CLI) when it names one, and otherwise the Datum role named by the
 * config (default `extraction-default`); either way it is a Relay runtime routed
 * through Dispatch.
 *
 * Exit codes: 0 ran (success, noop, dry-run), 1 failed, 2 disabled or bad
 * configuration (including no model set up), 3 blocked telemetry, 75 another run
 * holds the lock.
 *
 * @module dream/cli
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_ROLE, assertOwnerControlledDir, assertOwnerControlledFile, loadDreamConfig } from "./config.js";
import { createCliRuntime, createRoleRuntime, extractForRuntime, modelSetupHelp } from "./model.js";
import { defaultDreamDir, runDream } from "./run.js";
import { dreamError } from "./util.js";

/** Errors that mean the operator has to change something before any run can work: exit 2, not a failed run. */
const CONFIGURATION_CODES = new Set(["DREAM_DISABLED", "DREAM_CONFIG_INVALID", "DREAM_MODEL_UNCONFIGURED", "DREAM_MODEL_UNAVAILABLE", "DREAM_MODEL_UNSUPPORTED"]);

/**
 * A dry run creates nothing, but constructing a Corpus store over a memory root that does not exist yet creates the
 * root (Corpus binds a root to a stable identity when the store is built). So under `--dry-run` a host whose root is
 * missing returns no `store`, and the run reads this one: the root holds nothing yet, so there is nothing to list. A
 * host that leaves out the store while its root exists would hide the proposals in it, and is refused.
 */
function storeForMissingRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw dreamError("DREAM_CONFIG_INVALID", "root must be an absolute path");
  if (fs.existsSync(root)) throw dreamError("DREAM_CONFIG_INVALID", "the host returned no store, but its memory root exists; open the store read-only instead");
  return {
    async listProposals() { return []; },
    async proposeCreate() { throw dreamError("DREAM_DRY_RUN", "a dry run proposes nothing"); },
  };
}

/** The runtime, reporting into `refused` when a call fails authentication (Relay's AUTHENTICATION_FAILED). */
function watchAuthentication(runtime, refused) {
  const watched = Object.create(runtime);
  watched.invoke = async (...args) => {
    try {
      return await runtime.invoke(...args);
    } catch (error) {
      if (error?.code === "AUTHENTICATION_FAILED") refused.error = error;
      throw error;
    }
  };
  return watched;
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "run") throw dreamError("DREAM_USAGE", "usage: dream run --config /abs/dream.config.json [--dry-run] [--trigger NAME]");
  const out = { dryRun: false, trigger: "manual" };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === "--dry-run") out.dryRun = true;
    else if (flag === "--config" || flag === "--trigger") {
      const value = rest[(i += 1)];
      if (!value || value.startsWith("--")) throw dreamError("DREAM_USAGE", `missing value for ${flag}`);
      out[flag === "--config" ? "config" : "trigger"] = value;
    } else throw dreamError("DREAM_USAGE", `unknown option: ${flag}`);
  }
  if (!out.config) throw dreamError("DREAM_USAGE", "--config is required");
  return out;
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  let args;
  let config;
  try {
    args = parseArgs(argv);
    config = loadDreamConfig(args.config);
  } catch (error) {
    stderr.write(`${error.code ?? "DREAM_FAILED"}: ${error.message}\n`);
    return 2;
  }
  if (!config.enabled && !args.dryRun) {
    stderr.write("DREAM_DISABLED: the dream run is disabled in this config\n");
    return 2;
  }
  try {
    // The run keeps its cursor, lock, reports and briefs here, and the SessionStart hook injects the briefs as the
    // user's memory, so another user must not be able to write, or redirect, either directory.
    const dreamDir = config.dreamDir ?? defaultDreamDir();
    assertOwnerControlledDir(dreamDir, "dreamDir");
    assertOwnerControlledDir(path.join(dreamDir, "briefs"), "dreamDir/briefs");
    let host;
    try {
      const module = await import(pathToFileURL(assertOwnerControlledFile(config.host, "host")).href);
      if (typeof module.createDreamHost !== "function") throw dreamError("DREAM_CONFIG_INVALID", "the host module must export createDreamHost");
      // A dry run is read-only all the way down: the host is told, so it opens its store without creating anything.
      host = await module.createDreamHost({ config, dryRun: args.dryRun });
      if (!host || typeof host !== "object") throw dreamError("DREAM_CONFIG_INVALID", "createDreamHost must return the host object");
    } catch (error) {
      if (error?.code === "DREAM_CONFIG_INVALID") throw error;
      throw dreamError("DREAM_CONFIG_INVALID", `the host module failed to load: ${String(error?.message ?? error).slice(0, 200)}`);
    }
    if (args.dryRun && host.store == null) host.store = storeForMissingRoot(host.root);
    const refused = {};
    if (!host.extract && !args.dryRun) {
      const runtime = host.runtime
        ?? (config.runtime
          ? await createCliRuntime(config.runtime)
          : await createRoleRuntime({ role: config.role ?? DEFAULT_ROLE }));
      host.extract = await extractForRuntime(watchAuthentication(runtime, refused));
    }
    const report = await runDream(host, {
      enabled: config.enabled,
      dryRun: args.dryRun,
      trigger: args.trigger,
      telemetryFile: config.telemetryFile,
      transcriptRoots: config.transcriptRoots,
      ...(config.dreamDir ? { dreamDir: config.dreamDir } : {}),
      ...Object.fromEntries(["passes", "maxSittingsPerRun", "globalBudget", "projectBudget", "maxEntryBytes", "includeUnreviewed", "routingPolicy", "idleGapMs", "proposerId", "visibility"].filter((key) => config[key] !== undefined).map((key) => [key, config[key]])),
    }).catch((error) => {
      // Every pass failing because the runtime refused its credentials is a setup problem, not a failed run.
      if (error?.code !== "DREAM_DISTILL_FAILED" || !refused.error) throw error;
      throw dreamError("DREAM_MODEL_UNAVAILABLE", `the model runtime refused its credentials (${refused.error.message}); for the Claude Code CLI, run claude and sign in with /login; for a Datum role, check its key`, { help: modelSetupHelp(config.role ?? DEFAULT_ROLE), report: error.report });
    });
    stdout.write(`${JSON.stringify(report)}\n`);
    return report.status === "blocked" ? 3 : 0;
  } catch (error) {
    stderr.write(`${error.code ?? "DREAM_FAILED"}: ${String(error.message).slice(0, 300)}\n`);
    // Setup guidance is ours, not echoed input, so it is printed whole.
    if (typeof error.help === "string") stderr.write(`${error.help}\n`);
    if (error.report) stdout.write(`${JSON.stringify(error.report)}\n`);
    return error.code === "DREAM_LOCKED" ? 75 : CONFIGURATION_CODES.has(error.code) ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
