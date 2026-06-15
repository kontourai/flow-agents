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
  const root = path.resolve(".");
  const builder = path.join(root, "kits", "builder");
  const errors = await validateKitRepository(builder);
  if (errors.length) {
    console.log("Source tree validation failed:");
    for (const error of errors) console.log(` - ${error}`);
    return 1;
  }
  console.log("Source tree validation passed");
  return 0;
}

// Use process.exitCode (not process.exit) to allow stdout to be flushed before exit.
// Resolve real paths to handle symlinks (e.g. /tmp -> /private/tmp on macOS).
import * as _fsVST from "node:fs";
import { fileURLToPath as _ftpVST } from "node:url";
const _selfVST = (() => { try { return _fsVST.realpathSync(_ftpVST(import.meta.url)); } catch { return _ftpVST(import.meta.url); } })();
const _argv1VST = (() => { try { return _fsVST.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfVST === _argv1VST) { main().then((code) => { process.exitCode = code; }).catch((err) => { console.error(err); process.exitCode = 1; }); }
