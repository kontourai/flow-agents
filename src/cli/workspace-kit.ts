import * as path from "node:path";
import { parseArgs } from "../lib/args.js";
import { inspectWorkspaceKits, resolveWorkspaceKits, readWorkspaceKitBindings, WorkspaceKitError } from "../workspace-kits.js";

export async function workspaceKitMain(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("usage: flow-agents kit workspace inspect --scope <directory> --cache <directory>\n   or: flow-agents kit workspace resolve --scope <directory> --cache <directory> [--bindings <local-json-file>] [--update]\nJSON outcomes: verified exits 0; refusals exit 2. Commands never activate or execute Kits.");
    return 0;
  }
  try {
    if (command !== "inspect" && command !== "resolve") throw new Error("Expected workspace inspect or resolve");
    const { positionals, flags } = parseArgs(rest);
    const allowed = command === "inspect" ? ["scope", "cache"] : ["scope", "cache", "bindings", "update"];
    if (positionals.length || Object.keys(flags).some(key => !allowed.includes(key))) throw new Error("Unsupported workspace argument");
    if (typeof flags.scope !== "string" || !flags.scope || typeof flags.cache !== "string" || !flags.cache) throw new Error("Explicit scope and cache directories are required");
    if (flags.update !== undefined && flags.update !== true) throw new Error("--update is a boolean switch");
    let bindings: Record<string, string> | undefined;
    if (flags.bindings !== undefined) {
      if (typeof flags.bindings !== "string") throw new Error("--bindings requires one local JSON file");
      bindings = readWorkspaceKitBindings(flags.bindings);
    }
    const options = { scope: path.resolve(flags.scope), cache: path.resolve(flags.cache) };
    const result = command === "inspect" ? await inspectWorkspaceKits(options) : await resolveWorkspaceKits({ ...options, bindings, update: flags.update === true });
    console.log(JSON.stringify(result, null, 2));
    return result.status === "verified" ? 0 : 2;
  } catch (error) {
    console.log(JSON.stringify({ status: error instanceof WorkspaceKitError ? error.status : "unsupported", artifacts: [], diagnostics: [{ code: error instanceof WorkspaceKitError ? error.code : "invalid-arguments", message: String((error as Error).message).slice(0, 1024) }] }, null, 2));
    return 2;
  }
}
