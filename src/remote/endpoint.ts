import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadRemoteHostsConfig, type RemoteHostsConfig } from './config.js';
import { RemoteClient, type RemoteCallOptions } from './client.js';
import { SshUnixForward, type SshSpawn } from './ssh-forward.js';
import { assertSocketPath, qualifySessionName, splitSessionHandle } from './qualified-name.js';
import type { BrokerMethod } from './protocol.js';

export type RouteDecision = 'local' | 'remote';

export interface RemoteForward {
  socketPath: string;
  close: () => Promise<void>;
}

export interface RemoteEndpointOptions {
  env?: NodeJS.ProcessEnv;
  connect?: (socketPath: string) => RemoteClient;
  forward?: (alias: string, remoteSocket: string) => Promise<RemoteForward>;
  /** Test seam. Production uses the OpenSSH child inside SshUnixForward. */
  spawnForward?: SshSpawn;
}

/**
 * Controller-side router. When remote sockets are disabled, callers stay on
 * the in-process SessionManager. When enabled, every routed call uses the
 * broker, including calls for this machine. The execution-broker flag refuses
 * to open another forward.
 */
export class RemoteEndpoint {
  private configCache: RemoteHostsConfig | null | undefined;
  private readonly clients = new Map<string, RemoteClient>();
  private readonly forwards = new Map<string, RemoteForward>();
  private readonly connecting = new Map<string, Promise<RemoteClient>>();
  private closed = false;

  constructor(private readonly options: RemoteEndpointOptions = {}) {}

  private environment(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  config(): RemoteHostsConfig | null {
    if (this.configCache === undefined) this.configCache = loadRemoteHostsConfig(this.environment());
    return this.configCache;
  }

  routeDecision(host?: string): RouteDecision {
    if (this.environment().CLAWO_REMOTE_EXECUTION_BROKER === '1') {
      if (host) {
        const config = this.config();
        if (!config || host !== config.localHost) {
          throw new Error(`Execution broker refuses to forward host '${host}'`);
        }
      }
      return 'local';
    }
    const config = this.config();
    if (!config) {
      if (host) throw new Error(`Unknown or unconfigured host '${host}'`);
      return 'local';
    }
    return 'remote';
  }

  async call(
    host: string | undefined,
    method: BrokerMethod,
    payload: Record<string, unknown>,
    opts: RemoteCallOptions = {},
  ): Promise<unknown> {
    const config = this.config();
    if (!config) throw new Error(host ? `Unknown or unconfigured host '${host}'` : 'Remote sockets are disabled');
    const known = new Set<string>([config.localHost, ...Object.keys(config.hosts)]);
    const body: Record<string, unknown> = { ...payload };
    let target = host;
    for (const field of ['name', 'to'] as const) {
      const value = body[field];
      if (typeof value !== 'string' || value === '*') continue;
      const split = splitSessionHandle(value, known);
      if (split.host && target && split.host !== target) {
        throw new Error(`Session handle host '${split.host}' does not match host '${target}'`);
      }
      if (split.host) {
        target = target ?? split.host;
        body[field] = split.localName;
      }
    }
    if (typeof body.from === 'string' && body.from !== '*') {
      const sender = splitSessionHandle(body.from, known);
      if (sender.host) {
        body.from = sender.localName;
        if (typeof body.fromHost !== 'string') body.fromHost = sender.host;
      }
    }
    target = target ?? config.localHost;
    if (!config.hosts[target]) throw new Error(`Unknown or unconfigured host '${target}'`);
    if (method === 'session.start') {
      if (typeof body.parentMachineId !== 'string' && config.parentMachineId)
        body.parentMachineId = config.parentMachineId;
      if (typeof body.parentToolId !== 'string' && config.parentToolId) body.parentToolId = config.parentToolId;
      if (typeof body.originHost !== 'string') body.originHost = config.localHost;
      delete body.executionHost;
      delete body.remoteSessionHandle;
    }
    const client = await this.clientFor(target, config);
    const view = await client.call(method, body, opts);
    if (view.status === 'completed') return present(target, config.localHost, view.result);
    if (view.status === 'running' || view.status === 'accepted') {
      return { ok: true, status: view.status, operationId: view.operationId };
    }
    const detail = view.error ? `: ${view.error}` : '';
    throw new Error(`remote operation ${view.operationId} is ${view.status}${detail}`);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
    for (const forward of [...this.forwards.values()]) await forward.close();
    this.forwards.clear();
  }

  private clientFor(host: string, config: RemoteHostsConfig): Promise<RemoteClient> {
    const existing = this.clients.get(host);
    if (existing) return Promise.resolve(existing);
    const pending = this.connecting.get(host);
    if (pending) return pending;
    const opening = this.openClient(host, config).then(
      (client) => {
        if (this.closed) {
          client.close();
          throw new Error('remote endpoint closed');
        }
        this.clients.set(host, client);
        return client;
      },
      (err) => {
        const forward = this.forwards.get(host);
        this.forwards.delete(host);
        if (forward) void forward.close();
        throw err;
      },
    );
    const tracked = opening.finally(() => {
      if (this.connecting.get(host) === tracked) this.connecting.delete(host);
    });
    this.connecting.set(host, tracked);
    return tracked;
  }

  private async openClient(host: string, config: RemoteHostsConfig): Promise<RemoteClient> {
    if (this.closed) throw new Error('remote endpoint closed');
    const entry = config.hosts[host];
    let socketPath: string;
    if (host === config.localHost) {
      socketPath = entry.socketPath || config.socketPath;
    } else {
      if (!entry.sshAlias || !entry.remoteSocketPath) throw new Error(`Unknown or unconfigured host '${host}'`);
      const forward = this.options.forward
        ? await this.options.forward(entry.sshAlias, entry.remoteSocketPath)
        : await this.defaultForward(entry.sshAlias, entry.remoteSocketPath);
      this.forwards.set(host, forward);
      if (this.closed) {
        await forward.close();
        this.forwards.delete(host);
        throw new Error('remote endpoint closed');
      }
      socketPath = forward.socketPath;
    }
    const client = this.options.connect ? this.options.connect(socketPath) : new RemoteClient(socketPath);
    if (this.closed) {
      client.close();
      throw new Error('remote endpoint closed');
    }
    return client;
  }

  private async defaultForward(alias: string, remoteSocket: string): Promise<RemoteForward> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clawo-fwd-'));
    fs.chmodSync(directory, 0o700);
    const localSocket = path.join(directory, 'peer.sock');
    const ssh = this.options.spawnForward
      ? new SshUnixForward(alias, localSocket, remoteSocket, this.options.spawnForward)
      : new SshUnixForward(alias, localSocket, remoteSocket);
    try {
      assertSocketPath(localSocket);
      await ssh.start();
    } catch (err) {
      await ssh.stop();
      fs.rmSync(directory, { recursive: true, force: true });
      throw err;
    }
    return {
      socketPath: localSocket,
      close: async () => {
        await ssh.stop();
        fs.rmSync(directory, { recursive: true, force: true });
      },
    };
  }
}

function present(host: string, localHost: string, result: unknown): unknown {
  if (host === localHost || !result || typeof result !== 'object') return result;
  const copy = { ...(result as Record<string, unknown>) };
  if (typeof copy.name === 'string') Object.assign(copy, qualifyRow({ name: copy.name, ...copy }, host));
  if (Array.isArray(copy.sessions)) copy.sessions = copy.sessions.map((item) => qualifyRow(item, host));
  if (Array.isArray(copy.persisted)) copy.persisted = copy.persisted.map((item) => qualifyRow(item, host));
  if (Array.isArray(copy.sessionNames)) {
    copy.sessionNames = copy.sessionNames.map((name) =>
      typeof name === 'string' && !name.includes('::') ? qualifySessionName(host, name) : name,
    );
  }
  if (Array.isArray(copy.details)) copy.details = copy.details.map((item) => qualifyRow(item, host));
  return copy;
}

function qualifyRow(item: unknown, host: string): unknown {
  if (!item || typeof item !== 'object') return item;
  const row = { ...(item as Record<string, unknown>) };
  if (typeof row.name !== 'string' || row.name.includes('::')) return row;
  const qualified = qualifySessionName(host, row.name);
  row.localName = row.localName ?? row.name;
  row.name = qualified;
  row.remoteSessionHandle = row.remoteSessionHandle ?? qualified;
  return row;
}
