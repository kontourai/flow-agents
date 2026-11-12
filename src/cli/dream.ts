/**
 * `flow-agents dream run --config /abs/dream.config.json [--dry-run] [--trigger NAME]`: the installed entry point
 * for the Knowledge kit's dream run. It forwards to `kits/knowledge/dream/cli.js`, which owns the arguments, the
 * report and the exit codes, so a consumer never has to name a path inside node_modules.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// build/src/cli/dream.js -> the package root, where kits/ ships.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DREAM_CLI = path.join(PACKAGE_ROOT, "kits", "knowledge", "dream", "cli.js");

export async function main(argv: string[]): Promise<number> {
  const cli = (await import(pathToFileURL(DREAM_CLI).href)) as { main: (argv: string[]) => Promise<number> };
  return cli.main(argv);
}
