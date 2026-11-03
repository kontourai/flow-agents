/**
 * Operator configuration for the dream run (#671). Everything is off until the
 * file says `"enabled": true`; an unknown key is an error, never ignored.
 *
 * @module dream/config
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { assertAbsolute, dreamError } from "./util.js";

const MAX_CONFIG_BYTES = 64 * 1024;
const KEYS = new Set([
  "enabled", "telemetryFile", "transcriptRoots", "dreamDir", "host", "role", "passes", "maxSittingsPerRun",
  "globalBudget", "projectBudget", "maxEntryBytes", "includeUnreviewed", "routingPolicy", "idleGapMs",
  "triggerMinIntervalMs", "proposerId", "visibility",
]);
const POSITIVE_INTEGERS = ["passes", "maxSittingsPerRun", "globalBudget", "projectBudget", "maxEntryBytes", "idleGapMs", "triggerMinIntervalMs"];

export const DEFAULT_ROLE = "extraction-default";
export const DEFAULT_TRIGGER_MIN_INTERVAL_MS = 15 * 60 * 1000;

/** Read and validate a config file. Returns plain data; nothing is run. */
export function loadDreamConfig(file) {
  assertAbsolute(file, "config");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw dreamError("DREAM_CONFIG_INVALID", "config must be a regular file under 64 KiB");
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw dreamError("DREAM_CONFIG_INVALID", "config is not valid JSON");
  }
  return validateDreamConfig(config);
}

export function validateDreamConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw dreamError("DREAM_CONFIG_INVALID", "config must be an object");
  for (const key of Object.keys(config)) {
    if (!KEYS.has(key)) throw dreamError("DREAM_CONFIG_INVALID", `unknown config key: ${key}`);
  }
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") throw dreamError("DREAM_CONFIG_INVALID", "enabled must be a boolean");
  assertAbsolute(config.telemetryFile, "telemetryFile");
  assertAbsolute(config.host, "host");
  if (!Array.isArray(config.transcriptRoots) || config.transcriptRoots.length === 0) throw dreamError("DREAM_CONFIG_INVALID", "transcriptRoots must list at least one root");
  config.transcriptRoots.forEach((root, i) => assertAbsolute(root, `transcriptRoots[${i}]`));
  if (config.dreamDir !== undefined) assertAbsolute(config.dreamDir, "dreamDir");
  for (const key of POSITIVE_INTEGERS) {
    if (config[key] !== undefined && !(Number.isSafeInteger(config[key]) && config[key] > 0)) throw dreamError("DREAM_CONFIG_INVALID", `${key} must be a positive integer`);
  }
  if (config.role !== undefined && (typeof config.role !== "string" || !config.role.trim())) throw dreamError("DREAM_CONFIG_INVALID", "role must be a Datum role name");
  return { ...config, enabled: config.enabled === true };
}

/** The host module is operator-owned code. Refuse one another user could have changed. */
export function assertOwnerControlledFile(file, label) {
  assertAbsolute(file, label);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw dreamError("DREAM_CONFIG_INVALID", `${label} must be a regular file`);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && stat.uid !== uid) throw dreamError("DREAM_CONFIG_INVALID", `${label} must be owned by the current user`);
  if ((stat.mode & 0o022) !== 0) throw dreamError("DREAM_CONFIG_INVALID", `${label} must not be group or world writable`);
  return path.resolve(file);
}
