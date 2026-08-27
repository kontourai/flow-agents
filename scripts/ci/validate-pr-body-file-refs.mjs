#!/usr/bin/env node
// validate-pr-body-file-refs.mjs — a PR body's file references must resolve on its own branch (#1375).
//
// #1366's body carried a verification table naming
// `src/cli/trust-bundle-verifying-actor.test.mjs` at "9 tests, 9 pass". That file
// existed on a SIBLING branch (#1368) and appeared 0 times in #1366's diff. Every
// required check passed, because nothing in this repo reads PR bodies — and the body
// is both the artifact a reviewer reads instead of re-running the evidence and, via
// `Closes #N`, the thing that mutates issue state on merge.
//
// This check extracts repo-rooted file paths from the body and fails when one does not
// resolve at the PR head. It reads only git; it never touches the filesystem with a
// body-derived path and never passes body text to a shell.
//
// Scoping decisions, and the measurement behind them, are in
// CONTRIBUTING.md ("Pull request body file references").

import { execFileSync } from "node:child_process";

const DIRECTIVE = /<!--\s*pr-body-paths:\s*allow\s+([^\s>]+)([\s\S]*?)-->/g;
const MIN_REASON_CHARS = 8;

// Authors whose bodies are not claims about this repository's diff. The reason is the
// value so an entry cannot be added without one.
//
// Dependabot's body is entirely upstream attribution — the dependency's own release
// notes, changelog and commit list, pasted from another repository. Measured over all 32
// dependabot pull requests in this repository, one (#28, actions/setup-python) quotes an
// upstream commit subject naming `docs/advanced-usage.md`, a file in ACTIONS/SETUP-PYTHON.
// It is not a claim that this tree contains that file, dependabot cannot rewrite its own
// body to add a directive, and a required check a bot can never pass is a check that gets
// bypassed — which costs more than the zero fabrication risk this exempts, since no agent
// lane composes a dependabot body.
//
// This is NOT a general bot exemption: release-please's bodies are changelogs of THIS
// repository and are checked like everyone else's (all release pull requests in the
// 120-PR measurement pass).
const EXEMPT_AUTHORS = new Map([
  [
    "dependabot[bot]",
    "body is upstream attribution (the dependency's own release notes, changelog and commits), not a claim about this diff",
  ],
]);

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
}

function tryGit(args) {
  // git exits 0 with EMPTY stdout for `cat-file -e` and `check-ignore -q`, so callers
  // must distinguish "" (success, no output) from null (non-zero exit). Returning a
  // falsy "" from a success would invert every one of these predicates.
  try {
    return git(args);
  } catch {
    return null;
  }
}

const problems = [];
function fail(message) {
  problems.push(message);
}

const body = process.env.PR_BODY;
const headSha = (process.env.PR_HEAD_SHA || "").trim();
const baseSha = (process.env.PR_BASE_SHA || "").trim();

if (typeof body !== "string") {
  console.error("PR body file-reference validation failed: PR_BODY is required (pass github.event.pull_request.body).");
  process.exitCode = 1;
} else if (!headSha || !baseSha) {
  console.error(
    "PR body file-reference validation failed: PR_HEAD_SHA and PR_BASE_SHA are required " +
      "(pass github.event.pull_request.head.sha and .base.sha).",
  );
  process.exitCode = 1;
} else {
  run(body, headSha, baseSha);
}

function run(bodyText, head, base) {
  const author = (process.env.PR_AUTHOR || "").trim();
  if (EXEMPT_AUTHORS.has(author)) {
    console.log(`PR body file references: skipped for ${author} — ${EXEMPT_AUTHORS.get(author)}.`);
    return;
  }

  if (tryGit(["cat-file", "-e", `${head}^{commit}`]) === null) {
    console.error(
      `PR body file-reference validation could not run: the PR head commit ${head} is not in this checkout.\n` +
        "This is a checkout problem, not a body problem: the job needs the PR head object " +
        "(actions/checkout with fetch-depth: 0, or an explicit fetch of refs/pull/<n>/head).",
    );
    process.exitCode = 1;
    return;
  }

  // The set of path prefixes that count as a repo-rooted reference is DERIVED from the
  // head tree's own top-level directories rather than hand-listed, so it cannot drift
  // from the repo. It also drops generated roots for free: `build/` is not tracked, so
  // `node build/src/cli.js` in a body is never read as a file claim.
  const roots = (tryGit(["ls-tree", "--name-only", "-d", head]) || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (roots.length === 0) {
    console.error(`PR body file-reference validation could not run: ${head} has no top-level directories.`);
    process.exitCode = 1;
    return;
  }

  const allowed = new Map();
  for (const match of bodyText.matchAll(DIRECTIVE)) {
    const reason = match[2].replace(/^[\s\-—–:.]+/, "").trim();
    if (reason.length < MIN_REASON_CHARS) {
      fail(
        `  ${match[1]}\n` +
          "      is marked allowed by a `pr-body-paths: allow` directive that gives no reason.\n" +
          "      The directive records why a path is deliberately absent; write the reason after the path.",
      );
      continue;
    }
    allowed.set(match[1], reason);
  }

  const candidates = extractPaths(bodyText, roots);
  const checked = [];
  const skippedIgnored = [];
  const skippedAllowed = [];

  const touched = changedPaths(base, head);
  if (touched === null) {
    console.error(
      `PR body file-reference validation could not run: no merge base between ${base} and ${head}.\n` +
        "This is a checkout problem, not a body problem: the job needs unshallowed history (fetch-depth: 0).",
    );
    process.exitCode = 1;
    return;
  }

  for (const candidate of candidates) {
    if (allowed.has(candidate)) {
      skippedAllowed.push(candidate);
      continue;
    }
    // A gitignored path is by construction never tracked, so "absent from the tree"
    // says nothing about it. `delivery/trust.bundle` is the live example: force-added
    // per delivery, ignored otherwise, and named in bodies that never carry it.
    if (tryGit(["check-ignore", "-q", "--", candidate]) !== null) {
      skippedIgnored.push(candidate);
      continue;
    }
    checked.push(candidate);
    if (tryGit(["cat-file", "-e", `${head}:${candidate}`]) !== null) continue;
    // A body may legitimately name a file the branch DELETES. It is gone from the head
    // tree and still unambiguously this PR's own work, so the diff is the second oracle.
    if (touched.has(candidate)) continue;
    fail(
      `  ${candidate}\n` +
        `      does not exist at the PR head (${head.slice(0, 8)}) and is not among the ` +
        `${touched.size} file(s) this PR changes.`,
    );
  }

  const summary =
    `PR body file references: ${checked.length} checked, ` +
    `${skippedIgnored.length} skipped as gitignored, ${skippedAllowed.length} allowed by directive.`;

  if (problems.length === 0) {
    console.log(summary);
    for (const path of checked) console.log(`  ok  ${path}`);
    for (const path of skippedAllowed) console.log(`  allowed  ${path} — ${allowed.get(path)}`);
    return;
  }

  console.error("PR body file-reference validation failed.");
  console.error("");
  for (const problem of problems) console.error(problem);
  console.error("");
  console.error(
    "A PR body is a provenance record: `Closes #N` mutates issue state on merge, and the\n" +
      "verification evidence in the body is what a reviewer reads instead of re-running it.\n" +
      "A path that resolves nowhere on this branch is evidence from somewhere else (#1375).",
  );
  console.error("");
  console.error("Fix one of these:");
  console.error("  * correct the path — check what this branch actually changed:");
  console.error(`      git diff --name-only ${base.slice(0, 8)}...${head.slice(0, 8)}`);
  console.error("  * remove the claim from the body");
  console.error("  * if the path is deliberately not in this tree — relative to a fixture root, added");
  console.error("    by a follow-up, or a historical reference — say so in the body:");
  console.error("      <!-- pr-body-paths: allow src/cli/example.test.mjs — added by the follow-up in #1400 -->");
  console.error("");
  console.error(summary);
  process.exitCode = 1;
}

function extractPaths(bodyText, roots) {
  const alternation = roots.map((root) => root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  // A candidate is <tracked-top-level-dir>/<segments>.<ext>, not preceded by a path or
  // word character. Requiring a file extension is what keeps prose, globs (`src/**`),
  // bare directory mentions (`scripts/ci/`) and issue refs out; the leading lookbehind
  // is what keeps URLs (`.../blob/main/src/foo.ts`) and absolute paths out.
  //
  // Code fences and inline code are deliberately NOT exempt: the fabricated evidence
  // table in #1366 lived inside a fenced block.
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_./-])((?:${alternation})\\/[A-Za-z0-9_./-]*[A-Za-z0-9_-]\\.[A-Za-z0-9]{1,6})(?![A-Za-z0-9])`,
    "g",
  );
  const seen = [];
  for (const match of bodyText.matchAll(pattern)) {
    const candidate = match[1];
    // Never let a body-derived string leave the repo root. Nothing here touches the
    // filesystem, but a traversal segment also means it is not a repo-rooted reference.
    if (candidate.split("/").includes("..")) continue;
    if (!seen.includes(candidate)) seen.push(candidate);
  }
  return seen;
}

function changedPaths(base, head) {
  const mergeBase = (tryGit(["merge-base", base, head]) || "").trim();
  if (!mergeBase) return null;
  // --no-renames so a rename reports BOTH the old and the new path; a body naming the
  // pre-rename path is describing this PR's own work.
  const output = tryGit(["diff", "--no-renames", "--name-only", mergeBase, head]);
  if (output === null) return null;
  return new Set(output.split("\n").map((line) => line.trim()).filter(Boolean));
}
