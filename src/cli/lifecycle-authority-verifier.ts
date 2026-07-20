import * as fs from "node:fs";
import * as path from "node:path";
import { createPublicKey, verify } from "node:crypto";

type JsonRecord = Record<string, unknown>;

function fail(message: string): never { throw new Error(message); }
function record(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exact(value: JsonRecord, fields: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} contains unexpected or missing fields`);
}
function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function registry(projectRoot: string): JsonRecord {
  const configured = process.env.FLOW_AGENTS_LIFECYCLE_AUTHORITY_REGISTRY;
  if (!configured || !path.isAbsolute(configured)) fail("lifecycle authority registry requires an absolute externally provisioned path");
  const file = path.resolve(configured);
  const root = fs.realpathSync(projectRoot);
  if (within(file, root)) fail("lifecycle authority registry must be outside the project and worktree");
  if (process.platform === "win32") fail("secure lifecycle authority ownership is unavailable without a platform adapter");
  let cursor = path.parse(file).root;
  for (const component of file.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) fail("lifecycle authority key registry path must not contain symlinks");
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) fail("lifecycle authority registry and every parent must be OS-owned and non-writable by group or world");
    try { fs.accessSync(cursor, fs.constants.W_OK); fail("lifecycle authority registry path must not be writable by the runtime user"); }
    catch (error) { if (error instanceof Error && error.message.includes("must not be writable")) throw error; }
  }
  const canonical = path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  if (within(canonical, root)) fail("lifecycle authority registry canonical path must remain outside the project and worktree");
  if (typeof process.getuid === "function" && process.getuid() === 0) fail("lifecycle authority registry is unavailable to a root caller without a platform privilege adapter");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 64 * 1024 || (stat.mode & 0o022) !== 0) fail("lifecycle authority key registry must be a protected regular file of at most 64 KiB");
    const parsed = JSON.parse(fs.readFileSync(descriptor, "utf8")) as unknown;
    if (!record(parsed)) fail("lifecycle authority key registry must be a JSON object");
    return parsed;
  } finally { fs.closeSync(descriptor); }
}

function main(): void {
  const request = JSON.parse(fs.readFileSync(0, "utf8")) as unknown;
  if (!record(request) || typeof request.project_root !== "string" || typeof request.payload !== "string" || !record(request.signature)) fail("invalid lifecycle authority verification request");
  const trusted = registry(request.project_root);
  exact(trusted, ["schema_version", "keys"], "key registry");
  if (trusted.schema_version !== "1.0") fail("lifecycle authority key registry must use schema_version 1.0");
  const keys = trusted.keys;
  if (!Array.isArray(keys)) fail("lifecycle authority key registry must contain keys[]");
  const keyId = request.signature.key_id;
  const signature = request.signature.value;
  if (typeof keyId !== "string" || typeof signature !== "string") fail("invalid lifecycle authorization signature descriptor");
  const seen = new Set<string>();
  for (const candidate of keys) {
    if (!record(candidate)) fail("lifecycle authority key registry entries must be objects");
    exact(candidate, ["id", "algorithm", "public_key_pem"], "key registry entry");
    if (typeof candidate.id !== "string" || candidate.id.length === 0 || candidate.id.length > 256) fail("lifecycle authority key id is invalid");
    if (seen.has(candidate.id)) fail(`lifecycle authority key registry contains duplicate key id ${candidate.id}`);
    seen.add(candidate.id);
    if (candidate.algorithm !== "ed25519" || typeof candidate.public_key_pem !== "string" || !candidate.public_key_pem.includes("BEGIN PUBLIC KEY") || /PRIVATE KEY/.test(candidate.public_key_pem)) fail(`lifecycle authority key ${candidate.id} must contain only an Ed25519 public key`);
  }
  const key = keys.find((candidate) => record(candidate) && candidate.id === keyId);
  if (!record(key) || key.algorithm !== "ed25519" || typeof key.public_key_pem !== "string" || /PRIVATE KEY/.test(key.public_key_pem)) fail(`lifecycle authorization key ${keyId} is not trusted`);
  let valid = false;
  try { valid = verify(null, Buffer.from(request.payload), createPublicKey(key.public_key_pem), Buffer.from(signature, "base64")); } catch { valid = false; }
  if (!valid) fail("lifecycle authorization signature is invalid");
  process.stdout.write('{"verified":true}\n');
}

try { main(); } catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
