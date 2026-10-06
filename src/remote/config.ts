import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PARENT_TOOL_IDS, type ParentToolId } from '../types.js';
import { assertHostAlias, assertSocketPath } from './qualified-name.js';

export interface RemoteHostEntry {
  socketPath?: string;
  sshAlias?: string;
  remoteSocketPath?: string;
}

export interface RemoteHostsConfig {
  enabled: true;
  localHost: string;
  parentMachineId?: string;
  parentToolId?: ParentToolId;
  socketPath: string;
  hosts: Record<string, RemoteHostEntry>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function defaultRemoteConfigPath(home = os.homedir()): string {
  return path.join(home, '.claw-orchestrator', 'remote-hosts.json');
}

/**
 * Load administrator config. Reads only `CLAWO_REMOTE_CONFIG` or the default
 * path. A missing default file disables the feature. A missing explicit path
 * is a configuration error, not a local fallback.
 */
export function loadRemoteHostsConfig(env: NodeJS.ProcessEnv = process.env): RemoteHostsConfig | null {
  const explicit = env.CLAWO_REMOTE_CONFIG?.trim();
  const file = explicit || defaultRemoteConfigPath();
  if (!fs.existsSync(file)) {
    if (!explicit) return null;
    throw new Error(`CLAWO_REMOTE_CONFIG does not exist: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (err) {
    throw new Error(`Remote host config is not valid JSON: ${(err as Error).message}`);
  }
  return normalizeRemoteHostsConfig(parsed);
}

function bareMachineId(file: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const trimmed = text.trim();
  if (!UUID_RE.test(trimmed)) return undefined;
  return trimmed.toLowerCase();
}

function readEntry(entry: unknown, alias: string): RemoteHostEntry {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`Host '${alias}' must be a JSON object`);
  }
  const raw = entry as Record<string, unknown>;
  const out: RemoteHostEntry = {};
  if (raw.socketPath !== undefined) {
    if (typeof raw.socketPath !== 'string') throw new Error(`Host '${alias}' socketPath must be a string`);
    assertSocketPath(raw.socketPath);
    out.socketPath = raw.socketPath;
  }
  if (raw.sshAlias !== undefined) {
    if (typeof raw.sshAlias !== 'string') throw new Error(`Host '${alias}' sshAlias must be a string`);
    assertHostAlias(raw.sshAlias);
    out.sshAlias = raw.sshAlias;
  }
  if (raw.remoteSocketPath !== undefined) {
    if (typeof raw.remoteSocketPath !== 'string') throw new Error(`Host '${alias}' remoteSocketPath must be a string`);
    assertSocketPath(raw.remoteSocketPath);
    out.remoteSocketPath = raw.remoteSocketPath;
  }
  return out;
}

export function normalizeRemoteHostsConfig(parsed: unknown): RemoteHostsConfig | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Remote host config must be a JSON object');
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.enabled === undefined || raw.enabled === false) return null;
  if (raw.enabled !== true) throw new Error('Remote host config enabled must be a boolean');
  if (typeof raw.localHost !== 'string') throw new Error('Remote host config localHost is required');
  assertHostAlias(raw.localHost);
  if (typeof raw.socketPath !== 'string') throw new Error('Remote host config socketPath is required');
  assertSocketPath(raw.socketPath);

  let parentMachineId: string | undefined;
  if (typeof raw.parentMachineId === 'string') {
    if (!UUID_RE.test(raw.parentMachineId)) {
      throw new Error('parentMachineId must be a UUID');
    }
    parentMachineId = raw.parentMachineId.toLowerCase();
  } else if (raw.parentMachineId !== undefined) {
    throw new Error('parentMachineId must be a UUID');
  } else if (typeof raw.parentMachineIdFile === 'string') {
    parentMachineId = bareMachineId(raw.parentMachineIdFile);
  }

  let parentToolId: ParentToolId | undefined;
  if (raw.parentToolId !== undefined) {
    if (typeof raw.parentToolId !== 'string' || !(PARENT_TOOL_IDS as readonly string[]).includes(raw.parentToolId)) {
      throw new Error('parentToolId must be codex, claude_code, cursor, or opencode');
    }
    parentToolId = raw.parentToolId as ParentToolId;
  }

  const hosts: Record<string, RemoteHostEntry> = {};
  if (raw.hosts !== undefined) {
    if (!raw.hosts || typeof raw.hosts !== 'object' || Array.isArray(raw.hosts)) {
      throw new Error('Remote host config hosts must be an object');
    }
    for (const [alias, entry] of Object.entries(raw.hosts as Record<string, unknown>)) {
      assertHostAlias(alias);
      hosts[alias] = readEntry(entry, alias);
    }
  }
  if (!hosts[raw.localHost]) hosts[raw.localHost] = { socketPath: raw.socketPath };
  if (!hosts[raw.localHost].socketPath) hosts[raw.localHost].socketPath = raw.socketPath;

  for (const [alias, entry] of Object.entries(hosts)) {
    if (alias === raw.localHost) {
      if (!entry.socketPath) throw new Error(`Local host '${alias}' needs a socketPath`);
      continue;
    }
    if (!entry.sshAlias || !entry.remoteSocketPath) {
      throw new Error(`Host '${alias}' needs sshAlias and remoteSocketPath`);
    }
  }

  return {
    enabled: true,
    localHost: raw.localHost,
    ...(parentMachineId ? { parentMachineId } : {}),
    ...(parentToolId ? { parentToolId } : {}),
    socketPath: raw.socketPath,
    hosts,
  };
}
