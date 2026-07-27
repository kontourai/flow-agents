/**
 * liveness-fleet.ts — a fleet view over ADR 0012 liveness lanes (#1021).
 *
 * ADR 0021 §1 makes effective claim state a join: `assignment ⋈ liveness`, where staleness —
 * not assignment — is what excludes. Both legs shipped, and `computeEffectiveState` in
 * workflow-sidecar.ts consumes the join to GATE pushes. Nothing ever exposed it to ANSWER a
 * question. `workflow status` is cwd-scoped to one run; `assignment-provider list` and
 * `pull-work-provider` are pure filters over JSON their caller must already have fetched. So
 * "which lanes are live, and who holds what" had no read surface at all, and answering it by
 * hand meant enumerating worktrees, tailing streams, and reconciling TTLs by eye.
 *
 * This module is that read surface, split the way `workflow-process-projection.ts` already
 * splits so both halves are reusable independently:
 *
 *   - PURE half (`classifyLane`, the types): given a lane's events and a clock, produce its
 *     liveness state. No filesystem, no git, no clock of its own. Re-exported through
 *     `@kontourai/flow-agents/console-contract` so Console renders lane state from the real
 *     contract instead of hand-mirroring it — the #933 precedent, where station's
 *     `workflow-process-projection-mirror.ts` hand-copied a status table because no subpath
 *     existed to import the real one from, and could drift silently.
 *   - IO half (`discoverRepoRoots`, `readFleet`): enumerate roots and their streams. Stays out
 *     of the contract subpath, which is deliberately pure (see console-contract.ts).
 *
 * FRESHNESS IS NOT REIMPLEMENTED HERE. The load-bearing predicate — is this holder's lease
 * still live — is delegated to `scripts/hooks/lib/liveness-read.js`'s `freshHolders`, the same
 * function `workflow-steering.js` and the sidecar consume, loaded through `createRequire` the
 * way the sidecar loads it. A second implementation of the TTL rule is exactly the drift this
 * repo's "consume, never fork" agreement exists to prevent. What this module adds around that
 * call is descriptive only: which lanes exist, their last event, and where the stream lives.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { FLOW_AGENTS_RUNTIME_DIR, resolveSharedRepoRoot } from "./local-artifact-root.js";
import { WORKSPACE_ROOTS_ENV } from "./declared-artifact-roots.js";

/**
 * The liveness leg's own vocabulary — deliberately NOT ADR 0021's effective-state vocabulary.
 *
 * ADR 0021's table (`held` / `reclaimable` / `human-held` / `free`) is the result of the JOIN
 * with durable assignment. A liveness stream alone cannot produce `human-held` (humans do not
 * heartbeat) or `free` (absence of a lane is not evidence of anything — the subject may simply
 * never have been claimed on this host). Naming those here would invite a caller to read a
 * one-legged answer as the joined one, which is the precise mistake ADR 0021 §1 warns against:
 * "provider state is never trusted alone" cuts both ways.
 *
 *   - `held`        — a holder's lease is within TTL. Excludes.
 *   - `reclaimable` — a holder exists but its lease lapsed. Offered, via the takeover protocol.
 *   - `released`    — the holder released explicitly. Not a lapse; a clean handoff.
 */
export type LivenessLaneState = "held" | "reclaimable" | "released";

/** One (subject, actor) lane as observed in a liveness stream. */
export type FleetLane = {
  /** Shared repo root the lane belongs to (post-#1020, where its stream should live). */
  repoRoot: string;
  /** Stream file the lane was actually read from — may be a worktree-private pre-#1020 stream. */
  streamPath: string;
  /** True when `streamPath` is NOT the shared root's stream, i.e. a stranded pre-#1020 lane. */
  stranded: boolean;
  subjectId: string;
  actor: string;
  /** Latest event timestamp for this (subject, actor), ISO-8601 as recorded. */
  lastEventAt: string;
  /** Age of `lastEventAt` in seconds at the evaluated clock; negative if the stamp is ahead. */
  ageSeconds: number;
  /** TTL in force, from the latest `claim` event; the helper's 1800s default when none said. */
  ttlSeconds: number;
  state: LivenessLaneState;
};

export type FleetScanWarning = { root: string; detail: string };

export type FleetScanResult = {
  lanes: FleetLane[];
  /** Roots scanned, canonicalized and deduped. */
  roots: string[];
  /** Stream files read (including worktree-private ones). */
  streams: string[];
  /** Non-fatal problems — an unreadable root, a git failure. Never thrown; a partial fleet view is still useful, but a SILENT partial one is not. */
  warnings: FleetScanWarning[];
  /** Clock the states were evaluated against, ms since epoch. */
  evaluatedAtMs: number;
};

type LivenessEvent = {
  type?: unknown;
  subjectId?: unknown;
  actor?: unknown;
  at?: unknown;
  ttlSeconds?: unknown;
};

type FreshHolder = { actor: string; lastAt: string; ttlSeconds: number; fresh: boolean };

type LivenessReadHelper = {
  readLivenessEvents: (streamPath: string) => LivenessEvent[];
  freshHolders: (events: LivenessEvent[], slug: string, selfActor: string | null, nowMs: number) => FreshHolder[];
};

/**
 * Load the shared pure-CJS liveness helper the hooks and the sidecar already use.
 * Same `createRequire` approach and same relative depth as workflow-sidecar.ts's loader
 * (`build/src/lib/` and `build/src/cli/` sit at equal depth from the repo root).
 */
function loadLivenessReadHelper(): LivenessReadHelper {
  const req = createRequire(import.meta.url);
  const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/hooks/lib/liveness-read.js");
  return req(helperPath) as LivenessReadHelper;
}

/** Milliseconds for an ISO-8601 stamp, or null when unparsable. */
function parseStampMs(at: string): number | null {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

/** The minimum a caller needs to state a lane's liveness — the shape `laneState` reasons over. */
export type LaneObservation = {
  /** Latest event type for this (subject, actor): `claim` | `heartbeat` | `release`. */
  lastEventType: string;
  /** Latest event timestamp, ISO-8601. */
  lastEventAt: string;
  /** TTL in force from the latest claim, in seconds. */
  ttlSeconds: number;
};

/**
 * PURE, DEPENDENCY-FREE: the one rule that decides whether a lane still holds.
 *
 * This is the function re-exported through `@kontourai/flow-agents/console-contract`, and it is
 * deliberately the whole rule rather than a helper around it: Console renders lane state, and a
 * renderer that recomputes "is this still live" from an age and a TTL it eyeballed is a second
 * implementation of the predicate — the #933 drift shape. Give the plane the rule, not the
 * ingredients.
 *
 * Mirrors `scripts/hooks/lib/liveness-read.js`'s grouping semantics: a trailing `release` means
 * not-fresh regardless of elapsed time; otherwise fresh while `elapsed < ttlSeconds * 1000`. The
 * IO-side `classifyLane` below still delegates its `held` verdict to that helper's `freshHolders`
 * so the two can never disagree on a real stream; this function exists for consumers that hold an
 * already-projected observation and no stream to re-read.
 *
 * An unparsable timestamp yields `reclaimable`, never `held` — an unreadable lease must not
 * exclude work.
 */
export function laneState(observation: LaneObservation, nowMs: number): LivenessLaneState {
  if (observation.lastEventType === "release") return "released";
  const stampMs = parseStampMs(observation.lastEventAt);
  if (stampMs === null) return "reclaimable";
  const ttlMs = (observation.ttlSeconds > 0 ? observation.ttlSeconds : 1800) * 1000;
  return nowMs - stampMs < ttlMs ? "held" : "reclaimable";
}

/**
 * PURE: classify every (subject, actor) lane present in `events`.
 *
 * `freshHolders` is called per subject with `selfActor = null` so no actor is filtered out —
 * a fleet view has no "self" to exclude, unlike the gate's conflict check which deliberately
 * ignores its own claim. Its verdict is authoritative for `held`; this function only decides
 * between `released` and `reclaimable` for the rest, from the lane's own latest event.
 *
 * @param events  parsed liveness events, from any number of streams
 * @param nowMs   clock to evaluate freshness against — injected, never read here
 */
export function classifyLane(events: LivenessEvent[], nowMs: number, helper: LivenessReadHelper = loadLivenessReadHelper()): Omit<FleetLane, "repoRoot" | "streamPath" | "stranded">[] {
  const latest = new Map<string, { subjectId: string; actor: string; at: string; type: string; ttlSeconds: number }>();

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const subjectId = typeof event.subjectId === "string" ? event.subjectId : null;
    const actor = typeof event.actor === "string" ? event.actor : null;
    const at = typeof event.at === "string" ? event.at : null;
    if (!subjectId || !actor || !at) continue;

    const key = `${subjectId}\0${actor}`;
    const prior = latest.get(key);
    const ttlSeconds = typeof event.ttlSeconds === "number" && event.ttlSeconds > 0 ? event.ttlSeconds : prior?.ttlSeconds ?? 1800;
    // String compare is correct for the Z-normalized ISO-8601 stamps the writer emits, and is
    // what liveness-read.js's own grouping uses — keep the two consistent.
    if (!prior || at > prior.at) {
      latest.set(key, { subjectId, actor, at, type: typeof event.type === "string" ? event.type : "", ttlSeconds });
    } else if (typeof event.ttlSeconds === "number" && event.ttlSeconds > 0) {
      prior.ttlSeconds = event.ttlSeconds;
    }
  }

  // One freshHolders call per subject; its result is the authority for `held`.
  const freshByKey = new Set<string>();
  for (const subjectId of new Set([...latest.values()].map((entry) => entry.subjectId))) {
    let holders: FreshHolder[] = [];
    try {
      holders = helper.freshHolders(events, subjectId, null, nowMs) ?? [];
    } catch {
      holders = [];
    }
    for (const holder of holders) {
      if (holder && holder.fresh && typeof holder.actor === "string") freshByKey.add(`${subjectId}\0${holder.actor}`);
    }
  }

  const lanes: Omit<FleetLane, "repoRoot" | "streamPath" | "stranded">[] = [];
  for (const [key, entry] of latest) {
    const stampMs = parseStampMs(entry.at);
    const state: LivenessLaneState = entry.type === "release" ? "released" : freshByKey.has(key) ? "held" : "reclaimable";
    lanes.push({
      subjectId: entry.subjectId,
      actor: entry.actor,
      lastEventAt: entry.at,
      ageSeconds: stampMs === null ? Number.NaN : Math.round((nowMs - stampMs) / 1000),
      ttlSeconds: entry.ttlSeconds,
      state,
    });
  }

  lanes.sort((a, b) => (a.lastEventAt < b.lastEventAt ? 1 : a.lastEventAt > b.lastEventAt ? -1 : a.subjectId.localeCompare(b.subjectId)));
  return lanes;
}

/** The liveness stream file under a `.kontourai/flow-agents` root. */
function streamFileFor(artifactRoot: string): string {
  return path.join(artifactRoot, "liveness", "events.jsonl");
}

/**
 * Repo roots to scan: the shared root for `cwd`, plus every configured workspace root.
 *
 * Reuses `SA_PROTECTED_WORKSPACE_ROOTS` — the same env var `declared-artifact-roots.ts` reads —
 * rather than minting a second "list of repos this machine works in" setting. One setting
 * scopes both surfaces, which is the precedent that module already set for the hook.
 */
export function discoverRepoRoots(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string[] {
  const roots: string[] = [];
  const own = resolveSharedRepoRoot(cwd);
  if (own) roots.push(own);

  const configured = String(env[WORKSPACE_ROOTS_ENV] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of configured) {
    const shared = resolveSharedRepoRoot(entry) ?? entry;
    roots.push(path.resolve(shared));
  }

  return [...new Set(roots.map((root) => path.resolve(root)))];
}

/**
 * Linked worktrees of `repoRoot`, for picking up streams stranded by the pre-#1020 emit path.
 *
 * Post-#1020 every lane writes to the shared root, so this exists to keep the view TRUTHFUL
 * during the transition rather than as load-bearing enumeration: a reader that silently ignored
 * stranded streams would under-report exactly the lanes the bug hid, which is how the defect
 * stayed invisible in the first place. Returns [] on any git failure — never throws.
 */
export function linkedWorktreesOf(repoRoot: string): string[] {
  try {
    const out = execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim())
      .filter(Boolean)
      .map((entry) => path.resolve(entry))
      .filter((entry) => entry !== path.resolve(repoRoot));
  } catch {
    return [];
  }
}

export type FleetScanOptions = {
  /** Roots to scan; defaults to `discoverRepoRoots(cwd, env)`. */
  roots?: string[];
  /** Clock, ms since epoch. Injected so callers and tests are deterministic. */
  nowMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Also read worktree-private streams stranded by the pre-#1020 emit path. Default true. */
  includeStrandedStreams?: boolean;
};

/**
 * Read every liveness lane across every scanned root. Never throws: an unreadable root
 * contributes a warning, not a failure — but the warning is always surfaced, because a
 * partial fleet view that LOOKS complete is worse than no view at all.
 */
export function readFleet(options: FleetScanOptions = {}): FleetScanResult {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const nowMs = options.nowMs ?? Date.now();
  const includeStranded = options.includeStrandedStreams !== false;
  const roots = (options.roots ?? discoverRepoRoots(cwd, env)).map((root) => path.resolve(root));

  const helper = loadLivenessReadHelper();
  const warnings: FleetScanWarning[] = [];
  const streams: string[] = [];
  const lanes: FleetLane[] = [];

  for (const repoRoot of roots) {
    const sharedStream = streamFileFor(path.join(repoRoot, FLOW_AGENTS_RUNTIME_DIR));
    const candidates: { streamPath: string; stranded: boolean }[] = [{ streamPath: sharedStream, stranded: false }];

    if (includeStranded) {
      for (const worktree of linkedWorktreesOf(repoRoot)) {
        candidates.push({ streamPath: streamFileFor(path.join(worktree, FLOW_AGENTS_RUNTIME_DIR)), stranded: true });
      }
    }

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate.streamPath)) continue;
      streams.push(candidate.streamPath);
      let events: LivenessEvent[] = [];
      try {
        events = helper.readLivenessEvents(candidate.streamPath) ?? [];
      } catch (err) {
        warnings.push({ root: repoRoot, detail: `unreadable stream ${candidate.streamPath}: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
      for (const lane of classifyLane(events, nowMs, helper)) {
        lanes.push({ repoRoot, streamPath: candidate.streamPath, stranded: candidate.stranded, ...lane });
      }
    }
  }

  lanes.sort((a, b) => (a.lastEventAt < b.lastEventAt ? 1 : a.lastEventAt > b.lastEventAt ? -1 : a.subjectId.localeCompare(b.subjectId)));
  return { lanes, roots, streams, warnings, evaluatedAtMs: nowMs };
}
