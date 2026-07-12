#!/usr/bin/env node
"use strict";

const cp = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");

function git(...args) { return cp.execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
function show(tag, file) { return git("show", `${tag}:${file}`); }
function payloadAt(tag) {
  const manifest = JSON.parse(show(tag, "packaging/manifest.json"));
  const excluded = new Set(manifest.codex?.excluded_agents ?? []);
  const names = git("ls-tree", "--name-only", `${tag}:agents`).trim().split(/\n/).filter((name) => name.endsWith(".json"));
  const agents = names.map((name) => JSON.parse(show(tag, `agents/${name}`)))
    .filter((agent) => !excluded.has(agent.name)).sort((a, b) => a.name.localeCompare(b.name));
  const summary = agents.map((agent) => `- \`${agent.name}\` — ${String(agent.description ?? "").trim()}`).join("\n");
  return Buffer.from(`# Universal Agent Bundle (Codex)\n\nThis bundle was generated from the canonical source in this repo. Treat the repo root as the source of truth and regenerate the bundle instead of editing exported agent files by hand.\n\n## Shared Conventions\n\n- \`skills/\`, \`context/\`, \`powers/\`, \`prompts/\`, \`scripts/\`, and \`evals/\` were copied from the canonical source.\n- Cross-session task artifacts should live under \`${manifest.codex.task_dir}\`.\n- Kiro-only hook wiring was stripped from exported non-Kiro agents to keep the package portable.\n\n## Exported Agents\n\n${summary}\n`);
}

const catalogPath = process.argv[2];
if (!catalogPath) throw new Error("usage: audit-codex-legacy-agents.js CATALOG");
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const tags = git("tag", "--sort=version:refname").trim().split(/\n/).filter(Boolean);
const discovered = [];
for (const tag of tags) {
  let installer;
  try { installer = show(tag, "scripts/install-codex-home.sh"); } catch { continue; }
  if (!/for seed_file in AGENTS\.md/.test(installer)) continue;
  const bytes = payloadAt(tag);
  discovered.push({ tag, commit: git("rev-list", "-n1", tag).trim(), bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), payload: bytes });
}
const covered = new Map();
for (const file of catalog.files ?? []) for (const release of file.covered_releases ?? []) covered.set(release.tag, { ...release, file });
for (const release of discovered) {
  const entry = covered.get(release.tag);
  if (!entry) throw new Error(`catalog omits seed-capable release ${release.tag}`);
  if (entry.commit !== release.commit || entry.file.sha256 !== release.sha256 || entry.file.bytes !== release.bytes) throw new Error(`catalog mismatch for ${release.tag}`);
  if (!entry.file.fixture || !fs.existsSync(entry.file.fixture) || !release.payload.equals(fs.readFileSync(entry.file.fixture))) throw new Error(`fixture mismatch for ${release.tag}`);
}
for (const tag of covered.keys()) if (!discovered.some((release) => release.tag === tag)) throw new Error(`catalog includes non-seed-capable or unreachable release ${tag}`);
if (catalog.audit?.first_tag !== discovered[0]?.tag || catalog.audit?.last_tag !== discovered.at(-1)?.tag) throw new Error("catalog audit interval does not match independently discovered releases");
if (!Array.isArray(catalog.audit?.gaps)) throw new Error("catalog must explicitly record reproduction gaps");
console.log(`Audited ${discovered.length} seed-capable releases; ${new Set(discovered.map((item) => item.sha256)).size} unique payload(s); gaps=${catalog.audit.gaps.length}`);
