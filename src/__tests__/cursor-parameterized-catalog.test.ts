/**
 * Unit tests for Cursor ACP parameterized catalog discovery.
 *
 * Mocks child_process.spawn. Never opens a real ACP session or prompts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const { clearCursorParameterizedCatalogCacheForTests, loadCursorParameterizedCatalog } =
  await import('../cursor-parameterized-catalog.js');

const INVOCATION = { command: 'cursor-agent', prefixArgs: [] as string[] };

interface WrittenMsg {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

interface MockProc extends EventEmitter {
  stdout: Readable & { destroy: ReturnType<typeof vi.fn> };
  stderr: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  stdin: {
    write: (s: string, cb?: (e?: Error) => void) => boolean;
    end: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
  kill: ReturnType<typeof vi.fn>;
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  written: WrittenMsg[];
}

function grok47Model(): Record<string, unknown> {
  return {
    value: 'grok-4.7',
    name: 'Grok 4.7',
    configOptions: [
      {
        id: 'context',
        name: 'Context',
        description: 'Context size the model has available.',
        category: 'model_config',
        type: 'select',
        currentValue: '256k',
        options: [
          { value: '256k', name: '256K' },
          { value: '500k', name: '500K' },
        ],
      },
      {
        id: 'reasoning_effort',
        name: 'Effort',
        description: 'Controls how much reasoning effort the model uses before responding.',
        category: 'thought_level',
        type: 'select',
        currentValue: 'xhigh',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
          { value: 'xhigh', name: 'Extra High' },
        ],
      },
      {
        id: 'fast',
        name: 'Fast',
        description: 'Significantly faster but consumes more usage',
        category: 'model_config',
        type: 'select',
        currentValue: 'false',
        options: [
          { value: 'false', name: 'Off' },
          { value: 'true', name: 'Fast' },
        ],
      },
    ],
  };
}

function createMockProc(
  responder: (
    msg: WrittenMsg,
  ) => Record<string, unknown> | { __rpcError: string } | { __malformed: unknown } | undefined,
): MockProc {
  const written: WrittenMsg[] = [];
  const proc = new EventEmitter() as MockProc;
  proc.stdout = new Readable({ read() {} }) as MockProc['stdout'];
  proc.stdout.destroy = vi.fn();
  proc.stderr = new EventEmitter() as MockProc['stderr'];
  proc.stderr.destroy = vi.fn();
  proc.kill = vi.fn(() => {
    proc.exitCode = 0;
    return true;
  });
  proc.pid = 4242;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.written = written;
  proc.stdin = {
    end: vi.fn(),
    on: vi.fn(),
    write(s: string, cb?: (e?: Error) => void) {
      for (const line of s.split('\n')) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as WrittenMsg;
        written.push(msg);
        const result = responder(msg);
        if (msg.id === undefined || result === undefined) continue;
        if (result && typeof result === 'object' && '__rpcError' in result) {
          proc.stdout.push(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32000, message: (result as { __rpcError: string }).__rpcError },
            })}\n`,
          );
        } else if (result && typeof result === 'object' && '__malformed' in result) {
          proc.stdout.push(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: result.__malformed })}\n`);
        } else {
          proc.stdout.push(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
        }
      }
      cb?.();
      return true;
    },
  };
  return proc;
}

function happyResponder(extraModels: unknown[] = [grok47Model()]) {
  return (msg: WrittenMsg): Record<string, unknown> | undefined => {
    if (msg.method === 'initialize') return { protocolVersion: 1 };
    if (msg.method === 'cursor/list_available_models') return { models: extraModels };
    return undefined;
  };
}

describe('loadCursorParameterizedCatalog', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    clearCursorParameterizedCatalogCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearCursorParameterizedCatalogCacheForTests();
  });

  it('initializes then lists models without session/new or a prompt', async () => {
    const proc = createMockProc(happyResponder());
    mockSpawn.mockReturnValue(proc);

    const models = await loadCursorParameterizedCatalog(INVOCATION);

    expect(mockSpawn).toHaveBeenCalledWith(
      'cursor-agent',
      ['acp'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    expect(proc.written.map((m) => m.method)).toEqual(['initialize', 'cursor/list_available_models']);
    expect(proc.written[0]?.params).toEqual({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'clawo', version: '1' },
    });
    expect(proc.written[1]?.params).toEqual({});
    expect(proc.written.some((m) => m.method === 'session/new')).toBe(false);
    expect(proc.written.some((m) => m.method === 'cursor/list_available_models_')).toBe(false);
    expect(JSON.stringify(proc.written)).not.toMatch(/-p|session\/new|prompt/);

    expect(models).toHaveLength(1);
    expect(models[0]).toEqual({
      value: 'grok-4.7',
      name: 'Grok 4.7',
      configOptions: [
        {
          id: 'context',
          category: 'model_config',
          type: 'select',
          currentValue: '256k',
          options: [
            { value: '256k', name: '256K' },
            { value: '500k', name: '500K' },
          ],
        },
        {
          id: 'reasoning_effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'xhigh',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
            { value: 'xhigh', name: 'Extra High' },
          ],
        },
        {
          id: 'fast',
          category: 'model_config',
          type: 'select',
          currentValue: 'false',
          options: [
            { value: 'false', name: 'Off' },
            { value: 'true', name: 'Fast' },
          ],
        },
      ],
    });
    expect(JSON.stringify(models)).not.toContain('Context size the model has available');
    expect(JSON.stringify(models)).not.toContain('Significantly faster');
  });

  it('forwards prefixArgs and env and appends acp', async () => {
    const proc = createMockProc(happyResponder());
    mockSpawn.mockReturnValue(proc);

    await loadCursorParameterizedCatalog({
      command: '/opt/cursor-agent',
      prefixArgs: ['--runtime', 'index.js'],
      env: { CURSOR_TEST: '1' },
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      '/opt/cursor-agent',
      ['--runtime', 'index.js', 'acp'],
      expect.objectContaining({
        env: expect.objectContaining({ CURSOR_TEST: '1' }),
      }),
    );
  });

  it('skips invalid models and bounds oversized catalogs', async () => {
    const oversized = Array.from({ length: 300 }, (_, i) => ({ value: `m${i}`, configOptions: [] }));
    const proc = createMockProc(
      happyResponder([
        { name: 'no-value' },
        { value: 12 },
        { value: 'kept', configOptions: 'nope' },
        { value: 'also', configOptions: [{ id: 'context', options: [{ value: '256k' }, { name: 'skip-me' }] }] },
        ...oversized,
      ]),
    );
    mockSpawn.mockReturnValue(proc);

    const models = await loadCursorParameterizedCatalog(INVOCATION);
    expect(models[0]).toEqual({ value: 'kept', configOptions: [] });
    expect(models[1]?.value).toBe('also');
    expect(models[1]?.configOptions[0]?.options).toEqual([{ value: '256k' }]);
    expect(models.length).toBe(256);
  });

  it('rejects a malformed catalog result', async () => {
    const proc = createMockProc((msg) => {
      if (msg.method === 'initialize') return {};
      if (msg.method === 'cursor/list_available_models') return { __malformed: { not: 'models' } };
      return undefined;
    });
    mockSpawn.mockReturnValue(proc);

    await expect(loadCursorParameterizedCatalog(INVOCATION)).rejects.toThrow(/malformed/);
    expect(proc.kill).toHaveBeenCalled();
  });

  it('sanitizes RPC errors and never dumps raw auth from stderr', async () => {
    const proc = createMockProc((msg) => {
      if (msg.method === 'initialize') return {};
      if (msg.method === 'cursor/list_available_models') {
        return { __rpcError: 'Bearer secret-token-value denied CURSOR_API_KEY=supersecret' };
      }
      return undefined;
    });
    mockSpawn.mockReturnValue(proc);

    const sendPromise = loadCursorParameterizedCatalog(INVOCATION);
    proc.stderr.emit('data', 'Authorization: Bearer secret-token-value\nCURSOR_API_KEY=supersecret\n');
    await expect(sendPromise).rejects.toThrow(/catalog request failed/);
    try {
      await sendPromise;
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain('secret-token-value');
      expect(message).not.toContain('supersecret');
      expect(message).not.toContain('CURSOR_API_KEY=supersecret');
    }
  });

  it('times out and kills a child that never answers', async () => {
    vi.useFakeTimers();
    const proc = createMockProc(() => undefined);
    mockSpawn.mockReturnValue(proc);

    const pending = loadCursorParameterizedCatalog(INVOCATION);
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(proc.kill).toHaveBeenCalled();
  });

  it('rejects when the child exits before a catalog response', async () => {
    const proc = createMockProc(() => undefined);
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => {
        proc.exitCode = 1;
        proc.emit('close', 1);
      });
      return proc;
    });

    await expect(loadCursorParameterizedCatalog(INVOCATION)).rejects.toThrow(/exited before catalog response/);
  });

  it('cleans up stdin, streams, and the child after success', async () => {
    const proc = createMockProc(happyResponder());
    mockSpawn.mockReturnValue(proc);

    await loadCursorParameterizedCatalog(INVOCATION);

    expect(proc.stdin.end).toHaveBeenCalled();
    expect(proc.stdout.destroy).toHaveBeenCalled();
    expect(proc.stderr.destroy).toHaveBeenCalled();
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('reuses a success cache for 5 minutes and does not cache failures', async () => {
    vi.useFakeTimers();
    const proc = createMockProc(happyResponder());
    mockSpawn.mockReturnValue(proc);

    const first = await loadCursorParameterizedCatalog(INVOCATION);
    const second = await loadCursorParameterizedCatalog(INVOCATION);
    expect(first).toEqual(second);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    const proc2 = createMockProc(happyResponder());
    mockSpawn.mockReturnValue(proc2);
    await loadCursorParameterizedCatalog(INVOCATION);
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    clearCursorParameterizedCatalogCacheForTests();
    const failing = createMockProc(() => undefined);
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => {
        failing.exitCode = 1;
        failing.emit('close', 1);
      });
      return failing;
    });
    await expect(loadCursorParameterizedCatalog(INVOCATION)).rejects.toThrow(/exited/);
    expect(mockSpawn).toHaveBeenCalledTimes(3);

    const recovered = createMockProc(happyResponder());
    mockSpawn.mockReturnValue(recovered);
    await expect(loadCursorParameterizedCatalog(INVOCATION)).resolves.toHaveLength(1);
    expect(mockSpawn).toHaveBeenCalledTimes(4);
  });

  it('single-flights concurrent calls for the same invocation', async () => {
    let releases = 0;
    const delayed = createMockProc((msg) => {
      if (msg.method === 'initialize') return {};
      if (msg.method === 'cursor/list_available_models') {
        releases += 1;
        return { models: [grok47Model()] };
      }
      return undefined;
    });
    mockSpawn.mockReturnValue(delayed);

    const [a, b] = await Promise.all([
      loadCursorParameterizedCatalog(INVOCATION),
      loadCursorParameterizedCatalog(INVOCATION),
    ]);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(releases).toBe(1);
    expect(a).toEqual(b);
    expect(a[0]?.value).toBe('grok-4.7');
  });

  it('does not share cache or inflight across different invocations', async () => {
    mockSpawn.mockImplementation((_cmd: string, args: string[]) =>
      createMockProc(happyResponder([{ value: args.join(' ') || 'base' }])),
    );

    const [left, right] = await Promise.all([
      loadCursorParameterizedCatalog({ command: 'cursor-agent', prefixArgs: ['a'] }),
      loadCursorParameterizedCatalog({ command: 'cursor-agent', prefixArgs: ['b'] }),
    ]);

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(left[0]?.value).toBe('a acp');
    expect(right[0]?.value).toBe('b acp');
  });

  it('ignores non-JSON ACP noise before a valid result', async () => {
    const proc = createMockProc((msg) => {
      if (msg.method === 'initialize') {
        proc.stdout.push('ready\n');
        return {};
      }
      if (msg.method === 'cursor/list_available_models') return { models: [grok47Model()] };
      return undefined;
    });
    mockSpawn.mockReturnValue(proc);

    await expect(loadCursorParameterizedCatalog(INVOCATION)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ value: 'grok-4.7' })]),
    );
  });
});
