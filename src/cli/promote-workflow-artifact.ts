import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs, flagString } from "../lib/args.js";
import { isoNow, relPath } from "../lib/fs.js";

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "delivery";
}

function repoRootFor(file: string): string {
  let current = path.dirname(path.resolve(file));
  for (let i = 0; i < 40; i += 1) {
    if (fs.existsSync(path.join(current, ".git")) || fs.existsSync(path.join(current, "AGENTS.md"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

function firstHeading(text: string): string {
  return text.split(/\r?\n/).find((line) => line.startsWith("# "))?.slice(2).trim() || "Delivery";
}

function field(text: string, name: string): string {
  return text.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1].trim() ?? "";
}

function section(text: string, heading: string): string {
  const match = new RegExp(`^##\\s+${heading}\\s*$`, "m").exec(text);
  if (!match) return "";
  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const next = /^##\s+/m.exec(rest);
  return rest.slice(0, next ? next.index : undefined).trim();
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  const artifact = path.resolve(args.positionals[0] ?? "");
  if (!artifact || !fs.existsSync(artifact)) throw new Error(`artifact not found: ${artifact}`);
  const root = repoRootFor(artifact);
  const text = fs.readFileSync(artifact, "utf8");
  const title = flagString(args.flags, "title") ?? firstHeading(text);
  const docsDir = path.resolve(root, flagString(args.flags, "docs-dir", "docs/delivery") ?? "docs/delivery");
  const date = isoNow().slice(0, 10);
  const archiveBase = flagString(args.flags, "archive-dir") ? path.resolve(root, flagString(args.flags, "archive-dir") ?? "") : path.join(path.dirname(artifact), "archive");
  const archive = path.join(archiveBase, date, path.basename(artifact));
  const doc = path.join(docsDir, `${slugify(title)}.md`);
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.mkdirSync(path.dirname(doc), { recursive: true });
  fs.copyFileSync(artifact, archive);
  const pieces = ["---", `title: "${title}"`, `created: ${isoNow()}`, `source_artifact: ${relPath(root, artifact)}`, `archived_artifact: ${relPath(root, archive)}`, `delivery_status: ${field(text, "status") || "unknown"}`, "---", "", `# ${title}`, "", "This document was promoted from a delivery artifact after final acceptance.", "", "## Source", "", `- Working artifact: \`${relPath(root, artifact)}\``, `- Archived artifact: \`${relPath(root, archive)}\``, `- Status at promotion: \`${field(text, "status") || "unknown"}\``, ""];
  for (const heading of ["Definition Of Done", "Plan", "Verification Report", "Goal Fit Gate", "Final Acceptance", "History"]) {
    const body = section(text, heading);
    if (body) pieces.push(`## ${heading}`, "", body, "");
  }
  fs.writeFileSync(doc, `${pieces.join("\n").trimEnd()}\n`, "utf8");
  console.log(`promoted_doc=${doc}`);
  console.log(`archived_artifact=${archive}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
