import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createCodexAdapter, type InstallationReceipt } from "@kontourai/conduit";

const STATUS = "Flow Agents: Veritas guidance for this repository";
const MATCHER = "apply_patch|Edit|Write";

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function gitValue(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, "rev-parse", ...args], { encoding: "utf8" }).trim();
}

export function codexGovernanceCommand(repository: string): string {
  const root = fs.realpathSync(gitValue(repository, "--show-toplevel"));
  const common = gitValue(root, "--git-common-dir");
  const commonDir = fs.realpathSync(path.resolve(root, common));
  const packageFile = path.join(root, "package.json");
  const packageName = JSON.parse(fs.readFileSync(packageFile, "utf8")).name as unknown;
  if (typeof packageName !== "string" || packageName.length === 0) throw new Error("repository package.json must name its package");
  if (!fs.existsSync(path.join(root, ".veritas", "repo-map.json"))) throw new Error("repository has no Veritas Repo Map");

  // The reviewed command contains the repository identity and all dispatcher code.
  // Changing either changes Codex's hook hash and requires another hook review.
  const code = `
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const expectedCommon = ${JSON.stringify(commonDir)};
const expectedPackage = ${JSON.stringify(packageName)};
const input = fs.readFileSync(0);
let event;
try { event = JSON.parse(input.toString("utf8")); } catch { process.exit(0); }
if (typeof event.cwd !== "string" || !path.isAbsolute(event.cwd)) process.exit(0);
let root, common;
try {
  root = cp.execFileSync("git", ["-C", event.cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  common = cp.execFileSync("git", ["-C", event.cwd, "rev-parse", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  common = fs.realpathSync(path.resolve(root, common));
} catch { process.exit(0); }
if (common !== expectedCommon) process.exit(0);
try {
  if (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).name !== expectedPackage) process.exit(0);
  if (!fs.statSync(path.join(root, ".veritas", "repo-map.json")).isFile()) process.exit(0);
} catch { process.exit(0); }
const result = cp.spawnSync("npm", ["exec", "--", "veritas", "hooks", "codex", "pre-tool-use"], { cwd: root, input, maxBuffer: 4 * 1024 * 1024 });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) { process.stderr.write(String(result.error)); process.exit(1); }
process.exit(result.status ?? 1);
`;
  return `node -e ${quoteShell(code)}`;
}

function verifyVeritasCodexProtocol(repository: string): void {
  const root = gitValue(repository, "--show-toplevel");
  const probe = spawnSync("npm", ["exec", "--", "veritas", "hooks", "codex", "pre-tool-use"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    input: JSON.stringify({
      cwd: root,
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Add File: docs/flow-agents-hook-probe.txt\n+probe\n*** End Patch" },
    }),
  });
  if (probe.error || probe.status !== 0) throw new Error("the repository's Veritas Codex hook probe did not complete successfully");
  let output: Record<string, unknown>;
  try {
    output = JSON.parse(probe.stdout) as Record<string, unknown>;
  } catch {
    throw new Error("the repository's Veritas Codex hook emitted invalid JSON");
  }
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("the repository's Veritas Codex hook emitted a non-object response");
  }
  if (Object.keys(output).some((key) => key !== "hookSpecificOutput" && key !== "systemMessage")) {
    throw new Error("the repository's Veritas Codex hook emits fields current Codex rejects; update Veritas before installing");
  }
}

export async function installCodexGovernanceHook(repository: string, codexHome: string): Promise<InstallationReceipt> {
  const home = path.resolve(codexHome);
  const target = path.join(home, "hooks.json");
  const command = codexGovernanceCommand(repository);
  verifyVeritasCodexProtocol(repository);
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(target)) {
    if (!fs.lstatSync(target).isFile()) throw new Error("Codex hooks target must be a regular file");
    existing = JSON.parse(fs.readFileSync(target, "utf8")) as Record<string, unknown>;
  }
  const hooks = existing.hooks === undefined ? {} : existing.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) throw new Error("Codex hooks must be an object");
  const groups = (hooks as Record<string, unknown>).PreToolUse ?? [];
  if (!Array.isArray(groups)) throw new Error("Codex PreToolUse groups must be an array");
  const retained = groups.flatMap((group) => {
    const record = group as { hooks?: { statusMessage?: string }[] };
    if (!Array.isArray(record.hooks)) throw new Error("Codex PreToolUse group has no handler array");
    const remaining = record.hooks.filter((handler) => handler.statusMessage !== STATUS);
    return remaining.length > 0 ? [{ ...record, hooks: remaining }] : [];
  });
  const updated = {
    ...existing,
    hooks: {
      ...hooks,
      PreToolUse: [...retained, { matcher: MATCHER, hooks: [{ type: "command", command, statusMessage: STATUS, timeout: 30 }] }],
    },
  };
  const content = `${JSON.stringify(updated, null, 2)}\n`;
  const adapter = createCodexAdapter({
    resolveTarget: () => target,
    write: (resolved, bytes) => {
      if (resolved !== target || bytes !== content) throw new Error("Conduit returned an unexpected Codex hook asset");
      fs.mkdirSync(home, { recursive: true });
      if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === bytes) return;
      const temporary = path.join(home, `.hooks.json.${process.pid}.${crypto.randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, target);
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    },
  });
  return adapter.install([{ id: "flow-agents.veritas.codex-pre-tool-use", kind: "hook", content }]);
}

export async function main(argv: string[]): Promise<number> {
  if (argv.length !== 2 || argv[0] !== "install") {
    console.error("usage: flow-agents codex-governance-hook install <governed-repository>");
    return 2;
  }
  try {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    const receipt = await installCodexGovernanceHook(argv[1]!, home);
    console.log(JSON.stringify({ receipt, codexHome: home, hostActivation: "not_verified", requiresHostTrust: true }));
    return 0;
  } catch (error) {
    console.error(`flow-agents codex-governance-hook: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
