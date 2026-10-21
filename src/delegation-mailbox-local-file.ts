import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { withSubjectLockAsync } from "./lib/assignment-local-store.js";
import {
  MAILBOX_MAX_OPERATIONS, MailboxValidationError, assertMailboxActive, canonicalMailboxJson,
  isMailboxRequest, mailboxGroupKey, sameMailboxIdentity, validateMailboxIdentity, validateMailboxMessage,
  type MailboxHostValidator, type MailboxIdentity, type MailboxMessage, type MailboxOperation, type MailboxResult,
} from "./delegation-mailbox.js";

type Journal = { schemaVersion: "1.0"; operations: MailboxOperation[]; cancelled: string[] };
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const refused = (code: string): MailboxResult<never> => ({ status: "refused", code });

/** Single-host offline transport. Opening or listing never delivers pending work. */
export function createLocalFileDelegationMailbox(options: {
  artifactRoot: string;
  validateHost: MailboxHostValidator;
  now?: () => string;
}) {
  const root = path.resolve(options.artifactRoot);
  const directory = path.join(root, "mailbox");
  const file = path.join(directory, "state.json");
  const now = options.now ?? (() => new Date().toISOString());

  // Narrow only this adapter's owned paths, using descriptors that cannot follow links.
  function privateDescriptor(fd: number, directory: boolean): void {
    const stat = fs.fstatSync(fd);
    if (typeof process.geteuid !== "function" || stat.uid !== process.geteuid()) throw new Error("Mailbox filesystem owner is unavailable or foreign");
    if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe mailbox directory or regular file (hardlink)");
    const mode = directory ? 0o700 : 0o600;
    if ((stat.mode & 0o7777) !== mode) fs.fchmodSync(fd, mode);
    const current = fs.fstatSync(fd);
    if (current.uid !== process.geteuid() || (current.mode & 0o7777) !== mode) throw new Error("Unsafe mailbox permissions");
  }
  function privateDirectory(dir: string, ancestor = false): void {
    let created = false;
    try { fs.mkdirSync(dir, { mode: 0o700 }); created = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
    try {
      if (!ancestor) privateDescriptor(fd, true);
      else {
        // mkdir success does not identify the inode opened afterward. Never
        // chmod ambient ancestors; refuse a nonprivate replacement instead.
        const stat = fs.fstatSync(fd);
        if (!stat.isDirectory() || (created && (typeof process.geteuid !== "function"
          || stat.uid !== process.geteuid() || (stat.mode & 0o7777) !== 0o700))) throw new Error("Unsafe mailbox ancestor directory");
      }
    } finally { fs.closeSync(fd); }
  }
  function prepare(): void {
    // Only create missing ancestors; existing parents and peers are not owned
    // by this adapter and must never have their permissions narrowed.
    const missing: string[] = [];
    let parent = path.dirname(root);
    while (true) {
      try {
        if (!fs.statSync(parent).isDirectory()) throw new Error("Unsafe mailbox ancestor directory");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        missing.push(parent);
        parent = path.dirname(parent);
      }
    }
    for (const dir of missing.reverse()) privateDirectory(dir, true);
    for (const dir of [root, directory, path.join(directory, "assignment")]) privateDirectory(dir);
  }
  function read(): Journal {
    let fd: number;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: "1.0", operations: [], cancelled: [] };
      throw error;
    }
    let value: unknown;
    try {
      const stat = fs.fstatSync(fd);
      privateDescriptor(fd, false);
      if (stat.size > MAX_JOURNAL_BYTES) throw new Error("Unsafe mailbox journal");
      value = JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally { fs.closeSync(fd); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Corrupt mailbox journal");
    const journal = value as Journal;
    if (Object.keys(journal).sort().join(",") !== "cancelled,operations,schemaVersion" || journal.schemaVersion !== "1.0"
      || !Array.isArray(journal.operations) || journal.operations.length > MAILBOX_MAX_OPERATIONS
      || !Array.isArray(journal.cancelled) || journal.cancelled.length > MAILBOX_MAX_OPERATIONS
      || !journal.cancelled.every((key) => typeof key === "string")
      || new Set(journal.cancelled).size !== journal.cancelled.length) throw new Error("Corrupt mailbox journal");
    const ids = new Set<string>();
    const messages = new Set<string>();
    const prior: MailboxOperation[] = [];
    for (const operation of journal.operations) {
      if (!operation || Object.keys(operation).sort().join(",") !== "message,status" || !["pending", "delivered", "acknowledged"].includes(operation.status)) throw new Error("Corrupt mailbox operation");
      const message = validateMailboxMessage(operation.message);
      if (ids.has(message.operationId) || messages.has(message.messageId) || !exchangeAllowed(prior, message)) throw new Error("Conflicting mailbox journal");
      ids.add(message.operationId); messages.add(message.messageId); prior.push(operation);
    }
    return journal;
  }
  function write(journal: Journal): void {
    const data = `${JSON.stringify(journal, null, 2)}\n`;
    if (Buffer.byteLength(data, "utf8") > MAX_JOURNAL_BYTES) throw new Error("Mailbox journal capacity exceeded");
    // Check the existing target before replacement, including ownership and hardlinks.
    let existing: number | undefined;
    try {
      existing = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      privateDescriptor(existing, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally { if (existing !== undefined) fs.closeSync(existing); }
    const temp = path.join(directory, `.state-${randomUUID()}.tmp`);
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      privateDescriptor(fd, false);
      fs.writeFileSync(fd, data, "utf8");
      fs.fsyncSync(fd);
      fs.renameSync(temp, file);
    } finally {
      fs.closeSync(fd);
      fs.rmSync(temp, { force: true });
    }
  }
  function confirmDurability(journal: Journal): void {
    // Also run for unchanged replay and read results: a prior rename may have
    // succeeded before fsync failed. Visibility alone is never confirmation.
    // Re-confirm both the configured pathname and its canonical targets on
    // every reopen. An alias's parent retains its symlink entry even when
    // realpath resolves that entry away (including /var on macOS).
    const ancestors = new Set<string>();
    let lexical = path.dirname(root);
    while (true) {
      let canonical = fs.realpathSync(lexical);
      while (!ancestors.has(canonical)) {
        ancestors.add(canonical);
        const next = path.dirname(canonical);
        if (next === canonical) break;
        canonical = next;
      }
      const next = path.dirname(lexical);
      if (next === lexical) break;
      lexical = next;
    }
    const owned = [file, path.join(directory, "assignment"), directory, root];
    for (const target of [...owned, ...ancestors]) {
      let fd: number;
      try { fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
        | (target === file ? 0 : fs.constants.O_DIRECTORY)); }
      catch (error) {
        if (target === file && (error as NodeJS.ErrnoException).code === "ENOENT" && journal.operations.length === 0 && journal.cancelled.length === 0) continue;
        throw error;
      }
      try {
        if (owned.includes(target)) privateDescriptor(fd, target !== file);
        else if (!fs.fstatSync(fd).isDirectory()) throw new Error("Unsafe mailbox ancestor directory");
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
    }
  }
  async function host(action: Parameters<MailboxHostValidator>[0]["action"], caller: MailboxIdentity, message?: MailboxMessage): Promise<MailboxResult<null>> {
    try {
      const decision = await options.validateHost({ action, caller: structuredClone(caller), ...(message ? { message: structuredClone(message) } : {}) });
      if (decision?.status === "current") return { status: "ok", value: null };
      return decision?.status === "refused" ? refused("host_refused") : { status: "unavailable", code: "host_unavailable" };
    } catch { return { status: "unavailable", code: "host_unavailable" }; }
  }
  async function transaction<T>(body: (journal: Journal) => Promise<MailboxResult<T>>): Promise<MailboxResult<T>> {
    prepare();
    return withSubjectLockAsync(directory, "mailbox-journal", async () => {
      privateDirectory(path.join(directory, "assignment", ".mailbox-journal.lockdir"));
      const journal = read();
      const result = await body(journal);
      if (result.status === "ok") {
        try { confirmDurability(journal); }
        catch { return { status: "unavailable", code: "durability_unconfirmed" }; }
      }
      return result;
    });
  }
  function active(journal: Journal, message: MailboxMessage): boolean {
    if (journal.cancelled.includes(mailboxGroupKey(message.sender))) return false;
    try { assertMailboxActive(message, now()); return true; } catch (error) {
      if (error instanceof MailboxValidationError) return false;
      throw error;
    }
  }
  function exchangeAllowed(operations: MailboxOperation[], message: MailboxMessage): boolean {
    const exchange = operations.filter((operation) => operation.message.exchangeId === message.exchangeId);
    if (isMailboxRequest(message.kind)) {
      const contactKey = (candidate: MailboxMessage): string => canonicalMailboxJson([
        candidate.subjectId,
        [canonicalMailboxJson(candidate.sender), canonicalMailboxJson(candidate.recipient)].sort(),
      ]);
      return exchange.length === 0 && !operations.some((operation) =>
        isMailboxRequest(operation.message.kind) && contactKey(operation.message) === contactKey(message));
    }
    if (exchange.length !== 1 || exchange[0].status === "pending") return false;
    const request = exchange[0].message;
    return isMailboxRequest(request.kind) && message.inReplyTo === request.messageId
      && sameMailboxIdentity(message.sender, request.recipient) && sameMailboxIdentity(message.recipient, request.sender)
      && message.subjectId === request.subjectId && canonicalMailboxJson(message.resourceScope) === canonicalMailboxJson(request.resourceScope)
      && canonicalMailboxJson(message.correlation) === canonicalMailboxJson(request.correlation)
      && message.createdAt >= request.createdAt && message.expiresAt <= request.expiresAt;
  }
  async function enqueue(value: unknown, identity: MailboxIdentity): Promise<MailboxResult<MailboxOperation>> {
    const message = validateMailboxMessage(value);
    const caller = validateMailboxIdentity(identity);
    if (!sameMailboxIdentity(caller, message.sender)) return refused("sender_mismatch");
    return transaction(async (journal) => {
      const admission = await host("send", caller, message);
      if (admission.status !== "ok") return admission;
      if (!active(journal, message)) return refused("inactive");
      const existing = journal.operations.find((op) => op.message.operationId === message.operationId || op.message.messageId === message.messageId);
      if (existing) return canonicalMailboxJson(existing.message) === canonicalMailboxJson(message)
        ? { status: "ok", value: structuredClone(existing) } : refused("conflicting_replay");
      if (!exchangeAllowed(journal.operations, message)) return refused("exchange_bound");
      if (journal.operations.length >= MAILBOX_MAX_OPERATIONS) return refused("capacity");
      const operation: MailboxOperation = { message, status: "pending" };
      journal.operations.push(operation); write(journal);
      return { status: "ok", value: structuredClone(operation) };
    });
  }
  async function transition(operationId: string, identity: MailboxIdentity, action: "deliver" | "ack"): Promise<MailboxResult<MailboxOperation>> {
    const caller = validateMailboxIdentity(identity);
    return transaction(async (journal) => {
      const authentication = await host(action, caller);
      if (authentication.status !== "ok") return authentication;
      const operation = journal.operations.find((op) => op.message.operationId === operationId);
      if (!operation || !sameMailboxIdentity(caller, action === "deliver" ? operation.message.sender : operation.message.recipient)) return refused("operation_unavailable");
      const admission = await host(action, caller, operation.message);
      if (admission.status !== "ok") return admission;
      if (!active(journal, operation.message)) return refused("inactive");
      if (action === "ack" && operation.status === "pending") return refused("not_delivered");
      if (action === "deliver" && operation.status === "pending") { operation.status = "delivered"; write(journal); }
      if (action === "ack" && operation.status === "delivered") { operation.status = "acknowledged"; write(journal); }
      return { status: "ok", value: structuredClone(operation) };
    });
  }
  async function list(identity: MailboxIdentity, side: "inbox" | "outbox"): Promise<MailboxResult<MailboxOperation[]>> {
    const caller = validateMailboxIdentity(identity);
    return transaction(async (journal) => {
      const admission = await host("read", caller);
      if (admission.status !== "ok") return admission;
      if (journal.cancelled.includes(mailboxGroupKey(caller))) return refused("inactive");
      const visible: MailboxOperation[] = [];
      for (const operation of journal.operations) {
        if (!sameMailboxIdentity(caller, side === "inbox" ? operation.message.recipient : operation.message.sender)) continue;
        if (side === "inbox" && (operation.status === "pending" || !active(journal, operation.message))) continue;
        const current = await host("read", caller, operation.message);
        if (current.status !== "ok") return current;
        visible.push(structuredClone(operation));
      }
      return { status: "ok", value: visible };
    });
  }
  async function cancel(identity: MailboxIdentity): Promise<MailboxResult<null>> {
    const caller = validateMailboxIdentity(identity);
    if (caller.actorKey !== caller.controllerActorKey) return refused("controller_required");
    return transaction(async (journal) => {
      const admission = await host("cancel", caller);
      if (admission.status !== "ok") return admission;
      const key = mailboxGroupKey(caller);
      if (!journal.cancelled.includes(key)) {
        if (journal.cancelled.length >= MAILBOX_MAX_OPERATIONS) return refused("capacity");
        journal.cancelled.push(key); write(journal);
      }
      return { status: "ok", value: null };
    });
  }
  return { enqueue, deliver: (id: string, identity: MailboxIdentity) => transition(id, identity, "deliver"),
    acknowledge: (id: string, identity: MailboxIdentity) => transition(id, identity, "ack"),
    inbox: (identity: MailboxIdentity) => list(identity, "inbox"), outbox: (identity: MailboxIdentity) => list(identity, "outbox"), cancel };
}
