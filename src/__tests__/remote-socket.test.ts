/**
 * Local Unix-socket coverage for the remote broker. No SSH process is spawned
 * and no inference engine is started.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionConfig, SessionInfo } from '../types.js';
import { RemoteBroker, prepareBrokerOwnership } from '../remote/broker.js';
import type { RemoteBrokerHost } from '../remote/broker-host.js';
import { RemoteClient } from '../remote/client.js';
import { loadRemoteHostsConfig, normalizeRemoteHostsConfig } from '../remote/config.js';
import { parentSessionIdFromDelegateMarker } from '../remote/delegate-marker.js';
import { RemoteEndpoint } from '../remote/endpoint.js';
import { DurableMailbox } from '../remote/mailbox.js';
import { OperationStore } from '../remote/operation-store.js';
import { payloadHash } from '../remote/protocol.js';
import { buildSshForwardArgs, SshUnixForward } from '../remote/ssh-forward.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

class FakeHost implements RemoteBrokerHost {
  starts: Array<Record<string, unknown>> = [];
  sends: string[] = [];
  shutdowns = 0;
  blockSend: Promise<void> | null = null;
  private releaseSend: () => void = () => undefined;
  private readonly live = new Map<string, SessionInfo>();

  armSendGate(): void {
    this.blockSend = new Promise<void>((resolve) => {
      this.releaseSend = resolve;
    });
  }

  releaseSendGate(): void {
    this.releaseSend();
    this.blockSend = null;
  }

  async startSession(config: Partial<SessionConfig> & { name?: string }): Promise<SessionInfo> {
    const name = config.name ?? 'anon';
    this.starts.push({ ...config });
    const info = {
      name,
      created: '2026-10-05T00:00:00.000Z',
      cwd: config.cwd ?? '/tmp',
      paused: false,
      stats: { turns: 0, turnsSucceeded: 0, tokensIn: 0, tokensOut: 0, cachedTokens: 0 },
      claudeSessionId: config.resumeSessionId ?? 'native-thread-1',
      engine: config.engine,
      localName: name,
      parentMachineId: config.parentMachineId,
      parentSessionId: config.parentSessionId,
      parentToolId: config.parentToolId,
      originHost: config.originHost,
      executionHost: config.executionHost,
      remoteSessionHandle: config.remoteSessionHandle,
    } as SessionInfo;
    this.live.set(name, info);
    return info;
  }

  async sendMessage(name: string, message: string): Promise<{ output: string; sessionId?: string }> {
    if (!this.live.has(name)) throw new Error(`Session '${name}' not found`);
    this.sends.push(message);
    if (this.blockSend) await this.blockSend;
    return { output: 'reply-text', sessionId: this.live.get(name)?.claudeSessionId };
  }

  async stopSession(name: string): Promise<void> {
    this.live.delete(name);
  }

  listSessions(): SessionInfo[] {
    return [...this.live.values()];
  }

  listPersistedSessions(): Array<{ name: string }> {
    return [];
  }

  getStatus(name: string): SessionInfo {
    const info = this.live.get(name);
    if (!info) throw new Error(`Session '${name}' not found`);
    return info;
  }

  health() {
    return {
      ok: true,
      sessions: this.live.size,
      sessionNames: [...this.live.keys()],
      details: [...this.live.values()],
    };
  }

  holdSession(): void {}
  releaseSessionHold(): void {}
  hasLiveSession(name: string): boolean {
    return this.live.has(name);
  }
  isSessionBusy(): boolean {
    return false;
  }
  async shutdown(): Promise<void> {
    this.shutdowns += 1;
  }
}

function openBroker(localHost = 'studio') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crs-'));
  const socketPath = path.join(dir, 'b.sock');
  const fake = new FakeHost();
  const operations = new OperationStore(path.join(dir, 'ops'));
  const mailbox = new DurableMailbox(path.join(dir, 'mail'));
  const broker = new RemoteBroker(fake, { localHost, operations, mailbox });
  const clients: RemoteClient[] = [];
  cleanups.push(async () => {
    fake.releaseSendGate();
    for (const client of clients) client.close();
    await broker.closeOwned();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    socketPath,
    fake,
    operations,
    mailbox,
    broker,
    client(): RemoteClient {
      const client = new RemoteClient(socketPath);
      clients.push(client);
      return client;
    },
  };
}

describe('remote protocol and config', () => {
  it('hashes payloads independently of key order and ignores delegate lookalikes', () => {
    expect(payloadHash({ b: 1, a: { d: true, c: 2 } })).toBe(payloadHash({ a: { c: 2, d: true }, b: 1 }));
    expect(payloadHash({ a: 1, b: undefined })).toBe(payloadHash({ a: 1 }));
    expect(parentSessionIdFromDelegateMarker('MEMENTO-DELEGATE-FROM: parent-native\nwork')).toBe('parent-native');
    expect(parentSessionIdFromDelegateMarker('MEMENTO-HANDOFF-FROM: handoff-id\nwork')).toBeUndefined();
    expect(parentSessionIdFromDelegateMarker('MEMENTO-TANGENT-FROM: tangent-id')).toBeUndefined();
    expect(parentSessionIdFromDelegateMarker('hello\nMEMENTO-DELEGATE-FROM: parent-native')).toBeUndefined();
  });

  it('keeps a missing default config disabled and rejects a missing explicit path', () => {
    expect(loadRemoteHostsConfig({})).toBeNull();
    expect(normalizeRemoteHostsConfig({ enabled: false })).toBeNull();
    expect(() => loadRemoteHostsConfig({ CLAWO_REMOTE_CONFIG: '/tmp/crs-missing-remote-hosts.json' })).toThrow(
      /does not exist/,
    );
  });

  it('accepts a UUID-only machine file and ignores a token-bearing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crs-cfg-'));
    cleanups.push(async () => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const tokenFile = path.join(dir, 'token.json');
    const idFile = path.join(dir, 'id.txt');
    fs.writeFileSync(tokenFile, '{"collectorToken":"do-not-log","machineId":"11111111-1111-4111-8111-111111111111"}\n');
    fs.writeFileSync(idFile, 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE\n');
    const base = {
      enabled: true,
      localHost: 'yoga',
      socketPath: '/tmp/crs-broker.sock',
      hosts: { studio: { sshAlias: 'studio', remoteSocketPath: '/tmp/crs-peer.sock' } },
    };
    expect(normalizeRemoteHostsConfig({ ...base, parentMachineIdFile: tokenFile })?.parentMachineId).toBeUndefined();
    expect(normalizeRemoteHostsConfig({ ...base, parentMachineIdFile: idFile })?.parentMachineId).toBe(
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );
    expect(() => normalizeRemoteHostsConfig({ ...base, parentMachineId: 'not-a-uuid' })).toThrow(/UUID/);
    expect(() =>
      normalizeRemoteHostsConfig({
        ...base,
        hosts: { studio: { sshAlias: 'studio' } },
      }),
    ).toThrow(/sshAlias and remoteSocketPath/);
  });
});

describe('ssh forward arguments', () => {
  it('uses only the fixed OpenSSH local stream forward', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crs-ssh-'));
    const local = path.join(dir, 'l.sock');
    const remote = '/run/user/1000/clawo/broker.sock';
    const signals: string[] = [];
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      stderr: new EventEmitter(),
      exitCode: null,
      signalCode: null,
      kill(signal?: string) {
        signals.push(signal ?? '');
        setTimeout(() => child.emit('exit', 0, null), 0);
        return true;
      },
    });
    let spawned: { command: string; args: string[] } | undefined;
    const forward = new SshUnixForward('studio', local, remote, (command, args) => {
      spawned = { command, args: [...args] };
      fs.writeFileSync(local, '');
      return child;
    });
    cleanups.push(async () => {
      await forward.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    expect(forward.args()).toEqual([
      '-N',
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'StreamLocalBindUnlink=yes',
      '-L',
      `${local}:${remote}`,
      'studio',
    ]);
    expect(buildSshForwardArgs('studio', local, remote).join(' ')).not.toContain('StrictHostKeyChecking');
    expect(buildSshForwardArgs('studio', local, remote).join(' ')).not.toContain('ClearAllForwardings');
    expect(() => buildSshForwardArgs('studio;rm', local, remote)).toThrow();
    await forward.start();
    expect(spawned).toEqual({ command: 'ssh', args: forward.args() });
    await forward.stop();
    expect(signals).toEqual(['SIGTERM']);
  });

  it('stops the owned child when the forward never binds', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crs-ssh-fail-'));
    const local = path.join(dir, 'missing.sock');
    let kills = 0;
    const child = new EventEmitter() as ChildProcess;
    const stderr = new PassThrough();
    Object.assign(child, { exitCode: null, signalCode: null, stderr });
    child.kill = ((signal?: NodeJS.Signals) => {
      kills += 1;
      child.signalCode = signal ?? null;
      queueMicrotask(() => child.emit('exit', null, signal ?? null));
      return true;
    }) as ChildProcess['kill'];
    const forward = new SshUnixForward('fake-peer', local, '/tmp/fake-remote.sock', () => child);
    cleanups.push(async () => {
      await forward.stop();
      stderr.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    await expect(forward.start()).rejects.toThrow('ssh forward did not bind the local socket');
    expect(kills).toBeGreaterThan(0);
  });

  it('removes the scratch directory when the default forward does not bind', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crs-fwd-cfg-'));
    const configPath = path.join(dir, 'remote-hosts.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        enabled: true,
        localHost: 'yoga',
        socketPath: '/tmp/crs-yoga.sock',
        hosts: {
          yoga: { socketPath: '/tmp/crs-yoga.sock' },
          studio: { sshAlias: 'studio', remoteSocketPath: '/tmp/crs-studio.sock' },
        },
      }),
    );
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('clawo-fwd-')));
    let kills = 0;
    const child = new EventEmitter() as ChildProcess;
    const stderr = new PassThrough();
    Object.assign(child, { exitCode: null, signalCode: null, stderr });
    child.kill = ((signal?: NodeJS.Signals) => {
      kills += 1;
      child.signalCode = signal ?? null;
      queueMicrotask(() => child.emit('exit', null, signal ?? null));
      return true;
    }) as ChildProcess['kill'];
    const endpoint = new RemoteEndpoint({
      env: { CLAWO_REMOTE_CONFIG: configPath },
      spawnForward: () => child,
    });
    cleanups.push(async () => {
      await endpoint.close();
      stderr.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    await expect(endpoint.call('studio', 'session.list', {})).rejects.toThrow(/did not bind the local socket/);
    expect(kills).toBeGreaterThan(0);
    const leaked = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('clawo-fwd-') && !before.has(name));
    expect(leaked).toEqual([]);
  });
});

describe('remote broker socket', () => {
  it('keeps the socket owner-only and does not stop sessions on client close', async () => {
    const rig = openBroker();
    await rig.broker.listen(rig.socketPath);
    expect(fs.statSync(rig.dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(rig.socketPath).mode & 0o777).toBe(0o600);
    const client = rig.client();
    const started = await client.call(
      'session.start',
      { name: 'worker', cwd: os.tmpdir(), engine: 'codex-app', resumeSessionId: 'native-thread-1' },
      { operationId: 'op-start-owner' },
    );
    expect(started.status).toBe('completed');
    await rig.broker.close();
    expect(rig.fake.shutdowns).toBe(0);
    expect(rig.fake.hasLiveSession('worker')).toBe(true);
  });

  it('persists acceptance before dispatch and rejoins one turn after the socket drops', async () => {
    const rig = openBroker();
    await rig.broker.listen(rig.socketPath);
    const client = rig.client();
    const started = await client.call(
      'session.start',
      { name: 'worker', cwd: os.tmpdir(), engine: 'codex-app', resumeSessionId: 'native-thread-1' },
      { operationId: 'op-start-rejoin' },
    );
    expect(started.status).toBe('completed');
    rig.fake.armSendGate();
    const running = await client.call(
      'session.send',
      { name: 'worker', message: 'hello', timeout: 3_600_000 },
      { operationId: 'op-send-1', waitTimeoutMs: 80 },
    );
    expect(running.status).toBe('running');
    expect(rig.fake.sends).toEqual(['hello']);
    expect(rig.operations.get('op-send-1')?.status).toBe('running');
    client.close();
    rig.fake.releaseSendGate();
    const rejoined = await rig
      .client()
      .call('session.send', { name: 'worker', message: 'hello', timeout: 3_600_000 }, { operationId: 'op-send-1' });
    expect(rejoined.status).toBe('completed');
    expect((rejoined.result as { output?: string }).output).toBe('reply-text');
    expect(rig.fake.sends).toEqual(['hello']);
    const mismatch = await rig
      .client()
      .call('session.send', { name: 'worker', message: 'changed', timeout: 3_600_000 }, { operationId: 'op-send-1' });
    expect(mismatch.status).toBe('rejected');
    expect(mismatch.error).toMatch(/does not match/);
    expect(rig.fake.sends).toEqual(['hello']);
  });

  it('marks an unfinished operation uncertain on restart and does not replay it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crs-ops-'));
    const ops = path.join(dir, 'ops');
    const first = new OperationStore(ops);
    first.accept({
      id: 'op-old',
      method: 'session.send',
      payloadHash: payloadHash({ name: 'worker', message: 'hello' }),
    });
    first.markRunning('op-old');
    const restarted = new OperationStore(ops);
    expect(restarted.get('op-old')?.status).toBe('running');
    expect(restarted.reconcile()).toBe(1);
    expect(restarted.get('op-old')?.status).toBe('uncertain');
    const fake = new FakeHost();
    const broker = new RemoteBroker(fake, {
      localHost: 'studio',
      operations: restarted,
      mailbox: new DurableMailbox(path.join(dir, 'mail')),
    });
    const socketPath = path.join(dir, 'b.sock');
    const clients: RemoteClient[] = [];
    cleanups.push(async () => {
      for (const client of clients) client.close();
      await broker.closeOwned();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    await broker.listen(socketPath);
    const client = new RemoteClient(socketPath);
    clients.push(client);
    const view = await client.call('session.send', { name: 'worker', message: 'hello' }, { operationId: 'op-old' });
    expect(view.status).toBe('uncertain');
    expect(view.error).toMatch(/not replayed/);
    expect(fake.sends).toHaveLength(0);
    expect(fake.starts).toHaveLength(0);
  });

  it('registers a manual thread without resuming and waits on the mailbox', async () => {
    const rig = openBroker();
    await rig.broker.listen(rig.socketPath);
    const client = rig.client();
    const registered = await client.call(
      'thread.register',
      { name: 'manual', nativeSessionId: 'native-9', parentToolId: 'codex' },
      { operationId: 'op-reg' },
    );
    expect(registered.status).toBe('completed');
    expect((registered.result as { resumed?: boolean }).resumed).toBe(false);
    expect(rig.fake.starts).toHaveLength(0);

    const waiting = rig
      .client()
      .call('thread.wait', { name: 'manual', waitTimeout: 2_000 }, { operationId: 'op-wait' });
    const sent = await client.call(
      'thread.send',
      { name: 'manual', from: 'yoga::parent', message: 'ping', messageId: 'msg-1' },
      { operationId: 'op-mail' },
    );
    expect(sent.status).toBe('completed');
    expect((sent.result as { status?: string }).status).toBe('queued');
    expect(rig.fake.sends).toHaveLength(0);
    const waited = await waiting;
    expect(waited.status).toBe('completed');
    expect((waited.result as { count?: number }).count).toBe(1);

    const [left, right] = await Promise.all([
      rig.client().call('thread.read', { name: 'manual' }, { operationId: 'op-read-a' }),
      rig.client().call('thread.read', { name: 'manual' }, { operationId: 'op-read-b' }),
    ]);
    expect((left.result as { count?: number }).count).toBe(1);
    expect((right.result as { count?: number }).count).toBe(1);
    const acked = await client.call('thread.ack', { messageId: 'msg-1' }, { operationId: 'op-ack-1' });
    const again = await client.call('thread.ack', { messageId: 'msg-1' }, { operationId: 'op-ack-2' });
    expect((acked.result as { acked?: string[] }).acked).toEqual(['msg-1']);
    expect((again.result as { acked?: string[] }).acked).toEqual(['msg-1']);
    const unread = await client.call('thread.read', { name: 'manual', unreadOnly: true }, { operationId: 'op-read-c' });
    expect((unread.result as { count?: number }).count).toBe(0);

    const missing = await client.call(
      'thread.send',
      { name: 'ghost', from: 'yoga::parent', message: 'nope', messageId: 'msg-x' },
      { operationId: 'op-ghost' },
    );
    expect(missing.status).toBe('failed');
    expect(missing.error).toMatch(/refusing to resume/);
    expect(rig.fake.starts).toHaveLength(0);
  });

  it('does not resend a message that was delivering when the mailbox reloaded', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crs-mail-'));
    cleanups.push(async () => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const first = new DurableMailbox(dir);
    await first.register({ name: 'manual', nativeSessionId: 'native-9' });
    await first.enqueue({ id: 'msg-d', threadKey: 'manual', from: 'planner', text: 'half sent' });
    await first.markDelivering('msg-d');
    const reloaded = new DurableMailbox(dir);
    expect(reloaded.read('manual', false)[0]?.status).toBe('uncertain');
    expect(reloaded.read('manual', true)).toHaveLength(0);
  });

  it('delivers managed mail once through the session path and rejects an unsafe cwd', async () => {
    const rig = openBroker();
    await rig.broker.listen(rig.socketPath);
    const client = rig.client();
    const unsafe = await client.call(
      'session.start',
      { name: 'nope', cwd: '/etc', engine: 'codex-app' },
      { operationId: 'op-etc' },
    );
    expect(unsafe.status).toBe('failed');
    expect(rig.fake.starts).toHaveLength(0);

    const started = await client.call(
      'session.start',
      {
        name: 'worker',
        cwd: os.tmpdir(),
        engine: 'codex-app',
        resumeSessionId: 'native-thread-1',
        executionHost: 'attacker',
        originHost: 'yoga',
      },
      { operationId: 'op-start-mail' },
    );
    expect(started.status).toBe('completed');
    expect(rig.fake.starts[0]?.executionHost).toBe('studio');
    expect(rig.fake.starts[0]?.originHost).toBe('yoga');
    expect(rig.fake.starts[0]?.remoteSessionHandle).toBe('studio::worker');
    expect(rig.fake.starts[0]?.resumeSessionId).toBe('native-thread-1');

    const sent = await client.call(
      'inbox.send',
      { from: 'planner', to: 'worker', message: 'do it', messageId: 'msg-m', fromHost: 'yoga' },
      { operationId: 'op-inbox' },
    );
    expect(sent.status).toBe('completed');
    expect(rig.fake.sends).toHaveLength(1);
    expect(rig.fake.sends[0]).toContain('from="planner"');
    expect(rig.fake.sends[0]).toContain('host="yoga"');
    expect(rig.fake.sends[0]).toContain('id="msg-m"');
    const duplicate = await client.call(
      'inbox.send',
      { from: 'planner', to: 'worker', message: 'do it', messageId: 'msg-m', fromHost: 'yoga' },
      { operationId: 'op-inbox-2' },
    );
    expect(duplicate.status).toBe('completed');
    expect(rig.fake.sends).toHaveLength(1);
  });

  it('qualifies a remote result and refuses an unknown host or a nested forward', async () => {
    const rig = openBroker('studio');
    await rig.broker.listen(rig.socketPath);
    const configPath = path.join(rig.dir, 'remote-hosts.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        enabled: true,
        localHost: 'yoga',
        parentMachineId: '00000000-0000-4000-8000-000000000001',
        parentToolId: 'cursor',
        socketPath: '/tmp/crs-yoga.sock',
        hosts: {
          yoga: { socketPath: '/tmp/crs-yoga.sock' },
          studio: { sshAlias: 'studio', remoteSocketPath: '/run/user/1000/clawo/broker.sock' },
        },
      }),
    );
    let forwards = 0;
    const endpoint = new RemoteEndpoint({
      env: { CLAWO_REMOTE_CONFIG: configPath },
      forward: async () => {
        forwards += 1;
        return { socketPath: rig.socketPath, close: async () => undefined };
      },
    });
    cleanups.push(async () => {
      await endpoint.close();
    });
    const started = (await endpoint.call(
      'studio',
      'session.start',
      {
        name: 'worker',
        cwd: os.tmpdir(),
        engine: 'codex-app',
        resumeSessionId: 'native-thread-1',
        executionHost: 'attacker',
      },
      { operationId: 'op-qualified' },
    )) as { name: string; claudeSessionId?: string; executionHost?: string; originHost?: string };
    expect(started.name).toBe('studio::worker');
    expect(started.claudeSessionId).toBe('native-thread-1');
    expect(started.executionHost).toBe('studio');
    expect(started.originHost).toBe('yoga');
    expect(rig.fake.starts[0]?.resumeSessionId).toBe('native-thread-1');
    expect(forwards).toBe(1);
    await endpoint.call('studio', 'session.list', {}, { operationId: 'op-list' });
    expect(forwards).toBe(1);

    await expect(endpoint.call('nope', 'session.list', {}, { operationId: 'op-nope' })).rejects.toThrow(
      /Unknown or unconfigured host 'nope'/,
    );
    const brokerSide = new RemoteEndpoint({
      env: { CLAWO_REMOTE_CONFIG: configPath, CLAWO_REMOTE_EXECUTION_BROKER: '1' },
      forward: async () => {
        forwards += 1;
        return { socketPath: rig.socketPath, close: async () => undefined };
      },
    });
    expect(brokerSide.routeDecision('yoga')).toBe('local');
    expect(() => brokerSide.routeDecision('studio')).toThrow(/refuses to forward/);
    expect(forwards).toBe(1);

    const disabled = new RemoteEndpoint({ env: {} });
    expect(disabled.routeDecision()).toBe('local');
    expect(() => disabled.routeDecision('studio')).toThrow(/Unknown or unconfigured host 'studio'/);
  });

  it('keeps a sender host when the recipient is on another machine', async () => {
    const rig = openBroker('studio');
    await rig.broker.listen(rig.socketPath);
    const configPath = path.join(rig.dir, 'remote-hosts.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        enabled: true,
        localHost: 'yoga',
        socketPath: '/tmp/crs-yoga.sock',
        hosts: {
          yoga: { socketPath: '/tmp/crs-yoga.sock' },
          studio: { sshAlias: 'studio', remoteSocketPath: '/tmp/crs-studio.sock' },
        },
      }),
    );
    const endpoint = new RemoteEndpoint({
      env: { CLAWO_REMOTE_CONFIG: configPath },
      forward: async () => ({ socketPath: rig.socketPath, close: async () => undefined }),
    });
    cleanups.push(async () => {
      await endpoint.close();
    });
    await endpoint.call(
      'studio',
      'session.start',
      { name: 'worker', cwd: os.tmpdir(), engine: 'codex-app' },
      { operationId: 'op-cross-start' },
    );
    await endpoint.call(
      'studio',
      'inbox.send',
      { from: 'yoga::parent', to: 'studio::worker', message: 'across\nhosts', messageId: 'msg-cross' },
      { operationId: 'op-cross-mail' },
    );
    expect(rig.fake.sends[0]).toContain('from="parent"');
    expect(rig.fake.sends[0]).toContain('host="yoga"');
    expect(rig.fake.sends).toHaveLength(1);
  });

  it('opens one forward for concurrent first calls and closes a forward that resolves after shutdown', async () => {
    const configPath = path.join(os.tmpdir(), `crs-fwd-${process.pid}.json`);
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        enabled: true,
        localHost: 'yoga',
        socketPath: '/tmp/crs-yoga.sock',
        hosts: { studio: { sshAlias: 'studio', remoteSocketPath: '/tmp/crs-studio.sock' } },
      }),
    );
    cleanups.push(async () => {
      fs.rmSync(configPath, { force: true });
    });
    let forwards = 0;
    let closed = 0;
    const endpoint = new RemoteEndpoint({
      env: { CLAWO_REMOTE_CONFIG: configPath },
      forward: async () => {
        forwards += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          socketPath: '/tmp/crs-peer.sock',
          close: async () => {
            closed += 1;
          },
        };
      },
      connect: () =>
        ({
          call: async () => ({ operationId: 'op', status: 'completed', result: { ok: true } }),
          close: () => undefined,
        }) as unknown as RemoteClient,
    });
    await Promise.all([
      endpoint.call('studio', 'session.list', {}, { operationId: 'op-a' }),
      endpoint.call('studio', 'session.list', {}, { operationId: 'op-b' }),
    ]);
    expect(forwards).toBe(1);
    await endpoint.close();
    expect(closed).toBe(1);

    let finish: (value: { socketPath: string; close: () => Promise<void> }) => void = () => undefined;
    let lateClosed = 0;
    const raced = new RemoteEndpoint({
      env: { CLAWO_REMOTE_CONFIG: configPath },
      forward: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      connect: () =>
        ({
          call: async () => ({ operationId: 'op', status: 'completed', result: { ok: true } }),
          close: () => undefined,
        }) as unknown as RemoteClient,
    });
    const pending = raced.call('studio', 'session.list', {});
    await new Promise((resolve) => setImmediate(resolve));
    await raced.close();
    finish({
      socketPath: '/tmp/crs-peer.sock',
      close: async () => {
        lateClosed += 1;
      },
    });
    await expect(pending).rejects.toThrow(/closed/);
    expect(lateClosed).toBe(1);
  });

  it('reports the operation id when acceptance is lost and does not open a second socket', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crs-lost-'));
    const socketPath = path.join(dir, 'b.sock');
    const ids = new Set<string>();
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      readline.createInterface({ input: socket }).on('line', (line) => {
        ids.add((JSON.parse(line) as { id: string }).id);
        socket.destroy();
      });
    });
    cleanups.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    const client = new RemoteClient(socketPath, 1);
    cleanups.push(async () => {
      client.close();
    });
    await expect(client.call('session.send', { name: 'worker', message: 'fake' })).rejects.toThrow(
      /operationId=.*acceptance is unknown/,
    );
    expect(ids.size).toBe(1);
    expect([...ids][0]?.length).toBeGreaterThan(0);

    const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crs-share-'));
    const sharedPath = path.join(sharedDir, 'b.sock');
    const seen = new Set<net.Socket>();
    const submits = new Map<string, number>();
    const shared = net.createServer((socket) => {
      seen.add(socket);
      socket.on('error', () => undefined);
      readline.createInterface({ input: socket }).on('line', (line) => {
        const frame = JSON.parse(line) as { id: string };
        submits.set(frame.id, (submits.get(frame.id) ?? 0) + 1);
        socket.write(
          `${JSON.stringify({ kind: 'result', id: frame.id, status: 'completed', result: { ok: true } })}\n`,
        );
      });
    });
    cleanups.push(async () => {
      await new Promise<void>((resolve) => shared.close(() => resolve()));
      fs.rmSync(sharedDir, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) => shared.listen(sharedPath, () => resolve()));
    const sharedClient = new RemoteClient(sharedPath);
    cleanups.push(async () => {
      sharedClient.close();
    });
    await Promise.all([
      sharedClient.call('session.list', {}, { operationId: 'c1' }),
      sharedClient.call('session.list', {}, { operationId: 'c2' }),
    ]);
    expect(seen.size).toBe(1);
    const joined = sharedClient.call('session.list', {}, { operationId: 'c-same' });
    const again = sharedClient.call('session.list', {}, { operationId: 'c-same' });
    await expect(
      sharedClient.call('session.send', { name: 'worker', message: 'other' }, { operationId: 'c-same' }),
    ).rejects.toThrow(/different method or payload/);
    const [left, right] = await Promise.all([joined, again]);
    expect(left).toEqual(right);
    expect(submits.get('c-same')).toBe(1);
    sharedClient.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([...seen].filter((socket) => !socket.destroyed)).toHaveLength(0);
  });

  it('rejects a call closed while the broker socket is still opening', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crs-open-close-'));
    const socketPath = path.join(dir, 'b.sock');
    const owned = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      owned.add(socket);
      socket.on('close', () => owned.delete(socket));
      socket.on('error', () => undefined);
    });
    cleanups.push(async () => {
      for (const socket of owned) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    const client = new RemoteClient(socketPath, 1);
    cleanups.push(async () => {
      client.close();
    });
    const call = client.call('session.list', {}, { operationId: 'client-close-during-open' });
    client.close();
    await expect(call).rejects.toThrow(/operationId=client-close-during-open/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(owned.size).toBe(0);
  });

  it('does not let a second broker reconcile a live operation or resume a manual thread', async () => {
    const rig = openBroker();
    await rig.broker.listen(rig.socketPath);
    const client = rig.client();
    await client.call('thread.register', { name: 'manual', nativeSessionId: 'native-9' }, { operationId: 'op-manual' });
    const blocked = await client.call(
      'session.start',
      { name: 'other', cwd: os.tmpdir(), engine: 'codex-app', resumeSessionId: 'native-9' },
      { operationId: 'op-second-owner' },
    );
    expect(blocked.status).toBe('failed');
    expect(blocked.error).toMatch(/second managed owner/);
    expect(rig.fake.starts).toHaveLength(0);

    rig.fake.armSendGate();
    await client.call(
      'session.start',
      { name: 'worker', cwd: os.tmpdir(), engine: 'codex-app' },
      { operationId: 'op-live-start' },
    );
    const running = client.call(
      'session.send',
      { name: 'worker', message: 'line one\nline two' },
      { operationId: 'op-live', waitTimeoutMs: 50 },
    );
    await vi.waitFor(() => expect(rig.fake.sends).toEqual(['line one\nline two']));
    await running;
    const intruder = new RemoteBroker(new FakeHost(), {
      localHost: 'studio',
      operations: new OperationStore(path.join(rig.dir, 'ops')),
      mailbox: new DurableMailbox(path.join(rig.dir, 'mail-2')),
    });
    const liveSocket = fs.statSync(rig.socketPath);
    await expect(intruder.listen(rig.socketPath)).rejects.toThrow(/already listening/);
    const afterIntruder = fs.statSync(rig.socketPath);
    expect(afterIntruder.ino).toBe(liveSocket.ino);
    expect(rig.operations.get('op-live')?.status).toBe('running');
    const stillThere = await client.call('session.list', {}, { operationId: 'op-still-listening' });
    expect(stillThere.status).toBe('completed');
    rig.fake.releaseSendGate();
  });

  it('constructs the CLI mailbox only after broker ownership is claimed', async () => {
    const source = fs.readFileSync(new URL('../../bin/cli.ts', import.meta.url), 'utf8');
    const start = source.indexOf(".command('remote-broker')");
    const startup = source.slice(start, source.indexOf('// Session commands', start));
    const guardPosition = startup.indexOf('await prepareBrokerOwnership(');
    const mailboxPosition = startup.indexOf('const mailbox = new DurableMailbox(');
    expect(guardPosition).toBeGreaterThanOrEqual(0);
    expect(mailboxPosition).toBeGreaterThan(guardPosition);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crs-mail-owner-'));
    const socketPath = path.join(dir, 'b.sock');
    const mailboxDir = path.join(dir, 'mailbox');
    const operations = new OperationStore(path.join(dir, 'operations'));
    operations.claimOwner();
    operations.accept({ id: 'op-live', method: 'session.send', payloadHash: 'hash' });
    operations.markRunning('op-live');
    const mailbox = new DurableMailbox(mailboxDir);
    await mailbox.enqueue({ id: 'live-delivery', threadKey: 'worker', from: 'parent', text: 'one active delivery' });
    await mailbox.claimQueued('live-delivery');
    const server = net.createServer((socket) => {
      socket.on('error', () => undefined);
    });
    cleanups.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      operations.releaseOwner();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    const intruder = new OperationStore(path.join(dir, 'operations'));
    await expect(prepareBrokerOwnership(socketPath, intruder)).rejects.toThrow(/already listening/);
    const persisted = JSON.parse(fs.readFileSync(path.join(mailboxDir, 'mailbox.json'), 'utf8')) as {
      messages: Array<{ status: string }>;
    };
    expect(persisted.messages[0]?.status).toBe('delivering');
    expect(mailbox.read('worker', false)[0]?.status).toBe('delivering');
    expect(operations.get('op-live')?.status).toBe('running');
    expect(intruder.get('op-live')?.status).toBe('running');
  });

  it('cancels a mailbox wait on service shutdown and keeps one managed delivery', async () => {
    const rig = openBroker();
    await rig.broker.listen(rig.socketPath);
    const client = rig.client();
    await client.call(
      'thread.register',
      { name: 'manual', nativeSessionId: 'native-9' },
      { operationId: 'op-reg-stop' },
    );
    const waiting = client.call(
      'thread.wait',
      { name: 'manual', waitTimeout: 3_600_000 },
      { operationId: 'op-long-wait', waitTimeoutMs: 30 },
    );
    expect((await waiting).status).toBe('running');
    const started = Date.now();
    await rig.broker.closeOwned();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(rig.operations.get('op-long-wait')?.status).toBe('failed');

    const again = openBroker();
    await again.broker.listen(again.socketPath);
    const caller = again.client();
    await caller.call(
      'session.start',
      { name: 'worker', cwd: os.tmpdir(), engine: 'codex-app' },
      { operationId: 'op-claim-start' },
    );
    await again.mailbox.enqueue({ id: 'msg-once', threadKey: 'worker', from: 'planner', text: 'once' });
    await Promise.all([
      caller.call('inbox.deliver', { name: 'worker' }, { operationId: 'op-deliver-a' }),
      caller.call('inbox.deliver', { name: 'worker' }, { operationId: 'op-deliver-b' }),
    ]);
    expect(again.fake.sends).toHaveLength(1);
  });

  it('preserves a message id after its read payload is evicted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crs-receipt-'));
    cleanups.push(async () => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const box = new DurableMailbox(dir);
    await box.register({ name: 'manual', nativeSessionId: 'native-9' });
    for (let index = 0; index < 200; index += 1) {
      await box.enqueue({ id: `msg-${index}`, threadKey: 'manual', from: 'planner', text: `body ${index}` });
      await box.ack([`msg-${index}`]);
    }
    await box.enqueue({ id: 'msg-extra', threadKey: 'manual', from: 'planner', text: 'overflow' });
    const reloaded = new DurableMailbox(dir);
    const duplicate = await reloaded.enqueue({
      id: 'msg-0',
      threadKey: 'manual',
      from: 'planner',
      text: 'body 0',
    });
    expect(duplicate.duplicate).toBe(true);
    await expect(
      reloaded.enqueue({ id: 'msg-0', threadKey: 'manual', from: 'planner', text: 'changed' }),
    ).rejects.toThrow(/different payload/);
  });
});
