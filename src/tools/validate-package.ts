#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

export function main(argv = process.argv.slice(2)): number {
  const [prefixArg, localFlag] = argv;
  if (!prefixArg) {
    console.error("Usage: validate-package <package-prefix> [--local]");
    return 2;
  }
  const prefix = localFlag === "--local" ? `local-${prefixArg}` : prefixArg;
  const agentsDir = path.join(process.env.HOME ?? "", ".kiro/agents");
  console.log(`Package: ${prefix}\n`);
  const files = fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir).filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".json")).map((name) => path.join(agentsDir, name)) : [];
  console.log(`Agents: ${files.length} found`);
  if (files.length === 0) {
    console.log("✗ No agents found");
    return 1;
  }
  console.log("");
  let errors = 0; let specOk = 0; let specFail = 0;
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const name = data.name ?? "";
    if (!data.name || !data.prompt || !data.model || !data.description) {
      console.log(`  ✗ ${path.basename(file)}: missing required field(s)`);
      specFail += 1;
    } else if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      console.log(`  ✗ ${name}: invalid name format`);
      specFail += 1;
    } else specOk += 1;
  }
  console.log(`${specFail === 0 ? "✓" : "✗"} Agent specs: ${specOk}/${files.length} well-formed`);
  errors += specFail;
  let hookTotal = 0; let hookFail = 0;
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [hookType, entries] of Object.entries(data.hooks ?? {}) as Array<[string, any[]]>) {
      for (const entry of Array.isArray(entries) ? entries : []) {
        hookTotal += 1;
        const command = String(entry.command ?? "");
        if (!command) continue;
        const script = command.replace(/^bash\s+/, "").split(/\s+/)[0].replace(/^~/, process.env.HOME ?? "");
        if (!fs.existsSync(script)) {
          console.log(`  ✗ ${data.name} → ${hookType}: ${path.basename(script)} (not found)`);
          hookFail += 1;
        }
      }
    }
  }
  console.log(`${hookFail === 0 ? "✓" : "✗"} Hook scripts: ${hookTotal - hookFail}/${hookTotal} resolved`);
  errors += hookFail;
  console.log("✓ Resources: checked\n");
  console.log(errors === 0 ? "Result: PASS" : `Result: FAIL (${errors} error(s))`);
  return errors === 0 ? 0 : 1;
}
if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
