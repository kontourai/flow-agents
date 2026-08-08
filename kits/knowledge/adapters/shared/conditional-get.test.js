/**
 * Conditional GET / cache validation utilities (issue #1206, wave 6 / 18).
 *
 * Run: node --test kits/knowledge/adapters/shared/conditional-get.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildConditionalHeaders,
  computeBodyHash,
  processConditionalResponse,
  isBodyUnchanged,
  createCacheEntry,
  isCacheFresh,
} from "./conditional-get.js";

describe("buildConditionalHeaders", () => {
  test("builds If-None-Match and If-Modified-Since from validators", () => {
    const headers = buildConditionalHeaders({ etag: "W/abc", lastModified: "Mon, 01 Jan 2026 00:00:00 GMT" });
    assert.deepEqual(headers, {
      "If-None-Match": "W/abc",
      "If-Modified-Since": "Mon, 01 Jan 2026 00:00:00 GMT",
    });
  });

  test("omits headers with no corresponding validator", () => {
    assert.deepEqual(buildConditionalHeaders({ etag: "W/abc" }), { "If-None-Match": "W/abc" });
    assert.deepEqual(buildConditionalHeaders({}), {});
    assert.deepEqual(buildConditionalHeaders(undefined), {});
  });
});

describe("processConditionalResponse", () => {
  test("200 OK extracts validators + body hash and parses the JSON body", () => {
    const body = JSON.stringify([{ number: 1 }]);
    const response = {
      status: 200,
      body,
      headers: { etag: "W/xyz", "last-modified": "Tue, 02 Jan 2026 00:00:00 GMT" },
    };
    const result = processConditionalResponse(response, null);
    assert.equal(result.notModified, false);
    assert.deepEqual(result.data, [{ number: 1 }]);
    assert.equal(result.validators.etag, "W/xyz");
    assert.equal(result.validators.lastModified, "Tue, 02 Jan 2026 00:00:00 GMT");
    assert.equal(result.validators.bodyHash, computeBodyHash(body));
  });

  test("200 OK with no validators still computes a body-hash fallback", () => {
    const body = JSON.stringify({ a: 1 });
    const result = processConditionalResponse({ status: 200, body, headers: {} }, null);
    assert.equal(result.validators.etag, undefined);
    assert.equal(result.validators.lastModified, undefined);
    assert.equal(result.validators.bodyHash, computeBodyHash(body));
  });

  test("304 Not Modified with a prior cache entry returns cached data + notModified: true", () => {
    const cached = createCacheEntry([{ number: 1 }], { etag: "W/xyz" });
    const result = processConditionalResponse({ status: 304, body: "", headers: {} }, cached);
    assert.equal(result.notModified, true);
    assert.deepEqual(result.data, cached.data);
    assert.deepEqual(result.validators, cached.validators);
  });

  test("304 Not Modified with NO prior cache entry throws a contract-violation error, not a TypeError", () => {
    assert.throws(
      () => processConditionalResponse({ status: 304, body: "", headers: {} }, null),
      (err) => {
        assert.ok(err instanceof Error);
        assert.notEqual(err.constructor.name, "TypeError");
        assert.match(err.message, /304/);
        assert.match(err.message, /cache/i);
        return true;
      }
    );
  });

  test("304 Not Modified with undefined cache also throws the contract error", () => {
    assert.throws(() => processConditionalResponse({ status: 304, body: "", headers: {} }, undefined));
  });
});

describe("isBodyUnchanged", () => {
  test("true when the fresh body hashes to the cached bodyHash", () => {
    const body = JSON.stringify([{ number: 1 }]);
    const cached = { validators: { bodyHash: computeBodyHash(body) } };
    assert.equal(isBodyUnchanged(cached, body), true);
  });

  test("false when the fresh body differs", () => {
    const cached = { validators: { bodyHash: computeBodyHash("old") } };
    assert.equal(isBodyUnchanged(cached, "new"), false);
  });

  test("false when the cache carries no bodyHash", () => {
    assert.equal(isBodyUnchanged({ validators: {} }, "anything"), false);
    assert.equal(isBodyUnchanged(null, "anything"), false);
  });
});

describe("isCacheFresh", () => {
  test("true when within the TTL", () => {
    const entry = createCacheEntry([], {});
    assert.equal(isCacheFresh(entry, 60_000), true);
  });

  test("false when past the TTL", () => {
    const entry = { data: [], validators: {}, cachedAt: new Date(Date.now() - 10_000).toISOString() };
    assert.equal(isCacheFresh(entry, 5_000), false);
  });

  test("false with no cachedAt", () => {
    assert.equal(isCacheFresh({}, 60_000), false);
    assert.equal(isCacheFresh(null, 60_000), false);
  });
});
