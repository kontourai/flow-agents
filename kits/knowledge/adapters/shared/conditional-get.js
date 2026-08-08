/**
 * Conditional GET / cache validation utilities.
 *
 * Generic pattern for HTTP cache revalidation (ETag / Last-Modified).
 * Used by providers that support conditional requests to avoid full body transfer
 * when the cached representation is still current.
 *
 * Pattern (from traverse's http-validators decision):
 * - Store validators (etag, lastModified) with cached response
 * - On re-fetch, send If-None-Match / If-Modified-Since
 * - 304 Not Modified → return cached data + notModified: true
 * - No validators → normal fetch + sha256 body-hash compare (fallback)
 */

import { createHash } from "node:crypto";

/**
 * Build conditional request headers from stored validators.
 * @param {{ etag?: string, lastModified?: string }} validators
 * @returns {Record<string, string>}
 */
export function buildConditionalHeaders(validators) {
  const headers = {};
  if (validators?.etag) headers["If-None-Match"] = validators.etag;
  if (validators?.lastModified) headers["If-Modified-Since"] = validators.lastModified;
  return headers;
}

/**
 * Compute sha256 hash of body for fallback drift detection.
 * @param {string|Buffer} body
 * @returns {string}
 */
export function computeBodyHash(body) {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Process a conditional GET response.
 *
 * @param {Object} response - Raw response from fetch/runner
 * @param {number} response.status - HTTP status code
 * @param {string|Buffer} response.body - Response body
 * @param {Object} response.headers - Response headers
 * @param {Object} cached - Prior cached state
 * @param {any} cached.data - Cached data
 * @param {{ etag?: string, lastModified?: string, bodyHash?: string }} cached.validators
 * @returns {{ data: any, notModified: boolean, validators: { etag?, lastModified?, bodyHash? } }}
 */
export function processConditionalResponse(response, cached) {
  // 304 Not Modified: return cached data, no body transfer
  if (response.status === 304) {
    return {
      data: cached.data,
      notModified: true,
      validators: cached.validators,
    };
  }

  // 200 OK: extract new validators + compute body hash
  const headers = response.headers || {};
  const newValidators = {
    etag: headers.etag || headers["ETag"],
    lastModified: headers["last-modified"] || headers["Last-Modified"],
    bodyHash: computeBodyHash(response.body),
  };

  // Fallback: if no validators, body hash is the drift signal
  const data = typeof response.body === "string" ? JSON.parse(response.body) : response.body;

  return {
    data,
    notModified: false,
    validators: newValidators,
  };
}

/**
 * Check if cached data is still valid via body hash compare (no validators path).
 * @param {Object} cached - Cached state with validators.bodyHash
 * @param {string|Buffer} freshBody - Freshly fetched body
 * @returns {boolean} true if byte-identical
 */
export function isBodyUnchanged(cached, freshBody) {
  if (!cached?.validators?.bodyHash) return false;
  return cached.validators.bodyHash === computeBodyHash(freshBody);
}

/**
 * Create a cache entry with data + validators.
 * @template T
 * @param {T} data
 * @param {{ etag?: string, lastModified?: string, bodyHash?: string }} validators
 * @returns {{ data: T, validators, cachedAt: string }}
 */
export function createCacheEntry(data, validators) {
  return {
    data,
    validators,
    cachedAt: new Date().toISOString(),
  };
}

/**
 * Determine if cache is fresh (within TTL).
 * @param {{ cachedAt: string }} cacheEntry
 * @param {number} ttlMs - Time-to-live in milliseconds
 * @returns {boolean}
 */
export function isCacheFresh(cacheEntry, ttlMs) {
  if (!cacheEntry?.cachedAt) return false;
  const ageMs = Date.now() - new Date(cacheEntry.cachedAt).getTime();
  return ageMs < ttlMs;
}

export default {
  buildConditionalHeaders,
  computeBodyHash,
  processConditionalResponse,
  isBodyUnchanged,
  createCacheEntry,
  isCacheFresh,
};