import * as fs from 'node:fs';
import * as path from 'node:path';

import { MAX_FRAME_BYTES, type BrokerMethod } from './protocol.js';

export type StoredOperationStatus = 'accepted' | 'running' | 'completed' | 'failed' | 'uncertain';

export interface StoredOperation {
  id: string;
  method: BrokerMethod;
  payloadHash: string;
  status: StoredOperationStatus;
  result?: unknown;
  error?: string;
  acceptedAt: string;
  finishedAt?: string;
}

/**
 * Durable operation identity. Acceptance is on disk before dispatch, and a
 * terminal result is on disk before the broker replies. A process restart
 * marks anything still accepted or running as uncertain and does not replay it.
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class OperationStore {
  private ownerHeld = false;

  constructor(private readonly directory: string) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
  }

  /**
   * Exclusive owner of this directory. A live pid keeps its lock and this
   * process must not reconcile that owner's in-flight records.
   */
  claimOwner(): void {
    if (this.ownerHeld) return;
    const lock = path.join(this.directory, 'owner.lock');
    if (fs.existsSync(lock)) {
      const pid = Number(fs.readFileSync(lock, 'utf8').trim());
      if (this.ownerHeld && pid === process.pid) return;
      if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) {
        throw new Error(`Remote broker state is owned by live process ${pid}`);
      }
      try {
        fs.unlinkSync(lock);
      } catch {
        // another starter won the race; the exclusive create below reports it
      }
    }
    let fd: number;
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw new Error('Remote broker state is owned by another starting process');
      throw err;
    }
    fs.writeSync(fd, String(process.pid));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    this.ownerHeld = true;
  }

  releaseOwner(): void {
    if (!this.ownerHeld) return;
    const lock = path.join(this.directory, 'owner.lock');
    try {
      const pid = Number(fs.readFileSync(lock, 'utf8').trim());
      if (pid === process.pid) fs.unlinkSync(lock);
    } catch {
      // already released
    }
    this.ownerHeld = false;
  }

  get(id: string): StoredOperation | undefined {
    const file = this.file(id);
    if (!fs.existsSync(file)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredOperation;
    return parsed;
  }

  /** @returns how many in-flight records were marked uncertain */
  reconcile(): number {
    let changed = 0;
    for (const name of fs.readdirSync(this.directory)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.directory, name);
      let record: StoredOperation;
      try {
        record = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredOperation;
      } catch {
        continue;
      }
      if (record.status !== 'accepted' && record.status !== 'running') continue;
      record.status = 'uncertain';
      record.error = 'broker restarted before a final result was persisted; the operation was not replayed';
      record.finishedAt = new Date().toISOString();
      this.write(record);
      changed++;
    }
    return changed;
  }

  accept(input: { id: string; method: BrokerMethod; payloadHash: string }): StoredOperation {
    if (this.get(input.id)) throw new Error(`Operation '${input.id}' already exists`);
    const record: StoredOperation = {
      id: input.id,
      method: input.method,
      payloadHash: input.payloadHash,
      status: 'accepted',
      acceptedAt: new Date().toISOString(),
    };
    this.write(record);
    return record;
  }

  markRunning(id: string): void {
    const record = this.require(id);
    if (record.status === 'accepted') {
      record.status = 'running';
      this.write(record);
    }
  }

  complete(id: string, result: unknown): StoredOperation {
    const record = this.require(id);
    if (record.status === 'completed' || record.status === 'failed' || record.status === 'uncertain') return record;
    record.status = 'completed';
    record.result = result;
    record.finishedAt = new Date().toISOString();
    this.write(this.cap(record));
    return this.require(id);
  }

  fail(id: string, error: string): StoredOperation {
    const record = this.require(id);
    if (record.status === 'completed' || record.status === 'failed' || record.status === 'uncertain') return record;
    record.status = 'failed';
    record.error = error.slice(0, 4_000);
    record.finishedAt = new Date().toISOString();
    this.write(record);
    return record;
  }

  private require(id: string): StoredOperation {
    const record = this.get(id);
    if (!record) throw new Error(`Operation '${id}' is not accepted`);
    return record;
  }

  private cap(record: StoredOperation): StoredOperation {
    const encoded = JSON.stringify(record);
    if (Buffer.byteLength(encoded) <= MAX_FRAME_BYTES) return record;
    return {
      ...record,
      result: { truncated: true },
      error: 'result exceeded the persistence frame and was not stored; the operation was not replayed',
    };
  }

  private file(id: string): string {
    return path.join(this.directory, `${id}.json`);
  }

  private write(record: StoredOperation): void {
    const file = this.file(record.id);
    const tmp = `${file}.${process.pid}.tmp`;
    const payload = JSON.stringify(record);
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, payload);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
    const dirfd = fs.openSync(this.directory, 'r');
    try {
      fs.fsyncSync(dirfd);
    } finally {
      fs.closeSync(dirfd);
    }
  }
}
