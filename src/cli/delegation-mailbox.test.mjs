import assert from "node:assert/strict";
import * as fs from "node:fs";
import fsDefault from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  createMailboxMessage, validateMailboxMessage, canonicalMailboxJson, MailboxValidationError, MAILBOX_MAX_PAYLOAD_BYTES,
} from "../../build/src/delegation-mailbox.js";
import { createLocalFileDelegationMailbox } from "../../build/src/delegation-mailbox-local-file.js";

import { createRunCorrelationEnvelope, readRunCorrelation, RUN_CORRELATION_IDENTITY_KEYS } from "../../build/src/run-correlation.js";
import { createLocalFileAssignmentProvider } from "../../build/src/assignment-local-file.js";
import { canonicalHolderActorKey } from "../../build/src/assignment-contract.js";

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
  const open = (authenticatedActor, artifactRoot = root) => createLocalFileDelegationMailbox({
    artifactRoot,
    now: () => state.now,
    validateHost: ({ action, caller, message: candidate }) => {
      if (state.throwHost) throw new Error("host temporarily offline");
      if (state.unavailable) return { status: "unavailable" };
      const current = (item) => JSON.stringify(item) === JSON.stringify(live.get(item.actorKey));
      if (state.cancelled || caller.actorKey !== authenticatedActor || !current(caller)
        || (candidate && (!current(candidate.sender) || !current(candidate.recipient)))
        || (action === "cancel" && authenticatedActor !== caller.controllerActorKey)) return { status: "refused" };
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
    { sender: { ...A, actorKey: "" } }, { sender: { ...A, actorKey: 42 } },
    { sender: { ...A, actorKey: "Bearer credential" } },
    { sender: { ...A, controllerActorKey: "TOKEN=credential" } },
    { sender: { ...A, groupId: "_not-a-mailbox-id" } },
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
    const externalMode = fs.statSync(external).mode;
    fs.symlinkSync(external, link);
    await assert.rejects(f.sender.enqueue(message(), A), /symlink|Unsafe|ELOOP|ENOTDIR|escapes/);
    assert.equal(fs.statSync(external).mode, externalMode);
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
    validateHost: ({ action, message: candidate }) => {
      if (action === "deliver" && candidate) {
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


for (const field of ["evidenceRefs", "outputRefs", "resourceScope"]) {
  test(`noncanonical ${field} cannot enter the journal or corrupt later reads`, async (t) => {
    const f = fixture(t);
    const pending = ok(await f.sender.enqueue(message(), A));
    const original = fs.readFileSync(path.join(f.root, "mailbox/state.json"));
    for (const bad of [new Array(1), Object.assign(["ref:one"], { extra: "discarded" }),
      Object.defineProperty(["ref:one"], "0", { get: () => "ref:one", enumerable: true })]) {
      const value = intent({ messageId: "bad-message", operationId: "bad-operation", exchangeId: "bad-exchange", subjectId: "other" });
      if (field === "resourceScope") value.resourceScope = bad;
      else value.payload[field] = bad;
      // A caller can supply a digest directly; validation must reject before persistence.
      const normalized = { ...value, payload: { ...value.payload } };
      if (field === "resourceScope") normalized.resourceScope = bad.filter(() => true);
      else normalized.payload[field] = bad.filter(() => true);
      const raw = { ...value, intentDigest: createHash("sha256").update(canonicalMailboxJson(normalized)).digest("hex") };
      await assert.rejects(f.sender.enqueue(raw, A), MailboxValidationError);
      assert.throws(() => createMailboxMessage(value), MailboxValidationError);
      assert.deepEqual(fs.readFileSync(path.join(f.root, "mailbox/state.json")), original);
    }
    const roundtrip = JSON.parse(JSON.stringify(pending.message));
    assert.deepEqual(validateMailboxMessage(roundtrip), pending.message);
    assert.equal(canonicalMailboxJson(roundtrip), canonicalMailboxJson(pending.message));
    assert.deepEqual(ok(await f.open(A.actorKey).outbox(A)), [pending]);
  });
}

for (const target of ["file", "directory"]) {
  test(`post-replace ${target} fsync failure stays unavailable through retry and reopen until confirmed`, async (t) => {
    const f = fixture(t);
    const sent = message();
    ok(await f.sender.enqueue(sent, A));
    const file = path.join(f.root, "mailbox/state.json");
    let failing = true;
    let calls = 0;
    const actual = fsDefault.fsyncSync;
    t.mock.method(fsDefault, "fsyncSync", (fd) => {
      const stat = fs.fstatSync(fd);
      const retained = JSON.parse(fs.readFileSync(file, "utf8"));
      if (retained.operations[0].status === "delivered" && (target === "file" ? stat.isFile() : stat.isDirectory())) {
        calls++;
        if (failing) throw Object.assign(new Error("injected post-replace EIO"), { code: "EIO" });
      }
      return actual(fd);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const uncertain = (result) => assert.deepEqual(result, { status: "unavailable", code: "durability_unconfirmed" });
    uncertain(await f.sender.deliver(sent.operationId, A));
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).operations[0].status, "delivered");
    for (const observe of [() => f.open(B.actorKey).inbox(B), () => f.open(A.actorKey).outbox(A),
      () => f.open(A.actorKey).enqueue(sent, A), () => f.open(A.actorKey).deliver(sent.operationId, A)]) {
      const before = calls;
      uncertain(await observe());
      assert.ok(calls > before, "each observation must attempt durability repair");
    }
    failing = false;
    const before = calls;
    const delivered = ok(await f.open(A.actorKey).deliver(sent.operationId, A));
    assert.ok(calls > before);
    assert.equal(delivered.status, "delivered");
    assert.deepEqual(ok(await f.open(B.actorKey).inbox(B)), [delivered]);
    assert.equal(ok(await f.open(B.actorKey).acknowledge(sent.operationId, B)).status, "acknowledged");
  });
}

test("published present correlation reader result roundtrips; raw envelopes are rejected", async (t) => {
  const f = fixture(t);
  const envelope = createRunCorrelationEnvelope({ correlation_id: "run-mailbox", identities: Object.fromEntries(
    RUN_CORRELATION_IDENTITY_KEYS.map((key) => [key, { status: "unavailable", reason: "offline" }])) });
  const correlation = readRunCorrelation({ run_correlation: envelope });
  assert.equal(correlation.status, "present");
  const sent = message({ correlation });
  ok(await f.sender.enqueue(sent, A));
  ok(await f.sender.deliver(sent.operationId, A));
  assert.deepEqual(ok(await f.open(B.actorKey).inbox(B))[0].message.correlation, correlation);
  for (const malformed of [envelope, { ...correlation, gatePass: true }, { status: "present" }]) {
    assert.throws(() => message({ correlation: malformed }), MailboxValidationError);
  }
  const types = path.join(f.root, "correlation-contract.mts");
  const source = path.resolve("build/src");
  fs.writeFileSync(types, `import { readRunCorrelation, type RunCorrelationPresence } from ${JSON.stringify(source + "/run-correlation.js")};
import { createMailboxMessage, type MailboxMessageIntent } from ${JSON.stringify(source + "/delegation-mailbox.js")};
const correlation: RunCorrelationPresence = readRunCorrelation({});
declare const intent: Omit<MailboxMessageIntent, "correlation">;
createMailboxMessage({ ...intent, correlation });
// @ts-expect-error a raw envelope is outside the published mailbox type
createMailboxMessage({ ...intent, correlation: { schema_version: "1.0", correlation_id: "run", identities: {} } });
`);
  const result = spawnSync(path.resolve("node_modules/.bin/tsc"), ["--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022",
    "--module", "Node16", "--moduleResolution", "Node16", "--ignoreDeprecations", "6.0", types], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("real local assignment subject retains exact owner identity in mailbox and replay", async (t) => {
  const f = fixture(t);
  const provider = createLocalFileAssignmentProvider(path.join(f.root, "assignments"));
  const subject = "kontourai/flow-agents#561";
  await provider.claim(subject, { runtime: "codex", session_id: "mailbox-test", host: "offline" }, {
    ttlSeconds: 3600, branch: "detached", artifactDir: f.root, workItemRef: subject,
  });
  const assignment = await provider.status(subject);
  assert.equal(assignment.subject_id, subject);
  const sent = message({ subjectId: assignment.subject_id });
  ok(await f.sender.enqueue(sent, A));
  ok(await f.sender.deliver(sent.operationId, A));
  assert.equal(ok(await f.open(B.actorKey).inbox(B))[0].message.subjectId, subject);
  refused(await f.sender.enqueue(message({ subjectId: "other-owner/flow-agents#561" }), A), "conflicting_replay");
  for (const subjectId of ["../flow-agents#561", "kontourai/flow-agents#0", "owner/repo#01", "owner/repo#9007199254740992",
    "Bearer credential", "owner/ghp_abcdefgh12345678#561", "x".repeat(256)]) {
    assert.throws(() => message({ subjectId }), MailboxValidationError);
  }
});

test("forged transition callers cannot distinguish existing and absent operations before authentication", async (t) => {
  const f = fixture(t);
  ok(await f.sender.enqueue(message(), A));
  const calls = [];
  const attacker = createLocalFileDelegationMailbox({ artifactRoot: f.root, now: () => AT, validateHost: (observation) => {
    calls.push(observation);
    return { status: "refused" };
  } });
  for (const action of ["deliver", "acknowledge"]) {
    calls.length = 0;
    const existing = await attacker[action]("operation-1", action === "deliver" ? A : B);
    const absent = await attacker[action]("absent-operation", action === "deliver" ? A : B);
    assert.deepEqual(existing, { status: "refused", code: "host_refused" });
    assert.deepEqual(absent, existing);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => !Object.hasOwn(call, "message")), "refused callers receive no participant-bearing observation");
  }
  refused(await f.open(C.actorKey).deliver("operation-1", A), "host_refused");
  refused(await f.open(C.actorKey).deliver("absent-operation", A), "host_refused");
});

test("umask 022 journal is private, owned, and never chmods ancestors or peers", async (t) => {
  const f = fixture(t);
  const parentMode = fs.statSync(path.dirname(f.root)).mode;
  fs.chmodSync(f.root, 0o755);
  const peer = path.join(f.root, "peer");
  fs.mkdirSync(peer, { mode: 0o755 });
  const old = process.umask(0o022);
  t.after(() => process.umask(old));
  ok(await f.sender.enqueue(message(), A));
  for (const target of [f.root, path.join(f.root, "mailbox"), path.join(f.root, "mailbox/assignment")]) {
    const stat = fs.lstatSync(target);
    assert.equal(stat.uid, process.geteuid());
    assert.equal(stat.mode & 0o777, 0o700, target);
  }
  const file = path.join(f.root, "mailbox/state.json");
  assert.equal(fs.lstatSync(file).mode & 0o777, 0o600);
  fs.chmodSync(file, 0o644);
  assert.equal(ok(await f.open(A.actorKey).outbox(A)).length, 1);
  assert.equal(fs.lstatSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(peer).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.dirname(f.root)).mode, parentMode);
});

test("foreign-owned root and hardlinked journal are refused without chmod or disclosure", async (t) => {
  const f = fixture(t);
  const foreign = fs.realpathSync("/usr");
  assert.notEqual(fs.statSync(foreign).uid, process.geteuid(), "test requires the real system-owned directory");
  const before = fs.statSync(foreign);
  const foreignMailbox = createLocalFileDelegationMailbox({ artifactRoot: foreign, validateHost: () => ({ status: "current" }) });
  await assert.rejects(foreignMailbox.outbox(A), /owner/i);
  assert.equal(fs.statSync(foreign).mode, before.mode);
  ok(await f.sender.enqueue(message(), A));
  const file = path.join(f.root, "mailbox/state.json");
  const link = path.join(f.root, "peer-state");
  fs.linkSync(file, link);
  fs.chmodSync(link, 0o644);
  const bytes = fs.readFileSync(link);
  await assert.rejects(f.open(A.actorKey).outbox(A), /Unsafe|hardlink/i);
  assert.equal(fs.statSync(link).mode & 0o777, 0o644);
  assert.deepEqual(fs.readFileSync(link), bytes);
});


test("exact 4096 UTF8 payload, one hour lifetime and 256 operations remain bounded", async (t) => {
  const f = fixture(t);
  const payload = { summary: "🧭".repeat(496) + "x", evidenceRefs: Array.from({ length: 8 }, (_, i) => `${i}${"r".repeat(254)}`), outputRefs: [] };
  assert.equal(Buffer.byteLength(canonicalMailboxJson(payload)), 4096);
  const sent = message({ payload, expiresAt: "2026-10-21T07:00:00.000Z" });
  assert.deepEqual(ok(await f.sender.enqueue(sent, A)).message, sent);
  assert.throws(() => message({ payload: { ...payload, summary: payload.summary + "x" } }), MailboxValidationError);
  assert.throws(() => message({ expiresAt: "2026-10-21T07:00:00.001Z" }), MailboxValidationError);
  for (let i = 1; i < 256; i++) {
    ok(await f.sender.enqueue(message({ messageId: `capacity-m-${i}`, operationId: `capacity-op-${i}`,
      exchangeId: `capacity-ex-${i}`, subjectId: `capacity-subject-${i}` }), A));
  }
  refused(await f.sender.enqueue(message({ messageId: "overflow-m", operationId: "overflow-op", exchangeId: "overflow-ex", subjectId: "overflow-subject" }), A), "capacity");
  assert.equal(ok(await f.open(A.actorKey).outbox(A)).length, 256);
  assert.deepEqual(ok(await f.sender.enqueue(sent, A)).message, sent);
  ok(await f.sender.deliver(sent.operationId, A));
  assert.deepEqual(ok(await f.open(B.actorKey).inbox(B))[0].message, sent);
});


for (const phase of ["acknowledged", "cancelled"]) {
  for (const target of ["file", "directory"]) {
    test(`${phase} post-replace ${target} fsync failure requires confirmed retry`, async (t) => {
      const f = fixture(t);
      ok(await f.sender.enqueue(message(), A));
      ok(await f.sender.deliver("operation-1", A));
      const file = path.join(f.root, "mailbox/state.json");
      let failing = true;
      let calls = 0;
      const actual = fsDefault.fsyncSync;
      t.mock.method(fsDefault, "fsyncSync", (fd) => {
        const retained = JSON.parse(fs.readFileSync(file, "utf8"));
        const replaced = phase === "acknowledged" ? retained.operations[0].status === phase : retained.cancelled.length === 1;
        const stat = fs.fstatSync(fd);
        if (replaced && (target === "file" ? stat.isFile() : stat.isDirectory())) {
          calls++;
          if (failing) throw Object.assign(new Error("injected post-replace EIO"), { code: "EIO" });
        }
        return actual(fd);
      });
      syncBuiltinESMExports();
      t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
      const retry = () => phase === "acknowledged"
        ? f.open(B.actorKey).acknowledge("operation-1", B) : f.open(CONTROLLER.actorKey).cancel(CONTROLLER);
      for (let i = 0; i < 2; i++) {
        const before = calls;
        assert.deepEqual(await retry(), { status: "unavailable", code: "durability_unconfirmed" });
        assert.ok(calls > before);
      }
      if (phase === "acknowledged") assert.equal((await f.open(B.actorKey).inbox(B)).status, "unavailable");
      else refused(await f.open(B.actorKey).inbox(B), "inactive");
      failing = false;
      const before = calls;
      const repaired = ok(await retry());
      assert.ok(calls > before);
      if (phase === "acknowledged") {
        assert.equal(repaired.status, phase);
        assert.deepEqual(ok(await f.open(B.actorKey).inbox(B)), [repaired]);
      } else {
        assert.equal(repaired, null);
        refused(await f.open(A.actorKey).enqueue(message(), A), "inactive");
      }
    });
  }
}

test("replacement flushes its temporary data before replacing an acknowledged journal", async (t) => {
  const f = fixture(t);
  ok(await f.sender.enqueue(message(), A));
  const synced = new Set();
  const replacements = [];
  const sync = fsDefault.fsyncSync;
  const rename = fsDefault.renameSync;
  const inode = (stat) => `${stat.dev}:${stat.ino}`;
  t.mock.method(fsDefault, "fsyncSync", (fd) => {
    sync(fd);
    const stat = fs.fstatSync(fd);
    if (stat.isFile()) synced.add(inode(stat));
  });
  t.mock.method(fsDefault, "renameSync", (from, to) => {
    replacements.push(synced.has(inode(fs.statSync(from))));
    return rename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  ok(await f.sender.deliver("operation-1", A));
  assert.deepEqual(replacements, [true]);
});

test("temporary data fsync failure preserves the prior acknowledged journal", async (t) => {
  const f = fixture(t);
  ok(await f.sender.enqueue(message(), A));
  const file = path.join(f.root, "mailbox/state.json");
  const prior = fs.readFileSync(file);
  const sync = fsDefault.fsyncSync;
  t.mock.method(fsDefault, "fsyncSync", (fd) => {
    if (fs.fstatSync(fd).isFile()) throw Object.assign(new Error("temporary data not durable"), { code: "EIO" });
    return sync(fd);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(f.sender.deliver("operation-1", A), { code: "EIO" });
  assert.deepEqual(fs.readFileSync(file), prior);
});


for (const [relativeRoot, syncParent] of [["new-root", "."], ["missing-parent/new-root", "."],
  ["missing-parent/new-root", "missing-parent"]]) {
  test(`first enqueue must confirm each new ancestor entry through retry and reopen (${relativeRoot}, ${syncParent})`, async (t) => {
    const f = fixture(t);
    const root = path.join(f.root, relativeRoot);
    const sync = fsDefault.fsyncSync;
    let failing = true;
    let attempts = 0;
    t.mock.method(fsDefault, "fsyncSync", (fd) => {
      const stat = fs.fstatSync(fd);
      const parent = fs.statSync(path.join(f.root, syncParent));
      if (stat.dev === parent.dev && stat.ino === parent.ino) {
        attempts++;
        if (failing) throw Object.assign(new Error("new root entry not durable"), { code: "EIO" });
      }
      return sync(fd);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const sent = message();
    const sender = f.open(A.actorKey, root);
    for (const observe of [() => sender.enqueue(sent, A), () => sender.enqueue(sent, A),
      () => f.open(A.actorKey, root).enqueue(sent, A), () => f.open(A.actorKey, root).outbox(A)]) {
      const before = attempts;
      assert.deepEqual(await observe(), { status: "unavailable", code: "durability_unconfirmed" });
      assert.ok(attempts > before, "an existing path does not confirm its directory entry");
    }
    const journal = JSON.parse(fs.readFileSync(path.join(root, "mailbox/state.json"), "utf8"));
    assert.equal(journal.operations.length, 1);
    assert.equal(journal.operations[0].status, "pending");
    failing = false;
    const before = attempts;
    const pending = ok(await f.open(A.actorKey, root).enqueue(sent, A));
    assert.ok(attempts > before);
    assert.deepEqual(ok(await f.open(A.actorKey, root).outbox(A)), [pending]);
  });
}

test("nested absent ancestors are created privately and every directory entry is flushed", async (t) => {
  const f = fixture(t);
  fs.chmodSync(f.root, 0o755);
  const peer = path.join(f.root, "peer");
  fs.mkdirSync(peer, { mode: 0o755 });
  const root = path.join(f.root, "missing-parent", "another-parent", "new-root");
  const created = [path.dirname(path.dirname(root)), path.dirname(root), root,
    path.join(root, "mailbox"), path.join(root, "mailbox/assignment")];
  const synced = new Set();
  const sync = fsDefault.fsyncSync;
  const inode = (stat) => `${stat.dev}:${stat.ino}`;
  t.mock.method(fsDefault, "fsyncSync", (fd) => {
    sync(fd);
    const stat = fs.fstatSync(fd);
    if (stat.isDirectory()) synced.add(inode(stat));
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const pending = ok(await f.open(A.actorKey, root).enqueue(message(), A));
  for (const dir of created) {
    const stat = fs.lstatSync(dir);
    assert.equal(stat.isDirectory(), true, dir);
    assert.equal(stat.uid, process.geteuid(), dir);
    assert.equal(stat.mode & 0o7777, 0o700, dir);
    assert.ok(synced.has(inode(stat)), `directory contents and metadata flushed: ${dir}`);
    assert.ok(synced.has(inode(fs.statSync(path.dirname(dir)))), `parent entry flushed: ${dir}`);
  }
  assert.equal(fs.statSync(f.root).mode & 0o7777, 0o755);
  assert.equal(fs.statSync(peer).mode & 0o7777, 0o755);
  assert.deepEqual(ok(await f.open(A.actorKey, root).outbox(A)), [pending]);
});

for (const actorKey of ["_reviewer", ".reviewer", "-reviewer", "reviewer/é @ workstation", "r".repeat(1100)]) {
  test(`canonical assignment actor key survives mailbox unchanged (${actorKey.slice(0, 30)})`, async (t) => {
    const f = fixture(t);
    const provider = createLocalFileAssignmentProvider(path.join(f.root, "assignments"));
    const record = await provider.claimReturning("kontourai/flow-agents#561", {
      runtime: "explicit-override", session_id: "descriptive-session", host: "offline",
    }, { actorKey, ttlSeconds: 3600, branch: "detached", artifactDir: f.root });
    const canonical = canonicalHolderActorKey(record);
    assert.equal(canonical, actorKey);
    const sender = { ...A, actorKey: canonical, controllerActorKey: canonical };
    const recipient = { ...B, controllerActorKey: canonical };
    f.live.set(canonical, sender);
    f.live.set(B.actorKey, recipient);
    const sent = message({ sender, recipient });
    const pending = ok(await f.open(canonical).enqueue(sent, sender));
    assert.equal(pending.message.sender.actorKey, canonical);
    assert.equal(pending.message.sender.controllerActorKey, canonical);
    assert.deepEqual(ok(await f.open(canonical).enqueue(sent, sender)), pending);
    const altered = { ...sender, actorKey: `${canonical}-other` };
    refused(await f.open(canonical).enqueue(sent, altered), "sender_mismatch");
    ok(await f.open(canonical).deliver(sent.operationId, sender));
    assert.deepEqual(ok(await f.open(B.actorKey).inbox(recipient))[0].message, sent);
    assert.equal(ok(await f.open(B.actorKey).acknowledge(sent.operationId, recipient)).status, "acknowledged");
    ok(await f.open(canonical).cancel(sender));
    ok(await f.open(canonical).cancel(sender));
    refused(await f.open(B.actorKey).inbox(recipient), "inactive");
  });
}


test("symlink artifact root is refused without changing its target", async (t) => {
  const f = fixture(t);
  const target = path.join(f.root, "unrelated");
  const root = path.join(f.root, "linked-root");
  fs.mkdirSync(target, { mode: 0o755 });
  const before = fs.statSync(target).mode;
  fs.symlinkSync(target, root);
  await assert.rejects(f.open(A.actorKey, root).enqueue(message(), A), /ELOOP|ENOTDIR|symlink/i);
  assert.equal(fs.statSync(target).mode, before);
  assert.deepEqual(fs.readdirSync(target), []);
});

test("ancestor created by a peer during preparation keeps its permissions", async (t) => {
  const f = fixture(t);
  const parent = path.join(f.root, "peer-parent");
  const root = path.join(parent, "new-root");
  const mkdir = fsDefault.mkdirSync;
  let raced = false;
  t.mock.method(fsDefault, "mkdirSync", (target, options) => {
    if (target === parent && !raced) {
      raced = true;
      mkdir(target, { mode: 0o755 });
      fs.chmodSync(target, 0o755);
    }
    return mkdir(target, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  ok(await f.open(A.actorKey, root).enqueue(message(), A));
  assert.equal(raced, true);
  assert.equal(fs.statSync(parent).mode & 0o7777, 0o755);
  assert.equal(fs.statSync(root).mode & 0o7777, 0o700);
});
