import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";

import { createLocalFileAssignmentProvider } from "../../build/src/assignment-local-file.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";
import {
  ASSIGNMENT_PROVIDER_CONTRACT_CASES,
  createInMemoryAssignmentProvider,
  ACTOR_A,
  CLAIM_META,
} from "./assignment-provider-contract-suite.mjs";

// The one contract suite, run against every provider implementation (#1436). The in-memory
// provider is built from the published `assignment-contract` surface only; the local-file
// provider is the one Flow's CLI uses. Both must pass the same cases.

const providers = {
  "local-file provider": () => {
    const dir = makeFixtureDir("assignment-contract-local-");
    return { provider: createLocalFileAssignmentProvider(dir), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  },
  "in-memory reference provider": () => ({ provider: createInMemoryAssignmentProvider() }),
};

for (const [providerName, make] of Object.entries(providers)) {
  for (const contractCase of ASSIGNMENT_PROVIDER_CONTRACT_CASES) {
    test(`${providerName}: ${contractCase.name}`, () => contractCase.run(make));
  }
}

// The suite must have teeth: a provider that breaks the contract has to fail it, otherwise a
// green run proves nothing. Each broken provider below violates exactly one rule.
function breakProvider(mutate) {
  return () => {
    const provider = createInMemoryAssignmentProvider();
    mutate(provider);
    return { provider };
  };
}

const BROKEN = [
  {
    rule: "a different actor can never silently overwrite a claim",
    make: breakProvider((p) => {
      const claim = p.claim;
      p.claim = (id, actor, meta) => { try { claim(id, actor, meta); } catch { p.supersede(id, p.status(id).record.actor, actor, {}); } };
    }),
  },
  {
    rule: "release refuses a non-holder",
    make: breakProvider((p) => {
      const release = p.release;
      p.release = (id, _by, meta) => release(id, null, meta);
    }),
  },
  {
    rule: "list filters by the CANONICAL actor key",
    make: breakProvider((p) => {
      const list = p.list;
      p.list = (key) => (key ? list().filter((id) => p.status(id).assignee === key) : list());
    }),
  },
];

for (const { rule, make } of BROKEN) {
  test(`the contract suite rejects a provider that breaks: ${rule}`, async () => {
    const failures = [];
    for (const contractCase of ASSIGNMENT_PROVIDER_CONTRACT_CASES) {
      try { await contractCase.run(make); } catch (error) { failures.push(`${contractCase.name}: ${error.message}`); }
    }
    assert.ok(failures.length > 0, `a provider that breaks "${rule}" passed every contract case`);
  });
}

test("the in-memory reference provider's records are the codec's record shape (host-written records read back in Flow's CLI)", async () => {
  const { provider } = providers["in-memory reference provider"]();
  await provider.claim("subject-1", ACTOR_A, CLAIM_META);
  const { record } = await provider.status("subject-1");
  assert.equal(record.schema_version, "1.0");
  assert.equal(record.role, "AssignmentClaimRecord");
});
