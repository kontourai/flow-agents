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
 * `publish` must be idempotent: a run that is interrupted or crashes after publishing does not commit its cursor, so
 * the next run publishes the same batch again.
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
import { fileURLToPath, pathToFileURL } from "node:url";

import { PROCESS_TERMINATION_GRACE_MS } from "@kontourai/relay/process";

import { DEFAULT_ROLE, assertOwnerControlledDir, assertOwnerControlledFile, loadDreamConfig } from "./config.js";
import { createCliRuntime, createRoleRuntime, executionEvidence, extractForRuntime, modelSetupHelp } from "./model.js";
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

/**
 * Which passes failed authentication, per sitting. `runtime` records the code of the call that failed, and `extract`
 * files each pass under its sitting (the extraction request's `sourceRef` is the sitting id). The run gives up on a
 * sitting only when every pass failed, so `onlyAuthentication(sittingId)` is true when each of that sitting's failed
 * passes was Relay's AUTHENTICATION_FAILED: a 401 in one pass and an outage in another is an outage, and one sitting's
 * 401 says nothing about another sitting. Passes run one at a time, so one pass is in flight at once.
 */
function trackAuthentication(runtime) {
  const bySitting = new Map();
  let inFlight = null;
  const watched = Object.create(runtime);
  watched.invoke = async (...args) => {
    try {
      return await runtime.invoke(...args);
    } catch (error) {
      if (inFlight && inFlight.code === null) inFlight.code = error?.code ?? "ERROR";
      throw error;
    }
  };
  const extract = (inner) => async (request) => {
    const pass = { code: null };
    inFlight = pass;
    try {
      const result = await inner(request);
      if (result?.error && pass.code === null) pass.code = "ERROR";
      return result;
    } catch (error) {
      if (pass.code === null) pass.code = error?.code ?? "ERROR";
      throw error;
    } finally {
      inFlight = null;
      const key = request?.sourceRef;
      bySitting.set(key, [...(bySitting.get(key) ?? []), pass]);
    }
  };
  const onlyAuthentication = (sittingId) => {
    const failed = (bySitting.get(sittingId) ?? []).filter((pass) => pass.code !== null);
    return failed.length > 0 && failed.every((pass) => pass.code === "AUTHENTICATION_FAILED");
  };
  return { runtime: watched, extract, onlyAuthentication };
}

/**
 * Record each result's content-free execution evidence (model.js `executionEvidence`) into `evidence`, which the run
 * writes into its report. Each distinct record is kept once, so a run whose calls all ran the same way shows one.
 */
function recordExecution(runtime, evidence) {
  const recorded = Object.create(runtime);
  recorded.invoke = async (...args) => {
    const result = await runtime.invoke(...args);
    evidence.results += 1;
    const entry = executionEvidence(result?.execution);
    if (entry && !evidence.execution.some((seen) => JSON.stringify(seen) === JSON.stringify(entry))) evidence.execution.push(entry);
    return result;
  };
  return recorded;
}

const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 };

/**
 * When this module is the command (`handleSignals`), SIGINT and SIGTERM abort the run instead of killing this process.
 * claude runs in its own process group (model.js), so a terminal Ctrl-C no longer reaches it. Aborting makes Relay send
 * the group SIGTERM, then SIGKILL after its grace period, and makes the run stop at its next stage boundary without
 * committing the cursor (DREAM_INTERRUPTED, exit 130/143).
 *
 * A second signal ends this process at once, with `process.exit` rather than by re-raising the signal. Relay SIGKILLs
 * every group still running from its `exit` hook, which a death by signal would skip, leaving a claude that ignores
 * SIGTERM running. For the same reason the handlers stay installed for Relay's grace period after the run returns
 * (on an unref'd timer, so they never keep the process alive).
 *
 * Not covered: this process killed by SIGKILL (no handler or exit hook runs), and a process that left claude's group.
 */
function abortOnSignals() {
  const controller = new AbortController();
  let received = null;
  const handlers = {};
  const restore = () => {
    for (const [name, handler] of Object.entries(handlers)) process.removeListener(name, handler);
  };
  for (const name of Object.keys(SIGNAL_EXIT)) {
    handlers[name] = () => {
      if (received) {
        fs.writeSync(2, "dream: interrupted twice; stopping claude processes\n");
        process.exit(SIGNAL_EXIT[name]);
      }
      received = name;
      controller.abort(dreamError("DREAM_INTERRUPTED", `stopped by ${name}`));
    };
    process.on(name, handlers[name]);
  }
  const restoreAfterGrace = () => setTimeout(restore, PROCESS_TERMINATION_GRACE_MS + 500).unref();
  return { signal: controller.signal, received: () => received, restore: restoreAfterGrace };
}

/** One line on stderr when user turns were left out of sittings, so an assistant-only sitting is not a mystery. */
function noteDroppedTurns(report, stderr) {
  const dropped = report?.ingest?.dropped_user_turns ?? {};
  const total = Object.values(dropped).reduce((sum, n) => sum + n, 0);
  if (total === 0) return;
  const kinds = Object.entries(dropped).sort(([a], [b]) => a.localeCompare(b)).map(([kind, n]) => `${kind} ${n}`).join(", ");
  stderr.write(`note: ${total} user turn(s) were not read as yours (${kinds}); a person did not write them, or the transcript cannot say who did. Their sittings keep only the assistant's side (report.ingest.dropped_user_turns).\n`);
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

/**
 * @param {string[]} argv
 * @param {{ stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, handleSignals?: boolean }} [io]  `handleSignals`:
 *   this process is the dream command, so SIGINT/SIGTERM may be handled (`abortOnSignals`). Off when a host or a test
 *   calls `main` in its own process.
 */
export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, handleSignals = false } = {}) {
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
  let interrupt = null;
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
    if (handleSignals && !args.dryRun) interrupt = abortOnSignals();
    let auth = null;
    let runtimeEvidence;
    if (!host.extract && !args.dryRun) {
      runtimeEvidence = { kind: host.runtime ? "host" : config.runtime ? config.runtime.kind : "datum-role", results: 0, execution: [] };
      const runtime = recordExecution(host.runtime
        ?? (config.runtime
          ? await createCliRuntime(config.runtime, { dreamDir, ...(interrupt ? { signal: interrupt.signal } : {}) })
          : await createRoleRuntime({ role: config.role ?? DEFAULT_ROLE })), runtimeEvidence);
      auth = trackAuthentication(runtime);
      host.extract = auth.extract(await extractForRuntime(auth.runtime));
    }
    const report = await runDream(host, {
      enabled: config.enabled,
      dryRun: args.dryRun,
      trigger: args.trigger,
      telemetryFile: config.telemetryFile,
      transcriptRoots: config.transcriptRoots,
      ...(config.dreamDir ? { dreamDir: config.dreamDir } : {}),
      ...(runtimeEvidence ? { runtimeEvidence } : {}),
      ...(interrupt ? { signal: interrupt.signal } : {}),
      ...Object.fromEntries(["passes", "maxSittingsPerRun", "globalBudget", "projectBudget", "maxEntryBytes", "includeUnreviewed", "routingPolicy", "idleGapMs", "proposerId", "visibility"].filter((key) => config[key] !== undefined).map((key) => [key, config[key]])),
    }).catch((error) => {
      // A sitting whose every pass failed because the runtime refused its credentials is a setup problem, not a failed run.
      if (error?.code !== "DREAM_DISTILL_FAILED" || !auth?.onlyAuthentication(error.sittingId)) throw error;
      throw dreamError("DREAM_MODEL_UNAVAILABLE", "the model runtime refused its credentials on every pass (Relay AUTHENTICATION_FAILED); for the Claude Code CLI, run claude and sign in with /login; for a Datum role, check its key", { help: modelSetupHelp(config.role ?? DEFAULT_ROLE), report: error.report });
    });
    noteDroppedTurns(report, stderr);
    stdout.write(`${JSON.stringify(report)}\n`);
    return report.status === "blocked" ? 3 : 0;
  } catch (error) {
    const signal = interrupt?.received();
    if (signal) stderr.write(`DREAM_INTERRUPTED: stopped by ${signal}; the model calls were stopped and the cursor is held\n`);
    else stderr.write(`${error.code ?? "DREAM_FAILED"}: ${String(error.message).slice(0, 300)}\n`);
    // Setup guidance is ours, not echoed input, so it is printed whole.
    if (!signal && typeof error.help === "string") stderr.write(`${error.help}\n`);
    noteDroppedTurns(error.report, stderr);
    if (error.report) stdout.write(`${JSON.stringify(error.report)}\n`);
    if (signal) return SIGNAL_EXIT[signal];
    return error.code === "DREAM_LOCKED" ? 75 : CONFIGURATION_CODES.has(error.code) ? 2 : 1;
  } finally {
    interrupt?.restore();
  }
}

/** Whether this module is the program node was started with, compared by real path, so a symlinked path still runs it. */
function isEntryPoint(argv1) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2), { handleSignals: true });
}
