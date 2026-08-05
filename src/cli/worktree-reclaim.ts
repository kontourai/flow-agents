import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ChangeProviderSettings } from "./public-contracts.js";
import { resolveEffectiveChangeProviderSettings } from "./effective-change-provider-settings.js";
import { observeGithubMergedChange, type GithubMergedChangeObservation } from "./github-change-provider.js";
import { execTrustedGitSync } from "../lib/trusted-git.js";

const MAX_PROVIDER_RESULT_BYTES = 65_536;
const SHA = /^[0-9a-f]{40,64}$/u;

type PublishedChange = Readonly<{
  repository: { owner: string; name: string };
  provider: { kind: "github"; configurationId: string };
  change: {
    number: number;
    state: "open" | "merged";
    baseRef: string;
    headRef: string;
    headSha: string;
  };
  providerActor: string;
}>;

export type WorktreeReclaimReceipt = Readonly<{
  schema_version: "1.0";
  outcome: "reclaimed";
  repository: { owner: string; name: string };
  branch: string;
  head_sha: string;
  merge_sha: string;
  provider_actor: string;
  observed_at: string;
  reclaimed_at: string;
}>;

export type WorktreeReclaimDependencies = Readonly<{
  observeMergedChange?: (input: Readonly<{
    settings: ChangeProviderSettings;
    configurationId: string;
    expected: {
      number: number;
      repository: { owner: string; name: string };
      baseRef: string;
      headRef: string;
      headSha: string;
      providerActor: string;
    };
  }>) => Promise<GithubMergedChangeObservation>;
  now?: () => string;
}>;

/**
 * Remove only a clean, registered, non-primary worktree whose exact head has a
 * fresh authenticated merged observation. The branch is deliberately retained.
 */
export async function reclaimBuilderWorktree(
  sessionDirInput: string,
  dependencies: WorktreeReclaimDependencies = {},
): Promise<WorktreeReclaimReceipt> {
  const sessionDir = realDirectory(sessionDirInput, "session directory");
  const worktree = realDirectory(String(execTrustedGitSync(sessionDir, ["rev-parse", "--show-toplevel"])).trim(), "worktree");
  const commonDirText = String(execTrustedGitSync(worktree, ["rev-parse", "--git-common-dir"])).trim();
  const commonDir = fs.realpathSync(path.resolve(worktree, commonDirText));
  const primaryRoot = fs.realpathSync(path.dirname(commonDir));
  if (worktree === primaryRoot) throw new Error("builder-run reclaim refuses the primary repository checkout");
  if (!containsPath(worktree, sessionDir)) throw new Error("builder-run reclaim session is not inside the target worktree");
  assertRegisteredWorktree(primaryRoot, worktree);
  const dirty = String(execTrustedGitSync(worktree, ["status", "--porcelain=v1", "--untracked-files=all"])).trim();
  if (dirty) throw new Error("builder-run reclaim refuses a dirty worktree");

  assertLearningComplete(sessionDir);
  const published = readPublishedChange(sessionDir);
  const headSha = String(execTrustedGitSync(worktree, ["rev-parse", "--verify", "HEAD^{commit}"])).trim().toLowerCase();
  const branch = String(execTrustedGitSync(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
  if (published.change.headSha !== headSha || published.change.headRef !== branch) {
    throw new Error("builder-run reclaim worktree HEAD does not match the published change");
  }
  const effective = resolveEffectiveChangeProviderSettings(primaryRoot);
  if (effective.status !== "configured" || !effective.provider || typeof effective.provider !== "object") {
    throw new Error("builder-run reclaim requires the configured ChangeProvider");
  }
  const settings = effective.provider as ChangeProviderSettings;
  const observe = dependencies.observeMergedChange
    ?? ((input) => observeGithubMergedChange(input));
  const observation = await observe({
    settings,
    configurationId: published.provider.configurationId,
    expected: {
      number: published.change.number,
      repository: published.repository,
      baseRef: published.change.baseRef,
      headRef: published.change.headRef,
      headSha: published.change.headSha,
      providerActor: published.providerActor,
    },
  });
  if (observation.state !== "merged" || observation.headSha !== headSha) {
    throw new Error("builder-run reclaim provider observation did not confirm the exact merged head");
  }

  // Non-forced removal is the final safety check Git itself provides. Never
  // delete the branch: it remains a recovery ref after the checkout is gone.
  execTrustedGitSync(primaryRoot, ["worktree", "remove", worktree]);
  execTrustedGitSync(primaryRoot, ["worktree", "prune"]);
  const receipt: WorktreeReclaimReceipt = Object.freeze({
    schema_version: "1.0",
    outcome: "reclaimed",
    repository: published.repository,
    branch,
    head_sha: headSha,
    merge_sha: observation.mergeSha,
    provider_actor: observation.providerActor,
    observed_at: observation.observedAt,
    reclaimed_at: (dependencies.now ?? (() => new Date().toISOString()))(),
  });
  writeDurableReceipt(primaryRoot, receipt);
  return receipt;
}

function assertLearningComplete(sessionDir: string): void {
  const file = path.join(sessionDir, "trust.bundle");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let root: Record<string, unknown>;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("trust bundle is not a bounded regular file");
    root = record(JSON.parse(fs.readFileSync(descriptor, "utf8")), "trust bundle");
  } finally {
    fs.closeSync(descriptor);
  }
  const claims = Array.isArray(root.claims) ? root.claims.map((claim) => record(claim, "trust bundle claim")) : [];
  for (const claimType of ["builder.learn.decisions", "builder.learn.evidence"]) {
    const matching = claims.filter((claim) => claim.claimType === claimType);
    const accepted = matching.length > 0
      && matching.every((claim) => ["verified", "trusted", "accepted"].includes(String(claim.status)));
    if (!accepted) throw new Error(`builder-run reclaim requires only accepted current ${claimType} learning evidence`);
  }
}

function readPublishedChange(sessionDir: string): PublishedChange {
  const file = path.join(sessionDir, "publish-change.result.json");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_PROVIDER_RESULT_BYTES) throw new Error("published change result is not a bounded regular file");
    bytes = fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  const root = record(JSON.parse(bytes.toString("utf8")), "published change result");
  const repository = record(root.repository, "published change repository");
  const provider = record(root.provider, "published change provider");
  const change = record(root.change_ref, "published change ref");
  const owner = text(repository.owner, "repository owner", 255);
  const name = text(repository.name, "repository name", 255);
  const kind = text(provider.kind, "provider kind", 32);
  const configurationId = text(provider.configuration_id, "provider configuration id", 1_024);
  const state = text(change.state, "published change state", 16);
  const number = change.number;
  const headSha = text(change.head_sha, "published change head SHA", 64).toLowerCase();
  if (root.schema_version !== "1.0" || root.operation !== "publish-change" || kind !== "github"
    || !Number.isSafeInteger(number) || Number(number) < 1 || !["open", "merged"].includes(state) || !SHA.test(headSha)) {
    throw new Error("published change result is invalid");
  }
  return Object.freeze({
    repository: Object.freeze({ owner, name }),
    provider: Object.freeze({ kind: "github" as const, configurationId }),
    change: Object.freeze({
      number: Number(number),
      state: state as "open" | "merged",
      baseRef: text(change.base_ref, "published change base ref", 255),
      headRef: text(change.head_ref, "published change head ref", 255),
      headSha,
    }),
    providerActor: text(root.provider_actor, "provider actor", 512),
  });
}

function assertRegisteredWorktree(primaryRoot: string, worktree: string): void {
  const listing = String(execTrustedGitSync(primaryRoot, ["worktree", "list", "--porcelain", "-z"]));
  const registered = listing.split("\0").some((entry) => entry === `worktree ${worktree}`);
  if (!registered) throw new Error("builder-run reclaim target is not a registered worktree");
}

function writeDurableReceipt(primaryRoot: string, receipt: WorktreeReclaimReceipt): void {
  const id = createHash("sha256").update(`${receipt.repository.owner}/${receipt.repository.name}:${receipt.head_sha}`).digest("hex").slice(0, 24);
  const directory = path.join(primaryRoot, ".kontourai", "flow-agents", "worktree-reclaims");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${id}.json`);
  const temporary = path.join(directory, `.${id}.${process.pid}.tmp`);
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function realDirectory(value: string, label: string): string {
  const resolved = fs.realpathSync(path.resolve(value));
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label} must be a directory`);
  return resolved;
}

function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
    || value.includes("\0") || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
