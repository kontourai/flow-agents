import { createHash } from "node:crypto";
import type { AuthorizationLedger } from "@kontourai/dispatch";
import { delegationIdV2 } from "./delegation-authority-contract.js";
import { createDelegationAuthorityService, DelegationAdmissionError, type DelegationInvocationAmounts } from "./delegation-authority-service.js";
import { executeAuthorizedDelegation, type DelegationExecutionHost } from "./delegation-execution.js";

export interface DelegationSyncReceipt {
  runId: string;
  envelopeId: string;
  contentDigest: string;
  attempts: number;
  status: "acknowledged" | "incomplete";
  reason: "exact_ack" | "ack_mismatch" | "unexpected_tools" | "execution_incomplete";
}

export class DelegationSyncExecutionError extends Error {
  constructor(readonly receipt: DelegationSyncReceipt, cause: unknown) {
    super("Delegation context sync incomplete", { cause });
    this.name = "DelegationSyncExecutionError";
  }
}

export class DelegationSyncReceiptPersistenceError extends Error {
  readonly receipt: DelegationSyncReceipt;
  constructor(receipt: DelegationSyncReceipt, cause: unknown) {
    super("Delegation sync receipt persistence failed", { cause });
    this.name = "DelegationSyncReceiptPersistenceError";
    this.receipt = structuredClone(receipt);
  }
  /** Storage-only recovery: never redispatches a model invocation. */
  async retryRetention(host: { retainSyncReceipt(receipt: DelegationSyncReceipt): Promise<void> }): Promise<DelegationSyncReceipt> {
    await host.retainSyncReceipt(structuredClone(this.receipt));
    return structuredClone(this.receipt);
  }
}

/** Model acknowledgement only: this neither grants tools nor proves semantic understanding. */
export async function syncDelegationContext(input: {
  service: ReturnType<typeof createDelegationAuthorityService>;
  host: DelegationExecutionHost & { retainSyncReceipt(receipt: DelegationSyncReceipt): Promise<void> };
  dispatchLedger: AuthorizationLedger;
  authorityId: string;
  envelopeId: string;
  runId: string;
  text: string;
  allocation: DelegationInvocationAmounts;
  maxOutputTokens: number;
  signal?: AbortSignal;
}): Promise<DelegationSyncReceipt> {
  delegationIdV2(input.runId);
  if (typeof input.text !== "string" || Buffer.byteLength(input.text) > 64 * 1024) throw new Error("Context sync exceeds its text bound");
  const { envelope } = await input.service.admitEffect(input.authorityId, input.envelopeId, "context-sync");
  if (envelope.execution_authority.allowed_tools.length !== 0) throw new Error("Context sync requires explicit no-tools execution authority");
  const contentDigest = `sha256:${createHash("sha256").update(input.text).digest("hex")}`;
  const identity = createHash("sha256").update(JSON.stringify([input.authorityId, input.envelopeId, input.runId, contentDigest])).digest("hex");
  let reason: DelegationSyncReceipt["reason"] = "execution_incomplete";
  let attempts = 0;
  let executionFailure: unknown;
  try {
  for (let attempt = 0; attempt < 2; attempt++) {
    input.signal?.throwIfAborted();
    attempts++;
    const outcome = await executeAuthorizedDelegation({
      ...input,
      invocationId: `sync_${identity}_${attempt}`,
      effect: "context-sync",
      request: {
        messages: [
          { role: "system", content: `Receive context only. Do not call tools. Reply exactly ACK SYNC ${input.runId}` },
          { role: "user", content: input.text },
        ],
        tools: [],
        maxOutputTokens: input.maxOutputTokens,
      },
    });
    if (outcome.outcome !== "succeeded" || !outcome.result) { reason = "execution_incomplete"; break; }
    if (outcome.result.toolCalls.length !== 0) reason = "unexpected_tools";
    else if (outcome.result.outputText !== `ACK SYNC ${input.runId}`) reason = "ack_mismatch";
    else { reason = "exact_ack"; break; }
    // Only a completed, reconciled response reaches this bounded retry.
  }
  } catch (error) {
    if (attempts === 0 || (error instanceof DelegationAdmissionError && error.code === "invocation_already_reserved")) throw error;
    executionFailure = error;
    reason = "execution_incomplete";
  }
  const receipt: DelegationSyncReceipt = {
    runId: input.runId, envelopeId: input.envelopeId, contentDigest, attempts,
    status: reason === "exact_ack" ? "acknowledged" : "incomplete", reason,
  };
  try { await input.host.retainSyncReceipt(structuredClone(receipt)); }
  catch (error) { throw new DelegationSyncReceiptPersistenceError(receipt, error); }
  if (executionFailure) throw new DelegationSyncExecutionError(structuredClone(receipt), executionFailure);
  return receipt;
}
