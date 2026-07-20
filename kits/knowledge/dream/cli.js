#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { ensureGlobalStore, loadRoots, PERSONAL_ROOT_NAME, validateGlobalStoreLocation } from "../adapters/shared/store-resolve.js";
import { loadDistillerAdapter } from "./distiller.js";
import { runDream } from "./index.js";

export function parseArgs(argv) {
  const out = { transcriptRoots: [], applyPolicy: "auto", dryRun: false };
  const names = { "--telemetry": "telemetryFile", "--cursor": "cursorFile", "--transcript-root": "transcriptRoots", "--store": "store", "--apply-policy": "applyPolicy", "--global-budget": "globalBudget", "--project-budget": "projectBudget", "--distiller": "distiller", "--distiller-root": "distillerRoot" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]; if (flag === "--dry-run") { out.dryRun = true; continue; } const key = names[flag]; if (!key) throw new Error(`unknown option: ${flag}`); const value = argv[++index]; if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    if (key === "transcriptRoots") out.transcriptRoots.push(value); else if (key.endsWith("Budget")) out[key] = Number(value); else out[key] = value;
  }
  for (const required of ["telemetryFile", "store"]) if (!out[required]) throw new Error(`missing required option: ${required}`);
  if (!out.transcriptRoots.length) throw new Error("missing required option: --transcript-root"); if (!["auto", "pending"].includes(out.applyPolicy)) throw new Error("apply policy must be auto or pending");
  if (out.store !== "personal") throw new Error("--store must name the registered personal root");
  if (out.distiller && !out.distillerRoot) throw new Error("--distiller-root is required with --distiller"); if (out.distillerRoot && !out.distiller) throw new Error("--distiller-root requires --distiller");
  for (const key of ["globalBudget", "projectBudget"]) if (out[key] !== undefined && (!Number.isSafeInteger(out[key]) || out[key] <= 0)) throw new Error(`${key} must be a positive integer`);
  return out;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv); let storeRoot;
  if (options.dryRun) { storeRoot = validateGlobalStoreLocation(env).storeRoot; if (loadRoots(env).roots[PERSONAL_ROOT_NAME] !== storeRoot) throw new Error("registered personal store root is required for dry-run"); }
  else storeRoot = ensureGlobalStore(env);
  delete options.store; options.storeRoot = storeRoot;
  if (options.distiller) options.distiller = await loadDistillerAdapter(options.distiller, { allowedRoot: options.distillerRoot }); delete options.distillerRoot;
  const result = await runDream(options); process.stdout.write(`${JSON.stringify(result)}\n`); return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { process.stderr.write(`${error.code || "DREAM_FAILED"}: dream command failed\n`); process.exitCode = 1; });
