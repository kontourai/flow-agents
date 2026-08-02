import * as path from "node:path";
import { inspectEffectiveFlowAgentsConfig } from "../lib/effective-flow-agents-config.js";

export function main(argv: string[]): number {
  const rootArg = argv.find((value) => !value.startsWith("-"));
  const report = inspectEffectiveFlowAgentsConfig(path.resolve(rootArg ?? process.cwd()));
  console.log(JSON.stringify(report, null, 2));
  return report.fail_closed ? 1 : 0;
}
