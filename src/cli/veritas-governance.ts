import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { flagBool, flagString, parseArgs } from "../lib/args.js";

type EvidenceStatus = "pass" | "fail" | "not_verified" | "skip";
type EvidenceVerdict = "pass" | "partial" | "fail" | "not_verified";

type EvidenceCheck = {
  id: string;
  kind: "policy";
  status: EvidenceStatus;
  command?: string;
  summary: string;
  artifact_refs?: EvidenceRef[];
  standard_refs?: Array<{ standard: "veritas"; ref: string; role: "native"; summary: string }>;
};

type EvidencePayload = {
  schema_version: "1.0";
  task_slug: string;
  verdict: EvidenceVerdict;
  checks: EvidenceCheck[];
  external_evidence?: Array<{ system: "veritas"; ref: EvidenceRef; summary: string; standard: "veritas" }>;
  not_verified_gaps?: string[];
};

type EvidenceRef = {
  kind: "source" | "command" | "artifact" | "provider" | "external";
  url?: string;
  file?: string;
  line_start?: number;
  line_end?: number;
  excerpt?: string;
  summary?: string;
};

type EvidenceOptions = {
  artifactDir: string;
  evidencePath: string;
  taskSlug: string;
  veritasBin: string;
  repoRoot: string;
  veritasRoot?: string;
  nativeArtifact?: string;
  maxAgeSeconds?: number;
  skip: boolean;
  notConfigured: boolean;
};

const OUTPUT_SUMMARY_MAX_BYTES = 2048;
const OUTPUT_SUMMARY_MAX_LINES = 20;
const REDACTED = "[REDACTED]";

function usage(): void {
  console.error(
    [
      "usage: flow-agents veritas-governance evidence --artifact-dir DIR [options]",
      "",
      "Options:",
      "  --artifact-dir DIR              Workflow artifact directory containing sidecars.",
      "  --evidence-path FILE            Evidence sidecar path. Defaults to DIR/evidence.json.",
      "  --task-slug SLUG                Defaults to state.json task_slug or artifact dir name.",
      "  --veritas-bin PATH              Veritas executable. Defaults to veritas.",
      "  --repo-root DIR                 Repository root used as Veritas working directory.",
      "  --veritas-root DIR              Append --root DIR to the Veritas command.",
      "  --veritas-artifact FILE         Native Veritas artifact to reference and freshness-check.",
      "  --max-age-seconds N             Mark the check not_verified when the artifact is stale.",
      "  --skip                         Record a skipped policy check without invoking Veritas.",
      "  --not-configured               Record not_verified for an intentionally unconfigured provider.",
    ].join("\n")
  );
}

function readTaskSlug(artifactDir: string, fallback?: string): string {
  if (fallback) return fallback;
  const statePath = path.join(artifactDir, "state.json");
  if (fs.existsSync(statePath)) {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as { task_slug?: string };
    if (parsed.task_slug) return parsed.task_slug;
  }
  return path.basename(path.resolve(artifactDir));
}

function ensureParent(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function commandString(veritasBin: string, veritasRoot?: string): string {
  return ["veritas", "readiness", "--check", "evidence", "--working-tree", veritasRoot ? `--root ${veritasRoot}` : ""]
    .filter(Boolean)
    .join(" ")
    .replace(/^veritas/, veritasBin);
}

function artifactEvidenceRef(file: string): EvidenceRef {
  return { kind: "artifact", file, summary: file };
}

function resolveFromBase(file: string, base: string): string {
  return path.isAbsolute(file) ? file : path.resolve(base, file);
}

function artifactRef(file: string, repoRoot: string): string {
  return resolveFromBase(file, repoRoot);
}

function notVerifiedPayload(taskSlug: string, command: string, summary: string, repoRoot: string, artifact?: string): EvidencePayload {
  return {
    schema_version: "1.0",
    task_slug: taskSlug,
    verdict: "not_verified",
    checks: [
      {
        id: "veritas-governance-evidence",
        kind: "policy",
        status: "not_verified",
        command,
        summary,
        ...(artifact ? { artifact_refs: [artifactEvidenceRef(artifactRef(artifact, repoRoot))] } : {}),
      },
    ],
    not_verified_gaps: [summary],
  };
}

function writeEvidence(file: string, payload: EvidencePayload): void {
  ensureParent(file);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function artifactProblem(nativeArtifact: string | undefined, maxAgeSeconds: number | undefined, repoRoot: string): string | undefined {
  if (!nativeArtifact) return undefined;
  const resolved = resolveFromBase(nativeArtifact, repoRoot);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? `Veritas readiness completed, but the expected native artifact is missing: ${resolved}.`
      : `Veritas readiness completed, but the expected native artifact is unreadable: ${resolved}.`;
  }
  if (!stat.isFile()) return `Veritas readiness completed, but the expected native artifact is not a file: ${resolved}.`;
  try {
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch {
    return `Veritas readiness completed, but the expected native artifact is unreadable: ${resolved}.`;
  }
  if (maxAgeSeconds !== undefined && maxAgeSeconds >= 0) {
    const ageSeconds = (Date.now() - stat.mtimeMs) / 1000;
    if (ageSeconds > maxAgeSeconds) {
      return `Veritas native artifact is stale: ${resolved} is ${Math.floor(ageSeconds)}s old, max age is ${maxAgeSeconds}s.`;
    }
  }
  return undefined;
}

function successPayload(taskSlug: string, command: string, repoRoot: string, nativeArtifact?: string): EvidencePayload {
  const ref = nativeArtifact ? artifactRef(nativeArtifact, repoRoot) : "veritas://readiness/evidence";
  const evidenceRef: EvidenceRef = nativeArtifact ? artifactEvidenceRef(ref) : { kind: "external", url: ref, summary: "Veritas readiness evidence." };
  return {
    schema_version: "1.0",
    task_slug: taskSlug,
    verdict: "pass",
    checks: [
      {
        id: "veritas-governance-evidence",
        kind: "policy",
        status: "pass",
        command,
        summary: "Veritas readiness evidence completed without blocking findings.",
        artifact_refs: nativeArtifact ? [evidenceRef] : undefined,
        standard_refs: [
          {
            standard: "veritas",
            ref,
            role: "native",
            summary: "Native Veritas readiness evidence artifact.",
          },
        ],
      },
    ],
    external_evidence: nativeArtifact
      ? [
          {
            system: "veritas",
            ref: evidenceRef,
            summary: "Native Veritas readiness evidence artifact.",
            standard: "veritas",
          },
        ]
      : undefined,
  };
}

function skipPayload(taskSlug: string, command: string, notConfigured: boolean): EvidencePayload {
  const summary = notConfigured
    ? "Veritas governance evidence was requested, but Veritas is not configured for this repository."
    : "Veritas governance evidence was explicitly skipped by caller request.";
  return {
    schema_version: "1.0",
    task_slug: taskSlug,
    verdict: notConfigured ? "not_verified" : "partial",
    checks: [
      {
        id: "veritas-governance-evidence",
        kind: "policy",
        status: notConfigured ? "not_verified" : "skip",
        command,
        summary,
      },
    ],
    ...(notConfigured ? { not_verified_gaps: [summary] } : {}),
  };
}

function parseEvidenceOptions(argv: string[]): EvidenceOptions | undefined {
  const [subcommand, ...rest] = argv;
  if (subcommand !== "evidence") {
    usage();
    return undefined;
  }
  const { flags } = parseArgs(rest);
  const artifactDirFlag = flagString(flags, "artifact-dir");
  if (!artifactDirFlag) {
    usage();
    return undefined;
  }
  const artifactDir = path.resolve(artifactDirFlag);
  const repoRoot = path.resolve(flagString(flags, "repo-root", ".") ?? ".");
  const evidencePathFlag = flagString(flags, "evidence-path");
  const maxAgeRaw = flagString(flags, "max-age-seconds");
  const maxAgeSeconds = maxAgeRaw === undefined ? undefined : Number(maxAgeRaw);
  if (maxAgeRaw !== undefined && !Number.isFinite(maxAgeSeconds)) throw new Error("--max-age-seconds must be a number");
  return {
    artifactDir,
    evidencePath: path.resolve(evidencePathFlag ?? path.join(artifactDir, "evidence.json")),
    taskSlug: readTaskSlug(artifactDir, flagString(flags, "task-slug")),
    veritasBin: flagString(flags, "veritas-bin", "veritas") ?? "veritas",
    repoRoot,
    veritasRoot: flagString(flags, "veritas-root"),
    nativeArtifact: flagString(flags, "veritas-artifact"),
    maxAgeSeconds,
    skip: flagBool(flags, "skip"),
    notConfigured: flagBool(flags, "not-configured"),
  };
}

function outputSummary(result: ReturnType<typeof spawnSync>): string {
  const raw = `${result.stdout ?? ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
  if (!raw) return "";
  const redacted = redactSecrets(raw);
  const bounded = boundOutput(redacted);
  return bounded.truncated ? `${bounded.text}\n[Output truncated for evidence sidecar.]` : bounded.text;
}

function redactSecrets(value: string): string {
  return value
    .replace(/\b(?:api[_-]?key|token|secret|password|passwd|pwd|authorization)\s*[:=]\s*["']?[^"'\s]+/gi, (match) => {
      const separator = match.includes("=") ? "=" : ":";
      return `${match.slice(0, match.indexOf(separator) + 1)}${REDACTED}`;
    })
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs]|glpat)-[A-Za-z0-9_=-]{12,}\b/g, REDACTED)
    .replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, REDACTED);
}

function boundOutput(value: string): { text: string; truncated: boolean } {
  const lines = value.split(/\r?\n/);
  const lineBounded = lines.slice(0, OUTPUT_SUMMARY_MAX_LINES).join("\n");
  const bytes = Buffer.byteLength(lineBounded, "utf8");
  if (lines.length <= OUTPUT_SUMMARY_MAX_LINES && bytes <= OUTPUT_SUMMARY_MAX_BYTES) {
    return { text: lineBounded, truncated: false };
  }
  let text = lineBounded;
  if (bytes > OUTPUT_SUMMARY_MAX_BYTES) {
    text = Buffer.from(lineBounded, "utf8").subarray(0, OUTPUT_SUMMARY_MAX_BYTES).toString("utf8");
  }
  return { text, truncated: true };
}

function runEvidence(options: EvidenceOptions): number {
  const commandText = commandString(options.veritasBin, options.veritasRoot);

  if (options.skip || options.notConfigured) {
    writeEvidence(options.evidencePath, skipPayload(options.taskSlug, commandText, options.notConfigured));
    console.log(`Wrote Veritas governance evidence sidecar: ${options.evidencePath}`);
    return 0;
  }

  const args = ["readiness", "--check", "evidence", "--working-tree", ...(options.veritasRoot ? ["--root", options.veritasRoot] : [])];
  const result = spawnSync(options.veritasBin, args, { cwd: options.repoRoot, encoding: "utf8" });
  if (result.error) {
    const summary = `Unable to run Veritas executable '${options.veritasBin}': ${result.error.message}. Configure --veritas-bin or run with --not-configured when governance evidence is optional.`;
    writeEvidence(options.evidencePath, notVerifiedPayload(options.taskSlug, commandText, summary, options.repoRoot, options.nativeArtifact));
    console.log(`Wrote Veritas governance evidence sidecar: ${options.evidencePath}`);
    return 0;
  }
  if ((result.status ?? 1) !== 0) {
    const output = outputSummary(result);
    const summary = `Veritas readiness returned exit status ${result.status ?? "unknown"}${output ? ` with summarized output:\n${output}` : "."}`;
    writeEvidence(options.evidencePath, notVerifiedPayload(options.taskSlug, commandText, summary, options.repoRoot, options.nativeArtifact));
    console.log(`Wrote Veritas governance evidence sidecar: ${options.evidencePath}`);
    return 0;
  }
  const problem = artifactProblem(options.nativeArtifact, options.maxAgeSeconds, options.repoRoot);
  if (problem) {
    writeEvidence(options.evidencePath, notVerifiedPayload(options.taskSlug, commandText, problem, options.repoRoot, options.nativeArtifact));
    console.log(`Wrote Veritas governance evidence sidecar: ${options.evidencePath}`);
    return 0;
  }
  writeEvidence(options.evidencePath, successPayload(options.taskSlug, commandText, options.repoRoot, options.nativeArtifact));
  console.log(`Wrote Veritas governance evidence sidecar: ${options.evidencePath}`);
  return 0;
}

export function main(argv = process.argv.slice(2)): number {
  const options = parseEvidenceOptions(argv);
  return options ? runEvidence(options) : 2;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
