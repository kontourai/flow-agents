#!/usr/bin/env bash
# eval-report.sh — Generate markdown eval report from promptfoo JSON output
# Usage: bash lib/eval-report.sh <results-json> [previous-json]
# Output: markdown report to stdout
set -uo pipefail

RESULTS="${1:?Usage: bash lib/eval-report.sh <results.json> [previous.json]}"
PREVIOUS="${2:-}"

if [[ ! -f "$RESULTS" ]]; then
  echo "Error: Results file not found: $RESULTS" >&2
  exit 1
fi

AGENT=$(basename "$RESULTS" | sed 's/-[0-9].*$//')
DATE=$(date +%Y-%m-%d)

# Extract stats via jq
TOTAL=$(jq '.results.results | length' "$RESULTS")
PASSED=$(jq '[.results.results[] | select(.success == true)] | length' "$RESULTS")
FAILED=$((TOTAL - PASSED))
PASS_RATE=$(echo "scale=0; $PASSED * 100 / $TOTAL" | bc 2>/dev/null || echo "N/A")

# Check for repeat data
REPEAT=$(jq -r '.results.stats.repeatCount // 0' "$RESULTS" 2>/dev/null || echo "0")

cat <<EOF
# Eval Report: ${AGENT} — ${DATE}

## Summary
- Cases: ${TOTAL} total
- Passed: ${PASSED}/${TOTAL} (${PASS_RATE}%)
- Failed: ${FAILED}
EOF

if [[ "$REPEAT" -gt 1 ]]; then
  echo "- Repeat count: ${REPEAT} (pass@k computed per case)"
fi

echo ""
echo "## Results"
echo "| # | Prompt (truncated) | Pass | Assertions |"
echo "|---|-------------------|------|------------|"

jq -r '.results.results | to_entries[] | "\(.key + 1)|\(.value.vars.prompt // "N/A" | .[0:50])|\(.value.success)|\(.value.gradingResult.componentResults // [] | length) checked"' "$RESULTS" 2>/dev/null | \
while IFS='|' read -r num prompt pass asserts; do
  icon=$([[ "$pass" == "true" ]] && echo "✓" || echo "✗")
  echo "| ${num} | ${prompt} | ${icon} | ${asserts} |"
done

# Failures section
if [[ "$FAILED" -gt 0 ]]; then
  echo ""
  echo "## Failures"
  jq -r '.results.results | to_entries[] | select(.value.success == false) | "### Case \(.key + 1): \(.value.vars.prompt // "N/A" | .[0:60])\n- Failing assertions: \([.value.gradingResult.componentResults[]? | select(.pass == false) | .assertion.type // "unknown" | select(.pass == false) | .assertion.type // "unknown"] | join(", "))\n"' "$RESULTS" 2>/dev/null
fi

# Trend comparison
if [[ -n "$PREVIOUS" && -f "$PREVIOUS" ]]; then
  PREV_PASSED=$(jq '[.results.results[] | select(.success == true)] | length' "$PREVIOUS")
  PREV_TOTAL=$(jq '.results.results | length' "$PREVIOUS")
  echo ""
  echo "## Trend"
  echo "- Previous: ${PREV_PASSED}/${PREV_TOTAL}"
  echo "- Current:  ${PASSED}/${TOTAL}"
  if [[ "$PASSED" -gt "$PREV_PASSED" ]]; then
    echo "- Direction: ↑ improved"
  elif [[ "$PASSED" -lt "$PREV_PASSED" ]]; then
    echo "- Direction: ↓ regressed"
  else
    echo "- Direction: → stable"
  fi
fi
