import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { assertPathContained } from "../lib/fs.js";
import type { IntegrityClass, UnavailableReason } from "./integrity.js";
import {
  validateNarrativeSourceManifest,
  type NarrativeLineageEvent,
  type NarrativeSourceManifest,
  type NarrativeSourceManifestEntry,
  type NarrativeSourceOrigin,
} from "./snapshot.js";

export type ResolveSourceResult =
  | {
      status: "resolved";
      sourceId: string;
      integrityClass: IntegrityClass;
      sha256: string;
      content: Uint8Array;
      capturedAt: string;
      origin: NarrativeSourceOrigin;
      lineage: NarrativeLineageEvent[];
    }
  | { status: "unavailable"; sourceId: string; reason: UnavailableReason; detail: string };

export interface ResolveSourceOptions { scope?: string }

export interface VerifyManifestReport {
  ok: boolean;
  perSource: Array<{ sourceId: string; status: "resolved" | "unavailable"; reason?: UnavailableReason }>;
}

function unavailable(sourceId: string, reason: UnavailableReason, detail: string): ResolveSourceResult {
  return { status: "unavailable", sourceId, reason, detail };
}

function readRegularFile(file: string): Buffer {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("not a regular file");
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error("not a regular file");
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function safeNarrativeDir(narrativeDir: string, scope?: string): string {
  const real = fs.realpathSync(narrativeDir);
  if (!fs.lstatSync(real).isDirectory()) throw new Error("narrative directory is invalid");
  if (scope) assertPathContained(fs.realpathSync(scope), real);
  return real;
}

function readManifest(narrativeDir: string): { manifest?: NarrativeSourceManifest; malformedIds: string[] } {
  const bytes = readRegularFile(path.join(narrativeDir, "source-manifest.json"));
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { return { malformedIds: [] }; }
  const malformedIds = parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).sources)
    ? ((parsed as Record<string, unknown>).sources as unknown[]).map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "manifest";
        const sourceId = (entry as Record<string, unknown>).source_id;
        return typeof sourceId === "string" && sourceId.startsWith("fa1:") ? sourceId : "manifest";
      })
    : [];
  if (validateNarrativeSourceManifest(parsed).length) return { malformedIds };
  return { manifest: parsed as NarrativeSourceManifest, malformedIds: [] };
}

export function resolveSource(narrativeDir: string, sourceId: string, opts: ResolveSourceOptions = {}): ResolveSourceResult {
  let root: string;
  try { root = safeNarrativeDir(narrativeDir, opts.scope); }
  catch { return unavailable(sourceId, "unauthorized", "narrative directory is outside the authorized artifact scope"); }

  let manifest: NarrativeSourceManifest | undefined;
  try { manifest = readManifest(root).manifest; }
  catch { return unavailable(sourceId, "corrupt", "source manifest could not be read safely"); }
  if (!manifest) return unavailable(sourceId, "corrupt", "source manifest is malformed");
  const matches = manifest.sources.filter((entry) => entry.source_id === sourceId);
  if (matches.length === 0) return unavailable(sourceId, "not_captured", "source id is not present in the manifest");
  if (matches.length !== 1) return unavailable(sourceId, "corrupt", "source id is not unique in the manifest");
  const entry = matches[0];
  if (entry.status === "unavailable") return unavailable(sourceId, entry.unavailable_reason, "source was recorded as unavailable during snapshot");
  return resolveEntry(root, entry);
}

function resolveEntry(root: string, entry: Extract<NarrativeSourceManifestEntry, { status: "snapshotted" }>): ResolveSourceResult {
  const blob = path.join(root, "sources", entry.sha256);
  let bytes: Buffer;
  try {
    assertPathContained(root, blob);
    bytes = readRegularFile(blob);
  } catch {
    return unavailable(entry.source_id, "corrupt", "snapshot blob could not be read safely");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== entry.sha256 || bytes.length !== entry.bytes) return unavailable(entry.source_id, "corrupt", "snapshot blob integrity check failed");
  return {
    status: "resolved", sourceId: entry.source_id, integrityClass: entry.integrity_class,
    sha256: entry.sha256, content: bytes, capturedAt: entry.captured_at,
    origin: entry.origin, lineage: entry.lineage ?? [],
  };
}

export function verifyManifest(narrativeDir: string): VerifyManifestReport {
  let root: string;
  try { root = safeNarrativeDir(narrativeDir); }
  catch { return { ok: false, perSource: [{ sourceId: "manifest", status: "unavailable", reason: "corrupt" }] }; }
  let read: ReturnType<typeof readManifest>;
  try { read = readManifest(root); }
  catch { return { ok: false, perSource: [{ sourceId: "manifest", status: "unavailable", reason: "corrupt" }] }; }
  if (!read.manifest) {
    const ids = read.malformedIds.length ? read.malformedIds : ["manifest"];
    return { ok: false, perSource: ids.map((sourceId) => ({ sourceId, status: "unavailable", reason: "corrupt" })) };
  }
  const perSource = read.manifest.sources.map((entry) => {
    const result = resolveSource(root, entry.source_id);
    return result.status === "resolved"
      ? { sourceId: entry.source_id, status: "resolved" as const }
      : { sourceId: entry.source_id, status: "unavailable" as const, reason: result.reason };
  });
  return { ok: perSource.every((result) => result.status === "resolved"), perSource };
}
