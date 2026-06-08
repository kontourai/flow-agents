#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";

type Issue = { path: string; message: string };

const root = path.resolve(".");
const statusRe = /\[(PASS|FAIL|NOT_VERIFIED|SKIP|PARTIAL)\]/i;
const dateTimeRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const sidecarSchemas: Record<string, string> = {
  "state.json": "schemas/workflow-state.schema.json",
  "acceptance.json": "schemas/workflow-acceptance.schema.json",
  "evidence.json": "schemas/workflow-evidence.schema.json",
  "handoff.json": "schemas/workflow-handoff.schema.json",
  "critique.json": "schemas/workflow-critique.schema.json",
  "release.json": "schemas/workflow-release.schema.json",
  "learning.json": "schemas/workflow-learning.schema.json",
};

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

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
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

function schemaMatches(value: unknown, schema: any, rootSchema: any): boolean {
  const issues: Issue[] = [];
  validateSchemaValue("<schema-match>", value, schema, "<value>", issues, rootSchema);
  return issues.length === 0;
}

function validateSchemaCondition(value: unknown, schema: any, rootSchema: any): boolean {
  const issues: Issue[] = [];
  validateSchemaValue("<schema-condition>", value, schema, "<value>", issues, rootSchema);
  return issues.length === 0;
}

function resolveSchemaRef(ref: string, rootSchema: any): any {
  if (!ref.startsWith("#/$defs/")) return undefined;
  return rootSchema?.$defs?.[ref.slice("#/$defs/".length)];
}

function validateSchemaValue(file: string, value: unknown, schema: any, loc: string, issues: Issue[], rootSchema = schema): void {
  if (schema.anyOf) {
    if (!schema.anyOf.some((sub: any) => schemaMatches(value, sub, rootSchema))) {
      issues.push({ path: file, message: `${loc} must match at least one allowed schema` });
    }
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((sub: any) => schemaMatches(value, sub, rootSchema)).length;
    if (matches !== 1) issues.push({ path: file, message: `${loc} must match exactly one allowed schema` });
  }
  if (schema.$ref) {
    const resolved = resolveSchemaRef(schema.$ref, rootSchema);
    if (!resolved) issues.push({ path: file, message: `${loc} has unsupported schema ref ${schema.$ref}` });
    else validateSchemaValue(file, value, resolved, loc, issues, rootSchema);
  }
  for (const sub of schema.allOf ?? []) validateSchemaValue(file, value, sub, loc, issues, rootSchema);
  if (schema.if && schema.then && validateSchemaCondition(value, schema.if, rootSchema)) validateSchemaValue(file, value, schema.then, loc, issues, rootSchema);
  if (schema.const !== undefined && value !== schema.const) issues.push({ path: file, message: `${loc} must be ${schema.const}` });
  if (schema.enum && !schema.enum.includes(value)) issues.push({ path: file, message: `${loc} must be one of: ${schema.enum.join(", ")}` });
  const t = schema.type;
  if (!t && (schema.required || schema.properties)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) { issues.push({ path: file, message: `${loc} must be object` }); return; }
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) issues.push({ path: file, message: `${loc}.${key} is required` });
    for (const [key, sub] of Object.entries<any>(schema.properties ?? {})) if (key in obj) validateSchemaValue(file, obj[key], sub, `${loc}.${key}`, issues, rootSchema);
  }
  if (t === "string") {
    if (typeof value !== "string") { issues.push({ path: file, message: `${loc} must be string` }); return; }
    if (typeof schema.minLength === "number" && value.length < schema.minLength) issues.push({ path: file, message: `${loc} must not be empty` });
    if (schema.format === "date-time") {
      const d = Date.parse(value);
      if (!dateTimeRe.test(value) || Number.isNaN(d)) issues.push({ path: file, message: `${loc} must be date-time` });
    }
    return;
  }
  if (t === "boolean" && typeof value !== "boolean") { issues.push({ path: file, message: `${loc} must be boolean` }); return; }
  if (t === "integer") {
    if (!Number.isInteger(value)) { issues.push({ path: file, message: `${loc} must be integer` }); return; }
    if (typeof schema.minimum === "number" && (value as number) < schema.minimum) issues.push({ path: file, message: `${loc} must be at least ${schema.minimum}` });
    return;
  }
  if (t === "number" && typeof value !== "number") { issues.push({ path: file, message: `${loc} must be number` }); return; }
  if (t === "array") {
    if (!Array.isArray(value)) { issues.push({ path: file, message: `${loc} must be array` }); return; }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) issues.push({ path: file, message: `${loc} must contain at least ${schema.minItems} item(s)` });
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) issues.push({ path: file, message: `${loc} must contain unique items` });
    if (schema.items) value.forEach((item, i) => validateSchemaValue(file, item, schema.items, `${loc}[${i}]`, issues, rootSchema));
    return;
  }
  if (t === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) { issues.push({ path: file, message: `${loc} must be object` }); return; }
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) issues.push({ path: file, message: `${loc}.${key} is required` });
    const props = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj).filter((k) => !(k in props)).sort()) issues.push({ path: file, message: `${loc}.${key} is not allowed` });
    }
    for (const [key, sub] of Object.entries<any>(props)) if (key in obj) validateSchemaValue(file, obj[key], sub, `${loc}.${key}`, issues, rootSchema);
  }
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

function validateSidecar(file: string): Issue[] {
  const { value, issues } = readJson(file);
  if (value === undefined) return issues;
  const schemaFile = sidecarSchemas[path.basename(file)];
  if (schemaFile) {
    const schema = JSON.parse(readText(path.join(root, schemaFile)));
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
  return issues;
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
  if (requireSidecars) {
    const dirs = new Set<string>(markdown.map((p) => path.dirname(p)));
    for (const dir of dirs) {
      const deliver = markdown.find((p) => path.dirname(p) === dir && p.includes("deliver") && !p.includes("plan") && !p.includes("review"));
      const delivered = deliver ? /status:\s*(delivered|accepted|archived)/i.test(readText(deliver)) : true;
      for (const name of ["state.json", "acceptance.json", ...(delivered ? ["evidence.json"] : []), "handoff.json"]) {
        if (!fs.existsSync(path.join(dir, name))) issues.push({ path: path.join(dir, name), message: "required sidecar is missing" });
      }
      if (requireCritique && !fs.existsSync(path.join(dir, "critique.json"))) issues.push({ path: path.join(dir, "critique.json"), message: "required sidecar is missing" });
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
  if (!skipMarkdown) for (const file of markdown) issues.push(...validateArtifact(file));
  for (const file of sidecars) issues.push(...validateSidecar(file));
  issues.push(...validateSidecarGroup(pathsIn, markdown, requireSidecars, requireCritique));
  if (issues.length) {
    for (const issue of issues) console.error(`${issue.path}: ${issue.message}`);
    return 1;
  }
  console.log(`Validated ${markdown.length} artifact(s) and ${sidecars.length} sidecar(s).`);
  return 0;
}

process.exit(main());
