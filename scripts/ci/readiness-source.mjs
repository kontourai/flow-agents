#!/usr/bin/env node
// Identity metadata only. The following readiness command owns qualification.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const declared = JSON.parse(fs.readFileSync("package.json", "utf8")).devDependencies?.["@kontourai/veritas"];
const installed = JSON.parse(fs.readFileSync("node_modules/@kontourai/veritas/package.json", "utf8")).version;
if (declared !== "1.12.2" || installed !== declared) {
  throw new Error(`Pinned readiness requires Veritas 1.12.2; declared ${declared}, installed ${installed}`);
}
const resolve = (ref) => execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
  encoding: "utf8", timeout: 10000, maxBuffer: 4096,
}).trim();
const base = resolve("origin/main");
const head = resolve("HEAD");
if (process.env.GITHUB_ACTIONS === "true" && (!process.env.GITHUB_SHA || !process.env.GITHUB_EVENT_PATH)) {
  throw new Error("GitHub readiness requires GITHUB_SHA and GITHUB_EVENT_PATH");
}
let prHead = null;
if (process.env.GITHUB_EVENT_PATH) {
  prHead = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")).pull_request?.head?.sha ?? null;
}
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== head) {
  throw new Error("Readiness checkout differs from GITHUB_SHA");
}
console.log(JSON.stringify({
  schema: "flow-agents.pinned-readiness-source/v1",
  veritasVersion: installed,
  base,
  head,
  githubSha: process.env.GITHUB_SHA ?? null,
  prHead,
  qualification: "resolved checkout; a PR merge checkout is not PR-head execution",
}));
