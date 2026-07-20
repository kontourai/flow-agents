import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isStoreRoot } from "../adapters/shared/store-resolve.js";

export function dreamError(code, message) {
  const error = new Error(message); error.code = code; return error;
}

export function isContained(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function assertContained(root, target, label = "path") {
  if (!isContained(root, target)) throw dreamError("DREAM_PATH_ESCAPE", `${label} must be contained beneath storeRoot`);
}

export function assertNoSymlinkAncestry(target, label = "path") {
  const absolute = path.resolve(target); const parsed = path.parse(absolute); let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment); if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current); if (stat.isSymbolicLink()) throw dreamError("DREAM_SYMLINK_REJECTED", `${label} contains symlink ancestry`);
  }
}

export function ensurePrivateDirectory(directory, root = directory) {
  assertContained(root, directory, "private directory"); assertNoSymlinkAncestry(directory, "private directory");
  if (fs.existsSync(directory)) { const stat = fs.lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw dreamError("DREAM_PATH_UNSAFE", "private directory must be a regular directory"); }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700); assertNoSymlinkAncestry(directory, "private directory");
}

export function assertRegularFile(file, { privateMode = false } = {}) {
  assertNoSymlinkAncestry(file, "file"); const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw dreamError("DREAM_FILE_UNSAFE", "expected a regular file");
  if (privateMode && (stat.mode & 0o077) !== 0) throw dreamError("DREAM_FILE_MODE", "private file permissions are unsafe");
  return stat;
}

export function assertCompleteStoreRoot(storeRoot) {
  if (typeof storeRoot !== "string" || !path.isAbsolute(storeRoot)) throw dreamError("DREAM_STORE_INVALID", "personal store must be an absolute complete store root");
  assertNoSymlinkAncestry(storeRoot, "personal store");
  if (!isStoreRoot(storeRoot)) throw dreamError("DREAM_STORE_INVALID", "personal store is missing a valid complete scaffold");
  const records = path.join(storeRoot, "records"); const alias = path.join(storeRoot, "alias-index.json");
  const recordsStat = fs.lstatSync(records); const aliasStat = fs.lstatSync(alias);
  if (!recordsStat.isDirectory() || recordsStat.isSymbolicLink() || !aliasStat.isFile() || aliasStat.isSymbolicLink()) throw dreamError("DREAM_STORE_INVALID", "personal store is missing its records or alias shape");
  let aliasValue; try { aliasValue = JSON.parse(fs.readFileSync(alias, "utf8")); } catch { throw dreamError("DREAM_STORE_INVALID", "personal store alias index is malformed"); }
  if (!aliasValue || typeof aliasValue !== "object" || !aliasValue.by_slug || typeof aliasValue.by_slug !== "object" || Array.isArray(aliasValue.by_slug)) throw dreamError("DREAM_STORE_INVALID", "personal store alias index is invalid");
  return storeRoot;
}

export function writePrivateAtomic(file, content, root) {
  assertContained(root, file, "private file"); ensurePrivateDirectory(path.dirname(file), root);
  if (fs.existsSync(file)) {
    assertRegularFile(file); if (fs.readFileSync(file).equals(Buffer.from(content))) { fs.chmodSync(file, 0o600); return false; }
  }
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`); assertContained(root, temporary, "temporary file");
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.writeFileSync(descriptor, content); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
    assertRegularFile(temporary); fs.renameSync(temporary, file); fs.chmodSync(file, 0o600); return true;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); try { fs.unlinkSync(temporary); } catch {} }
}

export function tightenStoreFiles(storeRoot, recordIds = []) {
  for (const directory of [storeRoot, path.join(storeRoot, "records")]) if (fs.existsSync(directory)) { assertNoSymlinkAncestry(directory, "store directory"); fs.chmodSync(directory, 0o700); }
  const files = ["graph-index.json", "alias-index.json", ...recordIds.map((id) => path.join("records", `${id}.md`))];
  for (const relative of files) { const file = path.join(storeRoot, relative); if (fs.existsSync(file)) { assertContained(storeRoot, file, "store file"); assertRegularFile(file); fs.chmodSync(file, 0o600); } }
}

function pidActive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; } }

export function acquireDreamLock(storeRoot, name, now = () => new Date().toISOString(), staleMs = 300_000, { writeOwner = writePrivateAtomic } = {}) {
  const lock = path.join(storeRoot, "dream", "locks", `${name}.lock`); const ownerFile = path.join(lock, "owner.json"); ensurePrivateDirectory(path.dirname(lock), storeRoot);
  if (fs.existsSync(lock)) {
    assertContained(storeRoot, lock, "lock"); assertNoSymlinkAncestry(lock, "lock");
    let owner; try { assertRegularFile(ownerFile, { privateMode: true }); owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")); } catch { throw dreamError("DREAM_LOCKED", "DREAM_LOCKED: dream lock has no trustworthy owner metadata"); }
    const age = Date.now() - Date.parse(owner.created_at); if (Number.isSafeInteger(owner.pid) && !pidActive(owner.pid) && Number.isFinite(age) && age > staleMs) {
      fs.unlinkSync(ownerFile); fs.rmdirSync(lock);
    } else throw dreamError("DREAM_LOCKED", "another dream run owns the lock");
  }
  fs.mkdirSync(lock, { mode: 0o700 });
  try { writeOwner(ownerFile, `${JSON.stringify({ schema_version: "1.0", pid: process.pid, created_at: now() }, null, 2)}\n`, storeRoot); }
  catch (error) { try { fs.unlinkSync(ownerFile); } catch {} try { fs.rmdirSync(lock); } catch {} throw error; }
  return () => { try { fs.unlinkSync(ownerFile); } catch {} try { fs.rmdirSync(lock); } catch {} };
}
