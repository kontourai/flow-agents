import test from "node:test";
import assert from "node:assert/strict";
import { jsonSnapshot, jsonSnapshotList, MAX_SNAPSHOT_DEPTH, MAX_SNAPSHOT_NODES } from "@kontourai/flow-agents/memory-json";
import { MemoryClaimError } from "@kontourai/flow-agents/memory-claims";

const refuses = (value, pattern, name) => assert.throws(() => jsonSnapshot(value, "t"), error => error instanceof MemoryClaimError && pattern.test(error.message), name);
const deep = n => { let v = 1; for (let i = 0; i < n; i++) v = { a: v }; return v; };

test("a plain object round-trips unchanged, null-prototype and frozen included, and an undefined field is simply absent", () => {
  const input = Object.freeze({ a: 1, b: ["x", { c: true }], d: null, e: undefined, f: "" });
  assert.deepEqual(jsonSnapshot(input, "t"), { a: 1, b: ["x", { c: true }], d: null, f: "" });
  const bare = Object.assign(Object.create(null), { k: "v" });
  assert.deepEqual(jsonSnapshot(bare, "t"), { k: "v" });
  assert.notEqual(jsonSnapshot(input, "t"), input, "a copy, never the caller's object");
});

test("__proto__ is refused: as plain JSON it is an own key, and copying it would set a prototype and let an inherited value pass validation", () => {
  const hostile = JSON.parse('{"kind":"ReviewDecision","__proto__":{"spec":{"reviewItemName":"x"}}}');
  assert.equal(Object.hasOwn(hostile, "__proto__"), true, "the premise: JSON.parse makes it an own key");
  refuses(hostile, /__proto__/, "top level");
  refuses({ nested: [{ ok: 1 }, JSON.parse('{"__proto__":1}')] }, /__proto__/, "nested in a list");
});

test("everything JSON would change or drop is refused, not changed", () => {
  class Odd { constructor() { this.a = 1; } }
  const cyc = { a: 1 }; cyc.self = cyc;
  const withSymbol = { a: 1 }; withSymbol[Symbol("s")] = 1;
  const getter = {}; Object.defineProperty(getter, "x", { enumerable: true, get() { return 1; } });
  const extra = [1, 2]; extra.note = "x";
  const symList = [1]; symList[Symbol("s")] = 1;
  class Sub extends Array {}
  const sub = new Sub(); sub.push(1);
  for (const [name, value, pattern] of [
    ["NaN", { n: NaN }, /not finite/], ["Infinity", { n: Infinity }, /not finite/], ["-0", { n: -0 }, /negative zero/], ["a function", { f: () => 1 }, /function/], ["a bigint", { b: 1n }, /bigint/],
    ["a symbol value", { s: Symbol("x") }, /symbol/], ["a class instance", { o: new Odd() }, /plain objects/], ["a Date", { d: new Date() }, /plain objects/], ["a Map", { m: new Map() }, /plain objects/],
    ["a symbol key", withSymbol, /symbol key/], ["an accessor", getter, /accessor/], ["a cycle", cyc, /cycle/], ["a hole", [1, , 3], /hole|extra keys/], ["an undefined list entry", [1, undefined], /undefined list entry/],
    ["an array with extra keys", extra, /extra keys/], ["an array with a symbol", symList, /extra keys|symbols/], ["an array subclass", sub, /subclass/],
  ]) refuses(value, pattern, name);
});

test("size and depth are bounded, and over the bound is refused rather than cut short", () => {
  assert.doesNotThrow(() => jsonSnapshot(deep(MAX_SNAPSHOT_DEPTH), "t"));
  refuses(deep(MAX_SNAPSHOT_DEPTH + 1), /too deep/, "one level too deep");
  const wide = n => Array.from({ length: n }, (_, i) => i);
  assert.doesNotThrow(() => jsonSnapshot(wide(MAX_SNAPSHOT_NODES - 1), "t"));
  refuses(wide(MAX_SNAPSHOT_NODES), /too large/, "one node too many");
  refuses({ a: wide(MAX_SNAPSHOT_NODES) }, /too large/, "wide inside an object");
  // A cycle is refused as a cycle, not merely by running out of depth.
  const cyc = []; cyc.push(cyc);
  refuses(cyc, /cycle/, "a list containing itself");
  const shared = { x: 1 };
  assert.deepEqual(jsonSnapshot({ a: shared, b: shared }, "t"), { a: { x: 1 }, b: { x: 1 } }, "the same object twice is not a cycle");
});

test("a getter is refused at any read count, so what is validated is what is recorded", () => {
  for (const validReads of [1, 2, 3, 5, 9]) {
    let reads = 0;
    const evil = { kind: "ReviewDecision" };
    Object.defineProperty(evil, "spec", { enumerable: true, get() { reads++; return reads <= validReads ? { ok: 1 } : null; } });
    refuses(evil, /accessor/, `valid for ${validReads} reads`);
    assert.equal(reads, 0, "the getter was never even called");
  }
});

test("a list is read by index: a custom .map, a hole or a subclass cannot change what is recorded", () => {
  const list = [{ a: 1 }]; list.map = () => [{ a: NaN }];
  assert.throws(() => jsonSnapshotList(list, "t"), MemoryClaimError, "an own .map makes the list carry an extra key");
  const proto = Array.prototype.map;
  try {
    Array.prototype.map = function () { return [{ a: NaN }]; };
    assert.deepEqual(jsonSnapshotList([{ a: 1 }], "t"), [{ a: 1 }], "a patched Array.prototype.map is never consulted");
  } finally { Array.prototype.map = proto; }
  assert.throws(() => jsonSnapshotList([{ a: 1 }, , { a: 2 }], "t"), MemoryClaimError, "a hole is refused, not dropped");
  assert.throws(() => jsonSnapshotList("not a list", "t"), /expected a list/);
  assert.throws(() => jsonSnapshotList({ length: 1, 0: {} }, "t"), /expected a list/);
  assert.deepEqual(jsonSnapshotList(undefined, "t"), [], "absent is empty");
});

test("a Proxy is copied through its descriptors once, to a stable snapshot", () => {
  let reads = 0;
  const target = { a: 1 };
  const proxy = new Proxy(target, { get(t, k) { reads++; return reads > 1 ? "changed" : t[k]; } });
  assert.deepEqual(jsonSnapshot(proxy, "t"), { a: 1 }, "descriptors, not property gets, are what is read");
});
