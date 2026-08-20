/**
 * Host-spawn runtime strategy — runs the generated app as a regular Node
 * process on the host, no Docker. The natural default for personal /
 * internal-tool use; Docker is the opt-in mode for shared production
 * hosts where isolation matters.
 *
 * Mirrors the docker.ts shape (`build / run / stop / start / rm`) so the
 * deploy orchestrator and lifecycle helpers stay the same.
 *
 * State persistence:
 *   ~/.claw-orchestrator/host-procs.json keyed by container-name (we keep
 *   the term to match the rest of the API) → { pid, port, cwd, env, since }.
 *   Survives orchestrator restarts: hostStart re-spawns from the saved
 *   metadata, hostStop kills the recorded pid + child group.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BuildResult, DockerRunResult, PsResult } from './docker.js';

const STATE_FILE = path.join(os.homedir(), '.claw-orchestrator', 'host-procs.json');

interface HostProcEntry {
  pid: number;
  port: number;
  cwd: string;
  env: Record<string, string>;
  since: string;
  headless?: boolean;
}

const STATE_LOCK_FILE = `${STATE_FILE}.lock`;
const STATE_LOCK_STALE_MS = 30_000;

function readState(): Record<string, HostProcEntry> {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Record<string, HostProcEntry>;
  } catch {
    return {};
  }
}

function writeState(state: Record<string, HostProcEntry>): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const temporary = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, STATE_FILE);
}

async function withStateLock<T>(action: () => T): Promise<T> {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let handle: number;
    try {
      handle = fs.openSync(STATE_LOCK_FILE, 'wx');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      try {
        const age = Date.now() - fs.statSync(STATE_LOCK_FILE).mtimeMs;
        if (age > STATE_LOCK_STALE_MS) {
          fs.rmSync(STATE_LOCK_FILE, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    try {
      return action();
    } finally {
      fs.closeSync(handle);
      fs.rmSync(STATE_LOCK_FILE, { force: true });
    }
  }
  throw new Error(`timed out acquiring host process state lock: ${STATE_LOCK_FILE}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface HostBuildArgs {
  tag: string;
  cwd: string;
  buildArgs?: Record<string, string>;
}

/**
 * Host build = `npm install` + `npm run build` (if a build script exists).
 * No isolation; we mutate the worktree directly. The "tag" is metadata only
 * — host-mode doesn't have container images.
 */
export async function hostBuild(args: HostBuildArgs): Promise<BuildResult> {
  if (!fs.existsSync(path.join(args.cwd, 'package.json'))) {
    return { ok: false, error: `no package.json at ${args.cwd}` };
  }
  const install = await runNpm(['install'], { cwd: args.cwd, env: args.buildArgs });
  if (!install.ok) return { ok: false, error: `npm install failed: ${install.stderr.slice(0, 500)}` };

  // Only run build if the script exists.
  const pkg = JSON.parse(fs.readFileSync(path.join(args.cwd, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  if (pkg.scripts?.build) {
    const build = await runNpm(['run', 'build'], { cwd: args.cwd, env: args.buildArgs });
    if (!build.ok) return { ok: false, error: `npm run build failed: ${build.stderr.slice(0, 500)}` };
  }
  return { ok: true, imageId: `host:${args.tag}` };
}

export interface HostRunArgs {
  image: string; // for host mode: the cwd of the codebase to run
  name: string;
  hostPort: number;
  env: Record<string, string>;
  // volumes: ignored in host mode (we run in-place)
  volumes?: Record<string, string>;
  /** Hide the detached process window on Windows. Defaults to true. */
  headless?: boolean;
}

/**
 * Host run = spawn `npm start` (or `node server.js` fallback) detached, with
 * PORT + caller env. Records pid in host-procs.json keyed by name.
 */
export async function hostRun(args: HostRunArgs): Promise<DockerRunResult> {
  // image arg is repurposed to mean "cwd of the codebase" in host mode. The
  // caller (deploy orchestrator) passes `tag` as image; we accept either
  // a tag (which we look up — but we don't have a registry, so we expect
  // the caller passes the cwd directly via image).
  // NOTE: deploy.ts currently passes `tag` not `cwd`. We need the cwd
  // separately — passed via env.HOST_CWD as a contract for host mode.
  const cwd = args.env.HOST_CWD || args.image;
  if (!fs.existsSync(path.join(cwd, 'package.json'))) {
    return { ok: false, error: `no package.json at ${cwd}` };
  }
  // Strip the contract env keys from what gets exported to the child
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), ...args.env };
  delete childEnv.HOST_CWD;
  childEnv.PORT = String(args.hostPort);
  const headless = args.headless ?? process.env.CLAWO_HOST_HEADED !== '1';

  const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
    main?: string;
  };
  let cmd: string;
  let cmdArgs: string[];
  if (pkg.scripts?.start) {
    [cmd, cmdArgs] = npmInvocation(['start']);
  } else if (pkg.main) {
    cmd = 'node';
    cmdArgs = [pkg.main];
  } else {
    return { ok: false, error: 'no scripts.start and no main entry in package.json' };
  }

  const child = spawn(cmd, cmdArgs, {
    cwd,
    env: childEnv,
    detached: true,
    stdio: 'ignore',
    windowsHide: process.platform === 'win32' && headless,
  });
  child.unref();
  const pid = child.pid;
  if (typeof pid !== 'number') {
    return { ok: false, error: 'spawn returned no pid' };
  }

  await withStateLock(() => {
    const state = readState();
    state[args.name] = {
      pid,
      port: args.hostPort,
      cwd,
      env: args.env,
      since: new Date().toISOString(),
      headless,
    };
    writeState(state);
  });
  return { ok: true, containerName: args.name };
}

export async function hostStop(name: string): Promise<{ ok: boolean; error?: string }> {
  const state = readState();
  const entry = state[name];
  if (!entry) return { ok: false, error: `no host proc named ${name}` };
  if (isAlive(entry.pid)) {
    if (process.platform === 'win32') {
      // Node's process.kill() only terminates the npm launcher on Windows and
      // leaves its server child alive. Kill the exact recorded process tree;
      // no shell is involved, so names and arguments cannot be reinterpreted.
      spawnSync('taskkill.exe', ['/PID', String(entry.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      try {
        // Kill the process group (child + grandchildren via npm)
        process.kill(-entry.pid, 'SIGTERM');
      } catch {
        try {
          process.kill(entry.pid, 'SIGTERM');
        } catch {
          /* already dead */
        }
      }
    }
    // Give it a beat then SIGKILL if still alive
    await new Promise((r) => setTimeout(r, 250));
    if (process.platform !== 'win32' && isAlive(entry.pid)) {
      try {
        process.kill(-entry.pid, 'SIGKILL');
      } catch {
        try {
          process.kill(entry.pid, 'SIGKILL');
        } catch {
          /* already dead */
        }
      }
    }
  }
  return { ok: true };
}

export async function hostStart(name: string): Promise<{ ok: boolean; error?: string }> {
  const state = readState();
  const entry = state[name];
  if (!entry) return { ok: false, error: `no host proc named ${name}` };
  if (isAlive(entry.pid)) return { ok: true }; // already running
  // Re-spawn using saved metadata
  const r = await hostRun({
    image: entry.cwd,
    name,
    hostPort: entry.port,
    env: { ...entry.env, HOST_CWD: entry.cwd },
    headless: entry.headless !== false,
  });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export async function hostRm(name: string): Promise<{ ok: boolean; error?: string }> {
  await hostStop(name).catch(() => ({ ok: true }));
  await withStateLock(() => {
    const state = readState();
    delete state[name];
    writeState(state);
  });
  return { ok: true };
}

/** Stub matching dockerRmi — host mode has no images, so this is a no-op. */
export async function hostRmi(_tag: string): Promise<{ ok: boolean; error?: string }> {
  return { ok: true };
}

export async function hostPs(): Promise<PsResult> {
  const state = readState();
  const containers = Object.entries(state).map(([name, entry]) => ({
    name,
    state: isAlive(entry.pid) ? 'running' : 'exited',
    ports: `${entry.port}->${entry.port}`,
  }));
  return { containers };
}

interface CmdResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function npmInvocation(args: string[]): [string, string[]] {
  if (process.platform !== 'win32') return ['npm', args];

  // Windows does not expose `npm` as a directly executable PE file. Spawning
  // the npm.cmd shim with shell:false fails with ENOENT/EINVAL in Node. Invoke
  // npm-cli.js through the current Node executable instead, which also avoids
  // shell quoting differences for paths containing spaces.
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const npmCli = candidates.find((candidate): candidate is string => Boolean(candidate && fs.existsSync(candidate)));
  if (npmCli) return [process.execPath, [npmCli, ...args]];

  // Last-resort compatibility for unusual portable Node installations.
  return ['npm.cmd', args];
}

function runNpm(args: string[], opts: { cwd: string; env?: Record<string, string> }): Promise<CmdResult> {
  const [cmd, cmdArgs] = npmInvocation(args);
  return runCmd(cmd, cmdArgs, opts);
}

function runCmd(cmd: string, args: string[], opts: { cwd: string; env?: Record<string, string> }): Promise<CmdResult> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...(process.env as Record<string, string>), ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ ok: code === 0, stdout, stderr }));
    child.on('error', (e) => resolve({ ok: false, stdout, stderr: stderr + e.message }));
  });
}
