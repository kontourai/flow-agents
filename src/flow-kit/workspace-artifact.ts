import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const WORKSPACE_KIT_TREE_SCHEME = "flow-agents.kit-tree/v1";
export type ArtifactEntry = ["directory", string, 0] | ["file", string, 0 | 1, number, string];
export interface ArtifactTree { digest: string; entries: ArtifactEntry[] }
export interface WorkspaceArtifactBudget { entries: number; bytes: number }

export class WorkspaceArtifactError extends Error {
  constructor(public readonly code: string, public readonly status: "missing" | "corrupt" | "unsupported", message: string) {
    super(message);
    this.name = "WorkspaceArtifactError";
  }
}

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_DEPTH = 32;
const PRUNED = new Set([".git", "__pycache__", ".pytest_cache"]);
const utf8 = new TextDecoder("utf-8", { fatal: true });
type Anchor = { file: string; stat: fs.Stats };

export function createWorkspaceArtifactBudget(): WorkspaceArtifactBudget {
  return { entries: 0, bytes: 0 };
}

function reject(code: string, message: string, status: "corrupt" | "unsupported" = "corrupt"): never {
  throw new WorkspaceArtifactError(code, status, message);
}

function requireArtifactPlatform(): void {
  if (process.platform === "win32" || !Number.isInteger(fs.constants.O_NOFOLLOW) || fs.constants.O_NOFOLLOW <= 0
    || !Number.isInteger(fs.constants.O_DIRECTORY) || fs.constants.O_DIRECTORY <= 0)
    reject("artifact-platform", "Artifact capture requires POSIX no-follow directory opens and executable permission bits.", "unsupported");
}

function io<T>(operation: () => T): T {
  try { return operation(); } catch (error) {
    if (error instanceof WorkspaceArtifactError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new WorkspaceArtifactError(code === "ENOENT" ? "artifact-missing" : "artifact-io", code === "ENOENT" ? "missing" : "corrupt", `Artifact filesystem operation failed (${code ?? "unknown"}).`);
  }
}

function sameIdentity(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && (a.mode & fs.constants.S_IFMT) === (b.mode & fs.constants.S_IFMT);
}

function sameContents(a: fs.Stats, b: fs.Stats): boolean {
  return sameIdentity(a, b) && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function assertAnchors(anchors: Anchor[]): void {
  for (const anchor of anchors) {
    const current = fs.lstatSync(anchor.file);
    if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(anchor.stat, current))
      reject("artifact-source-changed", "Artifact directory identity changed during observation.");
  }
}

function rootAnchor(root: string): Anchor {
  const absolute = path.resolve(root);
  const before = fs.lstatSync(absolute);
  if (before.isSymbolicLink() || !before.isDirectory()) reject("artifact-root", "Artifact root must be an existing non-symlink directory.");
  const canonical = fs.realpathSync(absolute);
  const after = fs.lstatSync(canonical);
  if (!sameContents(before, after)) reject("artifact-source-changed", "Artifact root changed while resolving it.");
  return { file: canonical, stat: after };
}

function checkBudget(budget: WorkspaceArtifactBudget): void {
  if (![budget.entries, budget.bytes].every((value) => Number.isSafeInteger(value) && value >= 0))
    reject("artifact-budget", "Artifact budget counters must be non-negative safe integers.");
  if (budget.entries > MAX_ENTRIES) reject("artifact-entry-limit", "Artifact closure exceeds 10000 entries.", "unsupported");
  if (budget.bytes > MAX_BYTES) reject("artifact-byte-limit", "Artifact closure exceeds 256 MiB of file contents.", "unsupported");
}

function portableName(raw: string): string {
  let name: string;
  try { name = utf8.decode(Buffer.from(raw, "latin1")); } catch { return reject("artifact-path", "Artifact path must be UTF-8."); }
  if (!name || name === "." || name === ".." || name.normalize("NFC") !== name
    || /[\\/:\p{Cc}\p{Cf}]/u.test(name) || /[. ]$/.test(name)
    || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name))
    reject("artifact-path", "Artifact path is not a portable NFC name.");
  return name;
}

function enumerate(anchor: Anchor, budget: WorkspaceArtifactBudget, prune: boolean): string[] {
  // latin1 preserves directory-entry bytes so invalid UTF-8 cannot silently become U+FFFD.
  const directory = fs.opendirSync(anchor.file, { encoding: "latin1", bufferSize: 32 });
  const names: string[] = [];
  const folded = new Set<string>();
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      budget.entries += 1;
      checkBudget(budget);
      const name = portableName(entry.name);
      if (PRUNED.has(name)) {
        if (prune) continue;
        reject("artifact-pruned-entry", "Published artifact contains a source-only pruned entry.");
      }
      const key = name.toUpperCase().toLowerCase().toUpperCase().toLowerCase();
      if (folded.has(key)) reject("artifact-path-collision", "Artifact contains case-fold-equivalent names.");
      folded.add(key);
      names.push(name);
    }
  } finally { directory.closeSync(); }
  return names.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

function readFile(file: string, before: fs.Stats, anchors: Anchor[], destination?: string, destinationAnchors: Anchor[] = []): ArtifactEntry {
  assertAnchors(anchors);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let output: number | undefined;
  try {
    if (!sameContents(before, fs.fstatSync(descriptor))) reject("artifact-source-changed", "Artifact file changed before reading.");
    if (destination !== undefined) {
      assertAnchors(destinationAnchors);
      output = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!count) reject("artifact-source-changed", "Artifact file was truncated during reading.");
      hash.update(buffer.subarray(0, count));
      if (output !== undefined) {
        assertAnchors(destinationAnchors);
        let written = 0;
        while (written < count) {
          const amount = fs.writeSync(output, buffer, written, count - written);
          if (!amount) reject("artifact-io", "Artifact staging write made no progress.");
          written += amount;
        }
      }
      offset += count;
    }
    assertAnchors(anchors);
    if (!sameContents(before, fs.fstatSync(descriptor)) || !sameContents(before, fs.lstatSync(file)))
      reject("artifact-source-changed", "Artifact file changed during reading.");
    const executable = (before.mode & 0o111) !== 0 ? 1 : 0;
    if (output !== undefined) {
      fs.fchmodSync(output, executable ? 0o755 : 0o644);
      assertAnchors(destinationAnchors);
      if (!sameContents(fs.fstatSync(output), fs.lstatSync(destination!))) reject("artifact-source-changed", "Artifact staging file was replaced.");
    }
    return ["file", "", executable, before.size, hash.digest("hex")];
  } finally {
    if (output !== undefined) fs.closeSync(output);
    fs.closeSync(descriptor);
  }
}

function createDirectory(file: string, parents: Anchor[]): Anchor {
  assertAnchors(parents);
  fs.mkdirSync(file, { mode: 0o755 });
  const before = fs.lstatSync(file);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    if (!before.isDirectory() || !sameIdentity(before, fs.fstatSync(descriptor))) reject("artifact-source-changed", "Staging directory changed during creation.");
    fs.fchmodSync(descriptor, 0o755);
    assertAnchors(parents);
    const after = fs.lstatSync(file);
    if (!sameContents(after, fs.fstatSync(descriptor))) reject("artifact-source-changed", "Staging directory changed during creation.");
    return { file, stat: after };
  } finally { fs.closeSync(descriptor); }
}

function observe(root: Anchor, budget: WorkspaceArtifactBudget, destinations: Anchor[] = []): ArtifactTree {
  checkBudget(budget);
  const entries: ArtifactEntry[] = [];
  function visit(anchor: Anchor, relative: string, depth: number, ancestors: Anchor[], targets: Anchor[]): void {
    const sourceAnchors = [...ancestors, anchor];
    assertAnchors(sourceAnchors);
    for (const name of enumerate(anchor, budget, destinations.length > 0)) {
      if (depth + 1 > MAX_DEPTH) reject("artifact-depth-limit", "Artifact entry depth exceeds 32.", "unsupported");
      assertAnchors(sourceAnchors);
      const file = path.join(anchor.file, name);
      const rel = relative ? `${relative}/${name}` : name;
      const before = fs.lstatSync(file);
      if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory())) reject("artifact-entry-type", "Artifact entries must be regular files or directories.");
      const target = targets.length ? path.join(targets.at(-1)!.file, name) : undefined;
      if (before.isDirectory()) {
        entries.push(["directory", rel, 0]);
        let childTargets = targets;
        if (target) {
          childTargets = [...targets, createDirectory(target, targets)];
        }
        visit({ file, stat: before }, rel, depth + 1, sourceAnchors, childTargets);
      } else {
        if (before.size > MAX_FILE_BYTES) reject("artifact-file-limit", "Artifact file exceeds 64 MiB.", "unsupported");
        budget.bytes += before.size;
        checkBudget(budget);
        const entry = readFile(file, before, sourceAnchors, target, targets);
        entry[1] = rel;
        entries.push(entry);
      }
    }
    assertAnchors(sourceAnchors);
    if (!sameContents(anchor.stat, fs.lstatSync(anchor.file))) reject("artifact-source-changed", "Artifact directory contents changed during observation.");
  }
  visit(root, "", 0, [], destinations);
  entries.sort((a, b) => a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  return { digest: createHash("sha256").update(JSON.stringify([WORKSPACE_KIT_TREE_SCHEME, entries])).digest("hex"), entries };
}

export function observeWorkspaceKitTree(root: string, budget = createWorkspaceArtifactBudget()): ArtifactTree {
  return io(() => { requireArtifactPlatform(); return observe(rootAnchor(root), budget); });
}

export function captureWorkspaceKitTree(source: string, destination: string, budget: WorkspaceArtifactBudget): ArtifactTree {
  return io(() => {
    requireArtifactPlatform();
    const input = rootAnchor(source);
    const parent = rootAnchor(path.dirname(path.resolve(destination)));
    const target = path.join(parent.file, path.basename(path.resolve(destination)));
    for (const [left, right] of [[input.file, target], [target, input.file]]) {
      const relative = path.relative(left, right);
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)))
        reject("artifact-overlap", "Artifact source and staging destination must be disjoint.");
    }
    assertAnchors([input, parent]);
    const staging = createDirectory(target, [parent]);
    const captured = observe(input, budget, [parent, staging]);
    assertAnchors([parent, staging]);
    const staged = observe(rootAnchor(staging.file), createWorkspaceArtifactBudget());
    if (captured.digest !== staged.digest) reject("artifact-source-changed", "Staged artifact does not match the captured bytes.");
    return staged;
  });
}

export function sealWorkspaceKitTree(root: string): void {
  io(() => {
    requireArtifactPlatform();
    const anchor = rootAnchor(root);
    const tree = observe(anchor, createWorkspaceArtifactBudget());
    for (const entry of [...tree.entries].reverse()) {
      const segments = entry[1].split("/");
      const ancestors = [anchor];
      let current = anchor.file;
      for (const segment of segments.slice(0, -1)) {
        current = path.join(current, segment);
        ancestors.push(rootAnchor(current));
      }
      assertAnchors(ancestors);
      const file = path.join(anchor.file, ...segments);
      const before = fs.lstatSync(file);
      const directory = entry[0] === "directory";
      if (before.isSymbolicLink() || (directory ? !before.isDirectory() : !before.isFile())) reject("artifact-entry-type", "Artifact entry changed type before sealing.");
      const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | (directory ? fs.constants.O_DIRECTORY : 0));
      try {
        if (!sameContents(before, fs.fstatSync(descriptor))) reject("artifact-source-changed", "Artifact changed before sealing.");
        fs.fchmodSync(descriptor, directory || entry[2] === 1 ? 0o555 : 0o444);
        assertAnchors(ancestors);
        if (!sameContents(fs.fstatSync(descriptor), fs.lstatSync(file))) reject("artifact-source-changed", "Artifact changed during sealing.");
      } finally { fs.closeSync(descriptor); }
    }
    assertAnchors([anchor]);
    const descriptor = fs.openSync(anchor.file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      if (!sameIdentity(anchor.stat, fs.fstatSync(descriptor))) reject("artifact-source-changed", "Artifact root changed before sealing.");
      fs.fchmodSync(descriptor, 0o555);
      assertAnchors([anchor]);
    } finally { fs.closeSync(descriptor); }
    if (observe(rootAnchor(anchor.file), createWorkspaceArtifactBudget()).digest !== tree.digest)
      reject("artifact-source-changed", "Artifact contents changed during sealing.");
  });
}
