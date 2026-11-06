import type { MemoryRoutingDecision } from "@kontourai/flow-agents/memory-routing";
import { encodeEnvelope } from "@kontourai/flow-agents/memory-envelope";

declare const decision: MemoryRoutingDecision;
declare const args: Omit<Parameters<typeof encodeEnvelope>[0], "decision">;
encodeEnvelope({ ...args, decision });
