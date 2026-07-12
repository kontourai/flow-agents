#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function shellQuote(value) { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }
function advisory(message) { console.error(`classify-codex-legacy-agents: ${message}`); }

const [destinationArg, catalogArg] = process.argv.slice(2);
if (!destinationArg || !catalogArg) {
  advisory("usage: classify-codex-legacy-agents.js DEST CATALOG");
  process.exit(2);
}
const destination = path.resolve(destinationArg);
const source = path.join(destination, "AGENTS.md");
let stat;
try { stat = fs.lstatSync(source); }
catch (error) {
  if (error?.code === "ENOENT") process.exit(0);
  advisory(`cannot inspect ${source}; preserved without changes: ${error.message}`);
  process.exit(2);
}
if (stat.isSymbolicLink() || !stat.isFile()) {
  advisory(`preserved ambiguous non-regular or symlink object without changes: ${source}`);
  process.exit(0);
}
if (fs.constants.O_NOFOLLOW === undefined) {
  advisory(`platform lacks O_NOFOLLOW; preserved without classification: ${source}`);
  process.exit(2);
}
let fd;
let bytes;
try {
  fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const opened = fs.fstatSync(fd);
  if (!opened.isFile()) {
    advisory(`preserved non-regular descriptor without changes: ${source}`);
    process.exit(0);
  }
  bytes = fs.readFileSync(fd);
} catch (error) {
  advisory(`cannot open/read ${source} without following links; preserved without changes: ${error.message}`);
  process.exit(2);
} finally {
  if (fd !== undefined) fs.closeSync(fd);
}
const digest = crypto.createHash("sha256").update(bytes).digest("hex");
const catalog = JSON.parse(fs.readFileSync(catalogArg, "utf8"));
const match = (catalog.files ?? []).find((entry) => entry.sha256 === digest && entry.bytes === bytes.length);
if (!match) {
  advisory(`preserved unrecognized or user-owned ${source} (sha256=${digest}, bytes=${bytes.length})`);
  process.exit(0);
}
const releases = (match.covered_releases ?? []).map((item) => `${item.tag}@${item.commit}`).join(", ");
advisory(`REFUSING INSTALL: exact historical Flow Agents-generated global instructions remain active`);
advisory(`path=${source}`);
advisory(`sha256=${digest} bytes=${bytes.length}`);
advisory(`matching_releases=${releases}`);
advisory("automatic mutation is disabled because portable Node cannot condition pathname removal on the inode that was classified");
advisory(`evidence command (hash): shasum -a 256 -- ${shellQuote(source)}`);
advisory(`evidence command (bytes): wc -c < ${shellQuote(source)}`);
advisory("manual remediation checklist:");
advisory("1. Stop all agent and writer processes that can modify the Codex home.");
advisory(`2. Revalidate the file is still exactly sha256=${digest} and bytes=${bytes.length} using the evidence commands above.`);
advisory("3. Choose a new, unused recovery path outside every agent instruction-discovery location.");
advisory("4. Move the file manually without overwrite using operator-trusted tooling; no mutation command is emitted here.");
advisory("5. Inspect the preserved recovery file and confirm its exact hash and byte count.");
advisory("6. Rerun the Flow Agents Codex installer.");
process.exit(3);
