#!/usr/bin/env bash
# CI wrapper: the demo itself performs its hard assertions and leaves the
# fixture report behind for its process lifetime / CI artifact collection.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bash "$ROOT/evals/demo/effectiveness-loop/run.sh"
