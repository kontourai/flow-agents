#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validateCritiqueResolutionGraph } from "./critique-resolution.js";
import { captureReviewWorkspaceSnapshot } from "../lib/review-workspace-snapshot.js";
import { lifecycleAuthorityResultDigest, verifyLifecycleAuthorityCompletion } from "../external-lifecycle-authority.js";
// #783: the mini JSON-Schema validator (validateSchemaValue) and its Issue type moved to a
// shared lib so workflow-sidecar.ts's `fixture write --from-json` validates against the SAME
// schema-matching logic this file uses -- see src/lib/mini-json-schema.ts's header comment.
import { validateSchemaValue, type Issue } from "../lib/mini-json-schema.js";

// Resolve bundled JSON Schemas relative to this compiled script's own package
// location (build/src/cli/validate-workflow-artifacts.js -> ../../../schemas), NOT
// process.cwd(), so `flow-agents-validate-artifacts` works from any repo (the artifact
// paths to validate are still taken from argv/cwd). Mirrors the package-relative pattern
// used for liveness-read.js in workflow-sidecar.ts.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const statusRe = /\[(PASS|FAIL|NOT_VERIFIED|SKIP|PARTIAL)\]/i;
const sidecarSchemas: Record<string, string> = {
  "state.json": "schemas/workflow-state.schema.json",
  "acceptance.json": "schemas/workflow-acceptance.schema.json",
  "evidence.json": "schemas/workflow-evidence.schema.json",
  "handoff.json": "schemas/workflow-handoff.schema.json",
  "critique.json": "schemas/workflow-critique.schema.json",
  "release.json": "schemas/workflow-release.schema.json",
  "learning.json": "schemas/workflow-learning.schema.json",
  "waves.json": "schemas/workflow-waves.schema.json",
};

// Signed critique-resolution events are verified against the repository-owned
// trust-root registry. Validation can be invoked from any working directory,
// so process.cwd() is not an authority boundary: derive the owning repository
// from the canonical runtime session path instead.
function projectRootForSession(dir: string): string | undefined {
  const marker = `${path.sep}.kontourai${path.sep}flow-agents${path.sep}`;
  const resolved = path.resolve(dir);
  const markerIndex = resolved.lastIndexOf(marker);
  return markerIndex > 0 ? resolved.slice(0, markerIndex) : undefined;
}
// Runtime coordination records live below a session but are not workflow
// sidecars. Recursing into them would validate continuation-driver/state.json
// against the public workflow-state schema and turn an active driver into a
// false Goal Fit hard block.

function readText(file: string): string {
  return fs.readFileSync(file, "utf8");
}

function section(text: string, heading: string): string {
  const re = new RegExp(`^(?<marks>##+)\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  const match = re.exec(text);
  if (!match?.groups) return "";
  const level = match.groups.marks.length;
  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const next = new RegExp(`^#{2,${level}}\\s+`, "m").exec(rest);
  return rest.slice(0, next ? next.index : undefined).trim();
}

function field(text: string, name: string): string {
  const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(.+)$`, "m");
  return re.exec(text)?.[1]?.trim() ?? "";
}

function frontmatterField(text: string, name: string): string {
  if (!text.startsWith("---")) return "";
  const end = text.indexOf("\n---", 3);
  if (end < 0) return "";
  return field(text.slice(0, end), name);
}

function checkboxes(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^-\s+\[[ xX]\]/.test(line));
}

function unchecked(text: string): string[] {
  return checkboxes(text).filter((line) => /^-\s+\[\s\]/.test(line));
}

function statusLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => statusRe.test(line));
}

function acceptanceLines(text: string): string[] {
  const body = section(text, "Acceptance Criteria") || section(text, "Definition Of Done");
  return body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("-"));
}

function definitionAcceptanceCriteria(text: string): string[] {
  const body = section(text, "Definition Of Done");
  const found: string[] = [];
  let inAcceptance = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^-\s+\*\*Acceptance criteria:\*\*/i.test(line)) {
      inAcceptance = true;
      continue;
    }
    if (inAcceptance && /^-\s+\*\*(Usefulness checks|Stop-short risks|Durable docs target|Scope|User outcome):\*\*/i.test(line)) break;
    if (inAcceptance && /^-\s+\[[ xX]\]/.test(line)) found.push(line);
  }
  return found;
}

function hasEvidence(text: string): boolean {
  return /\bEvidence:\s*\S|\bevidence\b.+\S/i.test(text);
}

function hasExplicitAcceptance(text: string): boolean {
  return /explicitly accepted|accepted by user|user accepted|accepted gap/i.test(text);
}

function isPrivateRuntimeChild(dir: string): boolean {
  if (path.basename(dir) !== "continuation-driver") return false;
  const sessionDir = path.dirname(dir);
  const sessionState = path.join(sessionDir, "state.json");
  try {
    const stat = fs.lstatSync(sessionState);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    const state = JSON.parse(readText(sessionState)) as { task_slug?: unknown };
    return state.task_slug === path.basename(sessionDir);
  } catch {
    return false;
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory() && !isPrivateRuntimeChild(p)) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function artifactPaths(pathsIn: string[]): string[] {
  const found = new Set<string>();
  for (const p of pathsIn) {
    if (fs.existsSync(p) && fs.statSync(p).isFile() && p.endsWith(".md")) found.add(path.resolve(p));
    else if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      for (const f of walk(p)) if (f.endsWith(".md")) found.add(path.resolve(f));
    }
  }
  return [...found].sort();
}

function sidecarPaths(pathsIn: string[]): string[] {
  const names = new Set(Object.keys(sidecarSchemas));
  const found = new Set<string>();
  for (const p of pathsIn) {
    if (fs.existsSync(p) && fs.statSync(p).isFile() && names.has(path.basename(p))) found.add(path.resolve(p));
    else if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      for (const f of walk(p)) if (names.has(path.basename(f))) found.add(path.resolve(f));
    }
  }
  return [...found].sort();
}

function artifactKind(file: string, text: string): string {
  const base = path.basename(file);
  return (frontmatterField(text, "role") || field(text, "type") || (base.endsWith("-plan.md") ? "plan" : base.endsWith("-review.md") ? "review" : base.includes("deliver") ? "deliver" : "artifact")).toLowerCase();
}

function requireSection(file: string, text: string, heading: string, issues: Issue[]): string {
  const body = section(text, heading);
  if (!body) issues.push({ path: file, message: `missing section: ## ${heading}` });
  return body;
}

function validateDefinitionOfDone(file: string, text: string, issues: Issue[]): void {
  const dod = requireSection(file, text, "Definition Of Done", issues);
  if (!dod) return;
  const modes = new Set(["local-read-only", "local-edit", "worktree", "container", "cloud-sandbox", "privileged-integration"]);
  for (const [label, pattern] of [
    ["User outcome", /User outcome/i],
    ["Acceptance criteria", /Acceptance criteria/i],
    ["Evidence", /Evidence:|\bevidence\b/i],
    ["Stop-short risks", /Stop-short risks/i],
    ["Durable docs target", /Durable docs target/i],
    ["Sandbox mode", /Sandbox mode:\*\*/i],
  ] as const) if (!pattern.test(dod)) issues.push({ path: file, message: `Definition Of Done missing ${label}` });
  const match = /Sandbox mode:\*\*\s*`?([a-z-]+)`?/i.exec(dod);
  if (match && !modes.has(match[1].toLowerCase())) issues.push({ path: file, message: `Definition Of Done has invalid Sandbox mode; expected one of: ${[...modes].sort().join(", ")}` });
}

function validateArtifact(file: string): Issue[] {
  const issues: Issue[] = [];
  const text = readText(file);
  const kind = artifactKind(file, text);
  if (kind === "plan") {
    requireSection(file, text, "Plan", issues);
    validateDefinitionOfDone(file, text, issues);
    if (!/^###\s+Wave\s+\d+/m.test(text)) issues.push({ path: file, message: "plan artifact missing implementation waves" });
  } else if (kind === "review") {
    requireSection(file, text, "Verification Report", issues);
    const verdict = frontmatterField(text, "verdict") || /###\s+Verdict:\s*(\w+)/i.exec(text)?.[1] || "";
    if (!verdict) issues.push({ path: file, message: "review artifact missing verdict" });
    if (/PASS/i.test(verdict) && statusLines(text).some((line) => /\[NOT_VERIFIED\]/i.test(line)) && !hasExplicitAcceptance(text)) issues.push({ path: file, message: "PASS review contains NOT_VERIFIED without explicit acceptance or routing" });
    if (/PASS/i.test(verdict) && !hasEvidence(text)) issues.push({ path: file, message: "PASS review missing evidence" });
  } else if (kind === "deliver") {
    requireSection(file, text, "Plan", issues);
    validateDefinitionOfDone(file, text, issues);
    requireSection(file, text, "Verification Report", issues);
    requireSection(file, text, "Goal Fit Gate", issues);
    requireSection(file, text, "Final Acceptance", issues);
    const delivered = /status:\s*(delivered|accepted|archived)/i.test(text);
    if (delivered && unchecked(section(text, "Goal Fit Gate")).length) issues.push({ path: file, message: "Goal Fit Gate has unchecked items" });
    if (delivered && unchecked(section(text, "Final Acceptance")).length) issues.push({ path: file, message: "Final Acceptance has unchecked items" });
    const verification = section(text, "Verification Report");
    if (/Verdict:\s*PASS/i.test(verification) && !acceptanceLines(verification).some((line) => /\[PASS\]/i.test(line) && hasEvidence(line))) issues.push({ path: file, message: "green build is not enough; acceptance evidence is missing" });
    if (delivered && /NOT_VERIFIED/i.test(text) && !hasExplicitAcceptance(text)) issues.push({ path: file, message: "NOT_VERIFIED requires explicit acceptance or routing" });
    if (statusLines(verification).length && !hasEvidence(verification)) issues.push({ path: file, message: "verification statuses require evidence" });
  }
  return issues;
}

function readJson(file: string): { value: any | undefined; issues: Issue[] } {
  try { return { value: JSON.parse(readText(file)), issues: [] }; }
  catch (error) { return { value: undefined, issues: [{ path: file, message: `invalid JSON: ${(error as Error).message}` }] }; }
}

function validateSidecar(file: string): { issues: Issue[]; warnings: Issue[] } {
  const { value, issues } = readJson(file);
  const warnings: Issue[] = [];
  if (value === undefined) return { issues, warnings };
  const schemaFile = sidecarSchemas[path.basename(file)];
  if (schemaFile) {
    const schema = JSON.parse(readText(path.join(packageRoot, schemaFile)));
    validateSchemaValue(file, value, schema, path.basename(file), issues, schema);
  }
  if (path.basename(file) === "evidence.json") {
    const checks = Array.isArray(value.checks) ? value.checks : [];
    if (value.verdict === "pass" && checks.some((c: any) => c.status !== "pass" && c.status !== "skip")) issues.push({ path: file, message: "pass verdict requires all non-skipped checks to pass" });
    if (value.verdict === "pass" && checks.length === 0) issues.push({ path: file, message: "checks must contain at least 1 item" });
  }
  if (path.basename(file) === "critique.json") {
    const critiques = Array.isArray(value.critiques) ? value.critiques : [];
    if (value.status === "pass" && critiques.some((c: any) => Array.isArray(c.findings) && c.findings.some((f: any) => f.status === "open"))) issues.push({ path: file, message: "critique pass cannot have open findings" });
    if (value.required && value.status !== "pass") issues.push({ path: file, message: "required critique must pass" });
  }
  if (path.basename(file) === "learning.json") {
    const records = Array.isArray(value.records) ? value.records : [];
    if (value.status === "learned" && records.length === 0) issues.push({ path: file, message: "records must contain at least 1 item" });
    if (value.status === "learned" && records.some((r: any) => Array.isArray(r.routing) && r.routing.some((x: any) => x.status === "open"))) issues.push({ path: file, message: "learning status learned cannot have open routing" });
    validateLearningCorrections(file, value.status, records, issues);
  }
  if (path.basename(file) === "release.json") {
    const gates = Array.isArray(value.gates) ? value.gates : [];
    if (["merge", "release", "deploy"].includes(value.decision)) {
      if (gates.some((g: any) => g.status !== "pass" && g.status !== "not_required")) issues.push({ path: file, message: "positive release decision requires all required gates to pass" });
      if (!gates.some((g: any) => g.name === value.decision && g.status === "pass")) issues.push({ path: file, message: `positive release decision requires ${value.decision} gate to pass` });
    }
    if (value.decision === "deploy") {
      if (value.rollback_plan?.status !== "ready") issues.push({ path: file, message: "deploy decision requires rollback_plan status ready" });
      if (value.observability_plan?.status !== "ready") issues.push({ path: file, message: "deploy decision requires observability_plan status ready" });
      if (!Array.isArray(value.post_deploy_checks) || value.post_deploy_checks.length === 0) issues.push({ path: file, message: "deploy decision requires post_deploy_checks" });
      if (Array.isArray(value.post_deploy_checks) && value.post_deploy_checks.some((c: any) => !["planned", "pass"].includes(c.status))) issues.push({ path: file, message: "deploy decision requires post_deploy_checks to be planned or pass" });
    }
  }
  if (path.basename(file) === "waves.json") {
    validateWaves(file, value, issues);
  }
  if (path.basename(file) === "state.json" && value && typeof value === "object" && !Array.isArray(value) && !("branch" in value)) {
    warnings.push({ path: file, message: "state.json has no branch field (legacy/pre-#289 session) — re-run `ensure-session` to backfill agent/<actor>/<slug>." });
  }
  return { issues, warnings };
}

// #663 slice 1: wave-result reconciliation is machine-checkable, not prose. The schema
// (schemas/workflow-waves.schema.json) validates the shape; these semantic checks enforce the
// cross-record arithmetic the mini schema engine cannot express: exactly one terminal status
// record per declared worker, no undeclared reporters, reconciliation counts that match the
// records, and a `complete` claim that is impossible while any expected worker lacks a
// worker-landed terminal status. Missing workers must be recorded explicitly as not_reported —
// a reconciled wave never silently absorbs a dropped worker. Enforcement here is data-level
// validation only; stop-hook refusal of wave completion is #663 part 3 (slice 2).
function validateWaves(file: string, value: any, issues: Issue[]): void {
  const waves = Array.isArray(value?.waves) ? value.waves : [];
  waves.forEach((wave: any, index: number) => {
    const loc = `waves.json.waves[${index}]`;
    const expected: any[] = Array.isArray(wave?.expected_workers) ? wave.expected_workers : [];
    const results: any[] = Array.isArray(wave?.worker_results) ? wave.worker_results : [];
    const expectedIds = expected.map((w) => w?.worker_id).filter((id) => typeof id === "string" && id.length > 0);
    const expectedIdSet = new Set(expectedIds);
    if (expectedIdSet.size !== expectedIds.length) issues.push({ path: file, message: `${loc}.expected_workers must declare unique worker_id values` });
    const resultIds = results.map((r) => r?.worker_id).filter((id) => typeof id === "string" && id.length > 0);
    const seen = new Set<string>();
    for (const id of resultIds) {
      if (seen.has(id)) issues.push({ path: file, message: `${loc}.worker_results has more than one terminal status record for worker ${id}; each worker lands exactly one` });
      seen.add(id);
      if (!expectedIdSet.has(id)) issues.push({ path: file, message: `${loc}.worker_results records worker ${id} that is not declared in expected_workers; declare every worker in the manifest before dispatch` });
    }
    const reconciliation = wave?.reconciliation;
    if (!reconciliation || typeof reconciliation !== "object" || Array.isArray(reconciliation)) return;
    const expectedCount = expectedIds.length;
    const reportedIds = new Set(results.filter((r) => ["completed", "failed", "blocked"].includes(r?.status) && expectedIdSet.has(r?.worker_id)).map((r) => r.worker_id as string));
    const reportedCount = reportedIds.size;
    if (reconciliation.expected_count !== expectedCount) issues.push({ path: file, message: `${loc}.reconciliation.expected_count is ${reconciliation.expected_count} but expected_workers declares ${expectedCount}` });
    if (reconciliation.reported_count !== reportedCount) issues.push({ path: file, message: `${loc}.reconciliation.reported_count is ${reconciliation.reported_count} but ${reportedCount} of ${expectedCount} expected workers have a worker-landed terminal status (completed|failed|blocked)` });
    const missing = expectedIds.filter((id) => !results.some((r) => r?.worker_id === id));
    for (const id of missing) issues.push({ path: file, message: `${loc} is reconciled but worker ${id} has no terminal status record; record it explicitly as not_reported — never silently absorb a missing worker` });
    const notReported = results.filter((r) => r?.status === "not_reported" && expectedIdSet.has(r?.worker_id));
    if (reconciliation.status === "complete" && (missing.length > 0 || notReported.length > 0 || reportedCount !== expectedCount)) {
      issues.push({ path: file, message: `${loc}.reconciliation.status complete requires every expected worker to have a worker-landed terminal status; got ${reportedCount} of ${expectedCount} reported` });
    }
    if (reconciliation.status === "incomplete" && missing.length === 0 && notReported.length === 0 && reportedCount === expectedCount) {
      issues.push({ path: file, message: `${loc}.reconciliation.status incomplete contradicts the records: all ${expectedCount} expected workers reported` });
    }
  });
}

function validateLearningCorrections(file: string, status: unknown, records: any[], issues: Issue[]): void {
  records.forEach((record, index) => {
    const correction = record?.correction;
    const loc = `learning.json.records[${index}].correction`;
    if (correction === undefined) {
      if (status === "learned") issues.push({ path: file, message: `${loc}.needed is required when learning status is learned` });
      return;
    }
    if (correction?.needed === false) {
      if (typeof correction.evidence !== "string" || correction.evidence.length === 0) {
        issues.push({ path: file, message: `${loc}.evidence is required when correction.needed is false` });
      }
      return;
    }
    if (correction?.needed !== true) return;
    for (const key of ["type", "recurrence_key", "intended_behavior", "observed_behavior", "gap"]) {
      if (typeof correction[key] !== "string" || correction[key].length === 0) issues.push({ path: file, message: `${loc}.${key} is required when correction.needed is true` });
    }
    const prevention = correction.prevention;
    if (prevention !== undefined) validateLearningPrevention(file, `${loc}.prevention`, prevention, issues);
    const hasPrevention = prevention !== undefined;
    const hasNoChange = typeof correction.no_change_rationale === "string" && correction.no_change_rationale.length > 0;
    if (!hasPrevention && !hasNoChange) {
      issues.push({ path: file, message: `${loc} requires prevention route or no_change_rationale when correction.needed is true` });
    }
  });
}

function validateLearningPrevention(file: string, loc: string, prevention: any, issues: Issue[]): void {
  if (!prevention || typeof prevention !== "object" || Array.isArray(prevention)) {
    issues.push({ path: file, message: `${loc} must be an object` });
    return;
  }
  if (typeof prevention.target !== "string" || prevention.target.length === 0) {
    issues.push({ path: file, message: `${loc}.target is required` });
  } else if (!["rule", "skill", "power", "agent", "eval", "doc", "backlog", "knowledge", "none"].includes(prevention.target)) {
    issues.push({ path: file, message: `${loc}.target must be one of: rule, skill, power, agent, eval, doc, backlog, knowledge, none` });
  }
  if (typeof prevention.action !== "string" || prevention.action.length === 0) issues.push({ path: file, message: `${loc}.action is required` });
  if (typeof prevention.status !== "string" || prevention.status.length === 0) {
    issues.push({ path: file, message: `${loc}.status is required` });
  } else if (!["open", "completed", "accepted", "deferred", "rejected"].includes(prevention.status)) {
    issues.push({ path: file, message: `${loc}.status must be one of: open, completed, accepted, deferred, rejected` });
  }
}

function validateSidecarGroup(inputs: string[], markdown: string[], requireSidecars: boolean, requireCritique: boolean): Issue[] {
  const issues: Issue[] = [];
  const sidecars = sidecarPaths(inputs);
  const byDir = new Map<string, Map<string, any>>();
  for (const file of sidecars) {
    const { value } = readJson(file);
    if (value !== undefined) {
      const dir = path.dirname(file);
      if (!byDir.has(dir)) byDir.set(dir, new Map());
      byDir.get(dir)!.set(path.basename(file), value);
    }
  }
  for (const [dir, payloads] of byDir) {
    const slugs = new Set([...payloads.values()].map((p: any) => p.task_slug).filter(Boolean));
    if (slugs.size > 1) issues.push({ path: dir, message: "sidecar task_slug mismatch" });
    const evidence = payloads.get("evidence.json");
    if (evidence?.verdict === "pass" && Array.isArray(evidence.checks) && evidence.checks.some((c: any) => c.status !== "pass" && c.status !== "skip")) issues.push({ path: path.join(dir, "evidence.json"), message: "pass verdict requires all non-skipped checks to pass" });
  }
  if (requireSidecars || requireCritique) {
    const dirs = new Set<string>([
      ...markdown.map((p) => path.dirname(p)),
      ...inputs.filter((p) => fs.existsSync(p) && fs.statSync(p).isDirectory()).map((p) => path.resolve(p)),
    ]);
    for (const dir of dirs) {
      const deliver = markdown.find((p) => path.dirname(p) === dir && p.includes("deliver") && !p.includes("plan") && !p.includes("review"));
      const delivered = deliver ? /status:\s*(delivered|accepted|archived)/i.test(readText(deliver)) : true;
      // ADR 0010 Phase 4b: trust.bundle is the primary artifact at the delivered phase.
      // evidence.json is OPTIONAL when trust.bundle is present (still schema-validated when present).
      // Hard-fail on evidence.json absence only when no trust.bundle exists for a delivered session.
      const hasTrustBundle = fs.existsSync(path.join(dir, "trust.bundle"));
      const evidenceRequired = delivered && !hasTrustBundle;
      if (requireSidecars) {
        for (const name of ["state.json", "acceptance.json", ...(evidenceRequired ? ["evidence.json"] : []), "handoff.json"]) {
          if (!fs.existsSync(path.join(dir, name))) issues.push({ path: path.join(dir, name), message: "required sidecar is missing" });
        }
      }
      // ADR 0010 Phase 4c: critique.json no longer written; trust.bundle carries critique claims. Accept either.
      if (requireCritique && !fs.existsSync(path.join(dir, "critique.json")) && !fs.existsSync(path.join(dir, "trust.bundle"))) issues.push({ path: path.join(dir, "critique.json"), message: "required sidecar is missing" });
      // ADR 0010 Phase 4c: validate critique claims in trust.bundle (sole verification artifact).
      const trustBundlePath = path.join(dir, "trust.bundle");
      if (requireCritique && fs.existsSync(trustBundlePath)) {
        const { value: bundleValue } = readJson(trustBundlePath);
        if (bundleValue) {
          const claims = Array.isArray(bundleValue.claims) ? bundleValue.claims : [];
          const stateResult = readJson(path.join(dir, "state.json"));
          const state = stateResult.value;
          const subject = Array.isArray(state?.work_item_refs) && state.work_item_refs.length === 1
            ? state.work_item_refs[0]
            : typeof state?.task_slug === "string" ? `flow-agents://session/${state.task_slug}` : undefined;
          const authorityEvents = readJson(path.join(dir, "lifecycle-authority.resolution-events.json")).value;
          const resolutionEvents = Array.isArray(authorityEvents?.events)
            ? authorityEvents.events
            : Array.isArray(bundleValue.critique_resolution_events) ? bundleValue.critique_resolution_events : [];
          let externalCompletionVerified = false;
          const completion = readJson(path.join(dir, "lifecycle-authority.completion.json")).value;
          try {
            const verified = verifyLifecycleAuthorityCompletion(completion);
            externalCompletionVerified = ["resolve-critique", "repair-critique-resolution-history"].includes(String(verified.action))
              && verified.run_id === path.basename(dir)
              && verified.result_core_sha256 === lifecycleAuthorityResultDigest({ ...bundleValue, critique_resolution_events: resolutionEvents });
          } catch {
            // A cross-reviewer edge remains NOT_VERIFIED without a root-signed completion.
          }
          const graph = validateCritiqueResolutionGraph(claims, subject, resolutionEvents, projectRootForSession(dir), externalCompletionVerified);
          if (!graph.valid) issues.push({ path: trustBundlePath, message: `required critique must pass: ${graph.errors.join("; ")}` });
          const projectRoot = projectRootForSession(dir);
          if (!projectRoot) {
            issues.push({ path: trustBundlePath, message: "required critique project root could not be resolved" });
            continue;
          }
          for (const critique of graph.live) {
            const artifacts = Array.isArray(critique.review_target?.artifacts) ? critique.review_target.artifacts : [];
            try {
              const currentArtifacts = artifacts.map((artifact: any) => {
                const file = path.resolve(projectRoot, String(artifact.file));
                const relative = path.relative(fs.realpathSync(projectRoot), fs.realpathSync(file));
                if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("artifact escapes project root");
                const sha256 = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
                if (sha256 !== artifact.sha256) throw new Error("artifact digest changed");
                return { file: String(artifact.file), sha256 };
              });
              if (currentArtifacts.length === 0 || !isDeepStrictEqual(critique.review_target?.workspace_snapshot, captureReviewWorkspaceSnapshot(projectRoot, currentArtifacts))) throw new Error("workspace snapshot changed");
            } catch { issues.push({ path: trustBundlePath, message: "required critique resolver artifacts or workspace are no longer current" }); }
          }
        }
      }
      const acceptance = path.join(dir, "acceptance.json");
      if (deliver && fs.existsSync(acceptance)) {
        const expected = definitionAcceptanceCriteria(readText(deliver)).length;
        const payload = JSON.parse(readText(acceptance));
        const actual = Array.isArray(payload.criteria) ? payload.criteria.length : 0;
        if (expected && actual !== expected) issues.push({ path: acceptance, message: `acceptance.json has ${actual} criteria but Markdown defines ${expected}` });
      }
    }
  }
  return issues;
}

function main(): number {
  const args = process.argv.slice(2);
  const requireSidecars = args.includes("--require-sidecars");
  const requireCritique = args.includes("--require-critique");
  const skipMarkdown = args.includes("--skip-markdown-validation");
  const pathsIn = args.filter((a) => !a.startsWith("--"));
  if (!pathsIn.length) {
    console.error("usage: validate-workflow-artifacts [--require-sidecars] [--require-critique] [--skip-markdown-validation] paths...");
    return 2;
  }
  const markdown = artifactPaths(pathsIn);
  const sidecars = sidecarPaths(pathsIn);
  const issues: Issue[] = [];
  const warnings: Issue[] = [];
  if (!skipMarkdown) for (const file of markdown) issues.push(...validateArtifact(file));
  for (const file of sidecars) {
    const result = validateSidecar(file);
    issues.push(...result.issues);
    warnings.push(...result.warnings);
  }
  issues.push(...validateSidecarGroup(pathsIn, markdown, requireSidecars, requireCritique));
  for (const w of warnings) console.error(`WARN ${w.path}: ${w.message}`);
  if (issues.length) {
    for (const issue of issues) console.error(`${issue.path}: ${issue.message}`);
    return 1;
  }
  console.log(`Validated ${markdown.length} artifact(s) and ${sidecars.length} sidecar(s).`);
  return 0;
}

process.exit(main());
