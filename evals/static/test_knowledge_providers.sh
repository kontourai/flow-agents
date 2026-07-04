#!/usr/bin/env bash
# test_knowledge_providers.sh — Layer 1: Knowledge Store Provider contract
# conformance + provider-agnostic health verbs (issue #317).
#
# Runs the node:test suites that back AC1–AC3:
#   - providers/conformance/suite.test.js       (AC3: all three providers conform)
#   - providers/health/health-pass.test.js      (AC1: vault+git-repo reports;
#                                                 AC2: work-item seeded dupe + broken blocker)
#   - promote/promote.test.js                    (issue #313 knowledge promote sub-flow:
#                                                 AC1 draft delta+provenance, AC2 contradiction
#                                                 report+merge proposal, AC3 zero external writes)
#   - providers/neo4j/neo4j.test.js              (issue #327 neo4j provider, CI-safe: sync
#                                                 idempotency AC1, canonical queries AC3, degradation
#                                                 AC4 — via an injected fake driver, no Docker.
#                                                 Live Neo4j integration.test.js is gated on NEO4J_URI.)
# Deterministic, dependency-free, fixture-driven — never touches a real board.
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "── Knowledge store provider conformance + health + promote sub-flow (node --test) ──"

if node --test \
  kits/knowledge/providers/conformance/suite.test.js \
  kits/knowledge/providers/health/health-pass.test.js \
  kits/knowledge/promote/promote.test.js \
  kits/knowledge/providers/neo4j/neo4j.test.js; then
  echo "  PASS: knowledge store provider conformance + health verbs + promote sub-flow"
else
  echo "  FAIL: knowledge store provider conformance + health verbs + promote sub-flow"
  exit 1
fi
