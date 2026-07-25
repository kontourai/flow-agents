import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { containsSensitiveCredential } from "./run-correlation.js";
import {
  confinedSourceFile,
  readPinnedFile,
  type DirectoryIdentity,
} from "./retrospective-observation-filesystem.js";

export const RETROSPECTIVE_SOURCE_KINDS = [
  "runtime_events",
  "builder_state",
  "trust_bundle",
  "flow_state",
  "flow_evidence_manifest",
  "economics",
  "terminal_outcome",
] as const;

const MAX_OBSERVATION_DIAGNOSTICS = 1000;
export type RetrospectiveSourceKind = (typeof RETROSPECTIVE_SOURCE_KINDS)[number];
type JsonRecord = Record<string, unknown>;

type SourceDeclaration = {
  source_id: string;
  file: string;
};

export type RetrospectiveObservationManifest = {
  schema_version: "1.0";
  correlation_id: string;
  sources: Partial<Record<RetrospectiveSourceKind, SourceDeclaration>>;
};

export type ObservationDiagnostic = {
  source_id: string;
  line: number;
  content_sha256: string;
  error: string;
};

export type LoadedRecord = {
  value: JsonRecord;
  line: number;
  content_sha256: string;
};

export type LoadedSource = {
  kind: RetrospectiveSourceKind;
  source_id: string;
  file: string;
  content_sha256: string;
  total_records: number;
  records: LoadedRecord[];
  diagnostics: ObservationDiagnostic[];
  directory_chain: DirectoryIdentity[];
  malformed_records: number;
  invalid_records: number;
};

export function readRetrospectiveObservationManifest(file: string): RetrospectiveObservationManifest {
  const bytes = readPinnedFile(path.resolve(file), "observation manifest", 1024 * 1024);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("observation manifest is malformed (SyntaxError)");
  }
  if (!isRecord(value)) throw new Error("observation manifest must be an object");
  assertExactKeys(value, ["schema_version", "correlation_id", "sources"], "observation manifest");
  if (value.schema_version !== "1.0") throw new Error("observation manifest schema_version must be 1.0");
  assertPublicId(value.correlation_id, "observation manifest correlation_id");
  if (!isRecord(value.sources)) throw new Error("observation manifest sources must be an object");
  assertExactKeys(value.sources, RETROSPECTIVE_SOURCE_KINDS, "observation manifest sources");
  return {
    schema_version: "1.0",
    correlation_id: value.correlation_id,
    sources: parseSourceDeclarations(value.sources),
  };
}

export function loadRetrospectiveSources(
  manifest: RetrospectiveObservationManifest,
  recordRoot: string,
): LoadedSource[] {
  validateManifest(manifest);
  let root: string;
  try {
    root = fs.realpathSync(path.resolve(recordRoot));
    if (!fs.statSync(root).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new Error(`record root is unavailable (${errorClass(error)})`);
  }
  return RETROSPECTIVE_SOURCE_KINDS.flatMap((kind) => {
    const declaration = manifest.sources[kind];
    if (!declaration) return [];
    const confined = confinedSourceFile(root, declaration.file, kind);
    return [loadSource(kind, declaration.source_id, confined.file, confined.directoryChain)];
  });
}

export function quarantineLoadedRecord(
  source: LoadedSource,
  record: LoadedRecord,
  error: unknown,
): void {
  source.invalid_records += 1;
  if (source.diagnostics.length < MAX_OBSERVATION_DIAGNOSTICS) {
    source.diagnostics.push({
      source_id: source.source_id,
      line: record.line,
      content_sha256: record.content_sha256,
      error: error instanceof SyntaxError ? "SyntaxError" : "ProducerValidationError",
    });
  }
}

export function sortedObservationDiagnostics(
  values: ObservationDiagnostic[],
): ObservationDiagnostic[] {
  const unique = new Map<string, ObservationDiagnostic>();
  for (const value of values) {
    unique.set(`${value.source_id}\0${value.line}\0${value.content_sha256}\0${value.error}`, value);
  }
  return [...unique.values()].sort((left, right) => (
    left.source_id.localeCompare(right.source_id)
    || left.line - right.line
    || left.content_sha256.localeCompare(right.content_sha256)
  ));
}

function parseSourceDeclarations(value: JsonRecord): Partial<Record<RetrospectiveSourceKind, SourceDeclaration>> {
  const sources: Partial<Record<RetrospectiveSourceKind, SourceDeclaration>> = {};
  for (const kind of RETROSPECTIVE_SOURCE_KINDS) {
    const declaration = value[kind];
    if (declaration === undefined) continue;
    if (!isRecord(declaration)) throw new Error(`observation manifest source ${kind} must be an object`);
    assertExactKeys(declaration, ["source_id", "file"], `observation manifest source ${kind}`);
    assertPublicId(declaration.source_id, `observation manifest source ${kind} source_id`);
    assertRelativeSourcePath(declaration.file, `observation manifest source ${kind} file`);
    sources[kind] = { source_id: declaration.source_id, file: declaration.file };
  }
  return sources;
}

function validateManifest(manifest: RetrospectiveObservationManifest): void {
  if (!isRecord(manifest) || manifest.schema_version !== "1.0" || !isRecord(manifest.sources)) {
    throw new Error("manifest shape is invalid");
  }
  assertPublicId(manifest.correlation_id, "manifest correlation_id");
  assertExactKeys(manifest.sources, RETROSPECTIVE_SOURCE_KINDS, "manifest sources");
  for (const kind of RETROSPECTIVE_SOURCE_KINDS) {
    const declaration = manifest.sources[kind];
    if (!declaration) continue;
    if (!isRecord(declaration)) throw new Error(`manifest source ${kind} must be an object`);
    assertExactKeys(declaration, ["source_id", "file"], `manifest source ${kind}`);
    assertPublicId(declaration.source_id, `manifest source ${kind} source_id`);
    assertRelativeSourcePath(declaration.file, `manifest source ${kind} file`);
  }
}

function loadSource(
  kind: RetrospectiveSourceKind,
  sourceId: string,
  file: string,
  directoryChain: DirectoryIdentity[],
): LoadedSource {
  const bytes = readPinnedFile(file, `${kind} source`, 16 * 1024 * 1024, directoryChain);
  const jsonl = kind === "runtime_events" || kind === "economics";
  const lines = jsonl ? bytes.toString("utf8").split(/\r?\n/) : [bytes.toString("utf8")];
  const records: LoadedRecord[] = [];
  const diagnostics: ObservationDiagnostic[] = [];
  let totalRecords = 0;
  let malformedRecords = 0;
  lines.forEach((line, index) => {
    if (jsonl && line.length === 0) return;
    totalRecords += 1;
    const contentSha256 = sha256(line);
    try {
      const value = JSON.parse(line) as unknown;
      if (!isRecord(value)) throw new TypeError("record must be a JSON object");
      records.push({ value, line: index + 1, content_sha256: contentSha256 });
    } catch (error) {
      malformedRecords += 1;
      if (diagnostics.length < MAX_OBSERVATION_DIAGNOSTICS) {
        diagnostics.push({
          source_id: sourceId,
          line: index + 1,
          content_sha256: contentSha256,
          error: error instanceof SyntaxError ? "SyntaxError" : "ProducerValidationError",
        });
      }
    }
  });
  return {
    kind,
    source_id: sourceId,
    file,
    content_sha256: sha256(bytes),
    total_records: totalRecords,
    records,
    diagnostics,
    directory_chain: directoryChain,
    malformed_records: malformedRecords,
    invalid_records: 0,
  };
}

function assertPublicId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/.test(value)
    || containsSensitiveCredential(value)) {
    throw new Error(`${label} must be a bounded non-sensitive opaque identifier`);
  }
}

function assertRelativeSourcePath(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > 4096
    || value.includes("\0")
    || path.isAbsolute(value)
    || value.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must be a bounded relative path without traversal`);
  }
}

function assertExactKeys(value: JsonRecord, allowed: readonly string[], label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${label} contains unsupported field ${extras[0]}`);
}

function errorClass(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code)) {
    return error.code;
  }
  return error instanceof Error ? error.name : "UnknownError";
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
