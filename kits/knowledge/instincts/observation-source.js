/**
 * Observation-source boundary. Adapters return already-scrubbed Knowledge
 * residues; parsing belongs to Ferry/Thread (kontourai/thread#80). This module
 * never reads or writes a source file or advances a cursor.
 */
import { readFileSync } from 'node:fs';
import { validate } from '../providers/lib/schema-validate.js';

const schema = JSON.parse(readFileSync(new URL('../schemas/knowledge/residue.schema.json', import.meta.url), 'utf8'));
const MAX_RESIDUES = 1000;

export async function readObservationResidues(adapter, cursor = {}) {
  if (!adapter || typeof adapter.read !== 'function') throw new TypeError('observation adapter must supply read');
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) throw new TypeError('observation cursor must be an object');
  const result = await adapter.read(structuredClone(cursor));
  if (!result || !Array.isArray(result.residues) || result.residues.length > MAX_RESIDUES || !result.cursor || typeof result.cursor !== 'object' || Array.isArray(result.cursor)) throw new Error('invalid observation adapter result');
  const seen = new Set();
  for (const residue of result.residues) {
    if (!validate(residue, schema).valid || residue.source !== 'runtime-session' || seen.has(residue.sittingId)) throw new Error('invalid or duplicate observation residue');
    seen.add(residue.sittingId);
  }
  return structuredClone(result);
}
