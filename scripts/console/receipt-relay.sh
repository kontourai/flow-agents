#!/usr/bin/env bash
# receipt-relay.sh — console receipt relay (#1087 slice B, decision:
# docs/decisions/console-record-delivery.md).
#
# Mirrors ONE recorded receipt — a gate claim, critique, evidence record, or
# release — to the hosted Console as a `kontour.console.event`, over the SAME
# transport core the telemetry mirror and the liveness relay use (endpoint-allow
# gate, Bearer + tenant auth, timeouts).
#
# Unlike scripts/liveness/relay.sh, this uses the AT-LEAST-ONCE mode
# (`console_post_json_durable`), because the two carry different risk. A missed
# liveness heartbeat self-corrects on TTL; a missed receipt is a hole in an
# audit trail, and an invisible one — nothing distinguishes "no verdict was
# recorded" from "the verdict was lost". So the record is queued to a durable
# outbox BEFORE any send is attempted, and a later run delivers what an outage
# dropped.
#
# STRICTLY OPTIONAL and local-first: a no-op unless a console endpoint is
# configured. Invoked fully detached, AFTER the durable local bundle write that
# already happened — it must NEVER block, slow, or fail that write. Every
# failure path is a quiet `exit 0`.
#
# Usage: receipt-relay.sh '<receipt-event-json>'
set -uo pipefail

RECEIPT_JSON="${1:-}"
[[ -z "$RECEIPT_JSON" ]] && exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 0
# scripts/console/ -> scripts/telemetry (same relative layout in dist/* bundles).
TELEMETRY_DIR="${TELEMETRY_DIR:-$(cd "$SCRIPT_DIR/../telemetry" 2>/dev/null && pwd)}" || exit 0
[[ -z "$TELEMETRY_DIR" || ! -d "$TELEMETRY_DIR" ]] && exit 0
export TELEMETRY_DIR

# config.sh is the authoritative, trust-gated resolver for the endpoint, token
# and tenant — the same resolution the rest of the pipeline uses. Sourcing it
# here rather than trusting the caller's environment is what keeps an untrusted
# conf from becoming an exfil path.
# shellcheck source=/dev/null
source "$TELEMETRY_DIR/lib/config.sh" 2>/dev/null || exit 0
# shellcheck source=/dev/null
source "$TELEMETRY_DIR/lib/transport.sh" 2>/dev/null || exit 0

CONSOLE_URL="${CONSOLE_TELEMETRY_URL:-}"
[[ -z "$CONSOLE_URL" ]] && exit 0
[[ -z "${CONSOLE_TELEMETRY_TOKEN:-}" ]] && exit 0

# Receipts ride the records plane (cross-product events and projections), never
# the telemetry plane (cost/usage analytics) — different scope, different store.
ENDPOINT="${CONSOLE_URL%/}/records"

# Build the console record. The id is derived from the receipt's own identity so
# repeated delivery is idempotent against /records' upsert on
# (tenant_id, record_id) — which is exactly what makes at-least-once safe.
RECORD_AND_ID="$(printf '%s' "$RECEIPT_JSON" | node -e '
  let raw = "";
  process.stdin.on("data", (d) => { raw += d; });
  process.stdin.on("end", () => {
    let receipt;
    try {
      receipt = JSON.parse(raw);
    } catch {
      process.exit(1);
    }
    const session = String(receipt.session ?? "");
    const kind = String(receipt.kind ?? "");
    const revision = String(receipt.revision ?? "");
    if (!session || !kind || !revision) process.exit(1);
    // Stable, content-derived id: the same receipt re-sent after an outage
    // upserts onto itself instead of duplicating.
    const id = `receipt:${session}:${kind}:${revision}`;
    // id first, then the record, from ONE parse. Deriving the id a second time
    // from $RECORD would add an independent failure surface: an empty id makes
    // console_outbox_enqueue silently no-op, dropping the receipt with no
    // queueing and no warning — in the one script whose entire job is not
    // doing that.
    process.stdout.write(id + "\n");
    process.stdout.write(JSON.stringify({
      schema: "kontour.console.event",
      version: "1",
      id,
      type: `workflow.receipt.${kind}`,
      occurredAt: receipt.occurredAt ?? new Date().toISOString(),
      subject: { kind: "workflow", id: session },
      producer: { id: "flow-agents", kind: "kit" },
      payload: {
        kind,
        revision,
        session,
        summary: receipt.summary ?? undefined,
      },
    }));
  });
' 2>/dev/null)" || exit 0
[[ -z "$RECORD_AND_ID" ]] && exit 0

# At-least-once: durable enqueue first, then a detached flush.
RECORD_ID="$(printf '%s' "$RECORD_AND_ID" | sed -n '1p')"
RECORD="$(printf '%s' "$RECORD_AND_ID" | sed -n '2,$p')"
[[ -z "$RECORD_ID" || -z "$RECORD" ]] && exit 0

console_post_json_durable "$ENDPOINT" "$RECORD" "$RECORD_ID" 2>/dev/null

exit 0
