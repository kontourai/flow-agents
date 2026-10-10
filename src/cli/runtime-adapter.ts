import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { parseArgs, flagString } from "../lib/args.js";
import { activateCodexLocal, activateStrandsLocal } from "../runtime-adapters.js";
import { activateNativeHarness, NATIVE_HARNESS_SURFACES, type NativeHarnessSurface } from "../native-harness-activation.js";

const AVAILABLE_ADAPTERS = ["codex-local", "strands-local", ...NATIVE_HARNESS_SURFACES];

export function main(argv = process.argv.slice(2)): number {
  const [command, ...rest] = argv;
  if (command !== "activate") {
    console.error("usage: runtime-adapter activate [--dest INSTALLED_ROOT] [--target PROJECT] [--kits id,id] [--source-root DIR] [--adapter <native-surface|codex-local|strands-local>]");
    return 2;
  }
  const args = parseArgs(rest);
  const dest = path.resolve(flagString(args.flags, "dest", ".") ?? ".");
  const sourceRoot = path.resolve(flagString(args.flags, "source-root", fileURLToPath(new URL("../../../", import.meta.url))) ?? ".");
  const adapter = flagString(args.flags, "adapter");
  if (adapter && !AVAILABLE_ADAPTERS.includes(adapter)) {
    console.log(JSON.stringify({ selected_adapter: null, available_adapters: AVAILABLE_ADAPTERS, supported_asset_classes: [], generated_runtime_files: [], skipped_assets: [], warnings: [], errors: [`unknown runtime adapter '${adapter}'; available adapters: ${AVAILABLE_ADAPTERS.join(", ")}`] }, null, 2));
    return 2;
  }
  const target = flagString(args.flags, "target");
  const kitSelection = flagString(args.flags, "kits");
  const kitIdFilter = kitSelection?.split(",").map((id) => id.trim());
  const native = adapter !== undefined && NATIVE_HARNESS_SURFACES.includes(adapter as NativeHarnessSurface);
  const inputError = args.flags.target !== undefined && (!target || Array.isArray(args.flags.target))
    ? "--target requires exactly one project path"
    : target && !native ? "--target requires an explicit native harness adapter"
    : args.flags.kits !== undefined && (!kitSelection || Array.isArray(args.flags.kits) || kitIdFilter?.some((id) => !/^[a-z][a-z0-9-]*$/.test(id)))
      ? "--kits requires one comma-separated list of kebab-case kit ids" : null;
  if (inputError) {
    console.log(JSON.stringify({ selected_adapter: adapter ?? "codex-local", generated_runtime_files: [], warnings: [], errors: [inputError] }, null, 2));
    return 2;
  }
  // Default to codex-local for backward compatibility; strands-local is opt-in via --adapter.
  const result = adapter === "strands-local"
    ? activateStrandsLocal(sourceRoot, dest, { kitIdFilter })
    : adapter && NATIVE_HARNESS_SURFACES.includes(adapter as NativeHarnessSurface)
      ? activateNativeHarness(sourceRoot, dest, { surface: adapter as NativeHarnessSurface, targetRoot: target, kitIdFilter })
      : activateCodexLocal(sourceRoot, dest, { kitIdFilter });
  console.log(JSON.stringify(result, null, 2));
  return Array.isArray(result.errors) && result.errors.length ? 1 : 0;
}

// Use process.exitCode (not process.exit) to allow stdout to be flushed before exit.
// Resolve real paths to handle symlinks (e.g. /tmp -> /private/tmp on macOS) so the
// entry-point guard fires correctly when the module is loaded directly as a script.
const _selfRealPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1RealPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfRealPath === _argv1RealPath) { process.exitCode = main(); }
