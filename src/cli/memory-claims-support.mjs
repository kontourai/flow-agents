// Shared support for the memory-claims and memory-routing tests: the fixture
// loaders, a scripted model, and the host-side binding of Traverse's real
// extract() to the Kit's `extract` seam.
import fs from "node:fs";
import path from "node:path";
import { createExtractionTaskSpec, extract } from "@kontourai/traverse";
import { canonicalJson } from "@kontourai/relay";
import { distillMemoryClaims } from "@kontourai/flow-agents/memory-claims";

export const FIXTURES = path.resolve(import.meta.dirname, "fixtures", "memory-claims");
export const SCHEMAS = path.resolve(import.meta.dirname, "..", "..", "schemas", "knowledge");

export const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(...parts), "utf8"));
export const loadSittings = () => readJson(FIXTURES, "sittings.json");
export const loadScript = () => readJson(FIXTURES, "extraction-script.json");
/** Real Survey EntityProposals, made by createEntityProposal on kontourai/survey feat/243-entity-review. */
export const loadEntityProposals = () => readJson(FIXTURES, "entity-proposals.json");

/**
 * A scripted ExtractionProvider. Each call answers the next pass of the
 * script, in Traverse's ProviderExtractionOutput shape (indexed paths, an
 * excerpt per field).
 */
export function scriptedProvider(passes) {
  let call = 0;
  const calls = [];
  return {
    name: "scripted-replay",
    calls,
    async extract(input) {
      calls.push(input);
      const claims = passes[Math.min(call++, passes.length - 1)];
      const proposals = [];
      claims.forEach((claim, index) => {
        for (const field of ["subject", "subjectType", "property", "value", "speaker", "posture", "validFrom", "validUntil", "replacesPrior"]) {
          if (claim[field] === undefined) continue;
          proposals.push({
            fieldPath: `claims[${index}].${field}`, candidateValue: claim[field], confidence: 0.9,
            provenance: { excerpt: claim.quote, locator: "" }, extractor: "scripted-replay",
          });
        }
      });
      return { proposals, raw: { response: "scripted", model: "scripted-replay" } };
    },
  };
}

/** Binds Traverse's real extract() to the Kit's seam, with the Kit's schema passed as an ordinary caller-owned schema. */
export function traverseExtract(provider) {
  return async request => {
    const targetSchema = request.targetSchema.map(field => ({ ...field }));
    const taskSpec = createExtractionTaskSpec({ version: "1", targetSchema, guidance: request.guidance });
    return extract({ content: request.content, contentType: request.contentType, sourceRef: request.sourceRef, targetSchema, taskSpec, provider });
  };
}

/** What the host says the fixture sittings may be shown to. Every distilled fixture claim carries it. */
export const FIXTURE_VISIBILITY = { kind: "restricted", audiences: ["user:fixture"] };

export async function distillFixtureSitting(index, options = {}) {
  const sitting = loadSittings()[index];
  const provider = scriptedProvider(loadScript().sittings[index].passes);
  const result = await distillMemoryClaims({ sitting, extract: traverseExtract(provider), visibility: FIXTURE_VISIBILITY, ...options });
  return { sitting, provider, result };
}

/** Compares a value with a committed fixture; UPDATE_MEMORY_FIXTURES=1 rewrites it. */
export function matchesFixture(name, value) {
  const file = path.join(FIXTURES, name);
  const text = `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`;
  if (process.env.UPDATE_MEMORY_FIXTURES === "1") fs.writeFileSync(file, text);
  return { file, expected: fs.readFileSync(file, "utf8"), actual: text };
}
