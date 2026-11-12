#!/usr/bin/env node
/**
 * Opt-in hook trigger for the dream run (#671): wire it to a harness's
 * `SessionEnd` and `PreCompact` hooks to start a run when a session ends.
 *
 * It is off unless BOTH are set in the hook's environment:
 *   FLOW_AGENTS_DREAM_TRIGGER=1
 *   FLOW_AGENTS_DREAM_CONFIG=/abs/dream.config.json   (which must also say "enabled": true)
 *
 * What it does when on: spawns `dream/cli.js run` detached, with no stdio, and
 * exits 0 at once. The run takes the dream lock, so a trigger that fires while a
 * run is going just starts a process that exits with 75. A run is skipped when
 * the last trigger was under `triggerMinIntervalMs` ago (default 15 minutes).
 *
 * Best effort by construction: it reads no model output, blocks nothing, and
 * exits 0 whatever happens. It never runs a model itself ("no model calls in
 * hooks"): the detached run does, outside the hook's deadline.
 *
 * @module dream/hook-trigger
 */

import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_TRIGGER_MIN_INTERVAL_MS, assertOwnerControlledDir, loadDreamConfig } from "./config.js";
import { defaultDreamDir } from "./run.js";

export const TRIGGER_EVENTS = Object.freeze(["SessionEnd", "PreCompact"]);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
const MAX_INPUT_BYTES = 64 * 1024;

/**
 * @returns {{ triggered: boolean, reason: string }}
 */
export function handleTrigger({ input, env = process.env, spawn = nodeSpawn, now = Date.now, execPath = process.execPath } = {}) {
  try {
    if (env.FLOW_AGENTS_DREAM_TRIGGER !== "1" || !env.FLOW_AGENTS_DREAM_CONFIG) return { triggered: false, reason: "disabled" };
    let event;
    try {
      event = JSON.parse(input).hook_event_name;
    } catch {
      return { triggered: false, reason: "unreadable-input" };
    }
    if (!TRIGGER_EVENTS.includes(event)) return { triggered: false, reason: "not-a-trigger-event" };
    const config = loadDreamConfig(env.FLOW_AGENTS_DREAM_CONFIG);
    if (!config.enabled) return { triggered: false, reason: "config-disabled" };

    const dreamDir = assertOwnerControlledDir(config.dreamDir ?? defaultDreamDir(env), "dreamDir");
    const stamp = path.join(dreamDir, "trigger.stamp");
    const interval = config.triggerMinIntervalMs ?? DEFAULT_TRIGGER_MIN_INTERVAL_MS;
    try {
      if (now() - fs.statSync(stamp).mtimeMs < interval) return { triggered: false, reason: "debounced" };
    } catch {
      // No stamp yet.
    }
    fs.mkdirSync(path.dirname(stamp), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stamp, `${now()}\n`, { mode: 0o600 });

    const child = spawn(execPath, [CLI, "run", "--config", env.FLOW_AGENTS_DREAM_CONFIG, "--trigger", event], {
      detached: true,
      stdio: "ignore",
      env,
    });
    child.on?.("error", () => {});
    child.unref();
    return { triggered: true, reason: event };
  } catch {
    return { triggered: false, reason: "error" };
  }
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  handleTrigger({ input: await readInput() });
  process.exitCode = 0;
}
