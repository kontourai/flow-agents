#!/usr/bin/env bash
# test_trust_advisory_comment.sh — trusted workflow_run publisher fixtures.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELPER="$ROOT/scripts/ci/trust-advisory-comment.js"
errors=0

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; errors=$((errors + 1)); }

node - "$HELPER" "$ROOT" <<'NODE'
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const [,, helperPath, root] = process.argv;
const {
  ACTIONS_BOT_LOGIN, MAX_PAGES, advisoryStateFor, compareGenerations, findOwnedComment, listPages, listWorkflowRuns, markerFor,
  publishTrustAdvisoryComment, request,
} = require(helperPath);

const response = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const env = {
  GITHUB_REPOSITORY: 'kontourai/example', GITHUB_API_URL: 'https://api.example.test',
  GITHUB_SERVER_URL: 'https://github.example.test', TRUST_ADVISORY_TOKEN: 'never-print-this-token',
  TRUST_ADVISORY_RUN_ID: '900',
};
const run = (conclusion = 'failure') => ({
  id: 900, run_number: 12, run_attempt: 1,
  event: 'pull_request', status: 'completed', conclusion, head_sha: 'head-a',
  workflow_id: 77, path: '.github/workflows/trust-verify.yml',
  html_url: 'https://github.example.test/kontourai/example/actions/runs/900',
});
function route({ completedRun, workflowRuns = [completedRun], pullHead = 'head-a', comments = [] }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    calls.push({ pathname: parsed.pathname, search: parsed.search, init });
    if (parsed.pathname.endsWith('/actions/runs/900')) return response(200, completedRun);
    if (parsed.pathname.endsWith('/actions/workflows/77/runs')) return response(200, { total_count: workflowRuns.length, workflow_runs: workflowRuns });
    if (parsed.pathname.endsWith('/actions/runs/900/pulls')) return response(200, [{ number: 42 }]);
    if (parsed.pathname.endsWith('/pulls/42')) return response(200, { head: { sha: pullHead } });
    if (parsed.pathname.endsWith('/issues/42/comments') && init.method === 'GET') return response(200, comments);
    if (parsed.pathname.endsWith('/issues/42/comments') && init.method === 'POST') return response(201, { id: 9 });
    if (parsed.pathname.endsWith('/issues/comments/8') && init.method === 'PATCH') return response(200, { id: 8 });
    throw new Error(`unexpected API request ${init.method} ${parsed.pathname}${parsed.search}`);
  };
  return { calls, fetchImpl };
}

(async () => {
  // Failed run creates a warning from API metadata alone; no user identity or PR output is read.
  const failed = route({ completedRun: run('failure') });
  const failedResult = await publishTrustAdvisoryComment({ env, fetchImpl: failed.fetchImpl });
  assert.deepEqual(failedResult.results, [{ pullNumber: 42, action: 'created', commentId: 9 }]);
  const post = failed.calls.at(-1);
  assert.equal(post.init.method, 'POST');
  const body = JSON.parse(post.init.body).body;
  assert.match(body, /needs attention/);
  assert.match(body, /"workflow_id":77/);
  assert.match(body, /"workflow_path":"\.github\/workflows\/trust-verify\.yml"/);
  assert.match(body, /"run_id":900,"run_number":12,"run_attempt":1/);
  assert.match(body, /head-a/);
  assert.equal(failed.calls.some((call) => call.pathname === '/user'), false);
  assert.equal(failed.calls.some((call) => call.pathname.includes('/artifacts')), false);
  assert.match(failed.calls.find((call) => call.pathname.endsWith('/actions/workflows/77/runs')).search, /head_sha=head-a/);
  assert.throws(() => advisoryStateFor({ ...run('failure'), run_attempt: 0 }), /positive run attempt/);
  assert.equal(compareGenerations(
    { run_number: 12, run_attempt: 2, run_id: 1 },
    { run_number: 12, run_attempt: 1, run_id: 999 },
  ), 1);
  assert.equal(compareGenerations(
    { run_number: 12, run_attempt: 1, run_id: 2 },
    { run_number: 12, run_attempt: 1, run_id: 1 },
  ), 1);

  // Runs that are not completed pull_request workflows are rejected before any PR lookup.
  const nonPr = route({ completedRun: { ...run('failure'), event: 'push' } });
  assert.deepEqual(await publishTrustAdvisoryComment({ env, fetchImpl: nonPr.fetchImpl }), { skipped: 'not-pull-request-run' });
  assert.equal(nonPr.calls.length, 1);
  const incomplete = route({ completedRun: { ...run('failure'), status: 'in_progress', conclusion: null } });
  assert.deepEqual(await publishTrustAdvisoryComment({ env, fetchImpl: incomplete.fetchImpl }), { skipped: 'not-completed-run' });
  assert.equal(incomplete.calls.length, 1);

  // A matching bot-owned marker updates in place on success; a clean first success does not post.
  const marker = markerFor(run('success'));
  const resolved = route({ completedRun: run('success'), comments: [
    { id: 1, body: marker, user: { login: ACTIONS_BOT_LOGIN, type: 'User' } },
    { id: 8, body: marker, user: { login: ACTIONS_BOT_LOGIN, type: 'Bot' } },
  ] });
  const resolvedResult = await publishTrustAdvisoryComment({ env, fetchImpl: resolved.fetchImpl });
  assert.deepEqual(resolvedResult.results, [{ pullNumber: 42, action: 'updated', commentId: 8 }]);
  assert.match(JSON.parse(resolved.calls.at(-1).init.body).body, /resolved/);
  const clean = route({ completedRun: run('success') });
  assert.deepEqual((await publishTrustAdvisoryComment({ env, fetchImpl: clean.fetchImpl })).results, [{ pullNumber: 42, skipped: 'no-prior-warning' }]);
  assert.equal(clean.calls.some((call) => call.init.method === 'POST'), false);

  // An older success cannot erase a newer same-head failure; generation ordering is
  // run_number, then run_attempt, then immutable run id.
  const newerFailure = { ...run('failure'), id: 1300, run_number: 13, run_attempt: 1 };
  const olderSuccess = { ...run('success'), id: 1201, run_number: 12, run_attempt: 2 };
  const outOfOrder = route({ completedRun: olderSuccess, comments: [
    { id: 13, body: markerFor(newerFailure), user: { login: ACTIONS_BOT_LOGIN, type: 'Bot' } },
  ] });
  assert.deepEqual((await publishTrustAdvisoryComment({ env, fetchImpl: outOfOrder.fetchImpl })).results, [{ pullNumber: 42, skipped: 'newer-generation' }]);
  assert.equal(outOfOrder.calls.some((call) => call.init.method === 'PATCH'), false);

  // A newer clean success leaves no comment of its own. The immutable workflow-runs
  // lookup still blocks an older failure from creating a stale warning on this head.
  const newerSuccess = { ...run('success'), id: 1400, run_number: 14, run_attempt: 1 };
  const olderFailure = { ...run('failure'), id: 1301, run_number: 13, run_attempt: 2 };
  const cleanThenOlderFailure = route({
    completedRun: olderFailure,
    workflowRuns: [olderFailure, newerSuccess],
  });
  assert.deepEqual(
    (await publishTrustAdvisoryComment({ env, fetchImpl: cleanThenOlderFailure.fetchImpl })).results,
    [{ pullNumber: 42, skipped: 'newer-completed-generation' }],
  );
  assert.equal(cleanThenOlderFailure.calls.some((call) => call.init.method === 'POST'), false);

  // A newer PR head makes even a completed failed run stale; it cannot write or resolve.
  const stale = route({ completedRun: run('failure'), pullHead: 'head-b' });
  assert.deepEqual((await publishTrustAdvisoryComment({ env, fetchImpl: stale.fetchImpl })).results, [{ pullNumber: 42, skipped: 'stale-head' }]);
  assert.equal(stale.calls.some((call) => call.pathname.includes('/comments')), false);

  // The head may advance after the comment search. The final re-fetch prevents a POST.
  let headReads = 0;
  const advancing = [];
  const advancingFetch = async (url, init) => {
    const parsed = new URL(url);
    advancing.push({ pathname: parsed.pathname, init });
    if (parsed.pathname.endsWith('/actions/runs/900')) return response(200, run('failure'));
    if (parsed.pathname.endsWith('/actions/workflows/77/runs')) return response(200, { total_count: 1, workflow_runs: [run('failure')] });
    if (parsed.pathname.endsWith('/actions/runs/900/pulls')) return response(200, [{ number: 42 }]);
    if (parsed.pathname.endsWith('/pulls/42')) return response(200, { head: { sha: headReads++ === 0 ? 'head-a' : 'head-b' } });
    if (parsed.pathname.endsWith('/issues/42/comments')) return response(200, []);
    throw new Error(`unexpected API request ${init.method} ${parsed.pathname}`);
  };
  assert.deepEqual((await publishTrustAdvisoryComment({ env, fetchImpl: advancingFetch })).results, [{ pullNumber: 42, skipped: 'stale-head' }]);
  assert.equal(advancing.some((call) => call.init.method === 'POST'), false);

  // Comment search paginates and cannot mutate an unowned marker.
  let page = 0;
  const paged = await findOwnedComment({
    apiBase: env.GITHUB_API_URL, token: env.TRUST_ADVISORY_TOKEN,
    repository: env.GITHUB_REPOSITORY, pullNumber: 42, state: advisoryStateFor(run('success')),
    fetchImpl: async (url) => {
      const current = new URL(url).searchParams.get('page');
      page += 1;
      if (current === '1') return response(200, Array.from({ length: 100 }, (_, id) => ({ id, body: marker, user: { login: 'other-bot[bot]', type: 'Bot' } })));
      return response(200, [{ id: 101, body: marker, user: { login: ACTIONS_BOT_LOGIN, type: 'Bot' } }]);
    },
  });
  assert.equal(paged.comment.id, 101);
  assert.equal(page, 2);

  // HTTP failure is propagated to make the separate publisher visibly red, without token disclosure.
  await assert.rejects(
    () => publishTrustAdvisoryComment({ env, fetchImpl: async () => response(403, { message: 'ignored' }) }),
    (error) => /HTTP 403/.test(error.message) && !error.message.includes(env.TRUST_ADVISORY_TOKEN),
  );

  // Each request is abort-bounded, and pagination cannot become an unbounded API walk.
  await assert.rejects(
    () => request({ apiBase: env.GITHUB_API_URL, token: env.TRUST_ADVISORY_TOKEN, method: 'GET', pathname: '/slow', timeoutMs: 1,
      fetchImpl: async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) }),
    /timed out after 1ms/,
  );
  await assert.rejects(
    () => listPages({ apiBase: env.GITHUB_API_URL, token: env.TRUST_ADVISORY_TOKEN, pathname: '/many',
      fetchImpl: async () => response(200, Array.from({ length: 100 }, () => ({}))) }),
    new RegExp(`exceeded the ${MAX_PAGES}-page safety limit`),
  );
  const workflowRuns = await listWorkflowRuns({
    apiBase: env.GITHUB_API_URL, token: env.TRUST_ADVISORY_TOKEN, pathname: '/workflow-runs',
    fetchImpl: async () => response(200, { total_count: 1, workflow_runs: [run('success')] }),
  });
  assert.equal(workflowRuns.length, 1);
  await assert.rejects(
    () => listWorkflowRuns({
      apiBase: env.GITHUB_API_URL, token: env.TRUST_ADVISORY_TOKEN, pathname: '/workflow-runs',
      fetchImpl: async () => response(200, { total_count: 1, workflow_runs: {} }),
    }),
    /valid workflow_runs page/,
  );

  const trustAction = fs.readFileSync(path.join(root, '.github/actions/trust-verify/action.yml'), 'utf8');
  const publisherAction = fs.readFileSync(path.join(root, '.github/actions/trust-advisory-comment/action.yml'), 'utf8');
  const adoption = fs.readFileSync(path.join(root, 'docs/trust-anchor-adoption.md'), 'utf8');
  assert.equal(/pr-comment-token|trust-pr-comment\.js/.test(trustAction), false);
  assert.match(publisherAction, /workflow-run-id/);
  assert.match(publisherAction, /trust-advisory-comment\.js/);
  assert.equal(/uses:\s*actions\/checkout|download-artifact/i.test(publisherAction), false);
  assert.match(adoption, /workflow_run:/);
  assert.match(adoption, /actions: read/);
  assert.match(adoption, /pull-requests: write/);
  assert.match(adoption, /No actions\/checkout step belongs/);
  assert.match(adoption, /trust-advisory-comment\.yml  @your-org\/owners/);
  assert.match(adoption, /group: trust-advisory-\$\{\{ github\.event\.workflow_run\.workflow_id \}\}-\$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
})().then(() => process.exit(0)).catch((error) => { console.error(error.stack); process.exit(1); });
NODE
if [[ $? -eq 0 ]]; then pass "trusted workflow_run create/update/stale, ownership, bounds, API failure, and adoption contract"; else fail "trusted workflow_run publisher contract"; fi

# A publisher delivery failure must be visibly red and must not print its token.
out=$(GITHUB_REPOSITORY=kontourai/example TRUST_ADVISORY_TOKEN=never-print-this-token node "$HELPER" 2>&1)
exit_code=$?
if [[ $exit_code -eq 1 ]] && grep -q '\[trust-advisory-comment\] FAILED:' <<<"$out" && ! grep -q 'never-print-this-token' <<<"$out"; then
  pass "separate publisher fails visibly without token disclosure"
else
  fail "visible publisher failure/token safety"
fi

if [[ $errors -eq 0 ]]; then
  echo "PASS: Trust advisory comment integration"
  exit 0
fi
echo "FAIL: $errors Trust advisory comment check(s) failed"
exit 1
