import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { assertHostAlias, assertSocketPath } from './qualified-name.js';

export interface SshSpawn {
  (command: string, args: readonly string[], options: { stdio: ['ignore', 'ignore', 'pipe'] }): ChildProcess;
}

/**
 * Fixed OpenSSH local stream forward. Alias and socket paths are the only
 * variable fields, and both are administrator config, not model input.
 * Host key checking stays at SSH's default. No extra options are accepted.
 */
export function buildSshForwardArgs(alias: string, localSocket: string, remoteSocket: string): string[] {
  assertHostAlias(alias);
  assertSocketPath(localSocket);
  assertSocketPath(remoteSocket);
  return [
    '-N',
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'StreamLocalBindUnlink=yes',
    '-L',
    `${localSocket}:${remoteSocket}`,
    alias,
  ];
}

export class SshUnixForward {
  private child: ChildProcess | null = null;
  private stderr = '';
  private settled = false;

  constructor(
    private readonly alias: string,
    readonly localSocket: string,
    private readonly remoteSocket: string,
    private readonly spawnFn: SshSpawn = spawn as unknown as SshSpawn,
  ) {}

  args(): string[] {
    return buildSshForwardArgs(this.alias, this.localSocket, this.remoteSocket);
  }

  start(): Promise<void> {
    fs.mkdirSync(path.dirname(this.localSocket), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(this.localSocket), 0o700);
    const child = this.spawnFn('ssh', this.args(), { stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;
    return new Promise((resolve, reject) => {
      const fail = (err: Error): void => {
        if (this.settled) return;
        this.settled = true;
        void this.stop().finally(() => reject(err));
      };
      child.once('error', (err) => fail(err));
      child.stderr?.on('data', (chunk: Buffer) => {
        this.stderr = (this.stderr + chunk.toString('utf8')).slice(-2_000);
      });
      child.once('exit', (code) => {
        if (!this.settled) fail(new Error(`ssh forward exited (${code ?? 'signal'}): ${this.stderr.trim()}`));
      });
      void this.waitUntilBound()
        .then(() => {
          if (this.settled) return;
          this.settled = true;
          resolve();
        })
        .catch(fail);
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode != null || child.signalCode != null) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        resolve();
      }, 1_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async waitUntilBound(): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (fs.existsSync(this.localSocket)) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('ssh forward did not bind the local socket');
  }
}
