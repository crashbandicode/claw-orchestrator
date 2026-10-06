import { createHash } from 'node:crypto';

export const BROKER_METHODS = [
  'session.start',
  'session.send',
  'session.stop',
  'session.list',
  'session.status',
  'session.overview',
  'inbox.send',
  'inbox.read',
  'inbox.deliver',
  'thread.register',
  'thread.send',
  'thread.read',
  'thread.ack',
  'thread.wait',
] as const;

export type BrokerMethod = (typeof BROKER_METHODS)[number];

export const MAX_FRAME_BYTES = 4_000_000;

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type OperationStatus = 'accepted' | 'running' | 'completed' | 'failed' | 'uncertain' | 'rejected';

export interface SubmitFrame {
  kind: 'submit';
  id: string;
  method: BrokerMethod;
  payloadHash: string;
  payload: unknown;
}

export interface ResultFrame {
  kind: 'result';
  id: string;
  status: OperationStatus;
  result?: unknown;
  error?: string;
}

export function isBrokerMethod(value: string): value is BrokerMethod {
  return (BROKER_METHODS as readonly string[]).includes(value);
}

export function assertOperationId(id: string): void {
  if (!OPERATION_ID.test(id)) {
    throw new Error('operationId must be 1-128 characters from letters, numbers, and . _ : -');
  }
}

export function isTerminalStatus(status: OperationStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'uncertain' || status === 'rejected';
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) sorted[key] = sortValue(source[key]);
    }
    return sorted;
  }
  return value;
}

/** Stable JSON for payload hashing. Key order does not change the hash. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function asRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('payload must be an object');
  }
  return payload as Record<string, unknown>;
}

export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || /[\r\n]/.test(value)) {
    throw new Error(`${field} must be a single-line string`);
  }
  return value;
}

export function requiredString(value: unknown, field: string): string {
  const text = optionalString(value, field);
  if (!text) throw new Error(`${field} is required`);
  return text;
}

/** Message body. Newlines are part of the prompt and must not be rejected. */
export function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} is required`);
  if (value.length > 1_000_000) throw new Error(`${field} exceeds the size cap`);
  return value;
}
