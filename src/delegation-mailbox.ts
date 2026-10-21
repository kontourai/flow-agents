import { createHash } from "node:crypto";
import { containsSensitiveCredential, validateRunCorrelationEnvelope, validateRunCorrelationPresence, type RunCorrelationPresence } from "./run-correlation.js";
import { workItemSlug } from "./lib/work-item-identity.js";

export const MAILBOX_MAX_PAYLOAD_BYTES = 4096;
export const MAILBOX_MAX_OPERATIONS = 256;
export const MAILBOX_MAX_LIFETIME_MS = 60 * 60 * 1000;
export type MailboxKind = "scope_conflict" | "dependency_question" | "handoff_offer" | "unblock_request" | "ack" | "decline" | "redirect";

/** All generations are exact host-issued identities, never inferred from correlation. */
export type MailboxIdentity = {
  groupId: string;
  groupGeneration: number;
  controllerActorKey: string;
  controllerGeneration: number;
  memberId: string;
  memberGeneration: number;
  assignmentId: string;
  assignmentGeneration: number;
  actorKey: string;
};
export type MailboxMessageIntent = {
  schemaVersion: "1.0";
  messageId: string;
  operationId: string;
  exchangeId: string;
  subjectId: string;
  resourceScope: string[];
  sender: MailboxIdentity;
  recipient: MailboxIdentity;
  correlation: RunCorrelationPresence;
  kind: MailboxKind;
  inReplyTo: string | null;
  createdAt: string;
  expiresAt: string;
  payload: { summary: string; evidenceRefs: string[]; outputRefs: string[] };
};
/** Provenance-bearing data only; acknowledgement carries no semantic acceptance. */
export type MailboxMessage = MailboxMessageIntent & { intentDigest: string };
export type MailboxOperation = { message: MailboxMessage; status: "pending" | "delivered" | "acknowledged" };
export type MailboxHostDecision = { status: "current" } | { status: "unavailable" | "refused" };
/**
 * The host authenticates caller and checks BOTH message participants against live
 * assignment, member, controller, liveness and cancellation state for each call.
 * A current response must cover the whole observation, not just an actor key.
 */
export type MailboxHostValidator = (observation: {
  action: "send" | "deliver" | "read" | "ack" | "cancel";
  caller: MailboxIdentity;
  message?: MailboxMessage;
}) => MailboxHostDecision | Promise<MailboxHostDecision>;
export type MailboxResult<T> = { status: "ok"; value: T } | { status: "unavailable" | "refused"; code: string };

const identityKeys = ["groupId", "groupGeneration", "controllerActorKey", "controllerGeneration", "memberId", "memberGeneration", "assignmentId", "assignmentGeneration", "actorKey"];
const intentKeys = ["schemaVersion", "messageId", "operationId", "exchangeId", "subjectId", "resourceScope", "sender", "recipient", "correlation", "kind", "inReplyTo", "createdAt", "expiresAt", "payload"];
const requests = new Set<MailboxKind>(["scope_conflict", "dependency_question", "handoff_offer", "unblock_request"]);
const responses = new Set<MailboxKind>(["ack", "decline", "redirect"]);

export class MailboxValidationError extends Error {
  constructor() { super("Invalid closed delegation mailbox record"); this.name = "MailboxValidationError"; }
}
function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new MailboxValidationError();
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function closed(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  requireValid(record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
}
function identifier(value: unknown): boolean {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@#-]{0,254}$/.test(value) && !containsSensitiveCredential(value);
}
function subject(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 255 || containsSensitiveCredential(value)) return false;
  if (identifier(value)) return true;
  if (value.split("/").some((part) => part === "." || part === "..")) return false;
  try { workItemSlug(value); return true; } catch { return false; }
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function refs(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 16 && value.every(identifier) && new Set(value).size === value.length;
}
export function validateMailboxIdentity(value: unknown): MailboxIdentity {
  canonicalMailboxJson(value);
  closed(value, identityKeys);
  for (const key of identityKeys) {
    if (key.endsWith("Generation")) requireValid(Number.isSafeInteger(value[key]) && Number(value[key]) >= 0);
    else requireValid(identifier(value[key]));
  }
  return structuredClone(value) as MailboxIdentity;
}
export function canonicalMailboxJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown, depth: number): string {
    requireValid(depth <= 32);
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") {
      requireValid(Number.isFinite(item) && !Object.is(item, -0));
      return JSON.stringify(item);
    }
    requireValid(typeof item === "object" && item !== null && !ancestors.has(item));
    const array = Array.isArray(item);
    requireValid(Object.getPrototypeOf(item) === (array ? Array.prototype : Object.prototype) || (!array && Object.getPrototypeOf(item) === null));
    const keys = Reflect.ownKeys(item);
    if (array) requireValid(item.length <= MAILBOX_MAX_OPERATIONS && keys.length === item.length + 1 && Array.from({ length: item.length }, (_, index) => Object.hasOwn(item, index)).every(Boolean));
    for (const key of keys) {
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      requireValid(typeof key === "string" && descriptor.enumerable && Object.hasOwn(descriptor, "value"));
    }
    ancestors.add(item);
    const encoded = array
      ? `[${item.map((entry) => encode(entry, depth + 1)).join(",")}]`
      : `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
    ancestors.delete(item);
    return encoded;
  }
  return encode(value, 0);
}
export function sameMailboxIdentity(left: MailboxIdentity, right: MailboxIdentity): boolean {
  return canonicalMailboxJson(left) === canonicalMailboxJson(right);
}
export function mailboxGroupKey(identity: MailboxIdentity): string {
  return canonicalMailboxJson([identity.groupId, identity.groupGeneration, identity.controllerActorKey, identity.controllerGeneration]);
}
export function isMailboxRequest(kind: MailboxKind): boolean { return requests.has(kind); }

function validateIntent(value: unknown): MailboxMessageIntent {
  canonicalMailboxJson(value);
  closed(value, intentKeys);
  requireValid(value.schemaVersion === "1.0");
  for (const key of ["messageId", "operationId", "exchangeId"]) requireValid(identifier(value[key]));
  requireValid(subject(value.subjectId));
  const sender = validateMailboxIdentity(value.sender);
  const recipient = validateMailboxIdentity(value.recipient);
  requireValid(mailboxGroupKey(sender) === mailboxGroupKey(recipient) && sender.memberId !== recipient.memberId && sender.actorKey !== recipient.actorKey);
  requireValid(Array.isArray(value.resourceScope) && value.resourceScope.length > 0 && value.resourceScope.length <= 16
    && value.resourceScope.every((item) => typeof item === "string" && item.length <= 255 && /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*$/.test(item) && !containsSensitiveCredential(item))
    && new Set(value.resourceScope).size === value.resourceScope.length);
  try {
    requireValid(record(value.correlation));
    if (value.correlation.status === "present") {
      closed(value.correlation, ["status", "envelope"]);
      validateRunCorrelationEnvelope(value.correlation.envelope);
    } else {
      closed(value.correlation, ["status", "reason"]);
      requireValid(value.correlation.status === "incomplete");
      validateRunCorrelationPresence(value.correlation);
    }
  } catch { throw new MailboxValidationError(); }
  requireValid(requests.has(value.kind as MailboxKind) || responses.has(value.kind as MailboxKind));
  requireValid(requests.has(value.kind as MailboxKind) ? value.inReplyTo === null : identifier(value.inReplyTo));
  requireValid(timestamp(value.createdAt) && timestamp(value.expiresAt) && value.createdAt < value.expiresAt
    && Date.parse(value.expiresAt) - Date.parse(value.createdAt) <= MAILBOX_MAX_LIFETIME_MS);
  closed(value.payload, ["summary", "evidenceRefs", "outputRefs"]);
  requireValid(typeof value.payload.summary === "string" && value.payload.summary.trim().length > 0
    && Buffer.byteLength(value.payload.summary, "utf8") <= 2048 && !/[\u0000-\u001f\u007f]/.test(value.payload.summary)
    && !containsSensitiveCredential(value.payload.summary) && refs(value.payload.evidenceRefs) && refs(value.payload.outputRefs));
  requireValid(Buffer.byteLength(canonicalMailboxJson(value.payload), "utf8") <= MAILBOX_MAX_PAYLOAD_BYTES);
  return structuredClone(value) as MailboxMessageIntent;
}
export function createMailboxMessage(value: MailboxMessageIntent): MailboxMessage {
  const intent = validateIntent(value);
  return { ...intent, intentDigest: createHash("sha256").update(canonicalMailboxJson(intent)).digest("hex") };
}
export function validateMailboxMessage(value: unknown): MailboxMessage {
  canonicalMailboxJson(value);
  closed(value, [...intentKeys, "intentDigest"]);
  const { intentDigest, ...intent } = value;
  const message = createMailboxMessage(intent as MailboxMessageIntent);
  requireValid(intentDigest === message.intentDigest);
  return message;
}
export function assertMailboxActive(message: MailboxMessage, now: string): void {
  requireValid(timestamp(now) && message.createdAt <= now && now < message.expiresAt);
}
