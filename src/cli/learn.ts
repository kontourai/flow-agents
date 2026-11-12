/**
 * `flow-agents learn [--since ...] [--dry-run] ...`: the installed entry point for the Knowledge kit's
 * correction-recurrence learning loop. It forwards to `kits/knowledge/learn/cli.js`, which owns the arguments,
 * the output and the exit codes, so a consumer never has to name a path inside node_modules.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// build/src/cli/learn.js -> the package root, where kits/ ships.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const LEARN_CLI = path.join(PACKAGE_ROOT, "kits", "knowledge", "learn", "cli.js");

export async function main(argv: string[]): Promise<number> {
  const cli = (await import(pathToFileURL(LEARN_CLI).href)) as { main: (argv: string[]) => Promise<number> };
  return cli.main(argv);
}
