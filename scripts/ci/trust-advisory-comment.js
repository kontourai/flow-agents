#!/usr/bin/env node
/**
 * Publish a Trust Verify advisory comment from a trusted workflow_run publisher.
 *
 * This helper is intentionally separate from Trust Verify. It reads only GitHub REST
 * resources for a completed run and its current pull request(s): it never checks out
 * code, downloads artifacts, or parses untrusted pull-request logs/output.
 */
'use strict';

const HTTP_TIMEOUT_MS = 10_000;
const MAX_PAGES = 5;
const PER_PAGE = 100;
const ACTIONS_BOT_LOGIN = 'github-actions[bot]';
const STATE_PREFIX = '<!-- flow-agents:trust-advisory-state ';
const STATE_SUFFIX = ' -->';

function apiUrl(apiBase, pathname) {
  return `${apiBase.replace(/\/$/, '')}${pathname}`;
}

async function request({ fetchImpl, apiBase, token, method, pathname, body, timeoutMs = HTTP_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(apiUrl(apiBase, pathname), {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub API ${method} ${pathname} failed (HTTP ${response.status})`);
    if (response.status === 204) return null;
    return response.json();
  } catch (error) {
    // Deliberately do not include headers or response bodies: either could carry a token
    // or provider-controlled detail. The method/path/status above is enough to diagnose.
    if (error && error.name === 'AbortError') {
      throw new Error(`GitHub API ${method} ${pathname} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function requireRunId(value) {
  const runId = Number(value);
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('TRUST_ADVISORY_RUN_ID must be a positive integer');
  return runId;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`completed workflow run did not include a positive ${label}`);
  return value;
}

function advisoryStateFor(run) {
  positiveInteger(run.workflow_id, 'workflow_id');
  if (typeof run.path !== 'string' || run.path.length === 0) {
    throw new Error('completed workflow run did not include its workflow path');
  }
  return {
    version: 1,
    workflow_id: run.workflow_id,
    workflow_path: run.path,
    run_id: positiveInteger(run.id, 'run id'),
    run_number: positiveInteger(run.run_number, 'run number'),
    run_attempt: positiveInteger(run.run_attempt, 'run attempt'),
  };
}

function markerFor(run) {
  // JSON is machine-readable state, not a best-effort textual label. Its workflow id
  // and path namespace comments, while its generation prevents an old completed run
  // from overwriting a newer result for the same PR revision.
  return `${STATE_PREFIX}${JSON.stringify(advisoryStateFor(run))}${STATE_SUFFIX}`;
}

function parseAdvisoryState(body) {
  if (typeof body !== 'string') return null;
  const start = body.indexOf(STATE_PREFIX);
  if (start === -1) return null;
  const end = body.indexOf(STATE_SUFFIX, start + STATE_PREFIX.length);
  if (end === -1) return null;
  try {
    const state = JSON.parse(body.slice(start + STATE_PREFIX.length, end));
    if (!state || state.version !== 1 || typeof state.workflow_path !== 'string' || state.workflow_path.length === 0) return null;
    positiveInteger(state.workflow_id, 'recorded workflow_id');
    positiveInteger(state.run_id, 'recorded run id');
    positiveInteger(state.run_number, 'recorded run number');
    positiveInteger(state.run_attempt, 'recorded run attempt');
    return state;
  } catch {
    return null;
  }
}

function compareGenerations(left, right) {
  for (const field of ['run_number', 'run_attempt', 'run_id']) {
    if (left[field] !== right[field]) return left[field] > right[field] ? 1 : -1;
  }
  return 0;
}

function runUrl(env, run) {
  if (typeof run.html_url === 'string' && run.html_url) return run.html_url;
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  return `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${run.id}`;
}

function buildCommentBody({ env, run, marker }) {
  const success = run.conclusion === 'success';
  const title = success ? '✅ Trust Verify resolved' : '⚠️ Trust Verify needs attention';
  const status = success
    ? 'The completed Trust Verify run passed. The prior informational warning is resolved.'
    : 'The completed Trust Verify run did not pass. Its diagnostic is available in the linked workflow run.';
  return `${marker}\n## ${title}\n\n${status}\n\nRevision: \`${run.head_sha}\`\n\n[Open the exact workflow run](${runUrl(env, run)})\n\n_This comment is informational; it never changes the Trust Verify verdict._`;
}

async function listPages({ fetchImpl, apiBase, token, pathname }) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const separator = pathname.includes('?') ? '&' : '?';
    const items = await request({
      fetchImpl, apiBase, token, method: 'GET',
      pathname: `${pathname}${separator}per_page=${PER_PAGE}&page=${page}`,
    });
    if (!Array.isArray(items)) throw new Error(`GitHub API ${pathname} response was not an array`);
    all.push(...items);
    if (items.length < PER_PAGE) return all;
  }
  throw new Error(`GitHub API ${pathname} exceeded the ${MAX_PAGES}-page safety limit`);
}

async function listWorkflowRuns({ fetchImpl, apiBase, token, pathname }) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const separator = pathname.includes('?') ? '&' : '?';
    const payload = await request({
      fetchImpl, apiBase, token, method: 'GET',
      pathname: `${pathname}${separator}per_page=${PER_PAGE}&page=${page}`,
    });
    if (!payload || !Number.isSafeInteger(payload.total_count) || payload.total_count < 0
      || !Array.isArray(payload.workflow_runs)) {
      throw new Error(`GitHub API ${pathname} response did not contain a valid workflow_runs page`);
    }
    all.push(...payload.workflow_runs);
    if (payload.workflow_runs.length < PER_PAGE) return all;
  }
  throw new Error(`GitHub API ${pathname} exceeded the ${MAX_PAGES}-page safety limit`);
}

async function findOwnedComment({ fetchImpl, apiBase, token, repository, pullNumber, state }) {
  const comments = await listPages({
    fetchImpl, apiBase, token,
    pathname: `/repos/${repository}/issues/${pullNumber}/comments`,
  });
  for (const comment of comments) {
    if (!comment.user || comment.user.type !== 'Bot' || comment.user.login !== ACTIONS_BOT_LOGIN) continue;
    const recorded = parseAdvisoryState(comment.body);
    if (recorded && recorded.workflow_id === state.workflow_id && recorded.workflow_path === state.workflow_path) {
      return { comment, state: recorded };
    }
  }
  return null;
}

async function findNewerCompletedGeneration({ fetchImpl, apiBase, token, repository, run, state }) {
  // GitHub does not guarantee that list order reflects the generation we need to
  // publish. Fetch bounded pages, filter to this exact head, then compare the explicit
  // run_number → run_attempt → run_id tuple ourselves.
  const candidates = await listWorkflowRuns({
    fetchImpl, apiBase, token,
    pathname: `/repos/${repository}/actions/workflows/${state.workflow_id}/runs?event=pull_request&status=completed&head_sha=${encodeURIComponent(run.head_sha)}`,
  });
  let newer = null;
  for (const candidate of candidates) {
    if (!candidate || candidate.event !== 'pull_request' || candidate.status !== 'completed') continue;
    if (candidate.head_sha !== run.head_sha) continue;
    const candidateState = advisoryStateFor(candidate);
    if (candidateState.workflow_id !== state.workflow_id) continue;
    if (compareGenerations(candidateState, state) > 0
      && (!newer || compareGenerations(candidateState, newer) > 0)) {
      newer = candidateState;
    }
  }
  return newer;
}

async function currentPullHead({ fetchImpl, apiBase, token, repository, pullNumber }) {
  return request({
    fetchImpl, apiBase, token, method: 'GET', pathname: `/repos/${repository}/pulls/${pullNumber}`,
  });
}

async function publishForPullRequest({ env, fetchImpl, apiBase, token, repository, run, pullNumber, state, marker }) {
  // Re-fetch the PR immediately before writing. Associated workflow-run PR data can
  // describe an earlier revision; only a current head matching the run is publishable.
  const pull = await currentPullHead({ fetchImpl, apiBase, token, repository, pullNumber });
  if (!pull || !pull.head || pull.head.sha !== run.head_sha) return { pullNumber, skipped: 'stale-head' };

  const existing = await findOwnedComment({ fetchImpl, apiBase, token, repository, pullNumber, state });
  const body = buildCommentBody({ env, run, marker });
  if (existing) {
    if (compareGenerations(state, existing.state) < 0) return { pullNumber, skipped: 'newer-generation' };
    const newerCompleted = await findNewerCompletedGeneration({ fetchImpl, apiBase, token, repository, run, state });
    if (newerCompleted) return { pullNumber, skipped: 'newer-completed-generation' };
    // Re-fetch immediately before mutating. A head can advance while comments are
    // paginated; the original lookup is never authorization to write a stale result.
    const latestPull = await currentPullHead({ fetchImpl, apiBase, token, repository, pullNumber });
    if (!latestPull || !latestPull.head || latestPull.head.sha !== run.head_sha) return { pullNumber, skipped: 'stale-head' };
    await request({
      fetchImpl, apiBase, token, method: 'PATCH',
      pathname: `/repos/${repository}/issues/comments/${existing.comment.id}`, body: { body },
    });
    return { pullNumber, action: 'updated', commentId: existing.comment.id };
  }
  if (run.conclusion === 'success') return { pullNumber, skipped: 'no-prior-warning' };
  const newerCompleted = await findNewerCompletedGeneration({ fetchImpl, apiBase, token, repository, run, state });
  if (newerCompleted) return { pullNumber, skipped: 'newer-completed-generation' };
  const latestPull = await currentPullHead({ fetchImpl, apiBase, token, repository, pullNumber });
  if (!latestPull || !latestPull.head || latestPull.head.sha !== run.head_sha) return { pullNumber, skipped: 'stale-head' };
  const created = await request({
    fetchImpl, apiBase, token, method: 'POST',
    pathname: `/repos/${repository}/issues/${pullNumber}/comments`, body: { body },
  });
  return { pullNumber, action: 'created', commentId: created && created.id };
}

async function publishTrustAdvisoryComment({ env = process.env, fetchImpl = global.fetch } = {}) {
  const token = env.TRUST_ADVISORY_TOKEN || '';
  if (!token) throw new Error('TRUST_ADVISORY_TOKEN is required');
  if (!env.GITHUB_REPOSITORY) throw new Error('GITHUB_REPOSITORY is required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');

  const repository = env.GITHUB_REPOSITORY;
  const apiBase = env.GITHUB_API_URL || 'https://api.github.com';
  const runId = requireRunId(env.TRUST_ADVISORY_RUN_ID);
  const run = await request({
    fetchImpl, apiBase, token, method: 'GET', pathname: `/repos/${repository}/actions/runs/${runId}`,
  });
  if (!run || run.event !== 'pull_request') return { skipped: 'not-pull-request-run' };
  if (run.status !== 'completed' || !run.conclusion) return { skipped: 'not-completed-run' };
  if (typeof run.head_sha !== 'string' || run.head_sha.length === 0) throw new Error('completed workflow run did not include head_sha');
  const state = advisoryStateFor(run);
  const marker = markerFor(run);

  const associatedPulls = await listPages({
    fetchImpl, apiBase, token,
    pathname: `/repos/${repository}/actions/runs/${runId}/pulls`,
  });
  const numbers = [...new Set(associatedPulls
    .map((pull) => pull && pull.number)
    .filter((number) => Number.isSafeInteger(number) && number > 0))];
  if (numbers.length === 0) return { skipped: 'no-associated-pull-request' };

  const results = [];
  for (const pullNumber of numbers) {
    results.push(await publishForPullRequest({
      env, fetchImpl, apiBase, token, repository, run, pullNumber, state, marker,
    }));
  }
  return { results };
}

async function main() {
  try {
    const outcome = await publishTrustAdvisoryComment();
    for (const result of outcome.results || []) {
      if (result.action) process.stdout.write(`[trust-advisory-comment] ${result.action} comment on PR #${result.pullNumber}\n`);
      if (result.skipped === 'stale-head') process.stdout.write(`[trust-advisory-comment] skipped stale workflow run for PR #${result.pullNumber}\n`);
    }
  } catch (error) {
    // This is a separate, non-required publisher: delivery failure must be visible and
    // red, while remaining incapable of changing the completed Trust Verify run itself.
    process.stderr.write(`[trust-advisory-comment] FAILED: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  ACTIONS_BOT_LOGIN,
  HTTP_TIMEOUT_MS,
  MAX_PAGES,
  advisoryStateFor,
  buildCommentBody,
  compareGenerations,
  findOwnedComment,
  findNewerCompletedGeneration,
  listWorkflowRuns,
  listPages,
  markerFor,
  parseAdvisoryState,
  publishTrustAdvisoryComment,
  request,
};
