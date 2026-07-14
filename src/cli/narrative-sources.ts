import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { atomicWriteFile } from "../lib/fs.js";
import { parseArgs, flagBool, flagList, flagString } from "../lib/args.js";
import { flowAgentsArtifactRoot } from "../lib/local-artifact-root.js";
import type { CaptureCompleteness } from "../narrative/integrity.js";
import { effectiveNarrativeRedactionFields } from "../narrative/policy-filter.js";
import { projectRuntimeNarrative, stableStringify, validateNarrativeRuntimeProjection } from "../narrative/projection.js";
import { resolveSource, verifyManifest } from "../narrative/resolver.js";
import { snapshotNarrative, type NarrativeSourceRoots } from "../narrative/snapshot.js";
import { parseSourceId } from "../narrative/source-ids.js";

function packageVersion(): string {
  try {
    const packageFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../package.json");
    return String((JSON.parse(fs.readFileSync(packageFile, "utf8")) as { version?: unknown }).version ?? "unknown");
  } catch { return "unknown"; }
}

function usage(): void {
  console.error(`usage: flow-agents narrative-sources <snapshot|resolve|verify|project> [options]

snapshot:
  (--session-slug SLUG | --artifact-root PATH) --narrative-id ID --source FA1 [--source FA1 ...]
  [--telemetry-root PATH] [--session-root PATH] [--flow-root PATH]
  [--transcript-path FILE] [--repo-root PATH] [--redact-fields FIELD,...]
  [--allow-transcript-content]  (transcript content is default-deny: without
                                 this grant transcript sources are recorded
                                 path_only as unavailable/redacted)
  [--capture-completeness FILE]
resolve:
  --narrative-dir PATH --source-id FA1 (--out FILE | --json)
project:
  --narrative-dir PATH (--out FILE | --json) [--projected-at DATE-TIME]
verify:
  --narrative-dir PATH --json`);
}

function required(flags: ReturnType<typeof parseArgs>["flags"], name: string): string {
  const value = flagString(flags, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function readCaptureCompleteness(file: string | undefined): CaptureCompleteness {
  if (!file) return { channels: {}, known_gaps: [] };
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("capture completeness must be a JSON object");
  return parsed as CaptureCompleteness;
}

function snapshot(flags: ReturnType<typeof parseArgs>["flags"]): number {
  const sessionSlug = flagString(flags, "session-slug");
  const explicitArtifactRoot = flagString(flags, "artifact-root");
  if (Boolean(sessionSlug) === Boolean(explicitArtifactRoot)) throw new Error("exactly one of --session-slug or --artifact-root is required");
  if (sessionSlug && (sessionSlug.includes("/") || sessionSlug.includes("\\") || sessionSlug === "." || sessionSlug === "..")) throw new Error("--session-slug must be a single path component");
  const narrativeId = required(flags, "narrative-id");
  if (narrativeId.includes("/") || narrativeId.includes("\\") || narrativeId === "." || narrativeId === "..") throw new Error("--narrative-id must be a single path component");
  const sourceTexts = flagList(flags, "source");
  if (!sourceTexts.length) throw new Error("at least one --source is required");
  if (new Set(sourceTexts).size !== sourceTexts.length) throw new Error("--source values must be unique");

  const artifactRoot = explicitArtifactRoot ? path.resolve(explicitArtifactRoot) : flowAgentsArtifactRoot();
  const sessionDir = sessionSlug ? path.join(artifactRoot, sessionSlug) : flagString(flags, "session-root");
  const narrativeDir = sessionSlug
    ? path.join(artifactRoot, sessionSlug, "narrative", narrativeId)
    : path.join(artifactRoot, "narrative", narrativeId);
  const roots: NarrativeSourceRoots = {
    telemetryDir: flagString(flags, "telemetry-root"), sessionDir,
    flowRoot: flagString(flags, "flow-root"), transcriptPath: flagString(flags, "transcript-path"),
    repoRoot: flagString(flags, "repo-root"),
  };
  const narrativeFields = (flagString(flags, "redact-fields") ?? "").split(",").map((field) => field.trim()).filter(Boolean);
  const redactionFields = effectiveNarrativeRedactionFields(narrativeFields);
  const result = snapshotNarrative({
    narrativeDir, narrativeId, requests: sourceTexts.map((source) => ({ source: parseSourceId(source), roots })), redactionFields,
    compiler: {
      name: "@kontourai/flow-agents", version: packageVersion(),
      policy_hash: createHash("sha256").update(JSON.stringify(redactionFields)).digest("hex"),
    },
    captureCompleteness: readCaptureCompleteness(flagString(flags, "capture-completeness")),
    allowTranscriptContent: flagBool(flags, "allow-transcript-content"),
  });
  console.log(JSON.stringify(result));
  return 0;
}

function resolve(flags: ReturnType<typeof parseArgs>["flags"]): number {
  const narrativeDir = required(flags, "narrative-dir");
  const sourceId = required(flags, "source-id");
  const out = flagString(flags, "out");
  const json = flagBool(flags, "json");
  if (Boolean(out) === json) throw new Error("exactly one of --out or --json is required");
  const result = resolveSource(narrativeDir, sourceId);
  if (result.status === "unavailable") {
    console.log(JSON.stringify(result));
    return 2;
  }
  if (out) atomicWriteFile(path.dirname(path.resolve(out)), path.resolve(out), Buffer.from(result.content));
  const { content: _content, ...metadata } = result;
  console.log(JSON.stringify(metadata));
  return 0;
}

function verify(flags: ReturnType<typeof parseArgs>["flags"]): number {
  const narrativeDir = required(flags, "narrative-dir");
  if (!flagBool(flags, "json")) throw new Error("--json is required");
  const report = verifyManifest(narrativeDir);
  console.log(JSON.stringify(report));
  return report.ok ? 0 : 2;
}

function projectNarrative(flags: ReturnType<typeof parseArgs>["flags"]): number {
  const narrativeDir = required(flags, "narrative-dir");
  const out = flagString(flags, "out");
  const json = flagBool(flags, "json");
  if (Boolean(out) === json) throw new Error("exactly one of --out or --json is required");
  const projectedAt = flagString(flags, "projected-at") ?? new Date().toISOString();
  const projection = projectRuntimeNarrative(narrativeDir, { projectedAt });
  const issues = validateNarrativeRuntimeProjection(projection);
  if (issues.length > 0) {
    throw new Error(`narrative runtime projection validation failed: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  }
  const serialized = `${stableStringify(projection)}\n`;
  if (out) atomicWriteFile(path.dirname(path.resolve(out)), path.resolve(out), Buffer.from(serialized));
  else process.stdout.write(serialized);
  return 0;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  const verb = args.positionals[0];
  try {
    if (verb === "snapshot") return snapshot(args.flags);
    if (verb === "resolve") return resolve(args.flags);
    if (verb === "project") return projectNarrative(args.flags);
    if (verb === "verify") return verify(args.flags);
    usage();
    return 64;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "narrative source command failed");
    return 64;
  }
}
