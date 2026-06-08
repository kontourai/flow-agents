#!/usr/bin/env bash
set -euo pipefail

echo "Veritas policy failed"
echo "token=fixture-token-redaction-sentinel"
echo "api_key=fixture-api-key-redaction-sentinel"
for i in $(seq 1 40); do
  echo "detail line $i: this line should be bounded in the evidence sidecar"
done
exit 17
