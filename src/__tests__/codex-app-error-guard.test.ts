/**
 * End to end: a real SessionManager, a real PersistentCodexAppServerSession and a
 * fake `codex` executable that behaves like an off-network install — it announces
 * an `error` notification with no text at the handshake and again during a turn,
 * which is what took the broker down (an unlistened `error` event is an uncaught
 * exception). Nothing is mocked between the manager and the child process.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { SessionManager } = await import('../session-manager.js');

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const argv = process.argv.slice(2);
if (argv[0] === 'mcp') {
  process.stdout.write(JSON.stringify([
    { name: 'maas_slack', enabled: true, transport: { type: 'streamable_http', url: 'https://x.invalid/mcp' } },
    { name: 'docs', enabled: true, transport: { type: 'stdio', command: '/bin/docs' } },
  ]));
  process.exit(0);
}
fs.appendFileSync(process.env.FAKE_CODEX_ARGS, JSON.stringify(argv) + '\\n');
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
let n = 0;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ id: msg.id, result: {} });
  if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    send({ id: msg.id, result: { thread: { id: 'thread-' + process.pid } } });
    // The off-network MCP failure: an error notification with no message at all.
    return send({ method: 'error', params: {} });
  }
  if (msg.method === 'turn/start') {
    const turnId = 'turn-' + ++n;
    send({ id: msg.id, result: {} });
    send({ method: 'turn/started', params: { threadId: 't', turn: { id: turnId } } });
    send({ method: 'error', params: { error: { message: 'Transport channel closed' }, willRetry: false, turnId } });
    send({ method: 'item/completed', params: { threadId: 't', turnId, item: { type: 'agentMessage', text: 'fine' } } });
    return send({ method: 'turn/completed', params: { threadId: 't', turn: { id: turnId, status: 'completed' } } });
  }
  if (msg.id !== undefined) send({ id: msg.id, result: {} });
});
`;

describe('codex-app engine errors against a real manager and process', () => {
  let dir: string;
  let argsFile: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-fake-codex-'));
    const bin = path.join(dir, 'codex');
    fs.writeFileSync(bin, FAKE_CODEX, { mode: 0o755 });
    argsFile = path.join(dir, 'args.jsonl');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(argsFile, { force: true });
  });

  function launchedArgs(): string[][] {
    if (!fs.existsSync(argsFile)) return [];
    return fs
      .readFileSync(argsFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
  }

  async function withManager(fn: (mgr: InstanceType<typeof SessionManager>) => Promise<void>): Promise<void> {
    vi.stubEnv('CODEX_BIN', path.join(dir, 'codex'));
    vi.stubEnv('FAKE_CODEX_ARGS', argsFile);
    const mgr = new SessionManager({
      claudeBin: 'unused',
      maxConcurrentSessions: 5,
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

  it('does not crash on empty error notifications, records them, and keeps serving turns', async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    try {
      await withManager(async (mgr) => {
        await mgr.startSession({ name: 'e2e', cwd: dir, engine: 'codex-app', noSessionPersistence: true });
        await mgr.startSession({ name: 'bystander', cwd: dir, engine: 'codex-app', noSessionPersistence: true });

        const first = await mgr.sendMessage('e2e', 'hello');
        expect(first.output).toBe('fine');
        const second = await mgr.sendMessage('e2e', 'again');
        expect(second.output).toBe('fine');
        await new Promise((r) => setTimeout(r, 50));

        const health = mgr.getStatus('e2e').health;
        // The handshake error, plus one per turn.
        expect(health?.errorCount).toBe(3);
        expect(health?.state).toBe('ok');
        expect(health?.lastError).toBe('Transport channel closed');
        expect(mgr.getStatus('bystander').health?.errorCount).toBe(1);
        expect((await mgr.sendMessage('bystander', 'hi')).output).toBe('fine');
      });
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    expect(uncaught).toEqual([]);
  });

  it('starts the app-server with every MCP server disabled under ignoreUserConfig', async () => {
    await withManager(async (mgr) => {
      await mgr.startSession({
        name: 'no-mcp',
        cwd: dir,
        engine: 'codex-app',
        ignoreUserConfig: true,
        noSessionPersistence: true,
      });
      const args = launchedArgs()[0];
      expect(args.slice(0, 5)).toEqual(['app-server', '--listen', 'stdio://', '--enable', 'goals']);
      expect(args.slice(5)).toEqual([
        '-c',
        'mcp_servers.maas_slack.enabled=false',
        '-c',
        'mcp_servers.docs.enabled=false',
      ]);
    });
  });

  it('starts the app-server with exactly the selected MCP servers', async () => {
    await withManager(async (mgr) => {
      await mgr.startSession({
        name: 'some-mcp',
        cwd: dir,
        engine: 'codex-app',
        ignoreUserConfig: true,
        codexMcpServers: ['docs'],
        noSessionPersistence: true,
      });
      expect(launchedArgs()[0].slice(5)).toEqual(['-c', 'mcp_servers.maas_slack.enabled=false']);
    });
  });

  it('fails the start with the available names when a selected server is unknown', async () => {
    await withManager(async (mgr) => {
      await expect(
        mgr.startSession({
          name: 'bad-mcp',
          cwd: dir,
          engine: 'codex-app',
          ignoreUserConfig: true,
          codexMcpServers: ['nope'],
          noSessionPersistence: true,
        }),
      ).rejects.toThrow(/Unknown MCP server in codexMcpServers: nope.*maas_slack, docs/);
      expect(launchedArgs()).toEqual([]);
      expect(mgr.hasSession('bad-mcp')).toBe(false);
    });
  });
});
