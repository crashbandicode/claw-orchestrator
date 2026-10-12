#!/usr/bin/env tsx
/**
 * Real-binary check for Codex's per-server `-c` overrides.
 * Uses the real ~/.codex config, but prints only server name, enabled, and type.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildMcpDisableArgs, listCodexMcpServers, parseCodexMcpList } from '../src/codex-mcp.js';

const CODEX_BIN = 'codex';
const KEEP = 'memento-memory';
const CODEX_HOME = join(homedir(), '.codex');
const CONFIG = join(CODEX_HOME, 'config.toml');
const TIMEOUT_MS = 30_000;

function runCodex(args: string[], input?: string) {
  return spawnSync(CODEX_BIN, args, {
    cwd: homedir(),
    env: { ...process.env, CODEX_HOME },
    encoding: 'utf8',
    input,
    maxBuffer: 4 * 1024 * 1024,
    timeout: TIMEOUT_MS,
  });
}

function requireSuccess(result: ReturnType<typeof runCodex>, command: string): void {
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code ?? 'unknown';
    throw new Error(`${command} could not run (${code})`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} exited with code ${result.status ?? 'unknown'}${result.signal ? ` (${result.signal})` : ''}`,
    );
  }
}

async function main(): Promise<void> {
  const availability = spawnSync(CODEX_BIN, ['--version'], { encoding: 'utf8', timeout: TIMEOUT_MS });
  if ((availability.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    console.log('SKIP: codex binary is not installed or not on PATH');
    return;
  }
  requireSuccess(availability, 'codex --version');
  if (!existsSync(CONFIG)) throw new Error(`Codex config not found at ${CONFIG}`);

  const originalCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = CODEX_HOME;
  try {
    const original = await listCodexMcpServers({ codexBin: CODEX_BIN, cwd: homedir() });
    const selected = original.find((server) => server.name === KEEP);
    if (!selected) throw new Error(`Required MCP server ${KEEP} is not present in ~/.codex`);
    if (!selected.enabled) throw new Error(`Required MCP server ${KEEP} is disabled in ~/.codex`);
    if (!selected.transportType) throw new Error(`Required MCP server ${KEEP} has no transport.type in ~/.codex`);

    const overrides = buildMcpDisableArgs(original, [KEEP]);
    const appServer = runCodex(['app-server', '--listen', 'stdio://', ...overrides], '');
    const appOutput = `${appServer.stdout ?? ''}\n${appServer.stderr ?? ''}`;
    if (/invalid transport/i.test(appOutput)) throw new Error('codex app-server reported invalid transport');
    requireSuccess(appServer, 'codex app-server --listen stdio:// with generated overrides');

    const listed = runCodex(['mcp', 'list', '--json', ...overrides]);
    requireSuccess(listed, 'codex mcp list --json with generated overrides');
    const effective = parseCodexMcpList(listed.stdout ?? '');
    const originalByName = new Map(original.map((server) => [server.name, server]));
    const effectiveByName = new Map(effective.map((server) => [server.name, server]));
    if (effectiveByName.size !== originalByName.size) {
      throw new Error('codex mcp list --json changed the MCP server set');
    }
    for (const server of original) {
      const actual = effectiveByName.get(server.name);
      if (!actual) throw new Error(`codex mcp list --json omitted MCP server ${server.name}`);
      if (server.name === KEEP) {
        if (!actual.enabled || actual.transportType !== selected.transportType) {
          throw new Error(`Selected MCP server ${KEEP} did not retain its enabled state and transport type`);
        }
      } else if (actual.enabled) {
        throw new Error(`Non-selected MCP server ${server.name} remained enabled`);
      }
    }

    console.log('name\tenabled\ttype');
    for (const server of effective) {
      console.log(`${server.name}\t${server.enabled}\t${server.transportType ?? '(missing)'}`);
    }
    console.log('PASS: app-server exited 0 without invalid transport; mcp list kept only memento-memory enabled.');
  } finally {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown failure';
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
});
