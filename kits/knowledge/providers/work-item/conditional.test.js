/**
 * WorkItemProvider — conditional-GET behavior (issue #1206, wave 6 / 19).
 *
 * Run: node --test kits/knowledge/providers/work-item/conditional.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { WorkItemProvider } from "./index.js";

function issue(n) {
  return { number: n, title: `issue ${n}`, state: "OPEN", labels: [], body: "" };
}

describe("structured runner receives conditional validators on re-fetch", () => {
  test("second fetch (forceRefresh) carries validators + pre-built headers from the first 200", async () => {
    const calls = [];
    const runner = async (args, conditional) => {
      calls.push({ args, conditional });
      if (calls.length === 1) {
        return { issues: [issue(1)], etag: 'W/"abc"', lastModified: "Mon, 01 Jan 2026 00:00:00 GMT" };
      }
      return { issues: [], notModified: true };
    };
    const provider = new WorkItemProvider({ repo: "x/y", runner });

    const first = await provider._issues();
    assert.equal(first.length, 1);
    assert.equal(calls[0].conditional.validators, undefined, "first call has no cached validators yet");

    const second = await provider._issues({ forceRefresh: true });
    assert.equal(second.length, 1, "304 keeps cached data");
    assert.deepEqual(calls[1].conditional.validators, { etag: 'W/"abc"', lastModified: "Mon, 01 Jan 2026 00:00:00 GMT", bodyHash: calls[1].conditional.validators.bodyHash });
    assert.deepEqual(calls[1].conditional.headers, {
      "If-None-Match": 'W/"abc"',
      "If-Modified-Since": "Mon, 01 Jan 2026 00:00:00 GMT",
    });
  });

  test("readNodes/readEdges/readGraph work end to end through the conditional path", async () => {
    let calls = 0;
    const runner = async () => {
      calls += 1;
      return { issues: [issue(7)] };
    };
    const provider = new WorkItemProvider({ repo: "x/y", runner });
    const graph = await provider.readGraph();
    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.nodes[0].id, "issue:7");

    // Single-flight guard: readNodes()+readEdges() race in parallel inside
    // Promise.all on a COLD cache, but must share the same in-flight fetch —
    // exactly ONE underlying runner call, not two.
    assert.equal(calls, 1, "readGraph() on a cold cache must issue exactly one underlying fetch");

    // A second readGraph() must be served from cache (no new runner call).
    await provider.readGraph();
    assert.equal(calls, 1, "second readGraph() must be served from cache");
  });

  test("single-flight: a rejected in-flight fetch is cleared so the next call retries", async () => {
    let calls = 0;
    const runner = async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient failure");
      return { issues: [issue(1)] };
    };
    const provider = new WorkItemProvider({ repo: "x/y", runner });

    await assert.rejects(() => provider.readGraph(), /transient failure/);
    assert.equal(calls, 1, "first (failing) attempt made exactly one call across the concurrent pair");

    const graph = await provider.readGraph();
    assert.equal(graph.nodes.length, 1, "the next call must retry, not stay stuck on the cleared in-flight promise");
    assert.equal(calls, 2);
  });
});

describe("notModified keeps cached data", () => {
  test("a 304 on refresh returns the previously cached issues unchanged", async () => {
    let call = 0;
    const runner = async () => {
      call += 1;
      if (call === 1) return { issues: [issue(1), issue(2)], etag: "W/1" };
      return { issues: [], notModified: true };
    };
    const provider = new WorkItemProvider({ repo: "x/y", runner });
    const first = await provider._issues();
    const second = await provider._issues({ forceRefresh: true });
    assert.deepEqual(second, first);
  });
});

describe("legacy runner shapes still work unmodified", () => {
  test("a single-arg string-returning runner (JSON array text) still works", async () => {
    const runner = async () => JSON.stringify([issue(3)]);
    const provider = new WorkItemProvider({ repo: "x/y", runner });
    const nodes = await provider.readNodes();
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].id, "issue:3");
  });

  test("a single-arg array-returning runner (no { issues } wrapper) still works", async () => {
    const runner = async () => [issue(4), issue(5)];
    const provider = new WorkItemProvider({ repo: "x/y", runner });
    const nodes = await provider.readNodes();
    assert.equal(nodes.length, 2);
  });

  test("a runner that ignores the second (conditional) argument is unaffected", async () => {
    // eslint-disable-next-line no-unused-vars
    const runner = async (args) => JSON.stringify([issue(9)]);
    const provider = new WorkItemProvider({ repo: "x/y", runner });
    const nodes = await provider.readNodes();
    assert.equal(nodes.length, 1);
  });

  test("legacy string runner: a byte-identical refetch reuses cached parsed data (body-hash fallback)", async () => {
    const body = JSON.stringify([issue(11), issue(12)]);
    const runner = async () => body; // identical bytes every call
    const provider = new WorkItemProvider({ repo: "x/y", runner, cacheTtlMs: 10 });

    const first = await provider._issues();
    assert.equal(first.length, 2);

    await new Promise((r) => setTimeout(r, 30)); // force TTL expiry -> refetch path
    const second = await provider._issues();
    assert.deepEqual(second, first, "byte-identical body must reuse the cached parsed array, not re-parse");
    assert.equal(second, first, "must be the SAME cached array instance, not a freshly re-parsed one");
  });

  test("legacy array runner: a byte-identical refetch (JSON.stringify-equal) reuses cached data", async () => {
    const runner = async () => [issue(21), issue(22)]; // a NEW array instance every call, same content
    const provider = new WorkItemProvider({ repo: "x/y", runner, cacheTtlMs: 10 });

    const first = await provider._issues();
    await new Promise((r) => setTimeout(r, 30));
    const second = await provider._issues();
    assert.deepEqual(second, first);
    // The cache entry itself is untouched on a body-hash-unchanged hit — same object identity.
    assert.equal(second, first);
  });
});

describe("misbehaving runner: notModified on the first call", () => {
  test("throws the runner-contract error, not a TypeError", async () => {
    const runner = async () => ({ issues: [], notModified: true });
    const provider = new WorkItemProvider({ repo: "x/y", runner });
    await assert.rejects(
      () => provider._issues(),
      (err) => {
        assert.ok(err instanceof Error);
        assert.notEqual(err.constructor.name, "TypeError");
        assert.match(err.message, /304|cache/i);
        return true;
      }
    );
  });
});

describe("capabilities().conditional_get is derived from observed runner support", () => {
  test("a legacy string runner never flips conditional_get true", async () => {
    const provider = new WorkItemProvider({ repo: "x/y", runner: async () => JSON.stringify([issue(1)]) });
    assert.equal(provider.capabilities().conditional_get, false, "false before any fetch");
    await provider._issues();
    assert.equal(provider.capabilities().conditional_get, false, "still false — a legacy runner can never carry validators");
  });

  test("a legacy plain-array runner never flips conditional_get true", async () => {
    const provider = new WorkItemProvider({ repo: "x/y", runner: async () => [issue(1)] });
    await provider._issues();
    assert.equal(provider.capabilities().conditional_get, false);
  });

  test("a structured runner with no etag/lastModified does not flip conditional_get true", async () => {
    const provider = new WorkItemProvider({ repo: "x/y", runner: async () => ({ issues: [issue(1)] }) });
    await provider._issues();
    assert.equal(provider.capabilities().conditional_get, false, "structured but no validators observed yet");
  });

  test("a structured runner carrying an etag flips conditional_get true after the first fetch", async () => {
    const provider = new WorkItemProvider({ repo: "x/y", runner: async () => ({ issues: [issue(1)], etag: "W/1" }) });
    assert.equal(provider.capabilities().conditional_get, false, "false before any fetch has been observed");
    await provider._issues();
    assert.equal(provider.capabilities().conditional_get, true);
  });

  test("a structured runner carrying only lastModified also flips conditional_get true", async () => {
    const provider = new WorkItemProvider({ repo: "x/y", runner: async () => ({ issues: [issue(1)], lastModified: "Mon, 01 Jan 2026 00:00:00 GMT" }) });
    await provider._issues();
    assert.equal(provider.capabilities().conditional_get, true);
  });
});

describe("cacheTtlMs option", () => {
  test("default (unset): cache lives for the provider instance lifetime", async () => {
    let calls = 0;
    const runner = async () => { calls += 1; return { issues: [issue(1)] }; };
    const provider = new WorkItemProvider({ repo: "x/y", runner });
    await provider._issues();
    await new Promise((r) => setTimeout(r, 20));
    await provider._issues();
    assert.equal(calls, 1, "no TTL configured -> serves from cache indefinitely");
  });

  test("set: an expired cache entry triggers a refresh without forceRefresh", async () => {
    let calls = 0;
    const runner = async () => { calls += 1; return { issues: [issue(1)] }; };
    const provider = new WorkItemProvider({ repo: "x/y", runner, cacheTtlMs: 10 });
    await provider._issues();
    await new Promise((r) => setTimeout(r, 30));
    await provider._issues();
    assert.equal(calls, 2, "expired TTL triggers an automatic refresh");
  });

  test("set: a fresh cache entry (within TTL) is still served without a refetch", async () => {
    let calls = 0;
    const runner = async () => { calls += 1; return { issues: [issue(1)] }; };
    const provider = new WorkItemProvider({ repo: "x/y", runner, cacheTtlMs: 60_000 });
    await provider._issues();
    await provider._issues();
    assert.equal(calls, 1);
  });
});
