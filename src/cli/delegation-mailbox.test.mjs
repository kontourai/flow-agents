import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  createMailboxMessage, MailboxValidationError, MAILBOX_MAX_PAYLOAD_BYTES,
} from "../../build/src/delegation-mailbox.js";
import { createLocalFileDelegationMailbox } from "../../build/src/delegation-mailbox-local-file.js";

const AT = "2026-10-21T06:00:00.000Z";
const EXPIRES = "2026-10-21T06:30:00.000Z";
const identity = (member) => ({
  groupId: "group-1", groupGeneration: 2, controllerActorKey: "host:controller", controllerGeneration: 3,
  memberId: member, memberGeneration: 4, assignmentId: `assignment-${member}`, assignmentGeneration: 5,
  actorKey: member === "controller" ? "host:controller" : `host:${member}`,
});
const A = identity("a");
const B = identity("b");
const C = identity("c");
const CONTROLLER = identity("controller");
function intent(overrides = {}) {
  return {
    schemaVersion: "1.0", messageId: "message-1", operationId: "operation-1", exchangeId: "exchange-1",
    subjectId: "flow-agents#561", resourceScope: ["src/coordination.ts"], sender: A, recipient: B,
    correlation: { status: "incomplete", reason: "offline local fixture" }, kind: "scope_conflict", inReplyTo: null,
    createdAt: AT, expiresAt: EXPIRES,
    payload: { summary: "Does this resource overlap your assignment?", evidenceRefs: ["evidence:scope"], outputRefs: [] },
    ...overrides,
  };
}
function message(overrides = {}) { return createMailboxMessage(intent(overrides)); }
function ok(result) { assert.equal(result.status, "ok", JSON.stringify(result)); return result.value; }
function refused(result, code) { assert.equal(result.status, "refused"); if (code) assert.equal(result.code, code); }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-mailbox-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const live = new Map([A, B, C, CONTROLLER].map((item) => [item.actorKey, structuredClone(item)]));
  const state = { now: AT, unavailable: false, throwHost: false, cancelled: false };
  const open = (authenticatedActor) => createLocalFileDelegationMailbox({
    artifactRoot: root,
    now: () => state.now,
    validateHost: ({ action, caller, message: candidate }) => {
      if (state.throwHost) throw new Error("host temporarily offline");
      if (state.unavailable) return { status: "unavailable" };
      const current = (item) => JSON.stringify(item) === JSON.stringify(live.get(item.actorKey));
      if (state.cancelled || caller.actorKey !== authenticatedActor || !current(caller)
        || (candidate && (!current(candidate.sender) || !current(candidate.recipient)))
        || (action === "cancel" && authenticatedActor !== "host:controller")) return { status: "refused" };
      return { status: "current" };
    },
  });
  return { root, live, state, open, sender: open(A.actorKey), recipient: open(B.actorKey) };
}
const response = (kind = "ack", overrides = {}) => message({
  messageId: "message-2", operationId: "operation-2", sender: B, recipient: A, kind, inReplyTo: "message-1",
  payload: { summary: "Reference received for independent review", evidenceRefs: [], outputRefs: ["output:scope"] }, ...overrides,
});

// Each case reaches the public offline transport; no provider/native runtime is involved.
test("durable pending operation survives reopen; explicit delivery and ack preserve provenance", async (t) => {
  const f = fixture(t);
  const sent = message();
  const pending = ok(await f.sender.enqueue(sent, A));
  assert.equal(pending.status, "pending");
  assert.deepEqual(ok(await f.recipient.inbox(B)), []);
  const reopened = f.open(A.actorKey);
  assert.deepEqual(ok(await reopened.outbox(A)), [pending]);
  assert.deepEqual(ok(await reopened.enqueue(sent, A)), pending);
  const delivered = ok(await reopened.deliver(sent.operationId, A));
  assert.equal(delivered.status, "delivered");
  assert.deepEqual(ok(await f.recipient.inbox(B)), [delivered]);
  const acknowledged = ok(await f.recipient.acknowledge(sent.operationId, B));
  assert.equal(acknowledged.status, "acknowledged");
  assert.deepEqual(acknowledged.message, sent);
  assert.deepEqual(ok(await f.open(B.actorKey).acknowledge(sent.operationId, B)), acknowledged);
  assert.deepEqual(ok(await reopened.deliver(sent.operationId, A)), acknowledged);
  assert.deepEqual(ok(await f.open(B.actorKey).inbox(B)), [acknowledged]);
});

test("concurrent independent operations are not lost and concurrent exact replay creates one operation", async (t) => {
  const f = fixture(t);
  const sent = message();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.open(A.actorKey).enqueue(sent, A)));
  for (const result of results) assert.deepEqual(ok(result), { message: sent, status: "pending" });
  const more = Array.from({ length: 12 }, (_, i) => message({ messageId: `m-${i}`, operationId: `op-${i}`, exchangeId: `ex-${i}`, subjectId: `subject-${i}`,
    kind: ["scope_conflict", "dependency_question", "handoff_offer", "unblock_request"][i % 4] }));
  for (const result of await Promise.all(more.map((item) => f.open(A.actorKey).enqueue(item, A)))) ok(result);
  const pending = ok(await f.open(A.actorKey).outbox(A));
  assert.equal(pending.length, 13);
  assert.equal(new Set(pending.map((op) => op.message.operationId)).size, 13);
  for (const result of await Promise.all(pending.map((op) => f.open(A.actorKey).deliver(op.message.operationId, A)))) ok(result);
  assert.equal(ok(await f.open(B.actorKey).inbox(B)).length, 13);
});

test("concurrent first requests consume one exchange slot", async (t) => {
  const f = fixture(t);
  const results = await Promise.all([message(), message({ messageId: "m-other", operationId: "op-other" })].map((item) => f.sender.enqueue(item, A)));
  assert.equal(results.filter((item) => item.status === "ok").length, 1);
  refused(results.find((item) => item.status !== "ok"), "exchange_bound");
  assert.equal(ok(await f.sender.outbox(A)).length, 1);
});

test("one request and one response; competing responses and conversation loops are refused", async (t) => {
  const f = fixture(t);
  ok(await f.sender.enqueue(message(), A));
  refused(await f.recipient.enqueue(response(), B), "exchange_bound");
  ok(await f.sender.deliver("operation-1", A));
  const replies = [response(), response("decline", { operationId: "op-decline", messageId: "m-decline" })];
  const results = await Promise.all(replies.map((item) => f.recipient.enqueue(item, B)));
  assert.equal(results.filter((item) => item.status === "ok").length, 1);
  refused(results.find((item) => item.status !== "ok"), "exchange_bound");
  const accepted = ok(results.find((item) => item.status === "ok"));
  ok(await f.recipient.deliver(accepted.message.operationId, B));
  assert.equal(ok(await f.sender.inbox(A))[0].message.inReplyTo, "message-1");
  refused(await f.sender.enqueue(message({ messageId: "m-third", operationId: "op-third" }), A), "exchange_bound");
  assert.equal(ok(await f.open(B.actorKey).outbox(B)).length, 1);
  for (const sender of [A, B]) {
    const another = message({ sender, recipient: sender === A ? B : A, messageId: `m-loop-${sender.memberId}`,
      operationId: `op-loop-${sender.memberId}`, exchangeId: `ex-loop-${sender.memberId}`,
      correlation: { status: "incomplete", reason: "attempt to renew the conversation" } });
    refused(await f.open(sender.actorKey).enqueue(another, sender), "exchange_bound");
  }
});

test("response must bind the actual delivered request and all provenance", async (t) => {
  const f = fixture(t);
  ok(await f.sender.enqueue(message(), A));
  ok(await f.sender.deliver("operation-1", A));
  for (const overrides of [
    { inReplyTo: "unrelated" }, { subjectId: "different" }, { resourceScope: ["other.ts"] },
    { correlation: { status: "incomplete", reason: "different run" } }, { expiresAt: "2026-10-21T06:31:00.000Z" },
    { sender: C }, { exchangeId: "unrelated" },
  ]) {
    const reply = response("redirect", overrides);
    refused(await f.open(reply.sender.actorKey).enqueue(reply, reply.sender), "exchange_bound");
  }
  assert.deepEqual(ok(await f.recipient.outbox(B)), []);
});

test("replay retains canonical operation across key order; changed payload or identities cannot reuse IDs", async (t) => {
  const f = fixture(t);
  const sent = message();
  ok(await f.sender.enqueue(sent, A));
  const reordered = Object.fromEntries(Object.entries(sent).reverse());
  assert.deepEqual(ok(await f.open(A.actorKey).enqueue(reordered, A)).message, sent);
  for (const overrides of [
    { payload: { summary: "changed payload", evidenceRefs: [], outputRefs: [] } },
    { recipient: C }, { sender: C }, { operationId: "new-operation" }, { messageId: "new-message" },
  ]) {
    const changed = message(overrides);
    refused(await f.open(changed.sender.actorKey).enqueue(changed, changed.sender), "conflicting_replay");
  }
  const reassigned = { ...A, assignmentGeneration: A.assignmentGeneration + 1 };
  f.live.set(A.actorKey, reassigned);
  refused(await f.sender.enqueue(message({ sender: reassigned }), reassigned), "conflicting_replay");
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, "mailbox/state.json"), "utf8")).operations.length, 1);
});

// Actor forgery is distinct from a legitimate actor submitting its own independent request.
test("host refuses forged sender and unavailable identity without persisting a message", async (t) => {
  const f = fixture(t);
  refused(await f.sender.enqueue(message(), C), "sender_mismatch");
  refused(await f.open(C.actorKey).enqueue(message(), A), "host_refused");
  const forged = { ...A, actorKey: "host:forged" };
  refused(await f.open(forged.actorKey).enqueue(message({ sender: forged }), forged), "host_refused");
  f.state.unavailable = true;
  assert.equal((await f.sender.enqueue(message(), A)).status, "unavailable");
  f.state.unavailable = false; f.state.throwHost = true;
  assert.equal((await f.sender.enqueue(message(), A)).status, "unavailable");
  f.state.throwHost = false;
  assert.deepEqual(ok(await f.sender.outbox(A)), []);
});

for (const field of ["groupId", "groupGeneration", "controllerActorKey", "controllerGeneration", "memberId", "memberGeneration", "assignmentId", "assignmentGeneration", "actorKey"]) {
  test(`host checks exact ${field} for both participants at send, delivery, read and ack`, async (t) => {
    const f = fixture(t);
    const sent = message();
    ok(await f.sender.enqueue(sent, A));
    const original = f.live.get(B.actorKey);
    const changed = { ...original, [field]: typeof original[field] === "number" ? original[field] + 1 : `${original[field]}-next` };
    f.live.set(B.actorKey, changed);
    refused(await f.sender.enqueue(sent, A), "host_refused");
    refused(await f.sender.deliver(sent.operationId, A), "host_refused");
    refused(await f.recipient.inbox(B), "host_refused");
    refused(await f.recipient.acknowledge(sent.operationId, B), "host_refused");
    f.live.set(B.actorKey, original);
    ok(await f.sender.deliver(sent.operationId, A));
    const senderOriginal = f.live.get(A.actorKey);
    f.live.set(A.actorKey, { ...senderOriginal, [field]: typeof senderOriginal[field] === "number" ? senderOriginal[field] + 1 : `${senderOriginal[field]}-next` });
    refused(await f.recipient.inbox(B), "host_refused");
    refused(await f.recipient.acknowledge(sent.operationId, B), "host_refused");
  });
}

test("only exact intended recipient generation can read or acknowledge; another actor sees nothing", async (t) => {
  const f = fixture(t);
  ok(await f.sender.enqueue(message(), A));
  ok(await f.sender.deliver("operation-1", A));
  assert.deepEqual(ok(await f.open(C.actorKey).inbox(C)), []);
  assert.deepEqual(ok(await f.open(C.actorKey).outbox(C)), []);
  refused(await f.open(C.actorKey).acknowledge("operation-1", C), "operation_unavailable");
  refused(await f.open(C.actorKey).deliver("operation-1", C), "operation_unavailable");
  const next = { ...B, memberGeneration: B.memberGeneration + 1, assignmentGeneration: B.assignmentGeneration + 1 };
  f.live.set(B.actorKey, next);
  assert.deepEqual(ok(await f.recipient.inbox(next)), []);
  refused(await f.recipient.acknowledge("operation-1", next), "operation_unavailable");
});

test("expiry refuses delivery, read, ack and replay at the exact boundary", async (t) => {
  const f = fixture(t);
  ok(await f.sender.enqueue(message(), A));
  refused(await f.recipient.acknowledge("operation-1", B), "not_delivered");
  ok(await f.sender.deliver("operation-1", A));
  f.state.now = EXPIRES;
  assert.deepEqual(ok(await f.recipient.inbox(B)), []);
  refused(await f.sender.enqueue(message(), A), "inactive");
  refused(await f.sender.deliver("operation-1", A), "inactive");
  refused(await f.recipient.acknowledge("operation-1", B), "inactive");
  assert.equal(ok(await f.sender.outbox(A))[0].status, "delivered");
});

test("cancel fence survives reopen and races safely with delivery; only controller can cancel", async (t) => {
  const f = fixture(t);
  ok(await f.sender.enqueue(message(), A));
  refused(await f.sender.cancel(A), "controller_required");
  refused(await f.open(A.actorKey).cancel(CONTROLLER), "host_refused");
  const [cancelled, delivery] = await Promise.all([f.open(CONTROLLER.actorKey).cancel(CONTROLLER), f.sender.deliver("operation-1", A)]);
  ok(cancelled); refused(delivery, "inactive");
  refused(await f.open(A.actorKey).enqueue(message(), A), "inactive");
  refused(await f.open(B.actorKey).inbox(B), "inactive");
  refused(await f.open(B.actorKey).acknowledge("operation-1", B), "inactive");
  const journal = JSON.parse(fs.readFileSync(path.join(f.root, "mailbox/state.json"), "utf8"));
  assert.equal(journal.operations[0].status, "pending");
  assert.equal(journal.cancelled.length, 1);
  ok(await f.open(CONTROLLER.actorKey).cancel(CONTROLLER));
});

test("host cancellation is checked even when no local cancellation fence exists", async (t) => {
  const f = fixture(t);
  ok(await f.sender.enqueue(message(), A));
  f.state.cancelled = true;
  refused(await f.sender.deliver("operation-1", A), "host_refused");
  refused(await f.recipient.inbox(B), "host_refused");
});

test("closed validation refuses authority fields, secrets, invalid kinds, path references and UTF8 overflow", async (t) => {
  const f = fixture(t);
  const badIntents = [
    { gatePass: true }, { releaseOwner: true }, { kind: "takeover" }, { kind: "ack", inReplyTo: null },
    { resourceScope: ["../secrets"] }, { expiresAt: "2026-10-22T06:00:00.000Z" },
    { payload: { summary: "Bearer abcdefgh", evidenceRefs: [], outputRefs: [] } },
    { payload: { summary: "bounded", evidenceRefs: ["/etc/passwd"], outputRefs: [] } },
    { payload: { summary: "bounded", evidenceRefs: [], outputRefs: ["https://host/output"] } },
    { payload: { summary: "🧭".repeat(513), evidenceRefs: [], outputRefs: [] } },
    { payload: { summary: "x".repeat(1500), evidenceRefs: Array.from({ length: 16 }, (_, i) => `${i}${"r".repeat(200)}`), outputRefs: [] } },
    { sender: { ...A, assignmentGeneration: Number.MAX_SAFE_INTEGER + 1 } },
    { correlation: { status: "incomplete", reason: "Bearer credential" } },
    { correlation: { status: "incomplete", reason: "offline", establishTrust: true } },
    { sender: { ...A, guessedIdentity: true } }, { createdAt: "2026-02-30T06:00:00.000Z" },
  ];
  for (const overrides of badIntents) assert.throws(() => createMailboxMessage(intent(overrides)), MailboxValidationError);
  assert.equal(MAILBOX_MAX_PAYLOAD_BYTES, 4096);
  const forged = { ...message(), payload: { summary: "altered without recomputing digest", evidenceRefs: [], outputRefs: [] } };
  await assert.rejects(f.sender.enqueue(forged, A), MailboxValidationError);
  await assert.rejects(f.sender.enqueue({ ...message(), advanceGate: true }, A), MailboxValidationError);
  assert.deepEqual(ok(await f.sender.outbox(A)), []);
});

test("canonical digest is SHA256 over complete intent including operation and identity", () => {
  const sent = message();
  const intentDigest = sent.intentDigest;
  // Golden SHA256 produced independently with Python json.dumps(sort_keys=True).
  assert.equal(intentDigest, "a63d395b9ce7eb63ecbeaa58dd2aa995043b9c65d7305b49ea852356bb8d0d0d");
  assert.notEqual(message({ operationId: "other-operation" }).intentDigest, intentDigest);
  assert.notEqual(message({ sender: { ...A, memberGeneration: 6 } }).intentDigest, intentDigest);
});

for (const target of ["mailbox", "mailbox/assignment", "mailbox/state.json"]) {
  test(`refuses symlink ${target} without reading or writing its target`, async (t) => {
    const f = fixture(t);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "flow-mailbox-outside-"));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const external = path.join(outside, target.endsWith("json") ? "state.json" : "store");
    if (target.endsWith("json")) fs.writeFileSync(external, "untouched");
    else fs.mkdirSync(external);
    const link = path.join(f.root, target);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(external, link);
    await assert.rejects(f.sender.enqueue(message(), A), /symlink|Unsafe|ELOOP|escapes/);
    if (target.endsWith("json")) assert.equal(fs.readFileSync(external, "utf8"), "untouched");
    else assert.deepEqual(fs.readdirSync(external), []);
  });
}

test("corrupt retained state fails closed and a failed durable write never exposes delivery", async (t) => {
  const f = fixture(t);
  ok(await f.sender.enqueue(message(), A));
  const file = path.join(f.root, "mailbox/state.json");
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, "broken-json");
  await assert.rejects(f.sender.enqueue(message(), A), SyntaxError);
  fs.writeFileSync(file, original);
  const interrupted = createLocalFileDelegationMailbox({
    artifactRoot: f.root, now: () => AT,
    validateHost: ({ action }) => {
      if (action === "deliver") {
        fs.renameSync(file, `${file}.retained`);
        fs.mkdirSync(file);
      }
      return { status: "current" };
    },
  });
  await assert.rejects(interrupted.deliver("operation-1", A), /regular file/);
  fs.rmdirSync(file);
  fs.renameSync(`${file}.retained`, file);
  const reopened = f.open(A.actorKey);
  assert.equal(ok(await reopened.outbox(A))[0].status, "pending");
  assert.deepEqual(ok(await f.recipient.inbox(B)), []);
  assert.deepEqual(ok(await reopened.enqueue(message(), A)).message, message());
});


test("uncertain host delivery remains pending across reopen and never automatically resends", async (t) => {
  const f = fixture(t);
  const pending = ok(await f.sender.enqueue(message(), A));
  f.state.unavailable = true;
  assert.equal((await f.sender.deliver("operation-1", A)).status, "unavailable");
  f.state.unavailable = false;
  assert.deepEqual(ok(await f.open(A.actorKey).outbox(A)), [pending]);
  assert.deepEqual(ok(await f.open(B.actorKey).inbox(B)), []);
  assert.deepEqual(ok(await f.open(A.actorKey).enqueue(message(), A)), pending);
  refused(await f.recipient.acknowledge("operation-1", B), "not_delivered");
});
