import * as path from "node:path";
import { parseArgs, flagString } from "../lib/args.js";
import { activateCodexLocal } from "../runtime-adapters.js";

export function main(argv = process.argv.slice(2)): number {
  const [command, ...rest] = argv;
  if (command !== "activate") {
    console.error("usage: runtime-adapter activate [--dest DIR] [--source-root DIR] [--adapter codex-local]");
    return 2;
  }
  const args = parseArgs(rest);
  const dest = path.resolve(flagString(args.flags, "dest", ".") ?? ".");
  const sourceRoot = path.resolve(flagString(args.flags, "source-root", path.resolve(path.dirname(process.argv[1]), "..")) ?? ".");
  const adapter = flagString(args.flags, "adapter");
  if (adapter && adapter !== "codex-local") {
    console.log(JSON.stringify({ selected_adapter: null, available_adapters: ["codex-local"], supported_asset_classes: [], generated_runtime_files: [], skipped_assets: [], warnings: [], errors: [`unknown runtime adapter '${adapter}'; available adapters: codex-local`] }, null, 2));
    return 2;
  }
  const result = activateCodexLocal(sourceRoot, dest);
  console.log(JSON.stringify(result, null, 2));
  return Array.isArray(result.errors) && result.errors.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
