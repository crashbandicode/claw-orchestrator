/**
 * Unit tests for PersistentCodexAppServerSession app-server v2 RPCs.
 *
 * Mocks `child_process.spawn` with a JSON-RPC auto-responder: each line written
 * to stdin is parsed and answered on stdout by id. Verifies the exact request
 * payloads for turn/interrupt, thread/fork, thread/rollback, model/list (param
 * shapes confirmed against `codex app-server generate-json-schema`), plus the
 * turn-failure rejection path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  ChildProcess: class {},
}));

const { PersistentCodexAppServerSession } = await import('../persistent-codex-app-session.js');

interface WrittenMsg {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

function createMockProc(responder: (msg: WrittenMsg) => Record<string, unknown> | undefined) {
  const written: WrittenMsg[] = [];
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: EventEmitter;
    stdin: { writable: boolean; write: (s: string, cb?: (e?: Error) => void) => boolean };
    kill: ReturnType<typeof vi.fn>;
    pid: number;
    written: WrittenMsg[];
  };
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.pid = 7777;
  proc.written = written;
  proc.stdin = {
    writable: true,
    write(s: string, cb?: (e?: Error) => void) {
      for (const line of s.split('\n')) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as WrittenMsg;
        written.push(msg);
        const result = responder(msg);
        if (msg.id !== undefined && result !== undefined) {
          // A responder returning { __rpcError: 'msg' } simulates a JSON-RPC error frame.
          if (result && typeof result === 'object' && '__rpcError' in result) {
            const message = (result as { __rpcError: string }).__rpcError;
            proc.stdout.push(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message } }) + '\n');
          } else {
            proc.stdout.push(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
          }
        }
      }
      cb?.();
      return true;
    },
  };
  return proc;
}

/** Default responder: resolves the start() handshake (initialize + thread/start). */
function defaultResponder(extra?: (msg: WrittenMsg) => Record<string, unknown> | undefined) {
  return (msg: WrittenMsg): Record<string, unknown> | undefined => {
    if (msg.method === 'initialize') return {};
    if (msg.method === 'thread/start') return { thread: { id: 't1' } };
    const e = extra?.(msg);
    if (e !== undefined) return e;
    return {}; // ack anything else so requests resolve
  };
}

async function startSession(proc: ReturnType<typeof createMockProc>) {
  mockSpawn.mockReturnValue(proc);
  const session = new PersistentCodexAppServerSession({
    permissionMode: 'bypassPermissions',
    name: 't',
    cwd: '/tmp',
    engine: 'codex-app',
  });
  await session.start();
  return session;
}

describe('PersistentCodexAppServerSession v2 RPCs', () => {
  beforeEach(() => mockSpawn.mockReset());

  it('thread/start handshake captures the thread id', async () => {
    const session = await startSession(createMockProc(defaultResponder()));
    expect(session.codexThreadId).toBe('t1');
  });

  it('interrupt() sends turn/interrupt {threadId,turnId} for the active turn', async () => {
    const proc = createMockProc(defaultResponder());
    const session = await startSession(proc);
    // Simulate an in-flight turn so currentTurnId is populated.
    proc.stdout.push(
      JSON.stringify({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 't1', turn: { id: 'turn1' } } }) +
        '\n',
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(session.activeTurnId).toBe('turn1');

    const res = await session.interrupt();
    expect(res).toEqual({ interrupted: true });
    const sent = proc.written.find((m) => m.method === 'turn/interrupt');
    expect(sent?.params).toEqual({ threadId: 't1', turnId: 'turn1' });
  });

  it('interrupt() is a no-op when no turn is active', async () => {
    const session = await startSession(createMockProc(defaultResponder()));
    const res = await session.interrupt();
    expect(res).toEqual({ interrupted: false });
  });

  it('forkThread() returns the forked thread id from thread/fork', async () => {
    const proc = createMockProc(
      defaultResponder((m) => (m.method === 'thread/fork' ? { thread: { id: 't2' } } : undefined)),
    );
    const session = await startSession(proc);
    const res = await session.forkThread();
    expect(res).toEqual({ threadId: 't2' });
    const sent = proc.written.find((m) => m.method === 'thread/fork');
    expect(sent?.params).toEqual({ threadId: 't1' });
  });

  it('rollback() sends thread/rollback {threadId,numTurns} and rejects bad counts', async () => {
    const proc = createMockProc(defaultResponder());
    const session = await startSession(proc);
    await session.rollback(3);
    const sent = proc.written.find((m) => m.method === 'thread/rollback');
    expect(sent?.params).toEqual({ threadId: 't1', numTurns: 3 });
    await expect(session.rollback(0)).rejects.toThrow(/positive integer/);
  });

  it('listModels() returns the model/list data array', async () => {
    const proc = createMockProc(
      defaultResponder((m) => (m.method === 'model/list' ? { data: [{ id: 'gpt-5.5' }, { id: 'o3' }] } : undefined)),
    );
    const session = await startSession(proc);
    const models = await session.listModels();
    expect(models).toEqual([{ id: 'gpt-5.5' }, { id: 'o3' }]);
  });

  it('clears the active turn id on completion so interrupt() no-ops when idle', async () => {
    const proc = createMockProc(defaultResponder());
    const session = await startSession(proc);
    const tick = () => new Promise((r) => setTimeout(r, 5));

    proc.stdout.push(
      JSON.stringify({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 't1', turn: { id: 'turn1' } } }) +
        '\n',
    );
    await tick();
    expect(session.activeTurnId).toBe('turn1');

    proc.stdout.push(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { threadId: 't1', turn: { id: 'turn1', status: 'completed' } },
      }) + '\n',
    );
    await tick();
    expect(session.activeTurnId).toBeUndefined();

    const res = await session.interrupt();
    expect(res).toEqual({ interrupted: false });
    expect(proc.written.some((m) => m.method === 'turn/interrupt')).toBe(false);
  });

  it('rejects a send() and increments toolErrors when a turn completes with status failed', async () => {
    const proc = createMockProc(defaultResponder());
    const session = await startSession(proc);
    const p = session.send('do it', { waitForComplete: true });
    // turn/start was acked; now the server reports the turn failed.
    setTimeout(() => {
      proc.stdout.push(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { threadId: 't1', turn: { id: 'turnX', status: 'failed' } },
        }) + '\n',
      );
    }, 5);
    await expect(p).rejects.toThrow(/turn failed/i);
    expect(session.getStats().toolErrors).toBe(1);
    // The notification counts the turn and reports that it failed, in the same payload.
    expect(session.getStats().turns).toBe(1);
    expect(session.getStats().turnsSucceeded).toBe(0);
  });

  // The engine's TurnStatus is `completed | interrupted | failed | inProgress`, and
  // `interrupt()` on this class produces `interrupted` on purpose. Testing for the
  // absence of `failed` counted a cancelled turn as a success.
  it('does not count an interrupted turn as succeeded, and counts a completed one', async () => {
    const proc = createMockProc(defaultResponder());
    const session = await startSession(proc);

    const p1 = session.send('do it', { waitForComplete: true });
    setTimeout(() => {
      proc.stdout.push(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { threadId: 't1', turn: { id: 'turnI', status: 'interrupted' } },
        }) + '\n',
      );
    }, 5);
    await p1.catch(() => undefined);
    expect(session.getStats().turns).toBe(1);
    expect(session.getStats().turnsSucceeded).toBe(0);

    const p2 = session.send('do it again', { waitForComplete: true });
    setTimeout(() => {
      proc.stdout.push(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { threadId: 't1', turn: { id: 'turnC', status: 'completed' } },
        }) + '\n',
      );
    }, 5);
    await p2;
    expect(session.getStats().turns).toBe(2);
    expect(session.getStats().turnsSucceeded).toBe(1);
  });

  it('steer() falls back to a normal turn when idle (no in-flight turn)', async () => {
    const proc = createMockProc(defaultResponder());
    const session = await startSession(proc);
    const p = session.steer('please also add tests');
    // Idle path issues a normal turn/start; complete it so steer() resolves.
    setTimeout(() => {
      proc.stdout.push(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'item/completed',
          params: { threadId: 't1', turnId: 'tt', item: { type: 'agentMessage', text: 'done' } },
        }) + '\n',
      );
      proc.stdout.push(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { threadId: 't1', turn: { id: 'tt', status: 'completed' } },
        }) + '\n',
      );
    }, 5);
    const res = await p;
    expect(res.steered).toBe(false);
    expect(res.text).toBe('done');
    // It used turn/start, not turn/steer.
    expect(proc.written.some((m) => m.method === 'turn/steer')).toBe(false);
    expect(proc.written.some((m) => m.method === 'turn/start')).toBe(true);
  });

  it('listThreads() sends thread/list with filters and returns data + nextCursor', async () => {
    const proc = createMockProc(
      defaultResponder((m) =>
        m.method === 'thread/list' ? { data: [{ id: 'a' }, { id: 'b' }], nextCursor: 'cur2' } : undefined,
      ),
    );
    const session = await startSession(proc);
    const r = await session.listThreads({ searchTerm: 'auth', limit: 10 });
    expect(r).toEqual({ data: [{ id: 'a' }, { id: 'b' }], nextCursor: 'cur2' });
    const sent = proc.written.find((m) => m.method === 'thread/list');
    expect(sent?.params).toEqual({ searchTerm: 'auth', limit: 10 });
  });

  it('start() uses thread/resume (not thread/start) when resumeSessionId is set', async () => {
    const proc = createMockProc((msg) => {
      if (msg.method === 'initialize') return {};
      if (msg.method === 'thread/resume') return { thread: { id: 't-prev' } };
      return {};
    });
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({
      permissionMode: 'bypassPermissions',
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      resumeSessionId: 't-prev',
    });
    await session.start();
    expect(session.codexThreadId).toBe('t-prev');
    expect(proc.written.some((m) => m.method === 'thread/resume')).toBe(true);
    expect(proc.written.some((m) => m.method === 'thread/start')).toBe(false);
    const resume = proc.written.find((m) => m.method === 'thread/resume');
    expect(resume?.params).toMatchObject({ threadId: 't-prev' });
  });

  it('falls back to thread/start when thread/resume fails (stale id)', async () => {
    const proc = createMockProc((msg) => {
      if (msg.method === 'initialize') return {};
      if (msg.method === 'thread/resume') return { __rpcError: 'thread not found' };
      if (msg.method === 'thread/start') return { thread: { id: 'fresh1' } };
      return {};
    });
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({
      permissionMode: 'bypassPermissions',
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      resumeSessionId: 'stale-id',
    });
    await session.start();
    expect(session.codexThreadId).toBe('fresh1');
    expect(proc.written.some((m) => m.method === 'thread/resume')).toBe(true);
    expect(proc.written.some((m) => m.method === 'thread/start')).toBe(true);
  });

  // `thread/tokenUsage/updated` carries everything contextPercent needs — this
  // turn's own prompt (`last`) and the window the server enforces — but both
  // were ignored in favour of the cumulative totals over the model's published
  // window. That made the figure monotonic (it can only climb, so it pins at
  // 100 on a long thread) and ~4x too low per turn, which is what let the
  // openai-compat auto-compaction gate sit under its threshold until the
  // context hard-failed. Same defect as the `codex exec` wrapper, issue #75.
  it('derives contextPercent from the turn prompt and the server reported window', async () => {
    const proc = createMockProc(defaultResponder());
    const session = await startSession(proc);

    proc.stdout.push(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 't1',
          turnId: 'turn1',
          tokenUsage: {
            total: {
              totalTokens: 250_100,
              inputTokens: 250_000,
              cachedInputTokens: 100_000,
              outputTokens: 100,
              reasoningOutputTokens: 0,
            },
            last: {
              totalTokens: 129_250,
              inputTokens: 129_200,
              cachedInputTokens: 50_000,
              outputTokens: 50,
              reasoningOutputTokens: 0,
            },
            modelContextWindow: 258_400,
          },
        },
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 20));

    const stats = session.getStats();
    // Cumulative totals still drive cost — those were always right.
    expect(stats.tokensIn).toBe(250_000);
    // 129,200 / 258,400 = 50%. The old formula gave (250,000 + 100) / 1,050,000 = 24%.
    expect(stats.contextPercent).toBe(50);
  });
});

// Nothing passes `appendSystemPrompt` to `thread/start`, so it used to be
// dropped — including the charter of a council seat on this engine. It now
// leads the first turn of a fresh thread, and only that turn.
describe('PersistentCodexAppServerSession — appendSystemPrompt', () => {
  beforeEach(() => mockSpawn.mockReset());

  const turnTexts = (proc: ReturnType<typeof createMockProc>): string[] =>
    proc.written
      .filter((m) => m.method === 'turn/start')
      .map((m) => (m.params?.input as Array<{ text: string }>)[0].text);

  it('leads the first turn of a fresh thread, and only that turn', async () => {
    const proc = createMockProc(defaultResponder());
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({
      permissionMode: 'bypassPermissions',
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      appendSystemPrompt: 'SEAT RULES',
    });
    await session.start();
    await session.send('hi');
    await session.send('again');
    await new Promise((r) => setTimeout(r, 5));
    expect(turnTexts(proc)).toEqual(['SEAT RULES\n\n---\n\nhi', 'again']);
  });

  it('is not repeated on a resumed thread, which already carries it', async () => {
    const proc = createMockProc(
      defaultResponder((m) => (m.method === 'thread/resume' ? { thread: { id: 't9' } } : undefined)),
    );
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({
      permissionMode: 'bypassPermissions',
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      appendSystemPrompt: 'SEAT RULES',
      resumeSessionId: 't9',
    });
    await session.start();
    await session.send('continue');
    await new Promise((r) => setTimeout(r, 5));
    expect(turnTexts(proc)).toEqual(['continue']);
  });
});

function completeTurn(proc: ReturnType<typeof createMockProc>, turnId = 'tturn'): void {
  proc.stdout.push(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: { threadId: 't1', turnId, item: { type: 'agentMessage', text: 'ok' } },
    }) + '\n',
  );
  proc.stdout.push(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { threadId: 't1', turn: { id: turnId, status: 'completed' } },
    }) + '\n',
  );
}

function turnStartCalls(proc: ReturnType<typeof createMockProc>): WrittenMsg[] {
  return proc.written.filter((m) => m.method === 'turn/start');
}

describe('PersistentCodexAppServerSession — reasoning effort RPC', () => {
  beforeEach(() => mockSpawn.mockReset());

  it('puts session effort on thread/start config.model_reasoning_effort, not a top-level effort field', async () => {
    const proc = createMockProc(defaultResponder());
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({
      permissionMode: 'bypassPermissions',
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      effort: 'max',
    });
    await session.start();
    const started = proc.written.find((m) => m.method === 'thread/start');
    expect(started?.params).toMatchObject({
      config: { model_reasoning_effort: 'max' },
    });
    expect(started?.params).not.toHaveProperty('effort');
  });

  it('omits thread/start config when session effort is auto', async () => {
    const proc = createMockProc(defaultResponder());
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({
      permissionMode: 'bypassPermissions',
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      effort: 'auto',
    });
    await session.start();
    const started = proc.written.find((m) => m.method === 'thread/start');
    expect(started?.params).not.toHaveProperty('config');
  });

  it('sends turn/start.effort for session none and minimal', async () => {
    const proc = createMockProc(defaultResponder());
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({
      permissionMode: 'bypassPermissions',
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      effort: 'none',
    });
    await session.start();
    const started = proc.written.find((m) => m.method === 'thread/start');
    expect(started?.params).toMatchObject({
      config: { model_reasoning_effort: 'none' },
    });
    await session.send('hello');
    await new Promise((r) => setTimeout(r, 5));
    expect(turnStartCalls(proc)[0]?.params?.effort).toBe('none');

    session.setEffort('minimal');
    await session.send('again');
    await new Promise((r) => setTimeout(r, 5));
    expect(turnStartCalls(proc)[1]?.params?.effort).toBe('minimal');
    const resumeStart = proc.written.find((m) => m.method === 'thread/start');
    expect(resumeStart?.params?.config).toEqual({ model_reasoning_effort: 'none' });
  });

  it('sends turn/start.effort for session max and ultra without folding max to xhigh', async () => {
    const proc = createMockProc(defaultResponder());
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({
      permissionMode: 'bypassPermissions',
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      effort: 'max',
    });
    await session.start();
    await session.send('hello');
    await new Promise((r) => setTimeout(r, 5));
    expect(turnStartCalls(proc)[0]?.params).toMatchObject({
      threadId: 't1',
      effort: 'max',
    });
    expect(Object.keys(turnStartCalls(proc)[0]?.params ?? {}).sort()).toEqual(['effort', 'input', 'threadId']);

    session.setEffort('ultra');
    await session.send('again');
    await new Promise((r) => setTimeout(r, 5));
    expect(turnStartCalls(proc)[1]?.params?.effort).toBe('ultra');
  });

  it('forwards every native ReasoningEffort string on turn/start and thread/start config', async () => {
    const levels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
    for (const effort of levels) {
      const proc = createMockProc(defaultResponder());
      mockSpawn.mockReturnValue(proc);
      const session = new PersistentCodexAppServerSession({
        permissionMode: 'bypassPermissions',
        name: 't',
        cwd: '/tmp',
        engine: 'codex-app',
        effort,
      });
      await session.start();
      const started = proc.written.find((m) => m.method === 'thread/start');
      expect(started?.params).toMatchObject({
        config: { model_reasoning_effort: effort },
      });
      await session.send('hello');
      await new Promise((r) => setTimeout(r, 5));
      expect(turnStartCalls(proc)[0]?.params?.effort).toBe(effort);
    }
  });

  it('applies a per-turn override on turn/start without sticking to the next turn', async () => {
    const proc = createMockProc(defaultResponder());
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({
      permissionMode: 'bypassPermissions',
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      effort: 'max',
    });
    await session.start();

    const p1 = session.send('one', { waitForComplete: true });
    setTimeout(() => completeTurn(proc, 'a'), 5);
    await p1;

    const p2 = session.send('two', { waitForComplete: true, effort: 'high' });
    setTimeout(() => completeTurn(proc, 'b'), 5);
    await p2;

    const p3 = session.send('three', { waitForComplete: true });
    setTimeout(() => completeTurn(proc, 'c'), 5);
    await p3;

    const efforts = turnStartCalls(proc).map((m) => m.params?.effort);
    expect(efforts).toEqual(['max', 'high', 'max']);
    expect(session.getEffort()).toBe('max');
  });

  it('restores the engine-reported default after a one-turn override in an auto session', async () => {
    let effective = 'low';
    const observed: string[] = [];
    const proc = createMockProc((msg) => {
      if (msg.method === 'thread/start') return { thread: { id: 't1' }, reasoningEffort: effective };
      if (msg.method === 'turn/start') {
        if (typeof msg.params?.effort === 'string') effective = msg.params.effort;
        observed.push(effective);
      }
      return {};
    });
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({
      permissionMode: 'bypassPermissions',
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      effort: 'auto',
    });
    await session.start();

    const p1 = session.send('one', { waitForComplete: true, effort: 'xhigh' });
    setTimeout(() => completeTurn(proc, 'a'), 5);
    await p1;

    const p2 = session.send('two', { waitForComplete: true, effort: 'auto' });
    setTimeout(() => completeTurn(proc, 'b'), 5);
    await p2;

    const p3 = session.send('three', { waitForComplete: true });
    setTimeout(() => completeTurn(proc, 'c'), 5);
    await p3;

    const starts = turnStartCalls(proc);
    expect(starts[0]?.params?.effort).toBe('xhigh');
    expect(starts[1]?.params?.effort).toBe('low');
    expect(starts[2]?.params?.effort).toBe('low');
    expect(observed).toEqual(['xhigh', 'low', 'low']);
    expect(
      starts.some(
        (m) => m.params && Object.prototype.hasOwnProperty.call(m.params, 'effort') && m.params.effort == null,
      ),
    ).toBe(false);
    expect(session.getEffort()).toBe('auto');
  });

  it('sends per-turn effort on fire-and-forget turn/start', async () => {
    const proc = createMockProc(defaultResponder());
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({
      permissionMode: 'bypassPermissions',
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      effort: 'low',
    });
    await session.start();
    await session.send('go', { effort: 'medium' });
    await new Promise((r) => setTimeout(r, 5));
    expect(turnStartCalls(proc)[0]?.params?.effort).toBe('medium');
    expect(session.getEffort()).toBe('low');
  });

  it('puts session effort on thread/resume config and the following turn/start', async () => {
    const proc = createMockProc((msg) => {
      if (msg.method === 'initialize') return {};
      if (msg.method === 'thread/resume') return { thread: { id: 't-prev' } };
      return {};
    });
    mockSpawn.mockReturnValue(proc);
    const session = new PersistentCodexAppServerSession({
      permissionMode: 'bypassPermissions',
      name: 't',
      cwd: '/tmp',
      engine: 'codex-app',
      resumeSessionId: 't-prev',
      effort: 'xhigh',
    });
    await session.start();
    const resume = proc.written.find((m) => m.method === 'thread/resume');
    expect(resume?.params).toMatchObject({
      threadId: 't-prev',
      config: { model_reasoning_effort: 'xhigh' },
    });
    expect(resume?.params).not.toHaveProperty('effort');

    const p = session.send('continue', { waitForComplete: true });
    setTimeout(() => completeTurn(proc, 'r1'), 5);
    await p;
    expect(turnStartCalls(proc)[0]?.params?.effort).toBe('xhigh');
  });
});
