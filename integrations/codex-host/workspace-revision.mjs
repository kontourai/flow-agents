#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

async function filesBelow(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`workspace tree contains unsupported entry: ${child}`);
  }
  return files;
}

export async function workspaceRevision(root) {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`workspace root must be a regular directory: ${root}`);
  const digest = createHash("sha256");
  for (const relative of await filesBelow(root)) {
    const bytes = await readFile(path.join(root, relative));
    const name = Buffer.from(relative, "utf8");
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(bytes.length));
    digest.update(Buffer.from([0x01]));
    digest.update(name);
    digest.update(Buffer.from([0x00]));
    digest.update(size);
    digest.update(bytes);
  }
  return `sha256:${digest.digest("hex")}`;
}

