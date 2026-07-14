import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { assertPathContained } from "../lib/fs.js";
import { parseSourceId } from "./source-ids.js";
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
  perSource: Array<{
    sourceId: string;
    status: "resolved" | "unavailable";
    reason?: UnavailableReason;
    /**
     * Post-compile divergence between the frozen snapshot and its raw origin,
     * e.g. `raw_source_rotated_away` once telemetry rotation deletes the log.
     * Reported here (the manifest itself is frozen and never mutated).
     */
    lineageNote?: "raw_source_rotated_away";
  }>;
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
    const opened = fs.fstatSync(descriptor);
    // The descriptor must be the same inode the pre-open lstat admitted.
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("file changed between validation and read");
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
  const sourcesDir = path.join(root, "sources");
  const blob = path.join(sourcesDir, entry.sha256);
  let bytes: Buffer;
  try {
    // The blob's ancestor must be a real directory inside the narrative dir —
    // a symlinked sources/ would silently serve content from elsewhere.
    const dirStat = fs.lstatSync(sourcesDir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error("sources directory is not a real directory");
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
    const lineageNote = rawSourceRotatedAway(entry) ? ({ lineageNote: "raw_source_rotated_away" as const }) : {};
    return result.status === "resolved"
      ? { sourceId: entry.source_id, status: "resolved" as const, ...lineageNote }
      : { sourceId: entry.source_id, status: "unavailable" as const, reason: result.reason, ...lineageNote };
  });
  return { ok: perSource.every((result) => result.status === "resolved"), perSource };
}

function rawSourceRotatedAway(entry: NarrativeSourceManifestEntry): boolean {
  if (entry.status !== "snapshotted") return false;
  const originPath = entry.origin?.path;
  if (typeof originPath !== "string") return false;
  if (!fs.existsSync(originPath)) return true;
  // Telemetry origins record the log directory; the rotatable stores are the
  // channel files inside it, so divergence means no channel file remains.
  if (entry.origin.store !== "telemetry") return false;
  try {
    const parsed = parseSourceId(entry.source_id);
    if (parsed.stream !== "telemetry") return false;
    const names = fs.readdirSync(originPath);
    const channel = parsed.scope.channel;
    return !names.some((name) => name === `${channel}.jsonl` || new RegExp(`^${channel}\\.[1-9][0-9]*\\.jsonl$`).test(name));
  } catch {
    return false;
  }
}
