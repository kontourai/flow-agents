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

    // A second readGraph() must be served from cache (no new runner call) —
    // readNodes()+readEdges() race in parallel on the FIRST call (before
    // either has populated the cache, so that pair legitimately double-fetches),
    // but once cached, subsequent reads must not re-hit the runner.
    const callsAfterFirstRead = calls;
    await provider.readGraph();
    assert.equal(calls, callsAfterFirstRead, "second readGraph() must be served from cache");
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
