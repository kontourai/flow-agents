#!/usr/bin/env node
/**
 * Command-line entry for the dream run (#671): the thing a host scheduler or the
 * opt-in hook trigger invokes.
 *
 *   node dream/cli.js run --config /abs/dream.config.json [--dry-run] [--trigger NAME]
 *
 * Disabled unless the config says `"enabled": true`. The config's `host` is an
 * operator-owned module exporting `createDreamHost({ config })`, which returns
 * the host-composed pieces the run must not discover for itself (`dryRun` is true
 * under `--dry-run`, and the host must then create and write nothing):
 *   { store, registerRoot, root, rootName, publish, runtime?, extract?, reviewDecisions? }
 * With neither `runtime` nor `extract`, the model is the Datum role named by the
 * config (default `extraction-default`), routed through Dispatch and Relay.
 *
 * Exit codes: 0 ran (success, noop, dry-run), 1 failed, 2 disabled or bad
 * configuration, 3 blocked telemetry, 75 another run holds the lock.
 *
 * @module dream/cli
 */

import { pathToFileURL } from "node:url";

import { DEFAULT_ROLE, assertOwnerControlledFile, loadDreamConfig } from "./config.js";
import { createRoleRuntime, extractForRuntime } from "./model.js";
import { runDream } from "./run.js";
import { dreamError } from "./util.js";

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
    const module = await import(pathToFileURL(assertOwnerControlledFile(config.host, "host")).href);
    if (typeof module.createDreamHost !== "function") throw dreamError("DREAM_CONFIG_INVALID", "the host module must export createDreamHost");
    // A dry run is read-only all the way down: the host is told, so it opens its store without creating anything.
    const host = await module.createDreamHost({ config, dryRun: args.dryRun });
    if (!host.extract && !args.dryRun) {
      const runtime = host.runtime ?? (await createRoleRuntime({ role: config.role ?? DEFAULT_ROLE }));
      host.extract = await extractForRuntime(runtime);
    }
    const report = await runDream(host, {
      enabled: config.enabled,
      dryRun: args.dryRun,
      trigger: args.trigger,
      telemetryFile: config.telemetryFile,
      transcriptRoots: config.transcriptRoots,
      ...(config.dreamDir ? { dreamDir: config.dreamDir } : {}),
      ...Object.fromEntries(["passes", "maxSittingsPerRun", "globalBudget", "projectBudget", "maxEntryBytes", "includeUnreviewed", "routingPolicy", "idleGapMs", "proposerId", "visibility"].filter((key) => config[key] !== undefined).map((key) => [key, config[key]])),
    });
    stdout.write(`${JSON.stringify(report)}\n`);
    return report.status === "blocked" ? 3 : 0;
  } catch (error) {
    stderr.write(`${error.code ?? "DREAM_FAILED"}: ${String(error.message).slice(0, 300)}\n`);
    if (error.report) stdout.write(`${JSON.stringify(error.report)}\n`);
    return error.code === "DREAM_LOCKED" ? 75 : error.code === "DREAM_DISABLED" || error.code === "DREAM_CONFIG_INVALID" ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
