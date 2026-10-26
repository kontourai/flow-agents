import { createHash } from "node:crypto";
import { canonicalJson } from "@kontourai/relay";

export function dispatchAuthorizationIdentity(authorityId: string, executionId: string, invocationId: string) {
  const digest = createHash("sha256").update(canonicalJson([authorityId, executionId, invocationId])).digest("hex");
  return { id: `auth_${digest}`, invocationId: `invoke_${digest}` };
}
