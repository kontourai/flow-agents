// #1280: core must not enumerate Kit flow identifiers on the `workflow start` path. The startable
// set is DERIVED, in three parts, each answered by the component that owns the answer:
//   EXISTENCE   — declaredKitFlowIds: what the installed kits declare, bound to the declaring kit
//                 (id namespaced to the kit directory, flows[].path in agreement with the file
//                 canonical resolution reads), inside a kits/ root that has not been symlinked
//                 out of the repo or into runtime artifact storage.
//   CONFORMANCE — the resolver's composition machinery, declared-id agreement, @kontourai/flow's
//                 validateDefinition, AND flowDefinitionResolverContractIssues (the base
//                 validator is looser than the resolver: it accepts step ids the resolver
//                 cannot resolve).
//   RUNNABILITY — isCanonicalRunFlowId, the run adapter's own declared capability. A flow the
//                 canonical run runtime cannot bind is REFUSED, not half-started: with no run
//                 record there is no pinned definition digest, and record-gate-claim has no
//                 producer bindings for it, so the session could neither be trusted nor progress.
// An unknown, non-conforming or unrunnable flow fails closed naming what is missing.
// Run: `npm run test:unit`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { declaredKitFlowIds, flowDefinitionResolverContractIssues, resolveEffectiveFlowDefinition, resolveFlowFilePath } from "../../build/src/lib/flow-resolver.js";
import { CANONICAL_RUN_FLOW_IDS } from "../../build/src/builder-flow-run-adapter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const CLI = path.resolve(REPO_ROOT, "build/src/cli.js");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** A minimal kit-neutral FlowDefinition accepted by @kontourai/flow's validateDefinition. */
function fixtureFlow(id, steps) {
  return {
    id,
    version: "1.0",
    steps: steps ?? [{ id: "probe", next: "closeout" }, { id: "closeout", next: null }],
    gates: {
      "closeout-gate": {
        step: "closeout",
        on_route_back: { missing_evidence: "closeout" },
        route_back_policy: { max_attempts: 3, on_exceeded: "block" },
        expects: [{
          id: "readiness", kind: "trust.bundle", required: true, description: "closeout readiness",
          bundle_claim: { claimType: "acme.closeout.readiness", subjectType: "flow-step", accepted_statuses: ["verified"] },
        }],
      },
    },
  };
}

function runStart(args, cwd, env = {}) {
  return spawnSync(process.execPath, [CLI, "workflow", "start", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CODEX_SESSION_ID: "kit-declared-flow-test", FLOW_AGENTS_FLOW_DEFS_DIR: undefined, ...env },
  });
}

function withDefsDir(defs, fn) {
  const prior = process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
  if (defs === undefined) delete process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
  else process.env.FLOW_AGENTS_FLOW_DEFS_DIR = defs;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.FLOW_AGENTS_FLOW_DEFS_DIR;
    else process.env.FLOW_AGENTS_FLOW_DEFS_DIR = prior;
  }
}

test("declaredKitFlowIds derives from kit.json flow lists, flows/ directories, and the package fallback", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flows-"));
  try {
    // Kit with a kit.json flows list — the list is the declaration surface, so an extra
    // undeclared file in flows/ must NOT appear.
    writeJson(path.join(repoRoot, "kits/acme/kit.json"), {
      id: "acme",
      flows: [
        { id: "acme.alpha", path: "flows/alpha.flow.json" },
        { id: "acme.beta", path: "flows/beta.flow.json" },
        // An id the resolver can never resolve (no `<kit>.<flow>` shape) must be excluded —
        // recommending it in a refusal would recommend an impossible input.
        { id: "unresolvable", path: "flows/unresolvable.flow.json" },
      ],
    });
    writeJson(path.join(repoRoot, "kits/acme/flows/alpha.flow.json"), fixtureFlow("acme.alpha"));
    writeJson(path.join(repoRoot, "kits/acme/flows/beta.flow.json"), fixtureFlow("acme.beta"));
    writeJson(path.join(repoRoot, "kits/acme/flows/undeclared.flow.json"), fixtureFlow("acme.undeclared"));
    // Kit without a kit.json flow list — the flows/ directory is the declaration surface.
    writeJson(path.join(repoRoot, "kits/nolist/flows/gamma.flow.json"), fixtureFlow("nolist.gamma"));

    const declared = declaredKitFlowIds(repoRoot);
    assert.ok(declared.includes("acme.alpha"));
    assert.ok(declared.includes("acme.beta"));
    assert.ok(declared.includes("nolist.gamma"));
    assert.ok(!declared.includes("acme.undeclared"), "kit.json flow list is authoritative when present");
    assert.ok(!declared.includes("unresolvable"), "ids without the <kit>.<flow> shape are excluded");
    // Package fallback parity with resolveFlowFilePath: the executing package's own kits stay
    // declared even when the consumer repo has its own kits/ directory.
    assert.ok(declared.includes("builder.build"));
    assert.ok(declared.includes("builder.shape"));
    assert.deepEqual(declared, [...declared].sort(), "list is sorted");
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ─── FIX-2: a declaration is bound to the kit that made it ───────────────────────────────────

test("a kit manifest cannot declare another kit's flow id (cross-kit ownership)", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flows-own-"));
  try {
    // acme claims victim.hidden. The bytes it would authorize are kits/victim/flows/hidden.flow.json,
    // a file the victim kit never declared — and, here, one that exists.
    writeJson(path.join(repoRoot, "kits/acme/kit.json"), {
      id: "acme",
      flows: [{ id: "acme.alpha", path: "flows/alpha.flow.json" }, { id: "victim.hidden", path: "flows/hidden.flow.json" }],
    });
    writeJson(path.join(repoRoot, "kits/acme/flows/alpha.flow.json"), fixtureFlow("acme.alpha"));
    writeJson(path.join(repoRoot, "kits/victim/kit.json"), { id: "victim", flows: [] });
    writeJson(path.join(repoRoot, "kits/victim/flows/hidden.flow.json"), fixtureFlow("victim.hidden"));

    const declared = declaredKitFlowIds(repoRoot);
    assert.ok(declared.includes("acme.alpha"), "the declaring kit keeps its own flow");
    assert.ok(!declared.includes("victim.hidden"), "a manifest may only declare ids namespaced to its own kit directory");
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a manifest whose id disagrees with its directory is refused wholesale", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flows-id-"));
  try {
    // The directory is `acme`; the manifest calls itself `builder`. Its identity claim is the
    // thing under doubt, so nothing it says is trusted — including the flows/ fallback.
    writeJson(path.join(repoRoot, "kits/acme/kit.json"), { id: "builder", flows: [{ id: "acme.alpha" }] });
    writeJson(path.join(repoRoot, "kits/acme/flows/alpha.flow.json"), fixtureFlow("acme.alpha"));

    const declared = declaredKitFlowIds(repoRoot);
    assert.ok(!declared.includes("acme.alpha"), "a kit that misnames its own directory declares nothing");
    assert.ok(!declared.includes("builder.alpha"));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("flows[].path must agree with the file canonical resolution will read", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flows-path-"));
  try {
    writeJson(path.join(repoRoot, "kits/acme/kit.json"), {
      id: "acme",
      flows: [
        { id: "acme.agree", path: "flows/agree.flow.json" },
        // Same kit, but the declared path names a DIFFERENT file than the one a start for
        // `acme.disagree` would read (flows/disagree.flow.json).
        { id: "acme.disagree", path: "flows/somewhere-else.flow.json" },
        { id: "acme.traversal", path: "../victim/flows/traversal.flow.json" },
        { id: "acme.absolute", path: "/etc/passwd" },
        { id: "acme.notastring", path: 7 },
      ],
    });
    writeJson(path.join(repoRoot, "kits/acme/flows/agree.flow.json"), fixtureFlow("acme.agree"));
    writeJson(path.join(repoRoot, "kits/acme/flows/disagree.flow.json"), fixtureFlow("acme.disagree"));

    const declared = declaredKitFlowIds(repoRoot);
    assert.ok(declared.includes("acme.agree"));
    assert.ok(!declared.includes("acme.disagree"), "a declared path that names other bytes does not authorize the id");
    assert.ok(!declared.includes("acme.traversal"));
    assert.ok(!declared.includes("acme.absolute"));
    assert.ok(!declared.includes("acme.notastring"));
    // A missing `path` stays legal — the id alone binds to <kit>/flows/<flow>.flow.json.
    writeJson(path.join(repoRoot, "kits/nopath/kit.json"), { id: "nopath", flows: [{ id: "nopath.plain" }] });
    assert.ok(declaredKitFlowIds(repoRoot).includes("nopath.plain"));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("malformed kit manifests neither crash nor silently widen the derived list", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flows-bad-"));
  try {
    // Unparseable manifest → no declaration to honor; the flows/ directory is the surface.
    fs.mkdirSync(path.join(repoRoot, "kits/broken/flows"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "kits/broken/kit.json"), "{ not json");
    writeJson(path.join(repoRoot, "kits/broken/flows/one.flow.json"), fixtureFlow("broken.one"));
    // `flows` present but not an array → same fallback.
    writeJson(path.join(repoRoot, "kits/notarray/kit.json"), { id: "notarray", flows: { "notarray.two": true } });
    writeJson(path.join(repoRoot, "kits/notarray/flows/two.flow.json"), fixtureFlow("notarray.two"));
    // Entries that are not objects, or carry a non-string id, are skipped individually.
    writeJson(path.join(repoRoot, "kits/mixed/kit.json"), { id: "mixed", flows: [null, "mixed.three", { id: 3 }, { id: "mixed.four" }, ["mixed.five"]] });
    // A manifest that is a JSON array, not an object.
    fs.mkdirSync(path.join(repoRoot, "kits/arraymanifest/flows"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "kits/arraymanifest/kit.json"), "[]\n");
    writeJson(path.join(repoRoot, "kits/arraymanifest/flows/six.flow.json"), fixtureFlow("arraymanifest.six"));

    const declared = declaredKitFlowIds(repoRoot);
    assert.ok(declared.includes("broken.one"), "an unreadable manifest falls back to the flows/ directory");
    assert.ok(declared.includes("notarray.two"), "a non-array flows field declares no list");
    assert.ok(declared.includes("arraymanifest.six"));
    assert.deepEqual(declared.filter((id) => id.startsWith("mixed.")), ["mixed.four"], "only well-formed entries are honored");
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ─── FIX-1: the kits root boundary is resolved, not spelled ──────────────────────────────────

test("a kits/ root symlinked into runtime artifact storage authorizes nothing", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flows-symlink-"));
  try {
    // The bypass the review found: the containment check realpath'd BOTH sides, so a symlinked
    // kits/ compared definitions against the attacker's own target and passed.
    const runtimeKits = path.join(repoRoot, ".kontourai", "flow-agents", "sess", "kits");
    writeJson(path.join(runtimeKits, "acme/kit.json"), { id: "acme", flows: [{ id: "acme.sneaky", path: "flows/sneaky.flow.json" }] });
    writeJson(path.join(runtimeKits, "acme/flows/sneaky.flow.json"), fixtureFlow("acme.sneaky"));
    fs.symlinkSync(runtimeKits, path.join(repoRoot, "kits"), "dir");

    assert.ok(!declaredKitFlowIds(repoRoot).includes("acme.sneaky"), "a kits root inside runtime artifact storage is not a kit source");
    assert.equal(resolveFlowFilePath("acme", "sneaky", "acme.sneaky", repoRoot, false), null, "and resolution refuses it too");
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a kits/ root symlinked out of the repo authorizes nothing", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flows-escape-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flows-outside-"));
  try {
    writeJson(path.join(outside, "acme/kit.json"), { id: "acme", flows: [{ id: "acme.outside", path: "flows/outside.flow.json" }] });
    writeJson(path.join(outside, "acme/flows/outside.flow.json"), fixtureFlow("acme.outside"));
    fs.symlinkSync(outside, path.join(repoRoot, "kits"), "dir");

    assert.ok(!declaredKitFlowIds(repoRoot).includes("acme.outside"), "a resolved kits root outside the repo root is refused");
    assert.equal(resolveFlowFilePath("acme", "outside", "acme.outside", repoRoot, false), null);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a non-directory kits/ entry is not a kit source", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flows-file-"));
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flows-empty-"));
  try {
    fs.writeFileSync(path.join(repoRoot, "kits"), "not a directory\n");
    // A file (or dangling link) named `kits` contributes nothing: the derived list is exactly
    // what a repo with no kits/ at all derives — the executing package's own kits.
    assert.deepEqual(declaredKitFlowIds(repoRoot), declaredKitFlowIds(emptyRoot));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test("the FLOW_AGENTS_FLOW_DEFS_DIR override is judged by containment in runtime artifact storage, not by writability", () => {
  const defs = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flows-defs-"));
  try {
    writeJson(path.join(defs, "acme.custom.flow.json"), fixtureFlow("acme.custom"));
    writeJson(path.join(defs, "not-a-flow.json"), {});
    fs.writeFileSync(path.join(defs, "release-evidence.flow.json"), "{}\n"); // no `<kit>.<flow>` shape

    // ACCEPTED, deliberately: an ordinary process-writable directory outside every runtime
    // artifact root. This is the honest scope of the check and the reason `workflow start`
    // does NOT treat "the resolver would read it" as "it may start" — the runtime and the
    // agents it governs share a uid, so writability cannot separate them. Provenance does,
    // and that is enforced by the canonical-run refusal below, not here.
    fs.accessSync(defs, fs.constants.W_OK); // throws if not writable: the accepted override IS process-writable
    withDefsDir(defs, () => {
      assert.deepEqual(declaredKitFlowIds(REPO_ROOT), ["acme.custom"], "override replaces canonical discovery wholesale");
    });

    // REFUSED: the same directory tree, one level down, inside `.kontourai/flow-agents`.
    const runtimeStorage = path.join(defs, ".kontourai", "flow-agents", "defs");
    writeJson(path.join(runtimeStorage, "acme.sneaky.flow.json"), fixtureFlow("acme.sneaky"));
    withDefsDir(runtimeStorage, () => {
      assert.deepEqual(declaredKitFlowIds(REPO_ROOT), [], "an override inside runtime artifact storage yields nothing");
    });

    // REFUSED: `.flow-agents`, the second declared sub-root, which the previous segment scan
    // also caught — kept so a regression in either name is visible.
    const durableStorage = path.join(defs, ".flow-agents", "defs");
    writeJson(path.join(durableStorage, "acme.sneaky.flow.json"), fixtureFlow("acme.sneaky"));
    withDefsDir(durableStorage, () => assert.deepEqual(declaredKitFlowIds(REPO_ROOT), []));

    // REFUSED: `delivery` under a git working tree — the third declared sub-root, which the
    // previous segment scan missed entirely.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flows-repo-"));
    try {
      fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
      const deliveryStorage = path.join(repo, "delivery", "defs");
      writeJson(path.join(deliveryStorage, "acme.sneaky.flow.json"), fixtureFlow("acme.sneaky"));
      withDefsDir(deliveryStorage, () => assert.deepEqual(declaredKitFlowIds(REPO_ROOT), []));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }

    // REFUSED: a symlink whose NAME is innocent but that lands in runtime storage.
    const link = path.join(defs, "innocent-name");
    fs.symlinkSync(runtimeStorage, link, "dir");
    withDefsDir(link, () => assert.deepEqual(declaredKitFlowIds(REPO_ROOT), [], "the override is judged where it lands"));
  } finally {
    fs.rmSync(defs, { recursive: true, force: true });
  }
});

// ─── The public verb ─────────────────────────────────────────────────────────────────────────

test("an unknown flow fails closed naming the flows the installed kits actually declare", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flow-start-"));
  try {
    const result = runStart(["--flow", "acme.custom"], dir);
    assert.notEqual(result.status, 0);
    // Exact diagnostic, not a substring sample: the message names the derived list in full,
    // and the list is derived from this checkout's own kits.
    const declared = declaredKitFlowIds(REPO_ROOT);
    assert.ok(declared.length > 0, "the fixture only proves anything if the checkout declares flows");
    assert.ok(
      result.stderr.includes(`workflow start --flow "acme.custom" is not a flow declared by the installed kits; declared flows: ${declared.join(", ")}`),
      `unexpected diagnostic: ${result.stderr}`,
    );
    // Derived, not hardcoded: the refusal names kit-declared flows the old enumeration never knew.
    for (const id of ["builder.build", "builder.shape", "builder.publish-learn", "knowledge.ingest"]) {
      assert.ok(declared.includes(id), `${id} must be derived from the packaged kits`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("under a defs override the derived refusal lists the override's declared flows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flow-start-"));
  const defs = path.join(dir, "defs");
  try {
    writeJson(path.join(defs, "acme.custom.flow.json"), fixtureFlow("acme.custom"));
    const result = runStart(["--flow", "acme.missing"], dir, { FLOW_AGENTS_FLOW_DEFS_DIR: defs });
    assert.notEqual(result.status, 0);
    assert.ok(
      result.stderr.includes('workflow start --flow "acme.missing" is not a flow declared by the installed kits; declared flows: acme.custom'),
      `unexpected diagnostic: ${result.stderr}`,
    );
    assert.ok(!result.stderr.includes("builder.build"), "the override replaces canonical discovery in the refusal too");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── FIX-4/FIX-3: a flow with no canonical run is refused, not half-started ───────────────────

test("a declared, conforming flow with no canonical run adapter is REFUSED, naming the missing capability", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flow-start-"));
  const defs = path.join(dir, "defs");
  const consumer = path.join(dir, "consumer");
  const artifactRoot = path.join(consumer, ".kontourai", "flow-agents");
  try {
    writeJson(path.join(defs, "acme.custom.flow.json"), fixtureFlow("acme.custom"));
    fs.mkdirSync(consumer, { recursive: true });
    const result = runStart([
      "--artifact-root", artifactRoot,
      "--flow", "acme.custom",
      "--work-item", "acme/widgets#7",
      "--assignment-provider", "local-file",
      "--summary", "Custom kit flow fixture",
    ], consumer, { FLOW_AGENTS_FLOW_DEFS_DIR: defs });

    assert.notEqual(result.status, 0, `start must refuse a flow with no canonical run: ${result.stdout}`);
    assert.ok(
      result.stderr.includes(`workflow start --flow acme.custom is declared and conforming, but the canonical run runtime cannot bind it: no run adapter ships or pins this definition, and no producer bindings exist for its gates, so the session could not record a pinned definition digest or satisfy a gate. Flows with a canonical run: ${CANONICAL_RUN_FLOW_IDS.join(", ")}`),
      `unexpected diagnostic: ${result.stderr}`,
    );
    // The refusal is total: no session artifacts, no active pointer, nothing downstream can
    // read as a running flow. This is the assertion that replaced the old half-start contract
    // (exit 0 + durable session + absent flow_run).
    assert.ok(!fs.existsSync(path.join(artifactRoot, "current.json")), "no active pointer is advertised");
    assert.ok(!fs.existsSync(path.join(artifactRoot, "acme-widgets-7")), "no session directory is created");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the canonical-run capability is the run adapter's declaration, not a literal in the CLI", () => {
  const workflowSource = fs.readFileSync(path.join(REPO_ROOT, "src/cli/workflow.ts"), "utf8");
  const sidecarSource = fs.readFileSync(path.join(REPO_ROOT, "src/cli/workflow-sidecar.ts"), "utf8");
  assert.ok(!workflowSource.includes("workflow start supports only"), "the identifier-enumeration refusal is gone");
  assert.ok(!/flow !== "builder\.build" && flow !== "builder\.shape"/.test(workflowSource), "the start-path enumeration predicate is gone");
  // The half-start the review found existed because ensure-session re-spelled the same pair
  // independently of the public verb. One predicate, quoted in both.
  assert.ok(!/entry\.flowId === "builder\.build" \|\| entry\.flowId === "builder\.shape"/.test(sidecarSource),
    "ensure-session must consult isCanonicalRunFlowId, not re-spell the adapter's capability");
  assert.ok(workflowSource.includes("isCanonicalRunFlowId(flow)"));
  assert.ok(sidecarSource.includes("isCanonicalRunFlowId(entry.flowId)"));
});

// ─── FIX-5: conformance matches the downstream resolver contract ──────────────────────────────

test("a declared flow that does not conform fails closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flow-start-"));
  const defs = path.join(dir, "defs");
  try {
    // Declared (file exists in the defs dir) but no steps — the resolver cannot compile it.
    writeJson(path.join(defs, "acme.broken.flow.json"), { id: "acme.broken", version: "1.0" });
    // Declared under one id, definition claims another — the declaration and definition must agree.
    writeJson(path.join(defs, "acme.mismatch.flow.json"), fixtureFlow("acme.other"));
    // Passes @kontourai/flow's validateDefinition (any non-empty step id) but the resolver
    // requires SLUG_RE, so this step would publish and then resolve to nothing.
    writeJson(path.join(defs, "acme.badstep.flow.json"), fixtureFlow("acme.badstep", [{ id: "bad step", next: "closeout" }, { id: "closeout", next: null }]));
    // A gate naming a step the definition never declares.
    const orphan = fixtureFlow("acme.orphan");
    orphan.gates["closeout-gate"].step = "nosuchstep";
    writeJson(path.join(defs, "acme.orphan.flow.json"), orphan);

    const broken = runStart(["--flow", "acme.broken"], dir, { FLOW_AGENTS_FLOW_DEFS_DIR: defs });
    assert.notEqual(broken.status, 0);
    assert.ok(broken.stderr.includes("workflow start --flow acme.broken is declared by an installed kit but does not resolve to a conforming flow composition"), broken.stderr);

    const mismatch = runStart(["--flow", "acme.mismatch"], dir, { FLOW_AGENTS_FLOW_DEFS_DIR: defs });
    assert.notEqual(mismatch.status, 0);
    assert.ok(mismatch.stderr.includes('workflow start --flow acme.mismatch resolved a definition declaring id "acme.other"; a kit\'s declared flow id and its definition must agree'), mismatch.stderr);

    const badStep = runStart(["--flow", "acme.badstep"], dir, { FLOW_AGENTS_FLOW_DEFS_DIR: defs });
    assert.notEqual(badStep.status, 0);
    assert.ok(
      badStep.stderr.includes('workflow start --flow acme.badstep does not satisfy the flow resolver\'s identifier contract, so its steps would publish but never resolve: step id "bad step" must match'),
      `unexpected diagnostic: ${badStep.stderr}`,
    );

    // A gate naming an undeclared step is caught by the BASE validator, which runs first —
    // recorded here so the division of labour between the two checks stays visible.
    const orphanResult = runStart(["--flow", "acme.orphan"], dir, { FLOW_AGENTS_FLOW_DEFS_DIR: defs });
    assert.notEqual(orphanResult.status, 0);
    assert.ok(orphanResult.stderr.includes("workflow start --flow acme.orphan does not conform to the Flow definition contract: gate closeout-gate references unknown step: nosuchstep"), orphanResult.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the resolver identifier contract is enforced for a CANONICALLY-RUNNABLE flow too", () => {
  // Reachability proof, not a formality: for a flow with no canonical run the runnability
  // refusal would catch a bad definition anyway, so the identifier contract could look
  // load-bearing while being dead. Here the definition IS builder.build — the runnability
  // check passes — and the only thing standing between a step id the resolver can never
  // resolve and a published active_step_id is this contract.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flow-badstep-"));
  const defs = path.join(dir, "defs");
  try {
    writeJson(path.join(defs, "builder.build.flow.json"), fixtureFlow("builder.build", [{ id: "bad step", next: "closeout" }, { id: "closeout", next: null }]));
    const result = runStart(["--flow", "builder.build", "--work-item", "acme/widgets#7"], dir, { FLOW_AGENTS_FLOW_DEFS_DIR: defs });
    assert.notEqual(result.status, 0);
    assert.ok(
      result.stderr.includes('workflow start --flow builder.build does not satisfy the flow resolver\'s identifier contract, so its steps would publish but never resolve: step id "bad step" must match'),
      `unexpected diagnostic: ${result.stderr}`,
    );
    assert.ok(!result.stderr.includes("cannot bind it"), "this flow is canonically runnable; the contract is what refuses it");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("flowDefinitionResolverContractIssues names every clause it enforces", () => {
  // Direct coverage of each rejection branch, including the ones the base validator reaches
  // first at the CLI seam — an unexercised clause is an unproven clause.
  assert.deepEqual(flowDefinitionResolverContractIssues(fixtureFlow("acme.ok")), []);
  assert.deepEqual(flowDefinitionResolverContractIssues(null), ["definition must be an object"]);
  assert.match(
    flowDefinitionResolverContractIssues({ ...fixtureFlow("acme.ok"), id: "noshape" }).join("; "),
    /definition id "noshape" must be "<kit>\.<flow>"/,
  );
  assert.match(
    flowDefinitionResolverContractIssues(fixtureFlow("acme.ok", [{ id: "bad step", next: null }])).join("; "),
    /step id "bad step" must match/,
  );
  const orphan = fixtureFlow("acme.orphan");
  orphan.gates["closeout-gate"].step = "nosuchstep";
  assert.match(
    flowDefinitionResolverContractIssues(orphan).join("; "),
    /gate "closeout-gate" names step "nosuchstep", which the definition does not declare/,
  );
  const badGateStep = fixtureFlow("acme.badgate");
  badGateStep.gates["closeout-gate"].step = "bad step";
  assert.match(
    flowDefinitionResolverContractIssues(badGateStep).join("; "),
    /gate "closeout-gate" names step "bad step", which must match/,
  );
});

test("flowDefinitionResolverContractIssues accepts every packaged kit-declared flow it can resolve", () => {
  // Power check for the new conformance gate: it must not be a blanket refusal. Every flow the
  // packaged kits declare and that resolves must pass the resolver's identifier contract.
  let checked = 0;
  for (const flowId of declaredKitFlowIds(REPO_ROOT)) {
    const definition = resolveEffectiveFlowDefinition(flowId, REPO_ROOT);
    if (!definition) continue;
    assert.deepEqual(flowDefinitionResolverContractIssues(definition), [], `${flowId} must satisfy the resolver contract`);
    checked += 1;
  }
  assert.ok(checked >= 2, `expected the packaged kits to contribute resolvable flows, checked ${checked}`);
});

test("builder.build and builder.shape pass flow validation and keep their byte-stable contract refusals (regression)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-flow-start-"));
  try {
    // Reaching the contract-issue stage proves the derived validation accepted the flow; the
    // pinned strings prove the pre-existing consumer-matched refusals are untouched.
    const build = runStart(["--flow", "builder.build"], dir);
    assert.notEqual(build.status, 0);
    assert.match(build.stderr, /workflow start requires --work-item <provider-ref>/);
    assert.ok(!build.stderr.includes("is not a flow declared"), `builder.build must stay startable: ${build.stderr}`);
    assert.ok(!build.stderr.includes("cannot bind it"), `builder.build must stay startable: ${build.stderr}`);

    const shape = runStart(["--flow", "builder.shape"], dir);
    assert.notEqual(shape.status, 0);
    assert.match(shape.stderr, /workflow start --flow builder\.shape requires an explicit safe --task-slug/);
    assert.ok(!shape.stderr.includes("is not a flow declared"), `builder.shape must stay startable: ${shape.stderr}`);
    assert.ok(!shape.stderr.includes("cannot bind it"), `builder.shape must stay startable: ${shape.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
