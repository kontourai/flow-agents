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

export const MAX_SNAPSHOT_NODES = 20_000;
export const MAX_SNAPSHOT_DEPTH = 32;

export function jsonSnapshot(value: unknown, label: string): unknown {
  const bad = (what: string): never => { throw new MemoryClaimError("invalid", `${label}: ${what}`); };
  let nodes = 0;
  const walk = (item: unknown, depth: number, ancestors: Set<object>): unknown => {
    if (++nodes > MAX_SNAPSHOT_NODES) return bad("too large to record");
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
    if (depth >= MAX_SNAPSHOT_DEPTH) return bad("too deep to record"); // containers nest at most MAX_SNAPSHOT_DEPTH levels
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype) return bad("an array subclass cannot be recorded");
        const length = item.length;
        if (length > MAX_SNAPSHOT_NODES) return bad("too large to record");
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
export function ownEntries(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new MemoryClaimError("invalid", `${label}: expected a list`);
  if (types.isProxy(value)) throw new MemoryClaimError("invalid", `${label}: a Proxy cannot be read`);
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new MemoryClaimError("invalid", `${label}: expected a plain list`);
  const length = value.length;
  if (length > MAX_SNAPSHOT_NODES || Object.getOwnPropertySymbols(value).length || Object.keys(value).length !== length) throw new MemoryClaimError("invalid", `${label}: a list with extra keys, symbols or holes, or too long, cannot be read`);
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
export function jsonSnapshotEach(value: unknown, label: string): unknown[] {
  return ownEntries(value, label).map((item, index) => jsonSnapshot(item, `${label}[${index}]`));
}
