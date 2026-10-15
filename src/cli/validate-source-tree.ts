import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "../lib/args.js";
import { validateKitRepository } from "../flow-kit/validate.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const kit = args.flags.kit;
  if (typeof kit === "string") {
    const errors = await validateKitRepository(path.resolve(kit));
    if (errors.length) {
      console.log("Flow Kit repository validation failed:");
      for (const error of errors) console.log(` - ${error}`);
      return 1;
    }
    console.log("Flow Kit repository validation passed");
    return 0;
  }
  // Without --kit, validate every kit the source tree's catalog lists. An unreadable or empty
  // catalog, or an entry without a path, is a failure rather than a tree with nothing to check.
  const root = path.resolve(".");
  const errors: string[] = [];
  for (const kitDir of catalogKitDirs(root, errors)) errors.push(...await validateKitRepository(kitDir));
  if (errors.length) {
    console.log("Source tree validation failed:");
    for (const error of errors) console.log(` - ${error}`);
    return 1;
  }
  console.log("Source tree validation passed");
  return 0;
}

function catalogKitDirs(root: string, errors: string[]): string[] {
  const catalogPath = path.join(root, "kits", "catalog.json");
  let catalog: unknown;
  try {
    catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  } catch (error) {
    errors.push(`kits/catalog.json could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  const kits = (catalog as { kits?: unknown } | null)?.kits;
  if (!Array.isArray(kits) || kits.length === 0) {
    errors.push("kits/catalog.json: .kits must be a non-empty list");
    return [];
  }
  const dirs: string[] = [];
  kits.forEach((entry, index) => {
    const kitPath = (entry as { path?: unknown } | null)?.path;
    if (typeof kitPath !== "string" || !kitPath) errors.push(`kits/catalog.json: kits[${index}] must declare a path`);
    else dirs.push(path.resolve(root, kitPath));
  });
  return dirs;
}

// Use process.exitCode (not process.exit) to allow stdout to be flushed before exit.
// Resolve real paths to handle symlinks (e.g. /tmp -> /private/tmp on macOS).
import * as _fsVST from "node:fs";
import { fileURLToPath as _ftpVST } from "node:url";
const _selfVST = (() => { try { return _fsVST.realpathSync(_ftpVST(import.meta.url)); } catch { return _ftpVST(import.meta.url); } })();
const _argv1VST = (() => { try { return _fsVST.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfVST === _argv1VST) { main().then((code) => { process.exitCode = code; }).catch((err) => { console.error(err); process.exitCode = 1; }); }
