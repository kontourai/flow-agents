import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, flagList, flagString } from "../lib/args.js";

const FLOW_ARTIFACT_PATTERN = /(?<path>\.kontourai\/flow-agents\/[^\s`'")]+)/g;
const GITHUB_ISSUE_PATTERN = /(?:(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+))?#(?<number>\d+)/g;
const GITHUB_URL_PATTERN = /https:\/\/github\.com\/(?<owner>[^/\s]+)\/(?<repo>[^/\s]+)\/(?:issues|pull)\/(?<number>\d+)/g;
const BLOCKER_PATTERN = /\b(?:blocked by|depends on|waiting on|requires|should follow|coordinate with)\b[:\s-]*(?<refs>[^\n]+)/gi;
const PR_URL_PATTERN = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/g;
const WORK_ITEM_METADATA_PATTERN = /<!--\s*flow-agents:work-item-metadata\s*(?<json>[\s\S]*?)-->/g;
const DAY_MS = 24 * 60 * 60 * 1000;

type FreshnessInputs = {
  currentRef?: string;
  currentSha?: string;
  changedFiles: string[];
  commitsSince: Record<string, number>;
  now: Date;
};

type FreshnessContext = {
  plannedBaseRef?: string;
  plannedBaseSha?: string;
  plannedAgeDays: number | null;
  commitsSince: number | undefined;
  scopeRefs: string[];
  scopeIntersections: string[];
};

type BoardIssue = {
  id?: string;
  node_id?: string;
  owner?: string;
  repo?: string;
  number: number;
  title: string;
  body?: string;
  state?: string;
  labels: string[];
  url?: string;
  updatedAt?: string;
  createdAt?: string;
};

type BoardItem = {
  id?: string;
  position: number;
  status?: string;
  priority?: string;
  issue: BoardIssue | null;
};

type RepoRef = {
  owner: string;
  name: string;
};

function loadJson(file: string): unknown {
  return file === "-" ? JSON.parse(fs.readFileSync(0, "utf8")) : JSON.parse(fs.readFileSync(file, "utf8"));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function names(values: unknown): string[] {
  return Array.isArray(values) ? values.flatMap((item) => typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).name === "string" ? [(item as Record<string, string>).name] : []) : [];
}

function statusKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return ({ open: "todo", todo: "todo", to_do: "todo", ready: "ready", doing: "in_progress", in_progress: "in_progress", blocked: "blocked", review: "review", verification: "verification", done: "done", closed: "done" } as Record<string, string>)[key] ?? key;
}

function normalizedText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

function repoKey(owner: unknown, repo: unknown, number: unknown): string | null {
  const issueNumber = Number(number);
  return typeof owner === "string" && typeof repo === "string" && Number.isFinite(issueNumber)
    ? `${owner}/${repo}#${issueNumber}`
    : null;
}

function configuredRepos(settings: Record<string, unknown>): RepoRef[] {
  const workProvider = settings.work_item_provider as Record<string, unknown>;
  const boardProvider = (settings.board_provider ?? {}) as Record<string, unknown>;
  const workRepo = workProvider.repo as Record<string, string>;
  const board = (boardProvider.board ?? {}) as Record<string, unknown>;
  const defaultOwner = stringValue(board.owner) ?? stringValue((boardProvider.repo as Record<string, unknown> | undefined)?.owner) ?? workRepo.owner;
  const workspace = asRecord(settings.workspace);
  const repos = arrayValue(workspace?.repos).flatMap((repo) => {
    if (typeof repo === "string" && repo.trim()) return [{ owner: defaultOwner, name: repo.trim() }];
    const record = asRecord(repo);
    const owner = stringValue(record?.owner) ?? defaultOwner;
    const name = stringValue(record?.name);
    return owner && name ? [{ owner, name }] : [];
  });
  return repos.length ? repos : [{ owner: workRepo.owner, name: workRepo.name }];
}

function projectStatus(issue: Record<string, unknown>): string | null {
  for (const item of (Array.isArray(issue.projectItems) ? issue.projectItems : [])) {
    const status = (item as Record<string, unknown>).status;
    if (typeof status === "object" && status !== null && typeof (status as Record<string, unknown>).name === "string") return (status as Record<string, string>).name;
  }
  return null;
}

function extractRefs(text: string, owner: string, repo: string): Record<string, unknown>[] {
  const refs: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(GITHUB_URL_PATTERN)) {
    const key = `${match.groups?.owner}/${match.groups?.repo}#${Number(match.groups?.number)}`;
    if (!seen.has(key)) { seen.add(key); refs.push({ kind: "github", owner: match.groups?.owner, repo: match.groups?.repo, number: Number(match.groups?.number), url: match[0] }); }
  }
  for (const match of text.matchAll(GITHUB_ISSUE_PATTERN)) {
    const refOwner = match.groups?.owner ?? owner;
    const refRepo = match.groups?.repo ?? repo;
    const key = `${refOwner}/${refRepo}#${Number(match.groups?.number)}`;
    if (!seen.has(key)) { seen.add(key); refs.push({ kind: "github", owner: refOwner, repo: refRepo, number: Number(match.groups?.number) }); }
  }
  return refs;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.flatMap((item) => typeof item === "string" && item.trim() ? [item] : []);
  return out.length ? out : undefined;
}

function parseCommitsSince(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) {
    const [sha, rawCount] = value.split("=", 2);
    const count = Number(rawCount);
    if (sha && Number.isFinite(count) && count >= 0) out[sha] = count;
  }
  return out;
}

function ageDays(plannedAt: unknown, now: Date): number | null {
  const planned = stringValue(plannedAt);
  if (!planned) return null;
  const time = Date.parse(planned);
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.floor((now.getTime() - time) / DAY_MS));
}

function pathIntersects(scopeRef: string, changedFile: string): boolean {
  const scope = scopeRef.replace(/^\.\/+/, "").replace(/\/+$/, "");
  const changed = changedFile.replace(/^\.\/+/, "").replace(/\/+$/, "");
  return scope === changed || changed.startsWith(`${scope}/`) || scope.startsWith(`${changed}/`);
}

function planningScopeIntersections(scopeRefs: unknown, changedFiles: string[]): string[] {
  const scopes = stringList(scopeRefs) ?? [];
  const out = new Set<string>();
  for (const scope of scopes) {
    if (changedFiles.some((changed) => pathIntersects(scope, changed))) out.add(scope);
  }
  return Array.from(out);
}

function materialFreshnessFiles(changedFiles: string[]): string[] {
  return changedFiles.filter((file) => {
    const normalized = file.replace(/^\.\/+/, "");
    return normalized.startsWith("context/contracts/")
      || normalized === "package.json"
      || normalized === "package-lock.json"
      || normalized === "pnpm-lock.yaml"
      || normalized === "yarn.lock";
  });
}

function freshnessBase(ctx: FreshnessContext, inputs: FreshnessInputs): Record<string, unknown> {
  return {
    planned_base_ref: ctx.plannedBaseRef,
    planned_base_sha: ctx.plannedBaseSha ?? null,
    current_ref: inputs.currentRef,
    current_sha: inputs.currentSha ?? null,
    planned_age_days: ctx.plannedAgeDays,
    changed_files: inputs.changedFiles,
    planning_scope_refs: ctx.scopeRefs,
    planning_scope_intersections: ctx.scopeIntersections,
    commits_since_planned_base: ctx.commitsSince ?? null,
  };
}

function freshnessContext(item: Record<string, unknown>, inputs: FreshnessInputs): FreshnessContext {
  const plannedBaseRef = stringValue(item.planned_base_ref);
  const plannedBaseSha = stringValue(item.planned_base_sha);
  return {
    plannedBaseRef,
    plannedBaseSha,
    plannedAgeDays: ageDays(item.planned_at, inputs.now),
    commitsSince: plannedBaseSha ? inputs.commitsSince[plannedBaseSha] : undefined,
    scopeRefs: stringList(item.planning_scope_refs) ?? [],
    scopeIntersections: planningScopeIntersections(item.planning_scope_refs, inputs.changedFiles),
  };
}

/**
 * The reference adapter's CURRENT freshness diagnostic vocabulary — `classifyRevisionFreshness()`
 * below never returns any value outside this array. Exported as a runtime value (not just a type)
 * per #777 review finding 2 so `provider-interfaces.ts`'s `ReferenceAdapterFreshnessDiagnostic`
 * type derives from THIS array (`typeof referenceAdapterFreshnessDiagnostics[number]`) instead of
 * a hand-copied literal union that could silently drift from what this function actually emits.
 * This is deliberately NOT named after the work-item contract's normative five-value drift-outcome
 * table (`no_material_drift`/`scope_drift`/`dependency_drift`/`contract_drift`/`conflict_risk`,
 * work-item-contract.md "Planning Base And Drift") — this reference adapter does not yet implement
 * that more granular vocabulary; see `WorkItemDriftOutcome` in `provider-interfaces.ts` for the
 * contract's normative union and its doc comment for the flagged gap.
 */
export const referenceAdapterFreshnessDiagnostics = ["not_verified", "fresh", "stale", "drifted"] as const;
const [FRESHNESS_NOT_VERIFIED, FRESHNESS_FRESH, FRESHNESS_STALE, FRESHNESS_DRIFTED] = referenceAdapterFreshnessDiagnostics;

function classifyRevisionFreshness(ctx: FreshnessContext, inputs: FreshnessInputs): { classification: (typeof referenceAdapterFreshnessDiagnostics)[number]; reasons: Record<string, unknown>[]; route_recommendation?: Record<string, unknown> } {
  const reasons: Record<string, unknown>[] = [];
  const materialFiles = materialFreshnessFiles(inputs.changedFiles);

  if (!ctx.plannedBaseSha) {
    reasons.push({ code: "missing_planned_base_sha", message: "Work item has no planned_base_sha; freshness cannot be verified without inventing certainty." });
    return { classification: FRESHNESS_NOT_VERIFIED, reasons };
  }

  if (!inputs.currentSha) {
    reasons.push({ code: "missing_current_sha", message: "Current target SHA was not provided; pass --current-sha from the caller's refreshed provider/repo context." });
    return { classification: FRESHNESS_NOT_VERIFIED, reasons };
  }

  if (ctx.plannedBaseSha === inputs.currentSha && ctx.scopeIntersections.length === 0) {
    reasons.push({ code: "base_matches_current", message: "Planned base SHA matches current target SHA and no planning scope changes were reported." });
    return { classification: FRESHNESS_FRESH, reasons };
  }

  if (ctx.plannedBaseSha !== inputs.currentSha) reasons.push({ code: "base_sha_changed", message: "Current target SHA differs from the planned base SHA." });
  if (ctx.commitsSince === undefined && inputs.changedFiles.length === 0) {
    reasons.push({ code: "missing_drift_evidence", message: "Current target moved, but commits-since and changed-file evidence were not provided." });
    return { classification: FRESHNESS_NOT_VERIFIED, reasons };
  }
  if ((ctx.commitsSince ?? 0) > 0) reasons.push({ code: "commits_since_planned_base", message: `${ctx.commitsSince} commits were reported since planned_base_sha.` });
  if (ctx.scopeIntersections.length) reasons.push({ code: "planning_scope_changed", message: "Reported changed files intersect planning_scope_refs.", intersections: ctx.scopeIntersections });
  if (materialFiles.length) reasons.push({ code: "material_freshness_files_changed", message: "Reported changed files include workflow contracts or dependency manifests.", changed_files: materialFiles });
  if (ctx.plannedAgeDays !== null && ctx.plannedAgeDays >= 30) reasons.push({ code: "planned_base_age", message: `Planning baseline is ${ctx.plannedAgeDays} days old.` });

  const stale = materialFiles.length > 0 || ctx.scopeIntersections.length > 0 || (ctx.commitsSince ?? 0) >= 10 || (ctx.plannedAgeDays !== null && ctx.plannedAgeDays >= 30);
  return {
    classification: stale ? FRESHNESS_STALE : FRESHNESS_DRIFTED,
    route_recommendation: stale ? { target: "idea-to-backlog", reason: "Stale revision freshness should be reshaped before implementation planning." } : undefined,
    reasons,
  };
}

function revisionFreshness(item: Record<string, unknown>, inputs: FreshnessInputs): Record<string, unknown> {
  const ctx = freshnessContext(item, inputs);
  const result = classifyRevisionFreshness(ctx, inputs);
  return {
    ...freshnessBase(ctx, inputs),
    classification: result.classification,
    route_recommendation: result.route_recommendation,
    reasons: result.reasons,
  };
}

function applyFreshnessToReadiness(readiness: Record<string, unknown>, freshness: Record<string, unknown>): Record<string, unknown> {
  const reasons = Array.isArray(freshness.reasons) ? freshness.reasons as Record<string, unknown>[] : [];
  const reasonCodes = new Set(reasons.map((reason) => reason.code));
  if (readiness.classification === "ready" && freshness.classification === "stale") {
    return {
      classification: "stale",
      reasons: [
        ...(Array.isArray(readiness.reasons) ? readiness.reasons : []),
        { code: "revision_freshness_stale", message: "Revision freshness is stale; route this item back to idea-to-backlog before planning.", freshness },
      ],
    };
  }
  if (
    readiness.classification === "ready"
    && freshness.classification === "not_verified"
    && (reasonCodes.has("missing_drift_evidence") || reasonCodes.has("missing_current_sha"))
  ) {
    return {
      classification: "blocked",
      reasons: [
        ...(Array.isArray(readiness.reasons) ? readiness.reasons : []),
        { code: "revision_freshness_not_verified", message: "Revision freshness is not verified; planning needs an explicit accepted gap.", freshness },
      ],
    };
  }
  return readiness;
}

function parseWorkItemMetadata(body: string): Record<string, unknown> | null {
  for (const match of body.matchAll(WORK_ITEM_METADATA_PATTERN)) {
    const raw = match.groups?.json;
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw.trim()) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeSourceRevision(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ["repo", "planned_base_ref", "planned_base_sha", "planned_at", "planning_artifact_ref"]) {
    const normalized = stringValue(source[key]);
    if (normalized) out[key] = normalized;
  }
  const scopeRefs = stringList(source.planning_scope_refs);
  if (scopeRefs) out.planning_scope_refs = scopeRefs;
  return Object.keys(out).length ? out : null;
}

function sourceRevisionFields(metadata: Record<string, unknown> | null, owner: string, repo: string): Record<string, unknown> {
  if (!metadata) return {};
  const revisions = Array.isArray(metadata.source_revisions)
    ? metadata.source_revisions.flatMap((item) => {
      const revision = normalizeSourceRevision(item);
      return revision ? [revision] : [];
    })
    : [];
  const topLevelRevision = normalizeSourceRevision(metadata);
  const singleRepoRevision = topLevelRevision ?? (
    revisions.length === 1
      ? revisions[0]
      : revisions.find((revision) => revision.repo === `${owner}/${repo}`)
  );
  const out: Record<string, unknown> = {};
  if (singleRepoRevision) {
    for (const key of ["planned_base_ref", "planned_base_sha", "planned_at", "planning_artifact_ref", "planning_scope_refs"]) {
      if (singleRepoRevision[key] !== undefined) out[key] = singleRepoRevision[key];
    }
  }
  if (revisions.length) out.source_revisions = revisions;
  return out;
}

function blockers(body: string, owner: string, repo: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const proseBody = body.replace(WORK_ITEM_METADATA_PATTERN, "");
  for (const match of proseBody.matchAll(BLOCKER_PATTERN)) {
    const refs = extractRefs(match.groups?.refs ?? "", owner, repo);
    if (refs.length) out.push(...refs.map((ref) => ({ type: "provider_ref", ref, evidence: match[0].trim() })));
    else out.push({ type: "text", evidence: match[0].trim() });
  }
  return out;
}

function providerRefKey(ref: Record<string, unknown> | undefined): string | null {
  return ref && typeof ref.owner === "string" && typeof ref.repo === "string" && typeof ref.number === "number"
    ? `${ref.owner}/${ref.repo}#${ref.number}`
    : null;
}

function blockerResolvedStatus(ref: Record<string, unknown> | undefined, resolved: Record<string, string>): string | null {
  const key = providerRefKey(ref);
  return key ? resolved[key] ?? null : null;
}

function blockerImpactState(knownStatus: string | null): string {
  if (["closed", "done", "merged", "satisfied"].includes(knownStatus ?? "")) return "resolved";
  return knownStatus ? "blocking" : "unknown";
}

function isBlockerResolved(ref: Record<string, unknown> | undefined, resolved: Record<string, string>): boolean {
  return blockerImpactState(blockerResolvedStatus(ref, resolved)) === "resolved";
}

function dependencyImpacts(item: Record<string, unknown>, resolved: Record<string, string>): Record<string, unknown>[] {
  const current = item.source_provider as Record<string, unknown> | undefined;
  const currentOwner = typeof current?.owner === "string" ? current.owner : undefined;
  const currentRepo = typeof current?.repo === "string" ? current.repo : undefined;
  return (item.blockers as Record<string, unknown>[] ?? []).flatMap((blocker) => {
    const ref = blocker.ref as Record<string, unknown> | undefined;
    if (!providerRefKey(ref)) return [];
    const knownStatus = blockerResolvedStatus(ref, resolved);
    return [{
      ref,
      source: {
        type: blocker.type,
        evidence: blocker.evidence,
      },
      cross_repo: Boolean(currentOwner && currentRepo && (ref?.owner !== currentOwner || ref?.repo !== currentRepo)),
      known_status: knownStatus ?? "unknown",
      impact_state: blockerImpactState(knownStatus),
    }];
  });
}

function normalizeStructuredBlockers(metadata: Record<string, unknown> | null, owner: string, repo: string): Record<string, unknown>[] {
  if (!metadata || !Array.isArray(metadata.blockers)) return [];
  const out: Record<string, unknown>[] = [];
  for (const blocker of metadata.blockers) {
    if (typeof blocker !== "object" || blocker === null || Array.isArray(blocker)) continue;
    const record = blocker as Record<string, unknown>;
    const evidence = stringValue(record.evidence) ?? stringValue(record.summary) ?? stringValue(record.ref) ?? stringValue(record.type);
    const rawRef = record.ref;
    const refs = typeof rawRef === "string" ? extractRefs(rawRef, owner, repo) : [];
    if (refs.length) {
      out.push(...refs.map((ref) => ({ type: "provider_ref", ref, evidence: evidence ?? rawRef })));
      continue;
    }
    if (typeof rawRef === "object" && rawRef !== null && !Array.isArray(rawRef)) {
      const refRecord = rawRef as Record<string, unknown>;
      const normalizedRef = typeof refRecord.owner === "string" && typeof refRecord.repo === "string" && Number.isFinite(Number(refRecord.number))
        ? { ...refRecord, number: Number(refRecord.number) }
        : refRecord;
      out.push({ type: stringValue(record.type) ?? "provider_ref", ref: normalizedRef, evidence: evidence ?? JSON.stringify(rawRef) });
      continue;
    }
    if (evidence) out.push({ type: stringValue(record.type) ?? "text", evidence });
  }
  return out;
}

function mergeBlockers(structured: Record<string, unknown>[], prose: Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seenRefs = new Set<string>();
  const seenText = new Set<string>();
  for (const blocker of structured.concat(prose)) {
    const refKey = providerRefKey(blocker.ref as Record<string, unknown> | undefined);
    if (refKey) {
      if (seenRefs.has(refKey)) continue;
      seenRefs.add(refKey);
    } else {
      const evidence = String(blocker.evidence ?? "").trim().toLowerCase();
      if (evidence && seenText.has(evidence)) continue;
      if (evidence) seenText.add(evidence);
    }
    out.push(blocker);
  }
  return out;
}

function firstLabel(issue: Record<string, unknown>, prefixes: string[]): string | null {
  for (const label of names(issue.labels)) {
    const lower = label.toLowerCase();
    if (prefixes.includes(lower) || prefixes.some((prefix) => lower.startsWith(`${prefix}:`))) return label;
  }
  return null;
}

function normalize(issue: Record<string, unknown>, settings: Record<string, unknown>): Record<string, unknown> {
  const workProvider = settings.work_item_provider as Record<string, unknown>;
  const boardProvider = (settings.board_provider ?? {}) as Record<string, unknown>;
  const repo = workProvider.repo as Record<string, string>;
  const owner = repo.owner;
  const name = repo.name;
  const number = Number(issue.number);
  const body = String(issue.body ?? "");
  const metadata = parseWorkItemMetadata(body);
  const projectItems = Array.isArray(issue.projectItems) ? issue.projectItems as Record<string, unknown>[] : [];
  const prLinks = names(issue.closedByPullRequestsReferences).concat(Array.from(body.matchAll(PR_URL_PATTERN), (m) => m[0]));
  return {
    id: `github:${owner}/${name}#${number}`,
    title: issue.title ?? `#${number}`,
    body,
    status: statusKey(projectStatus(issue)) ?? (issue.state === "CLOSED" ? "done" : "todo"),
    labels: names(issue.labels),
    assignees: names(issue.assignees),
    milestone: issue.milestone,
    priority: firstLabel(issue, ["p0", "p1", "p2", "priority"]),
    size: firstLabel(issue, ["xs", "small", "medium", "large", "xl", "size"]),
    risk: firstLabel(issue, ["risk"]),
    ...sourceRevisionFields(metadata, owner, name),
    blockers: mergeBlockers(normalizeStructuredBlockers(metadata, owner, name), blockers(body, owner, name)),
    related_links: extractRefs(body, owner, name),
    source_provider: { role: "WorkItemProvider", kind: workProvider.kind, owner, repo: name, number, url: issue.url, state: issue.state, node_id: issue.id, capabilities: workProvider.capabilities ?? [] },
    board_membership: { role: "BoardProvider", kind: boardProvider.kind, board: boardProvider.board, items: projectItems.map((item) => ({ title: item.title, status: typeof item.status === "object" && item.status !== null ? (item.status as Record<string, unknown>).name : null, provider: "github_project" })), capabilities: boardProvider.capabilities ?? [] },
    pr_links: prLinks,
    artifact_refs: Array.from(body.matchAll(FLOW_ARTIFACT_PATTERN), (m) => (m.groups?.path ?? "").replace(/[.,]+$/, "")),
    updated_at: issue.updatedAt,
    created_at: issue.createdAt,
  };
}

function fieldValueByName(item: Record<string, unknown>, fieldName: string): string | undefined {
  const wanted = fieldName.toLowerCase();
  const direct = item[fieldName] ?? item[fieldName.toLowerCase()];
  if (typeof direct === "string") return direct;
  const fieldValues = Array.isArray(item.fieldValues) ? item.fieldValues : arrayValue(asRecord(item.fieldValues)?.nodes);
  for (const value of fieldValues) {
    const record = asRecord(value);
    if (!record) continue;
    const field = asRecord(record.field);
    const name = normalizedText(field?.name);
    if (name !== wanted) continue;
    return stringValue(record.name) ?? stringValue(record.text) ?? stringValue(record.value) ?? stringValue(record.optionName);
  }
  return undefined;
}

function normalizeBoardIssue(rawIssue: unknown, fallbackOwner?: string, fallbackRepo?: string): BoardIssue | null {
  const issue = asRecord(rawIssue);
  if (!issue) return null;
  const number = Number(issue.number);
  if (!Number.isFinite(number)) return null;
  const repository = asRecord(issue.repository);
  const owner = stringValue(issue.owner) ?? stringValue(asRecord(repository?.owner)?.login) ?? fallbackOwner;
  const repo = stringValue(issue.repo) ?? stringValue(issue.repositoryName) ?? stringValue(repository?.name) ?? fallbackRepo;
  return {
    id: stringValue(issue.id),
    node_id: stringValue(issue.node_id) ?? stringValue(issue.id),
    owner,
    repo,
    number,
    title: stringValue(issue.title) ?? `#${number}`,
    body: stringValue(issue.body) ?? "",
    state: stringValue(issue.state) ?? "OPEN",
    labels: names(issue.labels).concat(arrayValue(asRecord(issue.labels)?.nodes).flatMap((label) => stringValue(asRecord(label)?.name) ?? [])),
    url: stringValue(issue.url),
    updatedAt: stringValue(issue.updatedAt),
    createdAt: stringValue(issue.createdAt),
  };
}

function normalizeBoardItem(rawItem: unknown, index: number, fallbackOwner?: string, fallbackRepo?: string): BoardItem | null {
  const item = asRecord(rawItem);
  if (!item) return null;
  const content = item.content ?? item.issue;
  const issue = normalizeBoardIssue(content, fallbackOwner, fallbackRepo);
  if (!issue) return null;
  const rawPosition = item.position ?? item.databaseId ?? item.index;
  const position = Number.isFinite(Number(rawPosition)) ? Number(rawPosition) : index;
  return {
    id: stringValue(item.id),
    position,
    status: fieldValueByName(item, "Status") ?? stringValue(item.status),
    priority: fieldValueByName(item, "Priority") ?? stringValue(item.priority),
    issue,
  };
}

function boardItemsFromDoc(doc: unknown, settings: Record<string, unknown>): BoardItem[] {
  const workProvider = settings.work_item_provider as Record<string, unknown>;
  const repo = workProvider.repo as Record<string, string>;
  const record = asRecord(doc);
  const rawItems = Array.isArray(doc)
    ? doc
    : arrayValue(record?.project_items).length ? arrayValue(record?.project_items)
      : arrayValue(record?.projectItems).length ? arrayValue(record?.projectItems)
        : arrayValue(record?.items).length ? arrayValue(record?.items)
          : arrayValue(asRecord(asRecord(asRecord(record?.data)?.organization)?.projectV2)?.items).length
            ? arrayValue(asRecord(asRecord(asRecord(record?.data)?.organization)?.projectV2)?.items)
            : [];
  const nodes = rawItems.flatMap((item) => asRecord(item)?.nodes && Array.isArray(asRecord(item)?.nodes) ? arrayValue(asRecord(item)?.nodes) : [item]);
  return nodes.flatMap((item, index) => normalizeBoardItem(item, index, repo.owner, repo.name) ?? []);
}

function openIssuesFromDoc(doc: unknown, settings: Record<string, unknown>): BoardIssue[] {
  const repos = configuredRepos(settings);
  const fallback = repos.length === 1 ? repos[0] : undefined;
  const record = asRecord(doc);
  const rawOpenIssues = record?.open_issues;
  const rawIssues = arrayValue(rawOpenIssues).length ? arrayValue(rawOpenIssues)
    : rawOpenIssues && typeof rawOpenIssues === "object" && !Array.isArray(rawOpenIssues)
      ? Object.entries(rawOpenIssues as Record<string, unknown>).flatMap(([repoName, issues]) => arrayValue(issues).map((issue) => ({ issue, repoName })))
      : arrayValue(record?.issues).length ? arrayValue(record?.issues)
        : arrayValue(asRecord(asRecord(asRecord(record?.data)?.repository)?.issues)?.nodes);
  return rawIssues.flatMap((issue) => {
    const wrapped = asRecord(issue);
    const rawIssue = wrapped && "issue" in wrapped ? wrapped.issue : issue;
    const repoName = wrapped && typeof wrapped.repoName === "string" ? wrapped.repoName : undefined;
    const repoFallback = repoName ? repos.find((repo) => repo.name === repoName) : fallback;
    const normalized = normalizeBoardIssue(rawIssue, repoFallback?.owner, repoName ?? repoFallback?.name);
    return normalized && (normalized.state ?? "OPEN").toUpperCase() === "OPEN" ? [normalized] : [];
  });
}

function boardCandidate(item: BoardItem, settings: Record<string, unknown>): Record<string, unknown> {
  const workProvider = settings.work_item_provider as Record<string, unknown>;
  const boardProvider = (settings.board_provider ?? {}) as Record<string, unknown>;
  const issue = item.issue as BoardIssue;
  const owner = issue.owner ?? ((workProvider.repo as Record<string, string>).owner);
  const repo = issue.repo ?? ((workProvider.repo as Record<string, string>).name);
  const body = issue.body ?? "";
  const metadata = parseWorkItemMetadata(body);
  const rawStatus = item.status ?? "Todo";
  return {
    id: `github:${owner}/${repo}#${issue.number}`,
    title: issue.title,
    body,
    status: statusKey(rawStatus) ?? rawStatus.toLowerCase(),
    labels: issue.labels,
    priority: item.priority,
    ...sourceRevisionFields(metadata, owner, repo),
    blockers: mergeBlockers(normalizeStructuredBlockers(metadata, owner, repo), blockers(body, owner, repo)),
    related_links: extractRefs(body, owner, repo),
    source_provider: { role: "WorkItemProvider", kind: workProvider.kind, owner, repo, number: issue.number, url: issue.url, state: issue.state, node_id: issue.node_id ?? issue.id, capabilities: workProvider.capabilities ?? [] },
    board_membership: {
      role: "BoardProvider",
      kind: boardProvider.kind,
      board: boardProvider.board,
      project_item_id: item.id,
      position: item.position,
      status: rawStatus,
      priority: item.priority,
      capabilities: boardProvider.capabilities ?? [],
    },
    artifact_refs: Array.from(body.matchAll(FLOW_ARTIFACT_PATTERN), (m) => (m.groups?.path ?? "").replace(/[.,]+$/, "")),
    updated_at: issue.updatedAt,
    created_at: issue.createdAt,
  };
}

function priorityRank(priority: unknown): number {
  const key = String(priority ?? "").trim().toUpperCase();
  return ({ P0: 0, P1: 1, P2: 2 } as Record<string, number>)[key] ?? 99;
}

function boardResult(settings: Record<string, unknown>, boardItems: BoardItem[], openIssues: BoardIssue[]): Record<string, unknown> {
  const selection = (settings.selection ?? {}) as Record<string, unknown>;
  const filters = (selection.filters ?? {}) as Record<string, unknown>;
  const readyStatuses = new Set(((filters.ready_statuses as string[] | undefined) ?? ["ready"]).map((status) => status.toLowerCase()));
  const workProvider = settings.work_item_provider as Record<string, unknown>;
  const repo = workProvider.repo as Record<string, string>;
  const candidates = boardItems.map((item) => ({ item, candidate: boardCandidate(item, settings) }));
  const readyQueue = candidates
    .filter(({ item }) => readyStatuses.has(String(statusKey(item.status) ?? item.status ?? "").toLowerCase()))
    .sort((left, right) => priorityRank(left.item.priority) - priorityRank(right.item.priority) || left.item.position - right.item.position)
    .map(({ candidate }) => candidate);
  const boardIssueKeys = new Set(boardItems.flatMap((item) => {
    const issue = item.issue;
    const key = repoKey(issue?.owner ?? repo.owner, issue?.repo ?? repo.name, issue?.number);
    return key ? [key] : [];
  }));
  const intakeGaps = openIssues
    .filter((issue) => !boardIssueKeys.has(repoKey(issue.owner ?? repo.owner, issue.repo ?? repo.name, issue.number) ?? ""))
    .map((issue) => ({
      id: `github:${issue.owner ?? repo.owner}/${issue.repo ?? repo.name}#${issue.number}`,
      title: issue.title,
      status: statusKey(issue.state) ?? "todo",
      labels: issue.labels,
      source_provider: { role: "WorkItemProvider", kind: workProvider.kind, owner: issue.owner ?? repo.owner, repo: issue.repo ?? repo.name, number: issue.number, url: issue.url, state: issue.state, node_id: issue.node_id ?? issue.id, capabilities: workProvider.capabilities ?? [] },
    }));
  const warnings = readyQueue.length === 0
    ? [{ code: "zero_ready_items", message: "Configured BoardProvider yielded zero ready items; treat this as a dead readiness source and do not silently fall back to WorkItemProvider issue listing." }]
    : [];
  return { ready_queue: readyQueue, intake_gaps: intakeGaps, warnings };
}

const PROJECT_BOARD_QUERY = `
query($org: String!, $projectNumber: Int!, $repoOwner: String!, $repoName: String!, $itemCursor: String, $issueCursor: String) {
  organization(login: $org) {
    projectV2(number: $projectNumber) {
      items(first: 100, after: $itemCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          fieldValues(first: 30) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
            }
          }
          content {
            ... on Issue {
              id
              number
              title
              body
              state
              url
              updatedAt
              createdAt
              repository { name owner { login } }
              labels(first: 50) { nodes { name } }
            }
          }
        }
      }
    }
  }
  repository(owner: $repoOwner, name: $repoName) {
    issues(first: 100, after: $issueCursor, states: OPEN) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        number
        title
        body
        state
        url
        updatedAt
        createdAt
        repository { name owner { login } }
        labels(first: 50) { nodes { name } }
      }
    }
  }
}`;

const REPO_ISSUES_QUERY = `
query($repoOwner: String!, $repoName: String!, $issueCursor: String) {
  repository(owner: $repoOwner, name: $repoName) {
    issues(first: 100, after: $issueCursor, states: OPEN) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        number
        title
        body
        state
        url
        updatedAt
        createdAt
        repository { name owner { login } }
        labels(first: 50) { nodes { name } }
      }
    }
  }
}`;

function ghGraphql(query: string, variables: Record<string, string | number | undefined>): Record<string, unknown> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value !== undefined && value !== "") args.push("-F", `${key}=${value}`);
  }
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as Record<string, unknown>;
}

function liveBoardDoc(settings: Record<string, unknown>): Record<string, unknown> {
  const workProvider = settings.work_item_provider as Record<string, unknown>;
  const boardProvider = settings.board_provider as Record<string, unknown>;
  const workRepo = workProvider.repo as Record<string, string>;
  const repos = configuredRepos(settings);
  const board = boardProvider.board as Record<string, unknown>;
  const org = stringValue(board.owner) ?? stringValue((boardProvider.repo as Record<string, unknown> | undefined)?.owner) ?? workRepo.owner;
  const projectNumber = Number(board.number);
  if (!org || !Number.isFinite(projectNumber)) throw new Error("BoardProvider must configure board.owner or repo.owner and board.number for live reads");
  const items: unknown[] = [];
  const issues: unknown[] = [];
  let itemCursor = "";
  let issueCursor = "";
  let fetchItems = true;
  let fetchIssues = true;
  while (fetchItems || fetchIssues) {
    const page = ghGraphql(PROJECT_BOARD_QUERY, {
      org,
      projectNumber,
      repoOwner: repos[0]?.owner ?? workRepo.owner,
      repoName: repos[0]?.name ?? workRepo.name,
      itemCursor,
      issueCursor,
    });
    const projectItems = asRecord(asRecord(asRecord(page.data)?.organization)?.projectV2)?.items as Record<string, unknown> | undefined;
    const repoIssues = asRecord(asRecord(page.data)?.repository)?.issues as Record<string, unknown> | undefined;
    if (fetchItems) items.push(...arrayValue(projectItems?.nodes));
    if (fetchIssues) issues.push(...arrayValue(repoIssues?.nodes));
    const itemPageInfo = asRecord(projectItems?.pageInfo);
    const issuePageInfo = asRecord(repoIssues?.pageInfo);
    fetchItems = Boolean(itemPageInfo?.hasNextPage);
    fetchIssues = Boolean(issuePageInfo?.hasNextPage);
    itemCursor = stringValue(itemPageInfo?.endCursor) ?? "";
    issueCursor = stringValue(issuePageInfo?.endCursor) ?? "";
  }
  for (const repo of repos.slice(1)) {
    let repoIssueCursor = "";
    let fetchRepoIssues = true;
    while (fetchRepoIssues) {
      const page = ghGraphql(REPO_ISSUES_QUERY, {
        repoOwner: repo.owner,
        repoName: repo.name,
        issueCursor: repoIssueCursor,
      });
      const repoIssues = asRecord(asRecord(page.data)?.repository)?.issues as Record<string, unknown> | undefined;
      issues.push(...arrayValue(repoIssues?.nodes));
      const issuePageInfo = asRecord(repoIssues?.pageInfo);
      fetchRepoIssues = Boolean(issuePageInfo?.hasNextPage);
      repoIssueCursor = stringValue(issuePageInfo?.endCursor) ?? "";
    }
  }
  return { items, issues };
}

/**
 * The reference adapter's readiness-classification vocabulary — `classify()` below never returns
 * any value outside this array. Exported as a runtime value (not just a type) per #777 review
 * finding 5 so `provider-interfaces.ts`'s `WorkItemReadinessClassification` type derives from THIS
 * array instead of a hand-copied literal union that could silently drift from what this function
 * actually emits.
 */
export const workItemReadinessClassifications = ["ready", "blocked", "in_progress", "stale", "related-only"] as const;
const [READINESS_READY, READINESS_BLOCKED, READINESS_IN_PROGRESS, READINESS_STALE, READINESS_RELATED_ONLY] = workItemReadinessClassifications;

function classify(item: Record<string, unknown>, settings: Record<string, unknown>, resolved: Record<string, string>): Record<string, unknown> {
  const selection = (settings.selection ?? {}) as Record<string, unknown>;
  const filters = (selection.filters ?? {}) as Record<string, unknown>;
  const wip = (selection.wip_policy ?? {}) as Record<string, unknown>;
  const status = String(item.status ?? "");
  const labels = new Set((item.labels as string[] ?? []).map((label) => label.toLowerCase()));
  if ((wip.active_statuses as string[] ?? []).includes(status) || ["review", "verification"].includes(status)) return { classification: READINESS_IN_PROGRESS, reasons: [{ code: "active_status", message: `Item status is active: ${status}` }] };
  const open = (item.blockers as Record<string, unknown>[] ?? []).filter((blocker) => {
    const ref = blocker.ref as Record<string, unknown> | undefined;
    return !isBlockerResolved(ref, resolved);
  });
  if (status === "blocked" || open.length || labels.has("blocked")) {
    return {
      classification: READINESS_BLOCKED,
      reasons: [{
        code: "blocking_evidence",
        message: "Item has unresolved blocker evidence.",
        blockers: open.map((blocker) => {
          const ref = blocker.ref as Record<string, unknown> | undefined;
          return { blocker, known_status: blockerResolvedStatus(ref, resolved) ?? "unknown" };
        }),
      }],
    };
  }
  const title = String(item.title ?? "").toLowerCase();
  if (labels.has("research") || labels.has("spike") || status === "research" || title.includes("research")) return { classification: READINESS_RELATED_ONLY, reasons: [{ code: "parallel_research", message: "Research/spike item is related but not the implementation pickup." }] };
  const readyStatuses = (filters.ready_statuses as string[] | undefined) ?? ["ready"];
  const body = String(item.body ?? "").toLowerCase();
  if (readyStatuses.includes(status) || (status === "todo" && body.includes("## scope") && body.includes("## acceptance criteria"))) return { classification: READINESS_READY, reasons: [{ code: "pickup_contract", message: "Item has scope, acceptance criteria, and no unresolved blockers." }] };
  return { classification: READINESS_STALE, reasons: [{ code: "insufficient_readiness", message: `Status ${JSON.stringify(status)} is not ready and no pickup contract was found.` }] };
}

function resolveSettings(doc: Record<string, unknown>): Record<string, unknown> {
  if (typeof doc.settings === "object" && doc.settings !== null) return doc.settings as Record<string, unknown>;
  if (doc.work_item_provider) return doc;
  if (Array.isArray(doc.projects) && doc.projects.length) return doc.projects[0] as Record<string, unknown>;
  if (typeof doc.defaults === "object" && doc.defaults !== null) {
    const settings = structuredClone(doc.defaults) as Record<string, unknown>;
    if (typeof doc.workspace === "object" && doc.workspace !== null) settings.workspace = doc.workspace;
    return settings;
  }
  throw new Error("settings JSON must be an effective settings object or backlog-provider-settings document");
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  const settingsJson = flagString(args.flags, "settings-json");
  const issuesJson = flagString(args.flags, "issues-json");
  const itemsJson = flagString(args.flags, "items-json");
  if (!settingsJson) throw new Error("--settings-json is required");
  const now = new Date(flagString(args.flags, "now") ?? Date.now());
  if (Number.isNaN(now.getTime())) throw new Error("--now must be a valid date/time when provided");
  const freshnessInputs: FreshnessInputs = {
    currentRef: flagString(args.flags, "current-ref"),
    currentSha: flagString(args.flags, "current-sha"),
    changedFiles: flagList(args.flags, "changed-file"),
    commitsSince: parseCommitsSince(flagList(args.flags, "commits-since")),
    now,
  };
  const settings = resolveSettings(loadJson(settingsJson) as Record<string, unknown>);
  if (itemsJson || !issuesJson) {
    const doc = itemsJson ? loadJson(itemsJson) : liveBoardDoc(settings);
    console.log(JSON.stringify(boardResult(settings, boardItemsFromDoc(doc, settings), openIssuesFromDoc(doc, settings)), null, 2));
    return 0;
  }
  const issuesDoc = loadJson(issuesJson);
  const issues = Array.isArray(issuesDoc) ? issuesDoc : ((issuesDoc as Record<string, unknown>).items as unknown[] ?? [issuesDoc]);
  const resolved = Object.fromEntries(flagList(args.flags, "resolved-ref").map((item) => item.split("=", 2) as [string, string]));
  const items = (issues as Record<string, unknown>[]).map((issue) => {
    const item = normalize(issue, settings);
    const freshness = revisionFreshness(item, freshnessInputs);
    return { ...item, dependency_impacts: dependencyImpacts(item, resolved), revision_freshness: freshness, readiness: applyFreshnessToReadiness(classify(item, settings, resolved), freshness) };
  });
  // A configured BoardProvider is the canonical readiness source (docs/decisions/backlog-readiness-source.md).
  // Reaching this issue-level listing path with a board configured is a bypass that must be loud, never silent.
  const bypassedBoard = asRecord(asRecord(settings.board_provider)?.board);
  const warnings = bypassedBoard
    ? [{ code: "board_provider_bypassed", message: "A BoardProvider is configured but this pass used WorkItemProvider issue-level listing; board-driven selection is the canonical readiness source. Surface this bypass in the pull-work artifact instead of treating issue listing as a silent fallback." }]
    : [];
  console.log(JSON.stringify({ items, warnings }, null, 2));
  return 0;
}

// Use process.exitCode (not process.exit) to allow stdout to be flushed before exit.
// Resolve real paths to handle symlinks (e.g. /tmp -> /private/tmp on macOS) so the
// entry-point guard fires correctly when the module is loaded directly as a script.
const _selfRealPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1RealPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfRealPath === _argv1RealPath) { process.exitCode = main(); }
