import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { randomUUID } from 'node:crypto';

import { ENGINE_TYPES, PARENT_TOOL_IDS, type EffortLevel, type ParentToolId, type SessionConfig } from '../types.js';
import { sanitizeCwd } from '../validation.js';
import type { RemoteBrokerHost } from './broker-host.js';
import { DurableMailbox, type MailMessage, type MailThread } from './mailbox.js';
import { OperationStore } from './operation-store.js';
import {
  MAX_FRAME_BYTES,
  asRecord,
  assertOperationId,
  isBrokerMethod,
  isTerminalStatus,
  optionalString,
  payloadHash,
  requiredString,
  requiredText,
  type BrokerMethod,
  type ResultFrame,
  type SubmitFrame,
} from './protocol.js';
import { assertHostAlias, assertSocketPath, isWindowsPipePath, qualifySessionName } from './qualified-name.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSPORT_KEYS = new Set([
  'host',
  'operationId',
  'waitTimeout',
  'stream',
  'from',
  'to',
  'summary',
  'messageId',
  'message',
]);

export interface RemoteBrokerOptions {
  localHost: string;
  operations: OperationStore;
  mailbox: DurableMailbox;
}

/**
 * Execution-host broker. One process owns the SessionManager. Closing a
 * client socket detaches that client only. `closeOwned` is the service
 * shutdown and stops engines this broker started.
 */
export class RemoteBroker {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly listeners = new Map<string, Set<net.Socket>>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly deliveryChains = new Map<string, Promise<void>>();
  private readonly shutdownAbort = new AbortController();

  constructor(
    private readonly sessions: RemoteBrokerHost,
    private readonly options: RemoteBrokerOptions,
  ) {
    assertHostAlias(options.localHost);
  }

  async listen(socketPath: string): Promise<void> {
    assertSocketPath(socketPath);
    if (await probeBrokerSocket(socketPath)) {
      throw new Error('A broker is already listening on this socket');
    }
    this.options.operations.claimOwner();
    try {
      this.options.operations.reconcile();
      await this.bind(socketPath);
    } catch (err) {
      this.options.operations.releaseOwner();
      throw err;
    }
  }

  private async bind(socketPath: string): Promise<void> {
    const pipe = isWindowsPipePath(socketPath);
    if (!pipe) {
      const directory = path.dirname(socketPath);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(directory, 0o700);
      if (fs.existsSync(socketPath)) {
        if (!fs.lstatSync(socketPath).isSocket()) {
          throw new Error('Refusing to replace a non-socket at the broker path');
        }
        fs.unlinkSync(socketPath);
      }
    }
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => this.onConnection(socket));
      server.once('error', reject);
      const listening = (): void => {
        if (!pipe) {
          try {
            fs.chmodSync(socketPath, 0o600);
          } catch (err) {
            reject(err as Error);
            return;
          }
        }
        this.server = server;
        resolve();
      };
      if (pipe) {
        server.listen({ path: socketPath, readableAll: false, writableAll: false }, listening);
      } else {
        server.listen(socketPath, listening);
      }
    });
  }

  /** Stop accepting clients and detach sockets. Sessions keep running. */
  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.listeners.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** Service shutdown: detach clients, then stop this broker's engines. */
  async closeOwned(): Promise<void> {
    this.shutdownAbort.abort();
    await this.close();
    await this.sessions.shutdown();
    await Promise.allSettled([...this.jobs.values()]);
    this.options.operations.releaseOwner();
  }

  private onConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.sockets.delete(socket);
      for (const waiters of this.listeners.values()) waiters.delete(socket);
    });
    const lines = readline.createInterface({ input: socket, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      void this.onLine(socket, line);
    });
  }

  private async onLine(socket: net.Socket, line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.write(socket, { kind: 'result', id: 'invalid', status: 'rejected', error: 'frame is not JSON' });
      return;
    }
    const frame = parsed as Partial<SubmitFrame>;
    if (frame.kind !== 'submit' || typeof frame.id !== 'string' || typeof frame.method !== 'string') {
      this.write(socket, { kind: 'result', id: 'invalid', status: 'rejected', error: 'frame is not a submit' });
      return;
    }
    try {
      assertOperationId(frame.id);
      if (!isBrokerMethod(frame.method)) throw new Error(`Unknown broker method '${frame.method}'`);
      const payload = asRecord(frame.payload);
      const hash = payloadHash(payload);
      if (frame.payloadHash !== hash) {
        throw new Error('payloadHash does not match the payload');
      }
      await this.accept(socket, {
        kind: 'submit',
        id: frame.id,
        method: frame.method,
        payloadHash: hash,
        payload,
      });
    } catch (err) {
      this.write(socket, {
        kind: 'result',
        id: frame.id,
        status: 'rejected',
        error: (err as Error).message,
      });
    }
  }

  private async accept(socket: net.Socket, frame: SubmitFrame): Promise<void> {
    await this.withLock(frame.id, async () => {
      const existing = this.options.operations.get(frame.id);
      if (existing) {
        if (existing.method !== frame.method) {
          this.write(socket, {
            kind: 'result',
            id: frame.id,
            status: 'rejected',
            error: 'operation id was accepted for a different method',
          });
          return;
        }
        if (existing.payloadHash !== frame.payloadHash) {
          this.write(socket, {
            kind: 'result',
            id: frame.id,
            status: 'rejected',
            error: 'operation payload does not match the accepted payload',
          });
          return;
        }
        if (isTerminalStatus(existing.status)) {
          this.write(socket, {
            kind: 'result',
            id: frame.id,
            status: existing.status,
            result: existing.result,
            error: existing.error,
          });
          return;
        }
        this.write(socket, { kind: 'result', id: frame.id, status: 'accepted' });
        this.track(socket, frame.id);
        return;
      }
      this.options.operations.accept({ id: frame.id, method: frame.method, payloadHash: frame.payloadHash });
      this.write(socket, { kind: 'result', id: frame.id, status: 'accepted' });
      this.track(socket, frame.id);
      this.options.operations.markRunning(frame.id);
      const job = this.execute(frame);
      this.jobs.set(frame.id, job);
      void job.finally(() => this.jobs.delete(frame.id));
    });
  }

  private async execute(frame: SubmitFrame): Promise<void> {
    try {
      const result = await this.dispatch(frame.method, asRecord(frame.payload));
      this.options.operations.complete(frame.id, result);
    } catch (err) {
      this.options.operations.fail(frame.id, (err as Error).message);
    }
    this.publish(frame.id);
  }

  private async dispatch(method: BrokerMethod, payload: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'session.start':
        return this.sessionStart(payload);
      case 'session.send':
        return this.sessionSend(payload);
      case 'session.stop':
        return this.sessionStop(payload);
      case 'session.list':
        return {
          ok: true,
          sessions: this.sessions.listSessions(),
          persisted: this.sessions.listPersistedSessions(),
        };
      case 'session.status':
        return { ok: true, ...this.sessions.getStatus(requiredString(payload.name, 'name')) };
      case 'session.overview':
        return this.sessions.health();
      case 'session.side':
        return this.sessionSide(payload);
      case 'inbox.send':
        return this.inboxSend(payload);
      case 'inbox.read':
        return this.inboxRead(payload);
      case 'inbox.deliver':
        return this.inboxDeliver(payload);
      case 'thread.register':
        return this.threadRegister(payload);
      case 'thread.send':
        return this.threadSend(payload);
      case 'thread.read':
        return this.threadRead(payload);
      case 'thread.ack':
        return this.threadAck(payload);
      case 'thread.wait':
        return this.threadWait(payload);
      default:
        throw new Error(`Unknown broker method '${method}'`);
    }
  }

  private async sessionStart(payload: Record<string, unknown>): Promise<unknown> {
    const name = optionalString(payload.name, 'name') ?? `session-${Date.now()}`;
    if (name.includes('::')) throw new Error('Session name cannot contain ::');
    const resumeSessionId = optionalString(payload.resumeSessionId, 'resumeSessionId');
    const manual = this.manualThreadFor(name, resumeSessionId);
    this.assertCanOwn(name, resumeSessionId ?? manual?.nativeSessionId);
    const originHost = optionalString(payload.originHost, 'originHost');
    if (originHost) assertHostAlias(originHost);
    const parentMachineId = optionalString(payload.parentMachineId, 'parentMachineId');
    if (parentMachineId && !UUID_RE.test(parentMachineId)) throw new Error('parentMachineId must be a UUID');
    const parentToolId = this.parentTool(payload.parentToolId);
    const config: Partial<SessionConfig> & { name: string } = { name };
    for (const [key, value] of Object.entries(payload)) {
      if (TRANSPORT_KEYS.has(key) || key === 'executionHost' || key === 'remoteSessionHandle') continue;
      (config as Record<string, unknown>)[key] = value;
    }
    config.name = name;
    config.executionHost = this.options.localHost;
    if (originHost && originHost !== this.options.localHost) {
      config.remoteSessionHandle = qualifySessionName(this.options.localHost, name);
    } else {
      delete config.remoteSessionHandle;
    }
    if (parentMachineId) config.parentMachineId = parentMachineId.toLowerCase();
    if (parentToolId) config.parentToolId = parentToolId;
    if (manual && !config.resumeSessionId) config.resumeSessionId = manual.nativeSessionId;
    if (!config.engine && manual) {
      const inferred = this.engineForManual(manual);
      if (inferred) config.engine = inferred;
    }
    if (typeof config.engine === 'string' && !(ENGINE_TYPES as readonly string[]).includes(config.engine)) {
      throw new Error(`Unknown engine '${config.engine}'`);
    }
    if (typeof config.cwd === 'string') config.cwd = sanitizeCwd(config.cwd);
    this.sessions.holdSession(name);
    try {
      const info = await this.sessions.startSession(config);
      return { ok: true, ...info, localName: info.name };
    } finally {
      this.sessions.releaseSessionHold(name);
    }
  }

  private async sessionSend(payload: Record<string, unknown>): Promise<unknown> {
    const name = requiredString(payload.name, 'name');
    const message = requiredText(payload.message, 'message');
    if (!this.sessions.hasLiveSession(name)) throw new Error(`Session '${name}' not found`);
    const timeout = this.finiteNumber(payload.timeout, 'timeout');
    const effort = optionalString(payload.effort, 'effort') as EffortLevel | undefined;
    const plan = payload.plan === true ? true : undefined;
    this.sessions.holdSession(name);
    try {
      const result = await this.sessions.sendMessage(name, message, {
        ...(timeout !== undefined ? { timeout } : {}),
        ...(effort ? { effort } : {}),
        ...(plan ? { plan: true } : {}),
      });
      return { ok: true, ...result };
    } finally {
      this.sessions.releaseSessionHold(name);
    }
  }

  private async sessionSide(payload: Record<string, unknown>): Promise<unknown> {
    const name = requiredString(payload.name, 'name');
    const prompt = requiredText(payload.prompt, 'prompt');
    const timeout = this.finiteNumber(payload.timeout, 'timeout');
    if (!this.sessions.hasLiveSession(name)) throw new Error(`Session '${name}' not found`);
    this.sessions.holdSession(name);
    try {
      return await this.sessions.codexSide(name, prompt, timeout);
    } finally {
      this.sessions.releaseSessionHold(name);
    }
  }

  private async sessionStop(payload: Record<string, unknown>): Promise<unknown> {
    const name = requiredString(payload.name, 'name');
    await this.sessions.stopSession(name);
    return { ok: true };
  }

  private async inboxSend(payload: Record<string, unknown>): Promise<unknown> {
    const from = requiredString(payload.from, 'from');
    const to = requiredString(payload.to, 'to');
    const message = requiredText(payload.message, 'message');
    const summary = optionalString(payload.summary, 'summary');
    const fromHost = optionalString(payload.fromHost, 'fromHost');
    const messageId = optionalString(payload.messageId, 'messageId') ?? randomUUID();
    assertOperationId(messageId);
    if (to === '*') {
      const results = [];
      for (const session of this.sessions.listSessions()) {
        if (session.name === from) continue;
        results.push(
          await this.deliverManaged({
            id: `${messageId}:${session.name}`,
            threadKey: session.name,
            from,
            fromHost,
            text: message,
            summary,
          }),
        );
      }
      return {
        ok: true,
        delivered: results.some((item) => item.status === 'read'),
        queued: results.some((item) => item.status === 'queued' || item.status === 'uncertain'),
        messages: results,
      };
    }
    const manual = this.options.mailbox.getThread(to);
    const live = this.sessions.hasLiveSession(to);
    if (!live && !manual) {
      throw new Error(`Target '${to}' is not a live session or a registered manual thread; refusing to resume`);
    }
    if (!live && manual) {
      const queued = await this.options.mailbox.enqueue({
        id: messageId,
        threadKey: to,
        from,
        fromHost,
        text: message,
        summary,
      });
      return {
        ok: true,
        delivered: false,
        queued: queued.message.status === 'queued',
        status: queued.message.status,
        messageId: queued.message.id,
        duplicate: queued.duplicate,
      };
    }
    return this.deliverManaged({ id: messageId, threadKey: to, from, fromHost, text: message, summary });
  }

  private async deliverManaged(input: {
    id: string;
    threadKey: string;
    from: string;
    fromHost?: string;
    text: string;
    summary?: string;
  }): Promise<{
    ok: true;
    delivered: boolean;
    queued: boolean;
    status: string;
    messageId: string;
    duplicate: boolean;
  }> {
    const { message, duplicate } = await this.options.mailbox.enqueue(input);
    if (!duplicate && message.status === 'queued' && this.sessions.hasLiveSession(input.threadKey)) {
      await this.pushToSession(message);
    }
    const current = this.options.mailbox.read(input.threadKey, false).find((item) => item.id === message.id) ?? message;
    return {
      ok: true,
      delivered: current.status === 'read',
      queued: current.status === 'queued',
      status: current.status,
      messageId: current.id,
      duplicate,
    };
  }

  private async pushToSession(message: MailMessage): Promise<void> {
    const previous = this.deliveryChains.get(message.threadKey) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(
      () => gate,
      () => gate,
    );
    this.deliveryChains.set(message.threadKey, tail);
    await previous;
    try {
      await this.deliverClaimed(message);
    } finally {
      release();
      if (this.deliveryChains.get(message.threadKey) === tail) this.deliveryChains.delete(message.threadKey);
    }
  }

  private async deliverClaimed(message: MailMessage): Promise<void> {
    if (!this.sessions.hasLiveSession(message.threadKey) || this.sessions.isSessionBusy(message.threadKey)) return;
    const claimed = await this.options.mailbox.claimQueued(message.id);
    if (!claimed) return;
    this.sessions.holdSession(message.threadKey);
    try {
      await this.sessions.sendMessage(message.threadKey, this.options.mailbox.envelope(message));
      await this.options.mailbox.markRead(message.id);
    } catch (err) {
      const text = (err as Error).message;
      if (/still in progress/i.test(text)) {
        await this.options.mailbox.revertToQueued(message.id);
        return;
      }
      await this.options.mailbox.markUncertain(message.id);
      if (/Timeout waiting/i.test(text)) {
        throw new Error(`message ${message.id} became uncertain after a native wait timeout and was not retried`);
      }
      throw err;
    } finally {
      this.sessions.releaseSessionHold(message.threadKey);
    }
  }

  private inboxRead(payload: Record<string, unknown>): unknown {
    const name = requiredString(payload.name, 'name');
    const unreadOnly = payload.unreadOnly !== false;
    const messages = this.options.mailbox.read(name, unreadOnly);
    return { ok: true, count: messages.length, messages };
  }

  private async inboxDeliver(payload: Record<string, unknown>): Promise<unknown> {
    const name = requiredString(payload.name, 'name');
    const thread = this.options.mailbox.getThread(name);
    if (thread && !this.sessions.hasLiveSession(name)) {
      const engine = optionalString(payload.engine, 'engine') ?? this.engineForManual(thread);
      if (!engine) {
        throw new Error(
          `Manual thread '${name}' has no live session. Pass engine to start it (opencode, codex-app, claude, or cursor).`,
        );
      }
      const cwd = optionalString(payload.cwd, 'cwd');
      await this.sessionStart({
        name,
        engine,
        resumeSessionId: thread.nativeSessionId,
        ...(cwd ? { cwd } : {}),
        ...(thread.parentToolId ? { parentToolId: thread.parentToolId } : {}),
      });
    }
    if (!this.sessions.hasLiveSession(name)) throw new Error(`Session '${name}' not found`);
    let delivered = 0;
    for (const message of this.options.mailbox.read(name, true)) {
      await this.pushToSession(message);
      const updated = this.options.mailbox.read(name, false).find((item) => item.id === message.id);
      if (updated?.status === 'read') delivered++;
    }
    return { ok: true, delivered };
  }

  private async threadRegister(payload: Record<string, unknown>): Promise<unknown> {
    const name = requiredString(payload.name, 'name');
    const nativeSessionId = requiredString(payload.nativeSessionId, 'nativeSessionId');
    if (name.includes('::')) throw new Error('Thread name cannot contain ::');
    if (this.sessions.hasLiveSession(name)) {
      throw new Error(`Refusing to register '${name}' over a live managed session`);
    }
    const thread = await this.options.mailbox.register({
      name,
      nativeSessionId,
      parentToolId: this.parentTool(payload.parentToolId),
    });
    return { ok: true, ...thread, resumed: false };
  }

  private async threadSend(payload: Record<string, unknown>): Promise<unknown> {
    const name = requiredString(payload.name, 'name');
    if (!this.options.mailbox.getThread(name)) {
      throw new Error(`Manual thread '${name}' is not registered; refusing to resume`);
    }
    return this.inboxSend({ ...payload, to: name });
  }

  private threadRead(payload: Record<string, unknown>): unknown {
    const name = requiredString(payload.name, 'name');
    if (!this.options.mailbox.getThread(name) && !this.sessions.hasLiveSession(name)) {
      throw new Error(`Manual thread '${name}' is not registered; refusing to resume`);
    }
    return this.inboxRead(payload);
  }

  private async threadAck(payload: Record<string, unknown>): Promise<unknown> {
    const ids = Array.isArray(payload.messageIds)
      ? payload.messageIds.filter((id): id is string => typeof id === 'string')
      : [requiredString(payload.messageId, 'messageId')];
    const result = await this.options.mailbox.ack(ids);
    return { ok: true, ...result };
  }

  private async threadWait(payload: Record<string, unknown>): Promise<unknown> {
    const name = requiredString(payload.name, 'name');
    if (!this.options.mailbox.getThread(name)) {
      throw new Error(`Manual thread '${name}' is not registered; refusing to resume`);
    }
    const waitTimeout = this.finiteNumber(payload.waitTimeout, 'waitTimeout') ?? 30_000;
    if (waitTimeout < 0 || waitTimeout > 3_600_000) throw new Error('waitTimeout must be between 0 and 3600000 ms');
    const waited = await this.options.mailbox.wait(name, waitTimeout, this.shutdownAbort.signal);
    if (this.shutdownAbort.signal.aborted) throw new Error('broker shutting down');
    return { ok: true, timedOut: waited.timedOut, count: waited.messages.length, messages: waited.messages };
  }

  /** A registered manual thread may be started. A live managed session may not gain a second owner. */
  private manualThreadFor(name: string, resumeSessionId?: string): MailThread | undefined {
    const byName = this.options.mailbox.getThread(name);
    const byNative = resumeSessionId ? this.options.mailbox.findByNativeSessionId(resumeSessionId) : undefined;
    if (byName && resumeSessionId && byName.nativeSessionId !== resumeSessionId) {
      throw new Error(`Resume id '${resumeSessionId}' does not match manual thread '${byName.name}'`);
    }
    if (byName && byNative && byName.name !== byNative.name) {
      throw new Error(`Native session '${resumeSessionId}' belongs to manual thread '${byNative.name}'`);
    }
    return byName ?? byNative;
  }

  private assertCanOwn(name: string, nativeSessionId?: string): void {
    if (this.sessions.hasLiveSession(name)) {
      throw new Error(`Refusing to attach a second owner to live session '${name}'`);
    }
    if (!nativeSessionId) return;
    const owner = this.sessions.listSessions().find((session) => session.claudeSessionId === nativeSessionId);
    if (owner) throw new Error(`Refusing to attach a second owner to live session '${owner.name}'`);
  }

  private engineForManual(thread: MailThread): SessionConfig['engine'] | undefined {
    switch (thread.parentToolId) {
      case 'codex':
        return 'codex-app';
      case 'claude_code':
        return 'claude';
      case 'cursor':
        return 'cursor';
      case 'opencode':
        return 'opencode';
      default:
        return thread.nativeSessionId.startsWith('ses_') ? 'opencode' : undefined;
    }
  }

  private parentTool(value: unknown): ParentToolId | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || !(PARENT_TOOL_IDS as readonly string[]).includes(value)) {
      throw new Error('parentToolId must be codex, claude_code, cursor, or opencode');
    }
    return value as ParentToolId;
  }

  private finiteNumber(value: unknown, field: string): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
    return value;
  }

  private async withLock(id: string, fn: () => Promise<void>): Promise<void> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.locks.set(id, tail);
    await previous;
    try {
      await fn();
    } finally {
      release();
      if (this.locks.get(id) === tail) this.locks.delete(id);
    }
  }

  private track(socket: net.Socket, id: string): void {
    let waiters = this.listeners.get(id);
    if (!waiters) {
      waiters = new Set();
      this.listeners.set(id, waiters);
    }
    waiters.add(socket);
  }

  private publish(id: string): void {
    const record = this.options.operations.get(id);
    const waiters = this.listeners.get(id);
    this.listeners.delete(id);
    if (!record || !waiters) return;
    for (const socket of waiters) {
      this.write(socket, {
        kind: 'result',
        id,
        status: record.status,
        result: record.result,
        error: record.error,
      });
    }
  }

  private write(socket: net.Socket, frame: ResultFrame): void {
    if (socket.destroyed) return;
    let line = JSON.stringify(frame);
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
      line = JSON.stringify({
        kind: 'result',
        id: frame.id,
        status: frame.status,
        error: 'result exceeded the frame cap and was not replayed',
        result: { truncated: true },
      });
    }
    try {
      socket.write(`${line}\n`, (err) => {
        if (err) socket.destroy();
      });
    } catch {
      socket.destroy();
    }
  }
}

/** Probe and claim the operation store before a SessionManager is constructed. */
export async function prepareBrokerOwnership(socketPath: string, operations: OperationStore): Promise<void> {
  assertSocketPath(socketPath);
  if (await probeBrokerSocket(socketPath)) {
    throw new Error('A broker is already listening on this socket');
  }
  operations.claimOwner();
}

async function probeBrokerSocket(socketPath: string): Promise<boolean> {
  if (!fs.existsSync(socketPath)) return false;
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (live: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(live);
    };
    socket.setTimeout(200, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
