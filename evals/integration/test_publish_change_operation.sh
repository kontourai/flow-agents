#!/usr/bin/env bash
# Canonical, credential-free regression for the public publish-change operation.
# The exercised tests create their own fake gh executable and never contact GitHub.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

flow_agents_build_ts

# This is the public-command composition: it advances a real canonical Builder
# run through an existing exact fake-gh PR, without accepting a caller result.
# The adjacent transaction tests prove canonical request binding, stale-action
# rejection before provider execution, result-file no-follow handling, secret
# redaction, retry single attachment, and isolated pull-request-opened
# attachment before the adapter matrix runs.
node --test \
  --test-name-pattern='configured ChangeProvider projects|Flow completion authenticates|Flow completion accepts a terminal merged|publish-change rejects symlinked|stale publish-change actions|simultaneous publish-change recovery|provider failures cannot leak|in-process publish-change composition|public publish-change ignores' \
  src/cli/builder-flow-runtime.test.mjs

# Adapter coverage supplies the deterministic fake-provider matrix: exact argv,
# authenticated observation, create/recover/no-duplicate behavior, stale/wrong
# observations, malformed output, provider failure, and auth failure.
node --test src/cli/change-provider.test.mjs src/cli/github-change-provider.test.mjs

echo 'Publish-change operation integration checks passed'
