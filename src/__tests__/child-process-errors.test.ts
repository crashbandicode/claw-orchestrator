/**
 * A child process that cannot be spawned (ENOENT) or that closes its stdin before
 * a write lands (EPIPE) is an error on that one session, never on the broker.
 *
 * Node raises both as `error` events on the ChildProcess and on its pipes. An
 * `error` event nobody listens for is an uncaught exception, and the broker hosts
 * every session on the machine. These tests use real child processes (a missing
 * binary, and fake CLIs that close stdin) and fail on any uncaught exception.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const { SessionManager } = await import('../session-manager.js');
const { PersistentClaudeSession } = await import('../persistent-session.js');
const { PersistentCustomSession } = await import('../persistent-custom-session.js');
const { dockerStop } = await import('../ultraapp/docker.js');
const { hostRun } = await import('../ultraapp/host-strategy.js');
const { guardChildStreams, createStdinErrorReporter, reportSessionError } = await import('../child-process-guard.js');
const { SESSION_EVENT } = await import('../constants.js');

/** A codex that answers the handshake; `FAKE_CODEX_MODE=close-stdin` then closes its stdin. */
const FAKE_CODEX = `#!/usr/bin/env node
const readline = require('node:readline');
const argv = process.argv.slice(2);
if (argv[0] === 'mcp') {
  if (process.env.FAKE_CODEX_MODE === 'list-fails') process.exit(3);
  const servers = [
    { name: 'docs', enabled: true, transport: { type: 'stdio', command: '/bin/docs' } },
    { name: 'off', enabled: false, transport: { type: 'stdio', command: '/bin/off' } },
  ];
  if (process.env.FAKE_CODEX_MODE === 'odd-transport') {
    servers.push({ name: 'odd', enabled: true, transport: { type: 'carrier-pigeon' } });
  }
  process.stdout.write(JSON.stringify(servers));
  process.exit(0);
}
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
let n = 0;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ id: msg.id, result: {} });
  if (msg.method === 'thread/start') {
    send({ id: msg.id, result: { thread: { id: 'thread-' + process.pid } } });
    if (process.env.FAKE_CODEX_MODE === 'close-stdin') {
      // Stay alive but stop reading: the parent's next write meets a closed pipe.
      setTimeout(() => { process.stdin.pause(); require('node:fs').closeSync(0); }, 10);
      setInterval(() => {}, 1000);
    }
    return;
  }
  if (msg.method === 'turn/start') {
    const turnId = 'turn-' + ++n;
    send({ id: msg.id, result: {} });
    send({ method: 'item/completed', params: { threadId: 't', turnId, item: { type: 'agentMessage', text: 'fine' } } });
    return send({ method: 'turn/completed', params: { threadId: 't', turn: { id: turnId, status: 'completed' } } });
  }
  if (msg.id !== undefined) send({ id: msg.id, result: {} });
});
`;

/** A stream-json CLI (claude, or a persistent custom engine) that closes its stdin after init. */
const FAKE_STREAM_CLI = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake-' + process.pid }) + '\\n');
process.stdin.on('data', () => {});
setTimeout(() => { process.stdin.pause(); require('node:fs').closeSync(0); }, 10);
setInterval(() => {}, 1000);
`;

const MISSING_BIN = '/nonexistent-clawo-test-dir/definitely-not-installed';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('child process error events do not end the host', () => {
  let dir: string;
  let uncaught: unknown[];
  const onUncaught = (err: unknown) => uncaught.push(err);

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-child-errors-'));
    fs.writeFileSync(path.join(dir, 'codex'), FAKE_CODEX, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'stream-cli'), FAKE_STREAM_CLI, { mode: 0o755 });
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    process.off('uncaughtException', onUncaught);
    vi.unstubAllEnvs();
  });

  /** Run `fn` with an uncaught-exception collector; the test asserts it stayed empty. */
  async function watched(fn: () => Promise<void>): Promise<void> {
    uncaught = [];
    process.on('uncaughtException', onUncaught);
    await fn();
    // An 'error' event raised on a later tick must be seen before the check.
    await sleep(100);
    expect(uncaught).toEqual([]);
  }

  async function withManager(fn: (mgr: InstanceType<typeof SessionManager>) => Promise<void>): Promise<void> {
    const mgr = new SessionManager({
      claudeBin: 'unused',
      maxConcurrentSessions: 8,
      sessionTtlMinutes: 120,
      defaultPermissionMode: 'acceptEdits',
      defaultEffort: 'auto',
    });
    try {
      await fn(mgr);
    } finally {
      await mgr.shutdown();
    }
  }

  const start = (mgr: InstanceType<typeof SessionManager>, name: string, extra: Record<string, unknown> = {}) =>
    mgr.startSession({ name, cwd: dir, engine: 'codex-app', noSessionPersistence: true, ...extra });

  // ── ENOENT / EACCES: the child cannot be spawned ─────────────────────────

  it('codex-app: an unspawnable codex fails that start and nothing else', async () => {
    await watched(async () => {
      await withManager(async (mgr) => {
        vi.stubEnv('CODEX_BIN', path.join(dir, 'codex'));
        await start(mgr, 'bystander');

        vi.stubEnv('CODEX_BIN', MISSING_BIN);
        await expect(start(mgr, 'doomed')).rejects.toThrow(/ENOENT/);
        expect(mgr.hasSession('doomed')).toBe(false);

        expect((await mgr.sendMessage('bystander', 'still here')).output).toBe('fine');
      });
    });
  });

  it('codex-app: a codex that is not executable (EACCES) fails the start', async () => {
    const noExec = path.join(dir, 'codex-no-exec');
    fs.writeFileSync(noExec, FAKE_CODEX, { mode: 0o644 });
    await watched(async () => {
      await withManager(async (mgr) => {
        vi.stubEnv('CODEX_BIN', noExec);
        await expect(start(mgr, 'doomed')).rejects.toThrow(/EACCES/);
      });
    });
  });

  it('claude: an unspawnable claude fails the start', async () => {
    await watched(async () => {
      const session = new PersistentClaudeSession({ name: 'c', cwd: dir, permissionMode: 'acceptEdits' }, MISSING_BIN);
      session.on(SESSION_EVENT.ERROR, () => undefined);
      await expect(session.start()).rejects.toThrow(/ENOENT/);
    });
  });

  it('custom: an unspawnable persistent engine fails the start', async () => {
    await watched(async () => {
      const session = new PersistentCustomSession({
        name: 'x',
        cwd: dir,
        permissionMode: 'acceptEdits',
        customEngine: { name: 'ghost', bin: MISSING_BIN, persistent: true, args: {} },
      });
      session.on(SESSION_EVENT.ERROR, () => undefined);
      await expect(session.start()).rejects.toThrow(/ENOENT/);
    });
  });

  it('docker: a missing docker binary resolves as a failure instead of ending the host', async () => {
    await watched(async () => {
      const result = await dockerStop('whatever', (_cmd, args) => spawn(MISSING_BIN, args));
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/ENOENT/);
    });
  });

  it('host strategy: a launch command that cannot be spawned reports no pid and no crash', async () => {
    const app = fs.mkdtempSync(path.join(dir, 'app-'));
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ main: 'server.js' }));
    await watched(async () => {
      // With no `node` on its PATH the launch fails with ENOENT after hostRun has returned.
      const result = await hostRun({
        image: app,
        name: 'ghost-app',
        hostPort: 4999,
        env: { HOST_CWD: app, PATH: path.join(dir, 'empty-path') },
      });
      expect(result).toEqual({ ok: false, error: 'spawn returned no pid' });
    });
  });

  // ── EPIPE: the child closes stdin before a write lands ───────────────────

  it('codex-app: a write to an app-server that closed stdin fails the turn, not the host', async () => {
    await watched(async () => {
      await withManager(async (mgr) => {
        vi.stubEnv('CODEX_BIN', path.join(dir, 'codex'));
        vi.stubEnv('FAKE_CODEX_MODE', 'close-stdin');
        await start(mgr, 'epipe');
        await sleep(150);

        await expect(mgr.sendMessage('epipe', 'hello')).rejects.toThrow(/EPIPE|stdin|write/i);
        await sleep(50);
        // One fault, one recorded error: the write callback and the stream's
        // 'error' event describe the same failure.
        expect(mgr.getStatus('epipe').health?.errorCount).toBe(1);
      });
    });
  });

  it('claude: a write to a CLI that closed stdin is reported as one session error', async () => {
    await watched(async () => {
      const session = new PersistentClaudeSession(
        { name: 'c', cwd: dir, permissionMode: 'acceptEdits' },
        path.join(dir, 'stream-cli'),
      );
      const errors: Error[] = [];
      session.on(SESSION_EVENT.ERROR, (e: Error) => errors.push(e));
      await session.start();
      await sleep(150);
      await session.send('hello');
      await sleep(100);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch(/Failed to write to stdin/);
      await session.stop();
    });
  });

  it('custom: a write to a persistent engine that closed stdin is reported as one session error', async () => {
    await watched(async () => {
      const session = new PersistentCustomSession({
        name: 'x',
        cwd: dir,
        permissionMode: 'acceptEdits',
        customEngine: { name: 'fake-stream', bin: path.join(dir, 'stream-cli'), persistent: true, args: {} },
      });
      const errors: Error[] = [];
      session.on(SESSION_EVENT.ERROR, (e: Error) => errors.push(e));
      await session.start();
      await sleep(150);
      await session.send('hello');
      await sleep(100);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch(/Failed to write to stdin/);
      await session.stop();
    });
  });

  // ── the guard helpers ────────────────────────────────────────────────────

  it('guardChildStreams: stream faults reach the callback, and a throwing callback cannot escape', async () => {
    await watched(async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['pipe', 'pipe', 'pipe'] });
      const seen: string[] = [];
      guardChildStreams(child, (stream) => {
        seen.push(stream);
        throw new Error('callback failure');
      });
      child.stdin!.emit('error', new Error('x'));
      child.stdout!.emit('error', new Error('y'));
      child.stderr!.emit('error', new Error('z'));
      expect(seen).toEqual(['stdin', 'stdout', 'stderr']);
      child.kill('SIGKILL');
      await new Promise((r) => child.once('close', r));
    });
  });

  it('guardChildStreams: tolerates a stand-in with no pipes', () => {
    expect(() => guardChildStreams({ stdin: null, stdout: undefined } as never)).not.toThrow();
  });

  it('createStdinErrorReporter: folds a fault delivered twice (callback and event) into one report', () => {
    const reports: string[] = [];
    const fault = createStdinErrorReporter((err) => reports.push(err.message));
    const err = new Error('write EPIPE');
    fault(err);
    fault(err);
    fault(null);
    fault(new Error('write EPIPE'));
    expect(reports).toEqual(['Failed to write to stdin: write EPIPE', 'Failed to write to stdin: write EPIPE']);
  });

  it('reportSessionError: never throws without a listener, and logs instead', () => {
    const emitter = new EventEmitter();
    const logs: string[] = [];
    emitter.on(SESSION_EVENT.LOG, (l: string) => logs.push(l));
    expect(() => reportSessionError(emitter, new Error('boom'), '[t]')).not.toThrow();
    expect(logs).toEqual(['[t] boom']);
    const errors: Error[] = [];
    emitter.on(SESSION_EVENT.ERROR, (e: Error) => errors.push(e));
    reportSessionError(emitter, new Error('again'), '[t]');
    expect(errors.map((e) => e.message)).toEqual(['again']);
  });

  // ── codexMcpServers caller errors are not engine failures ────────────────

  describe('the circuit breaker ignores codexMcpServers caller and config errors', () => {
    const select = (names: string[]) => ({ ignoreUserConfig: true, codexMcpServers: names });

    it('three or more bad selections do not block a valid start', async () => {
      await withManager(async (mgr) => {
        vi.stubEnv('CODEX_BIN', path.join(dir, 'codex'));
        for (let i = 0; i < 4; i++) {
          await expect(start(mgr, `unknown-${i}`, select(['nope']))).rejects.toThrow(/Unknown MCP server/);
        }
        for (let i = 0; i < 2; i++) {
          await expect(start(mgr, `disabled-${i}`, select(['off']))).rejects.toThrow(/disabled in the Codex config/);
        }
        expect(mgr.health().circuitBreakers).toEqual({});

        await start(mgr, 'valid', select(['docs']));
        expect(mgr.hasSession('valid')).toBe(true);
      });
    });

    it('an unsupported transport type is not an engine failure', async () => {
      await withManager(async (mgr) => {
        vi.stubEnv('CODEX_BIN', path.join(dir, 'codex'));
        vi.stubEnv('FAKE_CODEX_MODE', 'odd-transport');
        for (let i = 0; i < 4; i++) {
          await expect(start(mgr, `odd-${i}`, select(['docs']))).rejects.toThrow(/unsupported or "carrier-pigeon"/);
        }
        expect(mgr.health().circuitBreakers).toEqual({});
      });
      vi.unstubAllEnvs();
      await withManager(async (mgr) => {
        vi.stubEnv('CODEX_BIN', path.join(dir, 'codex'));
        await start(mgr, 'valid', select(['docs']));
        expect(mgr.hasSession('valid')).toBe(true);
      });
    });

    it('a failed `codex mcp list` is not an engine failure', async () => {
      await withManager(async (mgr) => {
        vi.stubEnv('CODEX_BIN', path.join(dir, 'codex'));
        vi.stubEnv('FAKE_CODEX_MODE', 'list-fails');
        for (let i = 0; i < 4; i++) {
          await expect(start(mgr, `list-${i}`, select(['docs']))).rejects.toThrow(/codex mcp list --json exited/);
        }
        expect(mgr.health().circuitBreakers).toEqual({});

        vi.stubEnv('FAKE_CODEX_MODE', '');
        await start(mgr, 'valid', select(['docs']));
        expect(mgr.hasSession('valid')).toBe(true);
      });
    });

    it('the same holds for the exec engine', async () => {
      await withManager(async (mgr) => {
        vi.stubEnv('CODEX_BIN', path.join(dir, 'codex'));
        for (let i = 0; i < 4; i++) {
          await expect(start(mgr, `exec-${i}`, { engine: 'codex', ...select(['nope']) })).rejects.toThrow(
            /Unknown MCP server/,
          );
        }
        expect(mgr.health().circuitBreakers).toEqual({});
        await start(mgr, 'exec-valid', { engine: 'codex', ...select(['docs']) });
        expect(mgr.hasSession('exec-valid')).toBe(true);
      });
    });

    it('a genuine engine failure still opens the breaker', async () => {
      await withManager(async (mgr) => {
        vi.stubEnv('CODEX_BIN', MISSING_BIN);
        for (let i = 0; i < 3; i++) {
          await expect(start(mgr, `dead-${i}`)).rejects.toThrow(/ENOENT/);
        }
        expect(mgr.health().circuitBreakers['codex-app']?.failures).toBe(3);
        await expect(start(mgr, 'dead-3')).rejects.toThrow(/circuit breaker open/);
      });
    });
  });
});
