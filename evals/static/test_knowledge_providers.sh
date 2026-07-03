#!/usr/bin/env bash
# test_knowledge_providers.sh — Layer 1: Knowledge Store Provider contract
# conformance + provider-agnostic health verbs (issue #317).
#
# Runs the node:test suites that back AC1–AC3:
#   - providers/conformance/suite.test.js       (AC3: all three providers conform)
#   - providers/health/health-pass.test.js      (AC1: vault+git-repo reports;
#                                                 AC2: work-item seeded dupe + broken blocker)
# Deterministic, dependency-free, fixture-driven — never touches a real board.
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "── Knowledge store provider conformance + health (node --test) ──"

if node --test \
  kits/knowledge/providers/conformance/suite.test.js \
  kits/knowledge/providers/health/health-pass.test.js; then
  echo "  PASS: knowledge store provider conformance + health verbs"
else
  echo "  FAIL: knowledge store provider conformance + health verbs"
  exit 1
fi
