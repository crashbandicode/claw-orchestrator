/**
 * Cursor parameterized model catalog via ACP discovery.
 *
 * `cursor-agent --list-models` still prints the legacy getUsableModels ids.
 * Parameterized metadata (Grok 4.7 context / reasoning_effort / fast, etc.)
 * comes from `cursor-agent acp`: NDJSON `initialize`, then exactly
 * `cursor/list_available_models`. This loader never opens a session or sends
 * a prompt.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import { sanitizeSecrets } from './sanitize.js';

const DISCOVERY_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 5 * 60_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_MODELS = 256;
const MAX_CONFIG_OPTIONS = 32;
const MAX_OPTION_VALUES = 32;
const MAX_ERROR_DETAIL = 160;

const INIT_ID = 1;
const LIST_ID = 2;
const LIST_METHOD = 'cursor/list_available_models';

export interface CursorParameterizedCatalogInvocation {
  command: string;
  prefixArgs: string[];
  env?: Record<string, string>;
}

export interface CursorParameterizedOption {
  value: string;
  name?: string;
}

export interface CursorParameterizedConfigOption {
  id: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options: CursorParameterizedOption[];
}

export interface CursorParameterizedModel {
  value: string;
  name?: string;
  configOptions: CursorParameterizedConfigOption[];
}

interface CacheEntry {
  expiresAt: number;
  models: CursorParameterizedModel[];
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

const catalogCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CursorParameterizedModel[]>>();

/** Test hook. Clears success cache and in-flight singleflight entries. */
export function clearCursorParameterizedCatalogCacheForTests(): void {
  catalogCache.clear();
  inflight.clear();
}

export async function loadCursorParameterizedCatalog(
  invocation: CursorParameterizedCatalogInvocation,
): Promise<CursorParameterizedModel[]> {
  const key = invocationCacheKey(invocation);
  const cached = catalogCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return structuredClone(cached.models);
  }
  if (cached) catalogCache.delete(key);

  const existing = inflight.get(key);
  if (existing) return existing;

  const pending = discoverCatalog(invocation)
    .then((models) => {
      catalogCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, models });
      return structuredClone(models);
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, pending);
  return pending;
}

function invocationCacheKey(invocation: CursorParameterizedCatalogInvocation): string {
  const env = invocation.env;
  const envKey = env
    ? Object.keys(env)
        .sort()
        .map((k) => `${k}=${env[k]}`)
        .join('\0')
    : '';
  return `${invocation.command}\0${invocation.prefixArgs.join('\0')}\0${envKey}`;
}

function discoverCatalog(invocation: CursorParameterizedCatalogInvocation): Promise<CursorParameterizedModel[]> {
  return new Promise<CursorParameterizedModel[]>((resolve, reject) => {
    let child: ChildProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let stdoutBuf = '';
    let stderrBytes = 0;
    const pending = new Map<number, PendingRequest>();

    const finishOk = (models: CursorParameterizedModel[]): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      rejectAll(pending, new Error('cursor ACP catalog request cancelled'));
      resolve(models);
    };

    const finishErr = (err: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      rejectAll(pending, err);
      reject(err);
    };

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (!child) return;
      try {
        child.stdin?.end();
      } catch {
        /* already closed */
      }
      try {
        child.stdout?.destroy();
      } catch {
        /* already destroyed */
      }
      try {
        child.stderr?.destroy();
      } catch {
        /* already destroyed */
      }
      if (child.exitCode == null) {
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      }
    };

    try {
      child = spawn(invocation.command, [...invocation.prefixArgs, 'acp'], {
        env: { ...process.env, ...invocation.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: process.platform === 'win32',
      });
    } catch {
      finishErr(genericCatalogError());
      return;
    }

    const stdin = child.stdin;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdin || !stdout) {
      cleanup();
      finishErr(genericCatalogError());
      return;
    }

    stdin.on('error', () => undefined);
    stdout.on('error', () => undefined);
    stderr?.on('error', () => undefined);

    stderr?.on('data', (chunk: Buffer | string) => {
      const n = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      stderrBytes += n;
      if (stderrBytes > MAX_CAPTURE_BYTES) {
        stderr.removeAllListeners('data');
      }
    });

    stdout.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      stdoutBuf += text;
      if (stdoutBuf.length > MAX_CAPTURE_BYTES) {
        stdoutBuf = stdoutBuf.slice(stdoutBuf.length - MAX_CAPTURE_BYTES);
      }
      let nl = stdoutBuf.indexOf('\n');
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line) dispatchAcpLine(line, pending, finishErr);
        nl = stdoutBuf.indexOf('\n');
      }
    });

    child.on('error', () => {
      finishErr(genericCatalogError());
    });

    child.on('close', () => {
      if (!settled) {
        finishErr(new Error('cursor ACP catalog process exited before catalog response'));
      }
    });

    timer = setTimeout(() => {
      finishErr(new Error('cursor ACP catalog discovery timed out'));
    }, DISCOVERY_TIMEOUT_MS);

    const send = (id: number, method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (settled) return Promise.reject(genericCatalogError());
      return new Promise<unknown>((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        try {
          stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        } catch {
          pending.delete(id);
          rej(genericCatalogError());
        }
      });
    };

    void (async () => {
      try {
        await send(INIT_ID, 'initialize', {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'clawo', version: '1' },
        });
        const result = await send(LIST_ID, LIST_METHOD, {});
        finishOk(parseCatalogResult(result));
      } catch (err) {
        finishErr(err instanceof Error ? err : genericCatalogError());
      } finally {
        cleanup();
      }
    })();
  });
}

function dispatchAcpLine(line: string, pending: Map<number, PendingRequest>, finishErr: (err: Error) => void): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(parsed)) return;
  const id = parsed.id;
  if (typeof id !== 'number' || !Number.isInteger(id)) return;
  const waiter = pending.get(id);
  if (!waiter) return;
  pending.delete(id);
  if ('error' in parsed) {
    waiter.reject(rpcCatalogError(parsed.error));
    return;
  }
  if (!('result' in parsed)) {
    finishErr(new Error('cursor ACP catalog response was malformed'));
    waiter.reject(new Error('cursor ACP catalog response was malformed'));
    return;
  }
  waiter.resolve(parsed.result);
}

function parseCatalogResult(result: unknown): CursorParameterizedModel[] {
  if (!isRecord(result) || !Array.isArray(result.models)) {
    throw new Error('cursor ACP catalog response was malformed');
  }
  const models: CursorParameterizedModel[] = [];
  for (const raw of result.models) {
    if (models.length >= MAX_MODELS) break;
    const model = parseModel(raw);
    if (model) models.push(model);
  }
  return models;
}

function parseModel(raw: unknown): CursorParameterizedModel | undefined {
  if (!isRecord(raw) || typeof raw.value !== 'string' || raw.value.length === 0) return undefined;
  const model: CursorParameterizedModel = {
    value: raw.value,
    configOptions: [],
  };
  if (typeof raw.name === 'string') model.name = raw.name;
  if (Array.isArray(raw.configOptions)) {
    for (const opt of raw.configOptions) {
      if (model.configOptions.length >= MAX_CONFIG_OPTIONS) break;
      const parsed = parseConfigOption(opt);
      if (parsed) model.configOptions.push(parsed);
    }
  }
  return model;
}

function parseConfigOption(raw: unknown): CursorParameterizedConfigOption | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) return undefined;
  const option: CursorParameterizedConfigOption = { id: raw.id, options: [] };
  if (typeof raw.category === 'string') option.category = raw.category;
  if (typeof raw.type === 'string') option.type = raw.type;
  const current = asScalar(raw.currentValue);
  if (current !== undefined) option.currentValue = current;
  if (Array.isArray(raw.options)) {
    for (const item of raw.options) {
      if (option.options.length >= MAX_OPTION_VALUES) break;
      const parsed = parseOptionValue(item);
      if (parsed) option.options.push(parsed);
    }
  }
  return option;
}

function parseOptionValue(raw: unknown): CursorParameterizedOption | undefined {
  if (!isRecord(raw)) return undefined;
  const value = asScalar(raw.value);
  if (value === undefined || value.length === 0) return undefined;
  const option: CursorParameterizedOption = { value };
  if (typeof raw.name === 'string') option.name = raw.name;
  return option;
}

function asScalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectAll(pending: Map<number, PendingRequest>, err: Error): void {
  for (const waiter of pending.values()) waiter.reject(err);
  pending.clear();
}

function genericCatalogError(): Error {
  return new Error('cursor ACP catalog discovery failed');
}

function rpcCatalogError(error: unknown): Error {
  const prefix = 'cursor ACP catalog request failed';
  if (!isRecord(error) || typeof error.message !== 'string') return new Error(prefix);
  const cleaned = sanitizeSecrets(error.message).replace(/\s+/g, ' ').trim();
  if (!cleaned) return new Error(prefix);
  const unredacted = cleaned.replace(/\*+/g, '');
  if (/(bearer\s+\S+|sk-[a-z0-9_-]{8,}|(api[_-]?key|token|secret)\s*[:=])/i.test(unredacted)) {
    return new Error(prefix);
  }
  const clipped = cleaned.length > MAX_ERROR_DETAIL ? `${cleaned.slice(0, MAX_ERROR_DETAIL)}…` : cleaned;
  return new Error(`${prefix}: ${clipped}`);
}
