import { randomUUID } from 'node:crypto';
import * as net from 'node:net';
import * as readline from 'node:readline';

import {
  assertOperationId,
  isBrokerMethod,
  isTerminalStatus,
  payloadHash,
  type BrokerMethod,
  type OperationStatus,
  type ResultFrame,
  type SubmitFrame,
} from './protocol.js';

export interface RemoteCallOptions {
  operationId?: string;
  /** How long to wait after the broker accepts. Distinct from native execution timeout. */
  waitTimeoutMs?: number;
}

export interface RemoteCallResult {
  operationId: string;
  status: OperationStatus;
  result?: unknown;
  error?: string;
}

interface Waiter {
  socket: net.Socket;
  onFrame: (frame: ResultFrame) => void;
  fail: (err: Error) => void;
}

interface InflightCall {
  method: BrokerMethod;
  payloadHash: string;
  promise: Promise<RemoteCallResult>;
}

/**
 * NDJSON client. A dropped socket after acceptance does not submit a second
 * execution. The same operation id is retried only until the broker accepts it.
 * One connection is shared, including calls that start together.
 */
export class RemoteClient {
  private socket: net.Socket | null = null;
  private opening: net.Socket | null = null;
  private openingFail: ((err: Error) => void) | null = null;
  private connectPromise: Promise<void> | null = null;
  private pending = new Map<string, Waiter>();
  private calls = new Map<string, InflightCall>();
  private closed = false;

  constructor(
    private readonly socketPath: string,
    private readonly connectAttempts = 3,
  ) {}

  async call(method: BrokerMethod, payload: unknown, options: RemoteCallOptions = {}): Promise<RemoteCallResult> {
    if (!isBrokerMethod(method)) throw new Error(`Unknown broker method '${method}'`);
    const id = options.operationId ?? randomUUID();
    assertOperationId(id);
    const hash = payloadHash(payload);
    const existing = this.calls.get(id);
    if (existing) {
      if (existing.method !== method || existing.payloadHash !== hash) {
        throw new Error(`Operation '${id}' is already in flight with a different method or payload`);
      }
      return existing.promise;
    }
    const frame: SubmitFrame = { kind: 'submit', id, method, payloadHash: hash, payload };
    const record: InflightCall = { method, payloadHash: hash, promise: this.attempt(frame, options.waitTimeoutMs) };
    this.calls.set(id, record);
    try {
      return await record.promise;
    } finally {
      if (this.calls.get(id) === record) this.calls.delete(id);
    }
  }

  close(): void {
    this.closed = true;
    const opening = this.opening;
    this.opening = null;
    if (opening && !opening.destroyed) opening.destroy();
    this.openingFail?.(new Error('remote client closed'));
    this.dropSocket();
    for (const waiter of this.pending.values()) waiter.fail(new Error('remote client closed'));
    this.pending.clear();
  }

  private async attempt(frame: SubmitFrame, waitTimeoutMs?: number): Promise<RemoteCallResult> {
    let last: Error | undefined;
    for (let attempt = 0; attempt < this.connectAttempts; attempt++) {
      try {
        await this.ensureConnected();
        return await this.submit(frame, waitTimeoutMs);
      } catch (err) {
        last = err as Error;
        this.dropSocket();
        if (this.closed || attempt + 1 >= this.connectAttempts) break;
        await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
      }
    }
    throw new Error(
      `Cannot reach Claw broker: ${last?.message ?? 'unknown error'}. operationId=${frame.id}; acceptance is unknown and the operation was not replayed`,
    );
  }

  private submit(frame: SubmitFrame, waitTimeoutMs?: number): Promise<RemoteCallResult> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error('broker socket is closed'));
    return new Promise((resolve, reject) => {
      let settled = false;
      let sawAccepted = false;
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      const acceptTimer = setTimeout(() => fail(new Error('timed out waiting for broker acceptance')), 10_000);
      const finish = (result: RemoteCallResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(acceptTimer);
        if (waitTimer) clearTimeout(waitTimer);
        const waiter = this.pending.get(frame.id);
        if (waiter?.socket === socket) this.pending.delete(frame.id);
        resolve(result);
      };
      const fail = (err: Error): void => {
        if (settled) return;
        if (sawAccepted) {
          finish({ operationId: frame.id, status: 'running' });
          return;
        }
        settled = true;
        clearTimeout(acceptTimer);
        if (waitTimer) clearTimeout(waitTimer);
        const waiter = this.pending.get(frame.id);
        if (waiter?.socket === socket) this.pending.delete(frame.id);
        reject(err);
      };
      this.pending.set(frame.id, {
        socket,
        onFrame: (msg) => {
          if (msg.status === 'accepted') {
            sawAccepted = true;
            clearTimeout(acceptTimer);
            if (waitTimeoutMs !== undefined && waitTimeoutMs >= 0) {
              waitTimer = setTimeout(() => finish({ operationId: frame.id, status: 'running' }), waitTimeoutMs);
            }
            return;
          }
          if (isTerminalStatus(msg.status)) {
            finish({ operationId: frame.id, status: msg.status, result: msg.result, error: msg.error });
          }
        },
        fail,
      });
      try {
        socket.write(`${JSON.stringify(frame)}\n`, (err) => {
          if (err) fail(err);
        });
      } catch (err) {
        fail(err as Error);
      }
    });
  }

  private ensureConnected(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('remote client closed'));
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (!this.connectPromise) {
      const connecting = this.open().finally(() => {
        if (this.connectPromise === connecting) this.connectPromise = null;
      });
      this.connectPromise = connecting;
    }
    return this.connectPromise;
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error('remote client closed'));
        return;
      }
      const socket = net.createConnection(this.socketPath);
      this.opening = socket;
      let settled = false;
      let fail = (_err: Error): void => undefined;
      const stop = (): void => {
        socket.removeListener('error', onError);
        socket.removeListener('connect', onConnect);
        socket.removeListener('close', onClose);
        if (this.openingFail === fail) this.openingFail = null;
      };
      fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        stop();
        if (this.opening === socket) this.opening = null;
        if (!socket.destroyed) socket.destroy();
        reject(err);
      };
      const onError = (err: Error): void => fail(err);
      const onClose = (): void => fail(new Error('remote client closed'));
      const onConnect = (): void => {
        if (settled) return;
        if (this.closed || socket.destroyed) {
          fail(new Error('remote client closed'));
          return;
        }
        settled = true;
        stop();
        if (this.opening === socket) this.opening = null;
        this.attach(socket);
        resolve();
      };
      this.openingFail = fail;
      socket.once('error', onError);
      socket.once('close', onClose);
      socket.once('connect', onConnect);
    });
  }

  private attach(socket: net.Socket): void {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('error', () => {
      socket.destroy();
    });
    const lines = readline.createInterface({ input: socket, crlfDelay: Infinity });
    lines.on('line', (line) => {
      let frame: ResultFrame;
      try {
        frame = JSON.parse(line) as ResultFrame;
      } catch {
        return;
      }
      if (!frame || frame.kind !== 'result' || typeof frame.id !== 'string') return;
      const waiter = this.pending.get(frame.id);
      if (waiter?.socket === socket) waiter.onFrame(frame);
    });
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      for (const waiter of this.pending.values()) {
        if (waiter.socket === socket) waiter.fail(new Error('broker socket closed'));
      }
    });
  }

  private dropSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) socket.destroy();
  }
}
