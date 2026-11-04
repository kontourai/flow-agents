/**
 * A strict deep copy of plain JSON data, taken once, so that what is validated is exactly what is recorded.
 *
 * Refuses anything JSON would change or drop: Proxies (they answer every question as they like, and can answer differently
 * each time), accessors (a getter can answer differently the next time it is read),
 * non-finite numbers and `-0`, `undefined` list entries, holes, symbols, functions, bigints, class instances, array
 * subclasses, extra keys on arrays, cycles, and the key `__proto__` (assigning it sets a prototype instead of a field,
 * so a value validated through an inherited property would vanish when serialised). Lists are read by index, never
 * through methods the caller controls. Bounded in size and depth: over the bound is refused, never cut short.
 */
import { types } from "node:util";
import { MemoryClaimError } from "./memory-claims.js";

// The bounds are written here once and the larger ones are derived from the smaller, so that what the Kit produces is always
// something its own readers accept: a claim is checked against the claim bounds when it is assembled, and a routing decision
// (which embeds a claim, its peers and its verification records) is bounded by their sum, not by the claim's own bound.
/** JSON values in one claim, one review decision or event, or one extraction-pass proposal list entry. */
export const MAX_SNAPSHOT_NODES = 20_000;
/** Levels of nesting in one claim. */
export const MAX_SNAPSHOT_DEPTH = 32;
/** Other claims one claim is checked against (and so embedded with in its routing decision). */
export const MAX_PEERS = 64;
/** Support-verification records one routing decision carries, and the values one may hold (a record is digests and ids: about 15 values). */
export const MAX_VERIFICATIONS = 64;
export const MAX_VERIFICATION_NODES = 2_000;
/** Entries in one request list, and in the history a run keeps (decisions, review decisions, review events). */
export const MAX_RUN_LIST = 20_000;
/** JSON values in a routing policy (three short lists of names). */
export const MAX_POLICY_NODES = 20_000;
/** What one run holds across requests (routing decisions, review decisions, review events, each), and the default cap `maxHistoryEntries` lowers. */
export const MAX_HISTORY_ENTRIES = 1_000_000;
/**
 * What a routing decision holds besides its claims and verification records, each part bounded on its own: a baseline per claim
 * (65 x ~1,030 for a visibility that lists 1,024 audiences = ~67,000), the projection fact (at most 1,000 entries in each of three
 * lists, plus a slot of at most a claim's worth), the policy (`MAX_POLICY_NODES`), and a few hundred envelope fields: ~160,000 in
 * all, inside the allowance. Every part is bounded where the Kit takes it in, so a decision the Kit produces always fits; the test
 * `the decision bound covers the sum of its parts` pins that sum, so a bound cannot change without it.
 */
export const MAX_ENVELOPE_NODES = 200_000;
/** A routing decision: the claim and its peers, the verification records, and the envelope. */
export const MAX_DECISION_NODES = (MAX_PEERS + 1) * MAX_SNAPSHOT_NODES + MAX_VERIFICATIONS * MAX_VERIFICATION_NODES + MAX_ENVELOPE_NODES;
/** A claim sits a few levels down in a decision and in an extraction response, so those nest a few levels deeper than a claim. */
export const MAX_DECISION_DEPTH = MAX_SNAPSHOT_DEPTH + 8;
/** One extraction pass's response: many proposals, each with a value and provenance. */
export const MAX_EXTRACTION_RESULT_NODES = 250_000;

export interface SnapshotOptions { maxNodes?: number; maxDepth?: number }

export function jsonSnapshot(value: unknown, label: string, options: SnapshotOptions = {}): unknown {
  const bad = (what: string): never => { throw new MemoryClaimError("invalid", `${label}: ${what}`); };
  const maxNodes = options.maxNodes ?? MAX_SNAPSHOT_NODES, maxDepth = options.maxDepth ?? MAX_SNAPSHOT_DEPTH;
  let nodes = 0;
  const walk = (item: unknown, depth: number, ancestors: Set<object>): unknown => {
    if (++nodes > maxNodes) return bad("too large to record");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return bad("a number that is not finite cannot be recorded as JSON");
      if (Object.is(item, -0)) return bad("negative zero cannot be recorded as JSON");
      return item;
    }
    if (typeof item !== "object") return bad(`a ${typeof item} cannot be recorded as JSON`);
    // A Proxy answers every question (its keys, its descriptors, its length) as it likes, and can answer differently each time, so
    // no list of checks makes one safe to read. It is refused, not defended against.
    if (types.isProxy(item)) return bad("a Proxy cannot be recorded");
    if (ancestors.has(item)) return bad("a cycle cannot be recorded");
    if (depth >= maxDepth) return bad("too deep to record"); // containers nest at most maxDepth levels
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype) return bad("an array subclass cannot be recorded");
        const length = item.length;
        if (length > maxNodes) return bad("too large to record");
        if (Object.getOwnPropertySymbols(item).length || Object.keys(item).length !== length) return bad("a list with extra keys, symbols or holes cannot be recorded");
        const out: unknown[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, index);
          if (!descriptor || !("value" in descriptor)) return bad("a hole or accessor in a list cannot be recorded");
          if (descriptor.value === undefined) return bad("an undefined list entry cannot be recorded");
          out.push(walk(descriptor.value, depth + 1, ancestors));
        }
        return out;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) return bad("only plain objects can be recorded");
      if (Object.getOwnPropertySymbols(item).length) return bad("a symbol key cannot be recorded");
      const copy: Record<string, unknown> = {};
      for (const key of Object.keys(item)) {
        if (key === "__proto__") return bad("a __proto__ key cannot be recorded");
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!("value" in descriptor)) return bad(`${key} is an accessor, which cannot be recorded`);
        if (descriptor.value !== undefined) copy[key] = walk(descriptor.value, depth + 1, ancestors);
      }
      return copy;
    } finally {
      ancestors.delete(item);
    }
  };
  return walk(value, 0, new Set());
}

/**
 * One own data property of a caller's object, or undefined when it has none. For choosing the fields to snapshot before there
 * is a snapshot: nothing the caller defined runs (no getter, no inherited value, no Proxy trap). A getter or a Proxy is refused.
 */
export function ownField(record: unknown, key: string, label: string): unknown {
  if (record === undefined || record === null) return undefined;
  if (typeof record !== "object") throw new MemoryClaimError("invalid", `${label}: expected an object`);
  if (types.isProxy(record)) throw new MemoryClaimError("invalid", `${label}: a Proxy cannot be read`);
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) throw new MemoryClaimError("invalid", `${label}: ${key} is an accessor, which cannot be read`);
  return descriptor.value;
}

/** The entries of a caller's list, read by index with the same refusals as `jsonSnapshot`, without calling any of its methods. */
export function ownEntries(value: unknown, label: string, maxLength: number = MAX_RUN_LIST): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new MemoryClaimError("invalid", `${label}: expected a list`);
  if (types.isProxy(value)) throw new MemoryClaimError("invalid", `${label}: a Proxy cannot be read`);
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new MemoryClaimError("invalid", `${label}: expected a plain list`);
  const length = value.length;
  if (length > maxLength || Object.getOwnPropertySymbols(value).length || Object.keys(value).length !== length) throw new MemoryClaimError("invalid", `${label}: a list with extra keys, symbols or holes, or too long, cannot be read`);
  const out: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !("value" in descriptor)) throw new MemoryClaimError("invalid", `${label}: a hole or accessor in a list cannot be read`);
    out.push(descriptor.value);
  }
  return out;
}

/** Snapshots a list a caller handed in, reading it by index. A value that is not a list is refused. */
export function jsonSnapshotList(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new MemoryClaimError("invalid", `${label}: expected a list`);
  return jsonSnapshot(value, label) as unknown[];
}

/** A list of independent items, each copied on its own (so the size bound is per item, not per list), read by index. */
export function jsonSnapshotEach(value: unknown, label: string, options: SnapshotOptions = {}): unknown[] {
  return ownEntries(value, label).map((item, index) => jsonSnapshot(item, `${label}[${index}]`, options));
}
