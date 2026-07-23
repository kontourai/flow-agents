import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function opaqueIdentifier(domain, value) {
  return `${domain}-${sha256(`${domain}\u0000${String(value ?? "")}`).slice(0, 24)}`;
}

export function runtimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function assertNoSymlinkAncestry(target) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw runtimeError(
        "PATH_SYMLINK_REJECTED",
        "runtime-session path contains a symbolic link",
      );
    }
  }
}
