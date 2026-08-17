/**
 * console-declared-projection — project delivery/DECLARED accepted gaps as aging records a
 * Console can render (issue #1267, "Risks Standing").
 *
 * WHAT THIS IS: a TRANSPORT-AGNOSTIC FOLD of current state (docs/decisions/
 * console-record-delivery.md, epic #1087 slice C). The gap projection is derived entirely from
 * the committed `delivery/DECLARED` marker (ADR 0022 §2) and is therefore self-healing: any
 * successful emission repairs every prior miss, so best-effort delivery is the CORRECT class —
 * dropping one emission costs freshness, never correctness. The fold itself
 * (`buildDeclaredGapProjection`) is a pure function of the marker's entries; the local
 * projection file this CLI writes is an acceptable INTERIM carrier only — the
 * `console-*-projection` scrape path is slated for retirement (#1086/#1087 slice E), and when
 * it retires the same fold emits through whatever transport replaces it.
 *
 * UPSERT SEMANTICS (per-scope, #1087 slice C): the destination is
 * `<kontour-root>/projections/<producer>/<scope-kind>-<scope-id>.json` — ONE file per scope,
 * REPLACED wholesale on every run (never appended). Consumers treat each emission as the
 * complete current gap state for that scope; a gap absent from the newest projection is a gap
 * no longer declared, and a stale projection can only ever lag, not lie. Record ids are
 * content-derived (sha256 of scope + gap text), so the same declared gap keeps the same id
 * across emissions and a hosted `on conflict do update` upsert converges.
 *
 * NO PROSE SCRAPING: only entries carrying the structured optional `gaps: []` array (an array
 * of non-empty strings — see ADR 0022 addendum part 6 and delivery/README.md) are projected.
 * Legacy entries whose `reason` prose merely NAMES a gap are never parsed for it; they are
 * counted and disclosed in the summary (`legacy_entries_not_projected`) so their absence from
 * the projection is visible, not silent.
 *
 * AGING: each record carries its entry's `declared_at` verbatim; age is derived by the
 * renderer against the envelope's `generatedAt`. The fold never bakes a computed age into the
 * record — that would freeze staleness at emission time.
 *
 * FAIL-VISIBLE ON CORRUPTION: an unreadable or JSON-invalid marker is an ERROR (exit 1, no
 * write) — it must NOT upsert an empty projection over real state, which would make every
 * standing gap silently vanish on a parse error. A genuinely ABSENT marker is a real "no
 * declared exemptions" state and projects zero gaps.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { flagBool, flagString, parseArgs } from "../lib/args.js";
import { projectionTimestamp } from "../lib/workflow-trust-projection.js";

type DeclaredEntry = {
  scope: string;
  reason: string;
  approved_by: string;
  declared_at: string;
  gaps?: string[];
};

export type DeclaredGapRecord = {
  id: string;
  family: "delivery";
  nonAuthority: true;
  gap: string;
  source: "delivery/DECLARED";
  scope: string;
  declared_at: string;
  approved_by: string;
};

export type DeclaredGapProjectionEnvelope = {
  schema: "kontour.console.projection";
  version: "0.1";
  generatedAt: string;
  scope: { kind: string; id: string };
  producer: { id: string; product: "flow-agents" };
  derivedFrom: {
    mode: "direct_snapshot";
    eventHistory: "unavailable";
    directSnapshot: {
      id: string;
      emittedAt: string;
      producer: { id: string; product: "flow-agents" };
      reason: string;
      sourceRef: { product: "flow-agents"; kind: string; id: string; label: string };
    };
  };
  gaps: DeclaredGapRecord[];
};

export type ReadDeclaredEntriesResult = {
  entries: DeclaredEntry[];
  entriesTotal: number;
  legacyEntries: number;
  invalidEntries: number;
  warnings: string[];
};

type Summary = {
  scanned_entry_count: number;
  structured_gap_entry_count: number;
  legacy_entries_not_projected: number;
  invalid_entries_not_projected: number;
  emitted_gap_count: number;
  destination: string | null;
  producer: string;
  scope: { kind: string; id: string };
  dry_run: boolean;
  warnings: string[];
};

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const DEFAULT_KONTOUR_ROOT = path.join(".kontourai", "console");
const DEFAULT_DECLARED_PATH = path.join("delivery", "DECLARED");
/** Required fields on every well-formed delivery/DECLARED entry (ADR 0022 §2 — same normative
 * definition scripts/ci/trust-reconcile.js and scripts/hooks/lib/unstarted-delivery.js apply). */
const DECLARED_REQUIRED_FIELDS = ["scope", "reason", "approved_by", "declared_at"] as const;

function printHelp(): void {
  console.log("Usage: flow-agents console-declared-projection [options]");
  console.log("");
  console.log("Project delivery/DECLARED accepted gaps (structured gaps[] entries only) as aging Console records (issue #1267).");
  console.log("");
  console.log("Options:");
  console.log(`  --declared <path>       delivery/DECLARED marker file to fold (default: ${DEFAULT_DECLARED_PATH})`);
  console.log(`  --kontour-root <path>   Local Kontour root to write under (default: ${DEFAULT_KONTOUR_ROOT})`);
  console.log("  --out <file>            Override the projection file; use '-' for stdout");
  console.log("  --scope <id>            Projection scope id (default: current directory name)");
  console.log("  --scope-kind <kind>     Projection scope kind (default: repo)");
  console.log("  --producer <id>         Projection producer id (default: flow-agents-declared)");
  console.log("  --generated-at <ISO>    Override generated timestamp for deterministic output");
  console.log("  --dry-run               Do not write a projection file");
  console.log("  --json                  Print stable JSON summary (file output only)");
  console.log("  --help                  Show this help");
}

function defaultScopeId(): string {
  return path.basename(process.cwd()) || "local";
}

function requireSafeSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error(`${label} must contain only letters, numbers, dot, underscore, or hyphen: ${value}`);
  }
  return value;
}

function ensureNoSymlinkPath(target: string): void {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const parts = path.relative(root, resolved).split(path.sep).filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`refusing to write through symlink path: ${cursor}`);
    }
  }
}

function ensureDirectory(target: string): void {
  ensureNoSymlinkPath(target);
  fs.mkdirSync(target, { recursive: true });
  ensureNoSymlinkPath(target);
  if (!fs.statSync(target).isDirectory()) throw new Error(`destination directory is not a directory: ${target}`);
}

function containedPath(root: string, destination: string): void {
  const relative = path.relative(root, destination);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`destination escapes kontour root: ${destination}`);
  }
}

function defaultDestination(kontourRoot: string, producer: string, scopeKind: string, scopeId: string): string {
  const root = path.resolve(kontourRoot);
  const destination = path.resolve(root, "projections", producer, `${scopeKind}-${scopeId}.json`);
  containedPath(root, destination);
  return destination;
}

function writeProjection(file: string, projection: unknown, kontourRoot?: string): void {
  if (kontourRoot) containedPath(path.resolve(kontourRoot), file);
  ensureDirectory(path.dirname(file));
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
    throw new Error(`refusing to write symlinked projection file: ${file}`);
  }
  fs.writeFileSync(file, `${JSON.stringify(projection, null, 2)}\n`, "utf8");
}

function isWellFormedFourFields(entry: unknown): entry is Record<string, unknown> {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  return DECLARED_REQUIRED_FIELDS.every((field) => {
    const value = (entry as Record<string, unknown>)[field];
    return typeof value === "string" && value.trim() !== "";
  });
}

function entryLabel(entry: unknown, index: number): string {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const scope = (entry as Record<string, unknown>)["scope"];
    if (typeof scope === "string" && scope.trim() !== "") return `scope '${scope}'`;
  }
  return `entry #${index}`;
}

/**
 * Read and classify delivery/DECLARED entries for the gap fold.
 *
 * - Missing file → zero entries, no error (a repo with no marker has no declared gaps).
 * - Unreadable / invalid JSON → THROWS (fail-visible; never fold corruption into "no gaps").
 * - Entry missing any of the four required fields (ADR 0022 §2) → invalid, warned, skipped.
 * - Entry with a `gaps` field that is not an array of non-empty strings → invalid, warned,
 *   skipped (a malformed structured field must not silently degrade to "legacy").
 * - Well-formed entry WITHOUT a `gaps` field → legacy: counted, never prose-scraped.
 * - Well-formed entry WITH `gaps: []` (possibly empty) → structured: its gaps are projected.
 */
export function readDeclaredEntries(markerPath: string): ReadDeclaredEntriesResult {
  const result: ReadDeclaredEntriesResult = { entries: [], entriesTotal: 0, legacyEntries: 0, invalidEntries: 0, warnings: [] };
  if (!fs.existsSync(markerPath)) {
    result.warnings.push(`delivery/DECLARED marker not found at ${markerPath} — projecting zero declared gaps`);
    return result;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch (error) {
    throw new Error(
      `refusing to project: ${markerPath} is not valid JSON (${error instanceof Error ? error.message : String(error)}) — ` +
      "an empty projection over a corrupt marker would silently erase every standing gap",
    );
  }
  const rawEntries = Array.isArray(parsed) ? parsed : [parsed];
  result.entriesTotal = rawEntries.length;
  rawEntries.forEach((raw, index) => {
    if (!isWellFormedFourFields(raw)) {
      result.invalidEntries += 1;
      result.warnings.push(`${entryLabel(raw, index)}: missing required DECLARED field(s) (ADR 0022 §2) — not projected`);
      return;
    }
    const gaps = raw["gaps"];
    if (gaps === undefined) {
      result.legacyEntries += 1;
      return;
    }
    if (!Array.isArray(gaps) || gaps.some((gap) => typeof gap !== "string" || gap.trim() === "")) {
      result.invalidEntries += 1;
      result.warnings.push(`${entryLabel(raw, index)}: gaps must be an array of non-empty strings — not projected`);
      return;
    }
    result.entries.push({
      scope: String(raw["scope"]),
      reason: String(raw["reason"]),
      approved_by: String(raw["approved_by"]),
      declared_at: String(raw["declared_at"]),
      gaps: gaps.map((gap) => String(gap).trim()),
    });
  });
  return result;
}

function gapRecordId(scope: string, gap: string): string {
  const digest = crypto.createHash("sha256").update(JSON.stringify([scope, gap]), "utf8").digest("hex").slice(0, 16);
  return `gap.declared.${digest}`;
}

/**
 * The pure fold: structured DECLARED entries → one aging gap record per declared gap.
 * Deterministic (marker order preserved; ids content-derived) and transport-agnostic — no
 * filesystem, no clock beyond the caller-supplied generatedAt.
 */
export function buildDeclaredGapProjection(
  read: ReadDeclaredEntriesResult,
  options: { scope: { kind: string; id: string }; producer: string; generatedAt: string; declaredPathLabel?: string },
): { projection: DeclaredGapProjectionEnvelope; warnings: string[] } {
  const warnings: string[] = [];
  const records: DeclaredGapRecord[] = [];
  const seen = new Set<string>();
  for (const entry of read.entries) {
    for (const gap of entry.gaps ?? []) {
      const id = gapRecordId(entry.scope, gap);
      if (seen.has(id)) {
        warnings.push(`duplicate declared gap for scope '${entry.scope}': "${gap}" — projected once`);
        continue;
      }
      seen.add(id);
      records.push({
        id,
        family: "delivery",
        nonAuthority: true,
        gap,
        source: "delivery/DECLARED",
        scope: entry.scope,
        declared_at: entry.declared_at,
        approved_by: entry.approved_by,
      });
    }
  }
  const producer = { id: options.producer, product: "flow-agents" as const };
  const projection: DeclaredGapProjectionEnvelope = {
    schema: "kontour.console.projection",
    version: "0.1",
    generatedAt: options.generatedAt,
    scope: options.scope,
    producer,
    derivedFrom: {
      mode: "direct_snapshot",
      eventHistory: "unavailable",
      directSnapshot: {
        id: `declared-gaps.${options.scope.kind}.${options.scope.id}`,
        emittedAt: options.generatedAt,
        producer,
        reason: "Accepted-gap fold of committed delivery/DECLARED structured gaps[] entries (issue #1267); legacy prose entries are disclosed as counts, never scraped.",
        sourceRef: {
          product: "flow-agents",
          kind: "delivery-declared",
          id: options.declaredPathLabel ?? "delivery/DECLARED",
          label: "Committed no-agent-delivery exemption marker (ADR 0022 §2)",
        },
      },
    },
    gaps: records,
  };
  return { projection, warnings };
}

function printWarnings(warnings: string[]): void {
  for (const warning of warnings) console.error(`warning: ${warning}`);
}

function printText(summary: Summary): void {
  console.log(`Scanned DECLARED entries: ${summary.scanned_entry_count}`);
  console.log(`Structured gaps[] entries: ${summary.structured_gap_entry_count}`);
  console.log(`Legacy entries not projected: ${summary.legacy_entries_not_projected}`);
  console.log(`Invalid entries not projected: ${summary.invalid_entries_not_projected}`);
  console.log(`Emitted gap records: ${summary.emitted_gap_count}`);
  if (summary.dry_run) console.log("Dry run: no projection written");
  else console.log(`Projection: ${summary.destination}`);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { flags } = parseArgs(argv);
  if (flagBool(flags, "help") || flagBool(flags, "h")) {
    printHelp();
    return 0;
  }

  try {
    const declaredPath = path.resolve(flagString(flags, "declared", DEFAULT_DECLARED_PATH) ?? DEFAULT_DECLARED_PATH);
    const kontourRoot = path.resolve(flagString(flags, "kontour-root", DEFAULT_KONTOUR_ROOT) ?? DEFAULT_KONTOUR_ROOT);
    const producer = requireSafeSegment(flagString(flags, "producer", "flow-agents-declared") ?? "flow-agents-declared", "--producer");
    const scope = {
      kind: requireSafeSegment(flagString(flags, "scope-kind", "repo") ?? "repo", "--scope-kind"),
      id: requireSafeSegment(flagString(flags, "scope", defaultScopeId()) ?? defaultScopeId(), "--scope"),
    };
    const generatedAt = projectionTimestamp(flagString(flags, "generated-at"));
    const read = readDeclaredEntries(declaredPath);
    const { projection, warnings: foldWarnings } = buildDeclaredGapProjection(read, {
      scope,
      producer,
      generatedAt,
      declaredPathLabel: "delivery/DECLARED",
    });
    const warnings = [...read.warnings, ...foldWarnings];
    const dryRun = flagBool(flags, "dry-run");
    const requestedOut = flagString(flags, "out");
    if (requestedOut === "-" && flagBool(flags, "json")) throw new Error("--json cannot be combined with --out -");
    if (requestedOut === "-" && dryRun) throw new Error("--dry-run cannot be combined with --out -");

    let destination: string | null = null;
    if (!dryRun) {
      if (requestedOut === "-") {
        process.stdout.write(`${JSON.stringify(projection, null, 2)}\n`);
      } else if (requestedOut) {
        destination = path.resolve(requestedOut);
        writeProjection(destination, projection);
      } else {
        destination = defaultDestination(kontourRoot, producer, scope.kind, scope.id);
        writeProjection(destination, projection, kontourRoot);
      }
    }

    const summary: Summary = {
      scanned_entry_count: read.entriesTotal,
      structured_gap_entry_count: read.entries.length,
      legacy_entries_not_projected: read.legacyEntries,
      invalid_entries_not_projected: read.invalidEntries,
      emitted_gap_count: projection.gaps.length,
      destination,
      producer,
      scope,
      dry_run: dryRun,
      warnings,
    };
    printWarnings(warnings);
    if (requestedOut !== "-") {
      if (flagBool(flags, "json")) console.log(JSON.stringify(summary, null, 2));
      else printText(summary);
    }
    return 0;
  } catch (error) {
    console.error(`console-declared-projection: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const _selfRealPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1RealPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfRealPath === _argv1RealPath) {
  void main().then((code) => { process.exitCode = code; });
}
