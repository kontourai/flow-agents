import * as path from "node:path";
import { pathToFileURL } from "node:url";

export function validateSchedulerPath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  if(/[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} contains a control character`);
  return value;
}

export function shellQuote(value) { return `'${String(value).replaceAll("'", `'"'"'`)}'`; }

export function buildBooCommand({ flowAgentsRoot, telemetryFile, transcriptRoot }) {
  validateSchedulerPath(flowAgentsRoot, "FLOW_AGENTS_ROOT"); validateSchedulerPath(telemetryFile, "KNOWLEDGE_TELEMETRY"); validateSchedulerPath(transcriptRoot, "KNOWLEDGE_TRANSCRIPT_ROOT");
  return `node kits/knowledge/dream/cli.js --telemetry ${shellQuote(telemetryFile)} --transcript-root ${shellQuote(transcriptRoot)} --store personal --apply-policy auto`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${buildBooCommand({ flowAgentsRoot: process.argv[2], telemetryFile: process.argv[3], transcriptRoot: process.argv[4] })}\n`); }
  catch { process.stderr.write("invalid Boo recipe path configuration\n"); process.exitCode = 2; }
}
