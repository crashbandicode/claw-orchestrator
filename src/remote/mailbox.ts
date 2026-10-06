import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { InboxManager } from '../inbox-manager.js';
import { MAX_INBOX_SIZE } from '../constants.js';
import type { ParentToolId } from '../types.js';
import { payloadHash } from './protocol.js';

export type MailStatus = 'queued' | 'delivering' | 'read' | 'uncertain';

export interface MailThread {
  name: string;
  nativeSessionId: string;
  parentToolId?: ParentToolId;
  registeredAt: string;
}

export interface MailMessage {
  id: string;
  threadKey: string;
  from: string;
  fromHost?: string;
  text: string;
  summary?: string;
  payloadHash: string;
  status: MailStatus;
  acceptedAt: string;
  readAt?: string;
}

interface MailReceipt {
  id: string;
  threadKey: string;
  payloadHash: string;
}

interface MailboxState {
  threads: Record<string, MailThread>;
  messages: MailMessage[];
  receipts: MailReceipt[];
}

export interface EnqueueInput {
  id: string;
  threadKey: string;
  from: string;
  fromHost?: string;
  text: string;
  summary?: string;
}

const MAX_TEXT = 1_000_000;

/**
 * Receiver-host mailbox. Messages are durable before any model delivery.
 * A crash while `delivering` becomes `uncertain` and is not sent again.
 * Unread queued messages are kept. Read messages may be evicted only to
 * make room; unread messages are refused instead of dropped.
 */
export class DurableMailbox extends EventEmitter {
  private state: MailboxState = { threads: {}, messages: [], receipts: [] };
  private committed: MailboxState = { threads: {}, messages: [], receipts: [] };
  private chain: Promise<void> = Promise.resolve();
  private readonly inbox = new InboxManager();
  private readonly file: string;

  constructor(directory: string) {
    super();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    this.file = path.join(directory, 'mailbox.json');
    this.load();
  }

  getThread(name: string): MailThread | undefined {
    return this.state.threads[name];
  }

  findByNativeSessionId(nativeSessionId: string): MailThread | undefined {
    return Object.values(this.state.threads).find((thread) => thread.nativeSessionId === nativeSessionId);
  }

  async register(input: { name: string; nativeSessionId: string; parentToolId?: ParentToolId }): Promise<MailThread> {
    return this.mutate(() => {
      const existing = this.state.threads[input.name];
      if (existing) {
        if (existing.nativeSessionId !== input.nativeSessionId) {
          throw new Error(`Manual thread '${input.name}' is already registered to a different native session`);
        }
        return existing;
      }
      const thread: MailThread = {
        name: input.name,
        nativeSessionId: input.nativeSessionId,
        ...(input.parentToolId ? { parentToolId: input.parentToolId } : {}),
        registeredAt: new Date().toISOString(),
      };
      this.state.threads[input.name] = thread;
      this.persist();
      return thread;
    });
  }

  async enqueue(input: EnqueueInput): Promise<{ message: MailMessage; duplicate: boolean }> {
    if (input.text.length > MAX_TEXT) throw new Error('message exceeds the mailbox size cap');
    const hash = payloadHash({
      threadKey: input.threadKey,
      from: input.from,
      fromHost: input.fromHost,
      text: input.text,
      summary: input.summary,
    });
    return this.mutate(() => {
      const existing = this.state.messages.find((message) => message.id === input.id);
      const receipt = this.state.receipts.find((item) => item.id === input.id);
      const priorHash = existing?.payloadHash ?? receipt?.payloadHash;
      if (priorHash) {
        if (priorHash !== hash) {
          throw new Error(`message '${input.id}' was already accepted with a different payload`);
        }
        if (existing) return { message: existing, duplicate: true };
        return {
          message: {
            id: input.id,
            threadKey: input.threadKey,
            from: input.from,
            text: input.text,
            payloadHash: hash,
            status: 'read' as const,
            acceptedAt: new Date().toISOString(),
            readAt: new Date().toISOString(),
          },
          duplicate: true,
        };
      }
      this.makeRoom(input.threadKey);
      const message: MailMessage = {
        id: input.id,
        threadKey: input.threadKey,
        from: input.from,
        ...(input.fromHost ? { fromHost: input.fromHost } : {}),
        text: input.text,
        ...(input.summary ? { summary: input.summary } : {}),
        payloadHash: hash,
        status: 'queued',
        acceptedAt: new Date().toISOString(),
      };
      this.state.messages.push(message);
      this.persist();
      this.emit('enqueued', input.threadKey);
      return { message, duplicate: false };
    });
  }

  read(threadKey: string, unreadOnly = true): MailMessage[] {
    return this.state.messages.filter((message) => {
      if (message.threadKey !== threadKey) return false;
      if (!unreadOnly) return true;
      return message.status === 'queued';
    });
  }

  async ack(ids: string[]): Promise<{ acked: string[]; missing: string[] }> {
    return this.mutate(() => {
      const acked: string[] = [];
      const missing: string[] = [];
      for (const id of ids) {
        const message = this.state.messages.find((item) => item.id === id);
        if (!message) {
          missing.push(id);
          continue;
        }
        if (message.status !== 'read') {
          message.status = 'read';
          message.readAt = new Date().toISOString();
        }
        acked.push(id);
      }
      this.persist();
      return { acked, missing };
    });
  }

  wait(
    threadKey: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ messages: MailMessage[]; timedOut: boolean }> {
    const pending = this.read(threadKey, true);
    if (signal?.aborted) return Promise.resolve({ messages: pending, timedOut: true });
    if (pending.length > 0) return Promise.resolve({ messages: pending, timedOut: false });
    return new Promise((resolve) => {
      const onEnqueue = (key: string): void => {
        if (key !== threadKey) return;
        cleanup();
        resolve({ messages: this.read(threadKey, true), timedOut: false });
      };
      const onAbort = (): void => {
        cleanup();
        resolve({ messages: this.read(threadKey, true), timedOut: true });
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve({ messages: this.read(threadKey, true), timedOut: true });
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.removeListener('enqueued', onEnqueue);
        signal?.removeEventListener('abort', onAbort);
      };
      this.on('enqueued', onEnqueue);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Move one queued message to delivering. Returns false when another caller already claimed it. */
  async claimQueued(id: string): Promise<boolean> {
    return this.mutate(() => {
      const message = this.state.messages.find((item) => item.id === id);
      if (!message || message.status !== 'queued') return false;
      message.status = 'delivering';
      this.persist();
      return true;
    });
  }

  async markDelivering(id: string): Promise<void> {
    await this.mutate(() => {
      const message = this.require(id);
      if (message.status === 'queued') message.status = 'delivering';
      this.persist();
    });
  }

  async markRead(id: string): Promise<void> {
    await this.mutate(() => {
      const message = this.require(id);
      message.status = 'read';
      message.readAt = new Date().toISOString();
      this.persist();
    });
  }

  async markUncertain(id: string): Promise<void> {
    await this.mutate(() => {
      const message = this.require(id);
      if (message.status !== 'read') message.status = 'uncertain';
      this.persist();
    });
  }

  async revertToQueued(id: string): Promise<void> {
    await this.mutate(() => {
      const message = this.require(id);
      if (message.status === 'delivering') message.status = 'queued';
      this.persist();
    });
  }

  envelope(message: MailMessage): string {
    return this.inbox.wrapCrossSessionMessage({
      from: message.from,
      text: message.text,
      timestamp: message.acceptedAt,
      read: false,
      ...(message.summary ? { summary: message.summary } : {}),
      ...(message.fromHost ? { host: message.fromHost } : {}),
      id: message.id,
    });
  }

  private require(id: string): MailMessage {
    const message = this.state.messages.find((item) => item.id === id);
    if (!message) throw new Error(`message '${id}' is not in the mailbox`);
    return message;
  }

  private makeRoom(threadKey: string): void {
    const mine = this.state.messages.filter((message) => message.threadKey === threadKey);
    if (mine.length < MAX_INBOX_SIZE) return;
    const readIndex = this.state.messages.findIndex(
      (message) => message.threadKey === threadKey && message.status === 'read',
    );
    if (readIndex >= 0) {
      const [removed] = this.state.messages.splice(readIndex, 1);
      if (removed) {
        this.state.receipts.push({ id: removed.id, threadKey: removed.threadKey, payloadHash: removed.payloadHash });
      }
      return;
    }
    throw new Error(`mailbox for '${threadKey}' is full of unread messages`);
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return;
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as MailboxState;
    this.state = {
      threads: parsed.threads ?? {},
      messages: (parsed.messages ?? []).map((message) =>
        message.status === 'delivering' ? { ...message, status: 'uncertain' as const } : message,
      ),
      receipts: parsed.receipts ?? [],
    };
    this.committed = cloneState(this.state);
    if ((parsed.messages ?? []).some((message) => message.status === 'delivering')) this.persist();
  }

  private persist(): void {
    const snapshot = cloneState(this.state);
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(snapshot));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.file);
      fs.chmodSync(this.file, 0o600);
      const dirfd = fs.openSync(path.dirname(this.file), 'r');
      try {
        fs.fsyncSync(dirfd);
      } finally {
        fs.closeSync(dirfd);
      }
      this.committed = snapshot;
    } catch (err) {
      this.state = cloneState(this.committed);
      try {
        fs.unlinkSync(tmp);
      } catch {
        // the temporary file may not exist
      }
      throw err;
    }
  }

  private async mutate<T>(fn: () => T): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function cloneState(state: MailboxState): MailboxState {
  return {
    threads: { ...state.threads },
    messages: state.messages.map((message) => ({ ...message })),
    receipts: state.receipts.map((receipt) => ({ ...receipt })),
  };
}
