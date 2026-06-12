import * as path from "node:path";
import { parseArgs, flagString } from "../lib/args.js";
import { activateCodexLocal, activateStrandsLocal } from "../runtime-adapters.js";

const AVAILABLE_ADAPTERS = ["codex-local", "strands-local"];

export function main(argv = process.argv.slice(2)): number {
  const [command, ...rest] = argv;
  if (command !== "activate") {
    console.error("usage: runtime-adapter activate [--dest DIR] [--source-root DIR] [--adapter codex-local|strands-local]");
    return 2;
  }
  const args = parseArgs(rest);
  const dest = path.resolve(flagString(args.flags, "dest", ".") ?? ".");
  const sourceRoot = path.resolve(flagString(args.flags, "source-root", path.resolve(path.dirname(process.argv[1]), "..")) ?? ".");
  const adapter = flagString(args.flags, "adapter");
  if (adapter && !AVAILABLE_ADAPTERS.includes(adapter)) {
    console.log(JSON.stringify({ selected_adapter: null, available_adapters: AVAILABLE_ADAPTERS, supported_asset_classes: [], generated_runtime_files: [], skipped_assets: [], warnings: [], errors: [`unknown runtime adapter '${adapter}'; available adapters: ${AVAILABLE_ADAPTERS.join(", ")}`] }, null, 2));
    return 2;
  }
  // Default to codex-local for backward compatibility; strands-local is opt-in via --adapter.
  const result = adapter === "strands-local"
    ? activateStrandsLocal(sourceRoot, dest)
    : activateCodexLocal(sourceRoot, dest);
  console.log(JSON.stringify(result, null, 2));
  return Array.isArray(result.errors) && result.errors.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
