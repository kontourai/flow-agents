import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { parseArgs, flagString } from "../lib/args.js";
import { readJson } from "../lib/fs.js";

const CLOSING_KEYWORD_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?<refs>(?:(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+|https:\/\/github\.com\/[^\s)]+\/(?:issues|pull)\/\d+)(?:\s*(?:,|and)\s*(?:(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+|https:\/\/github\.com\/[^\s)]+\/(?:issues|pull)\/\d+))*)/gi;
const GITHUB_REF_RE = /(?<url>https:\/\/github\.com\/(?<url_owner>[^/\s)]+)\/(?<url_repo>[^/\s)]+)\/(?:issues|pull)\/(?<url_number>\d+))|(?:(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+))?#(?<number>\d+)/g;
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".adoc", ".rst"]);
const PACKAGE_FILES = new Set(["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "pyproject.toml", "uv.lock", "poetry.lock", "requirements.txt", "Cargo.toml", "Cargo.lock", "go.mod", "go.sum"]);

function loadJson(file: string): Record<string, unknown> {
  return (file === "-" ? JSON.parse(fs.readFileSync(0, "utf8")) : readJson(file)) as Record<string, unknown>;
}

function normalizeRef(ref: string, defaultOwner?: string, defaultRepo?: string): string {
  const matches = Array.from(ref.trim().replace(/[.,]+$/, "").matchAll(GITHUB_REF_RE));
  const match = matches.length === 1 && matches[0][0] === ref.trim().replace(/[.,]+$/, "") ? matches[0] : null;
  if (!match?.groups) throw new Error(`unsupported closing reference: ${ref}`);
  if (match.groups.url) return `github:${match.groups.url_owner}/${match.groups.url_repo}#${Number(match.groups.url_number)}`;
  const owner = match.groups.owner ?? defaultOwner;
  const repo = match.groups.repo ?? defaultRepo;
  if (!owner || !repo) throw new Error(`unqualified reference needs default owner/repo: ${ref}`);
  return `github:${owner}/${repo}#${Number(match.groups.number)}`;
}

function extractClosingRefs(text: string, defaultOwner?: string, defaultRepo?: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const keyword of text.matchAll(CLOSING_KEYWORD_RE)) {
    for (const ref of String(keyword.groups?.refs ?? "").matchAll(GITHUB_REF_RE)) {
      const normalized = normalizeRef(ref[0], defaultOwner, defaultRepo);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        refs.push(normalized);
      }
    }
  }
  return refs;
}

function renderBody(spec: Record<string, unknown>): string {
  if (typeof spec.body_file === "string") return fs.readFileSync(spec.body_file, "utf8");
  if (spec.body !== undefined) return String(spec.body);
  if (Array.isArray(spec.sections)) {
    return spec.sections.map((section) => {
      const record = section as Record<string, unknown>;
      const title = String(record.title ?? "").trim();
      const body = String(record.body ?? "").trimEnd();
      return body ? `## ${title}\n\n${body}` : `## ${title}`;
    }).join("\n\n").trimEnd() + "\n";
  }
  throw new Error("publish input must include body_file, body, or sections");
}

function render(argv: string[]): number {
  const args = parseArgs(argv);
  const input = flagString(args.flags, "input-json");
  if (!input) throw new Error("--input-json is required");
  const spec = loadJson(input);
  const body = renderBody(spec);
  const bodyOut = flagString(args.flags, "body-out");
  if (bodyOut) fs.writeFileSync(bodyOut, body, "utf8");
  console.log(JSON.stringify({ role: "PublishChangeRequest", provider: spec.provider ?? "github", change_provider: spec.change_provider ?? { kind: spec.provider ?? "github" }, title: spec.title, body, expected_closing_refs: spec.expected_closing_refs ?? [] }, null, 2));
  return 0;
}

function validateClosingRefs(argv: string[]): number {
  const input = flagString(parseArgs(argv).flags, "input-json");
  if (!input) throw new Error("--input-json is required");
  const spec = loadJson(input);
  const defaultOwner = typeof spec.default_owner === "string" ? spec.default_owner : undefined;
  const defaultRepo = typeof spec.default_repo === "string" ? spec.default_repo : undefined;
  const expected = (Array.isArray(spec.expected_closing_refs) ? spec.expected_closing_refs : []).map((ref) => normalizeRef(String(ref), defaultOwner, defaultRepo));
  const provider = (spec.provider_output ?? {}) as Record<string, unknown>;
  const recognized = Array.isArray(provider.recognized_closing_refs)
    ? provider.recognized_closing_refs.map((ref) => normalizeRef(String(ref), defaultOwner, defaultRepo))
    : extractClosingRefs(String(provider.body ?? ""), defaultOwner, defaultRepo);
  const missing = expected.filter((ref) => !recognized.includes(ref));
  console.log(JSON.stringify({ role: "ClosingReferenceCheck", provider: spec.provider ?? "github", status: missing.length ? "fail" : "pass", expected_closing_refs: expected, recognized_closing_refs: recognized, missing_closing_refs: missing }, null, 2));
  if (missing.length) {
    console.error(`missing recognized closing refs: ${missing.join(", ")}`);
    return 2;
  }
  return 0;
}

function riskForPath(value: string): string {
  const parts = new Set(value.split(/[\\/]+/));
  const name = path.basename(value);
  const ext = path.extname(value).toLowerCase();
  if (parts.has("schemas")) return "schema";
  if (parts.has("hooks")) return "hook";
  if (parts.has("scripts")) return "runtime";
  if (PACKAGE_FILES.has(name)) return "package";
  if (parts.has("security") || name.toLowerCase().startsWith("security")) return "security";
  if (parts.has("docs") || DOC_EXTENSIONS.has(ext)) return "docs";
  return "runtime";
}

function evaluateProviderChecks(argv: string[]): number {
  const args = parseArgs(argv);
  const filesDoc = loadJson(flagString(args.flags, "change-files-json") ?? "");
  const checksPath = flagString(args.flags, "provider-checks-json");
  const checks = checksPath ? loadJson(checksPath) : [];
  const files = Array.isArray(filesDoc) ? filesDoc : (filesDoc.files as unknown[] ?? []);
  const risks = Array.from(new Set(files.map((file) => riskForPath(String(file))))).sort();
  const checksPresent = Array.isArray(checks) ? checks.length > 0 : Object.keys(checks).length > 0;
  const risky = risks.some((risk) => ["runtime", "schema", "package", "hook", "security"].includes(risk));
  const status = checksPresent ? "pass" : risky ? "not_verified" : "skip";
  const release = checksPresent ? "pass" : risky ? "hold" : "not_required";
  console.log(JSON.stringify({ role: "ProviderCheckPolicy", risk_classes: risks.length ? risks : ["unknown"], provider_checks_present: checksPresent, evidence_status: status, release_gate_status: release, summary: checksPresent ? "Provider checks are present." : risky ? "Missing provider checks for risky change classes." : "Provider checks skipped for docs-only change." }, null, 2));
  return status === "not_verified" ? 3 : 0;
}

function reconcile(argv: string[]): number {
  const root = argv[0];
  if (!root) throw new Error("artifact_root is required");
  const evidence = readJson(path.join(root, "evidence.json")) as Record<string, unknown>;
  const release = readJson(path.join(root, "release.json")) as Record<string, unknown>;
  const mismatches: string[] = [];
  if (evidence.verdict !== "pass") mismatches.push("evidence verdict is not pass");
  const gates = Array.isArray(release.gates) ? release.gates as Record<string, unknown>[] : [];
  if (["merge", "release", "deploy"].includes(String(release.decision)) && gates.filter((gate) => gate.required !== false).some((gate) => gate.status !== "pass")) mismatches.push("positive release decision has non-pass required gate");
  console.log(JSON.stringify({ role: "FinalStateReconciliation", status: mismatches.length ? "fail" : "pass", authoritative_refs: [path.join(root, "evidence.json"), path.join(root, "release.json")], mismatches }, null, 2));
  return mismatches.length ? 4 : 0;
}

export function main(argv = process.argv.slice(2)): number {
  try {
    const [command, ...rest] = argv;
    if (command === "render") return render(rest);
    if (command === "validate-closing-refs") return validateClosingRefs(rest);
    if (command === "evaluate-provider-checks") return evaluateProviderChecks(rest);
    if (command === "reconcile-final-state") return reconcile(rest);
    console.error("usage: publish-change-helper <render|validate-closing-refs|evaluate-provider-checks|reconcile-final-state>");
    return 2;
  } catch (error) {
    console.error(`publish-change-helper: ${(error as Error).message}`);
    return 1;
  }
}

// Use process.exitCode (not process.exit) to allow stdout to be flushed before exit.
// Resolve real paths to handle symlinks (e.g. /tmp -> /private/tmp on macOS) so the
// entry-point guard fires correctly when the module is loaded directly as a script.
const _selfRealPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1RealPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfRealPath === _argv1RealPath) { process.exitCode = main(); }
