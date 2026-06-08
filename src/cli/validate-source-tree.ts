import * as path from "node:path";
import { parseArgs } from "../lib/args.js";
import { validateKitRepository } from "../flow-kit/validate.js";

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  const kit = args.flags.kit;
  if (typeof kit === "string") {
    const errors = validateKitRepository(path.resolve(kit));
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
  const errors = validateKitRepository(builder);
  if (errors.length) {
    console.log("Source tree validation failed:");
    for (const error of errors) console.log(` - ${error}`);
    return 1;
  }
  console.log("Source tree validation passed");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
