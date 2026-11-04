import test from "node:test";
import assert from "node:assert/strict";
import { jsonSnapshot, jsonSnapshotEach, jsonSnapshotList, ownEntries, ownField, MAX_SNAPSHOT_DEPTH, MAX_SNAPSHOT_NODES } from "@kontourai/flow-agents/memory-json";
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

test("a Proxy is refused wherever it appears: no trap list can make one safe to read", () => {
  const traps = {
    "a pass-through proxy": new Proxy({ a: 1 }, {}),
    "a proxied list": new Proxy([{ a: 1 }], {}),
    "a list whose ownKeys and length hide its only entry": new Proxy([{ keep: "current" }], { ownKeys: () => ["length"], get: (t, key, r) => key === "length" ? 0 : Reflect.get(t, key, r) }),
    "an object whose descriptor trap drops a field": new Proxy({ candidateId: "c", status: "x" }, { getOwnPropertyDescriptor: (t, key) => key === "candidateId" ? undefined : Reflect.getOwnPropertyDescriptor(t, key) }),
    "a list whose length changes while read": new Proxy([{ a: 1 }], (() => { let reads = 0; return { get(t, key, r) { if (key === "length") return ++reads === 1 ? 1 : 0; return Reflect.get(t, key, r); } }; })()),
  };
  for (const [name, proxy] of Object.entries(traps)) {
    refuses(proxy, /Proxy/, name);
    refuses({ nested: [proxy] }, /Proxy/, `${name}, nested`);
    assert.throws(() => jsonSnapshotList(Array.isArray(proxy) ? proxy : [proxy], "t"), MemoryClaimError, `${name} as a list`);
  }
});

test("ownField and ownEntries run nothing the caller defined: a getter, a Proxy or an overridden method is refused", () => {
  assert.equal(ownField({ a: 1 }, "a", "t"), 1);
  assert.equal(ownField({ a: 1 }, "missing", "t"), undefined);
  assert.equal(ownField(undefined, "a", "t"), undefined);
  assert.equal(ownField(Object.create({ a: 1 }), "a", "t"), undefined, "an inherited value is not the object's own");
  assert.throws(() => ownField({ get a() { return 1; } }, "a", "t"), MemoryClaimError);
  assert.throws(() => ownField(new Proxy({ a: 1 }, {}), "a", "t"), MemoryClaimError);
  assert.throws(() => ownField(7, "a", "t"), MemoryClaimError);
  assert.deepEqual(ownEntries([1, { a: 2 }], "t"), [1, { a: 2 }]);
  assert.deepEqual(ownEntries(undefined, "t"), []);
  const overridden = [1, 2]; overridden.map = () => [];
  assert.throws(() => ownEntries(overridden, "t"), MemoryClaimError, "an own `map` is an extra key");
  assert.throws(() => ownEntries(new Proxy([1], {}), "t"), MemoryClaimError);
  assert.throws(() => ownEntries(Object.defineProperty([0], 0, { get() { return 1; } }), "t"), MemoryClaimError, "an accessor entry");
  assert.throws(() => ownEntries(new Array(2), "t"), MemoryClaimError, "holes");
  assert.throws(() => ownEntries("x", "t"), MemoryClaimError);
  assert.throws(() => ownEntries(null, "t"), MemoryClaimError);
});

test("null is not an empty list: only an absent list is", () => {
  assert.deepEqual(jsonSnapshotList(undefined, "t"), []);
  assert.throws(() => jsonSnapshotList(null, "t"), /expected a list/);
});

test("ownEntries refuses an array subclass, a symbol key and a list over the bound; jsonSnapshotEach bounds each item, not the list", () => {
  class Sub extends Array {}
  assert.throws(() => ownEntries(Sub.from([1]), "t"), /plain list/, "a subclass");
  const symbolic = [1]; symbolic[Symbol("k")] = 2;
  assert.throws(() => ownEntries(symbolic, "t"), /extra keys, symbols or holes/, "a symbol key");
  assert.throws(() => ownEntries(new Array(MAX_SNAPSHOT_NODES + 1).fill(0), "t"), /too long/, "over the bound is refused, not cut short");
  assert.equal(ownEntries(new Array(MAX_SNAPSHOT_NODES).fill(0), "t").length, MAX_SNAPSHOT_NODES, "at the bound is read");
  const wide = Array.from({ length: 3 }, (_, i) => ({ k: new Array(MAX_SNAPSHOT_NODES - 10).fill(i) }));
  assert.equal(jsonSnapshotEach(wide, "t").length, 3, "each item is under the bound although the list is not");
  assert.throws(() => jsonSnapshotList(wide, "t"), /too large/, "the whole list is not");
  assert.throws(() => jsonSnapshotEach([{ a: 1 }, new Proxy({}, {})], "t"), /Proxy/);
});

test("a per-call node bound lets a caller copy more than one claim's worth, and still refuses past it", () => {
  const wide = { a: new Array(MAX_SNAPSHOT_NODES + 50).fill(1) };
  assert.throws(() => jsonSnapshot(wide, "t"), /too large/);
  assert.equal(jsonSnapshot(wide, "t", { maxNodes: MAX_SNAPSHOT_NODES * 2 }).a.length, MAX_SNAPSHOT_NODES + 50);
  assert.throws(() => jsonSnapshot(wide, "t", { maxNodes: MAX_SNAPSHOT_NODES + 10 }), /too large/);
  assert.equal(jsonSnapshotEach([wide, wide], "t", { maxNodes: MAX_SNAPSHOT_NODES * 2 }).length, 2);
});
