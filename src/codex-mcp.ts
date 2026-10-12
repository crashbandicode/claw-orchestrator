/**
 * Codex MCP server selection.
 *
 * `ignoreUserConfig` has to keep a session from loading the user's MCP servers:
 * an unreachable one (e.g. a corporate MCP host off the corporate network) makes
 * every Codex start log transport errors, and its failures reach the orchestrator
 * as notifications. `codexMcpServers` is the way back for the servers a caller
 * does want, by name, out of that same config.
 *
 * Two engines, two mechanisms:
 *   - `codex exec` has `--ignore-user-config`. It drops the whole file, selected
 *     servers included, so it is only used when nothing is selected.
 *   - `codex app-server` has no such flag, and `-c mcp_servers={}` does not clear
 *     anything — `-c` overrides are merged into the config tables, not swapped in.
 *     What does work, measured against 0.161.0 with a throwaway CODEX_HOME, is
 *     `-c mcp_servers.<name>.enabled=false` per server: the disabled server is
 *     never started.
 *
 * With a selection both engines therefore take the second route. It needs the set
 * of configured server names, which `codex mcp list --json` reports. Only names
 * and the `enabled` flag are read from that output. Transports, headers, bearer
 * tokens and env are never kept, logged or put on a command line, and error
 * messages here carry server names only.
 */

import { spawn } from 'node:child_process';
import { resolveWindowsNodeInvocation } from './windows-command.js';
import type { EngineType, SessionConfig } from './types.js';

/** Upper bound on a selection, so a runaway argument cannot grow the arg list unboundedly. */
export const MAX_CODEX_MCP_SELECTION = 64;

/** Characters Codex accepts in a server name (`codex mcp add` enforces the same set). */
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const LIST_TIMEOUT_MS = 30_000;

export interface CodexMcpServerEntry {
  name: string;
  enabled: boolean;
}

/**
 * Validate `codexMcpServers` on a session config and return the de-duplicated
 * selection, or `undefined` when the caller made none.
 *
 * Rejected, with a message that names the offending field:
 *   - a non-array, a non-string entry, or a name outside `[A-Za-z0-9_-]{1,64}`;
 *   - more than {@link MAX_CODEX_MCP_SELECTION} names;
 *   - use on an engine other than `codex` / `codex-app`, where nothing would
 *     honour it and silently dropping it would leave servers running;
 *   - use without `ignoreUserConfig: true`, where it has no meaning: without that
 *     flag every configured server loads anyway.
 *
 * An empty array is the same as no selection: `ignoreUserConfig` alone means no
 * MCP servers.
 */
export function validateCodexMcpSelection(
  config: Pick<SessionConfig, 'ignoreUserConfig' | 'codexMcpServers'>,
  engine: EngineType | undefined,
): string[] | undefined {
  const raw = config.codexMcpServers;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error('codexMcpServers must be an array of MCP server names');
  }
  if (engine !== 'codex' && engine !== 'codex-app') {
    throw new Error("codexMcpServers is only supported by the 'codex' and 'codex-app' engines");
  }
  if (raw.length > MAX_CODEX_MCP_SELECTION) {
    throw new Error(`codexMcpServers accepts at most ${MAX_CODEX_MCP_SELECTION} names`);
  }
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !MCP_SERVER_NAME.test(entry)) {
      throw new Error(
        'codexMcpServers entries must be MCP server names of 1-64 letters, digits, underscores or hyphens',
      );
    }
    if (!names.includes(entry)) names.push(entry);
  }
  if (config.ignoreUserConfig !== true) {
    throw new Error(
      'codexMcpServers selects servers to keep while ignoreUserConfig is on; it requires ignoreUserConfig: true',
    );
  }
  return names;
}

/** A TOML key for `-c`: bare when it can be, quoted otherwise. */
export function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

/**
 * Parse the output of `codex mcp list --json`, keeping only name and enabled.
 * Leading non-JSON lines (warnings that some builds print on stdout) are skipped.
 */
export function parseCodexMcpList(stdout: string): CodexMcpServerEntry[] {
  const start = stdout.indexOf('[');
  if (start < 0) throw new Error('codex mcp list --json returned no JSON array');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    throw new Error('codex mcp list --json returned output that is not valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('codex mcp list --json did not return an array');
  const out: CodexMcpServerEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as { name?: unknown; enabled?: unknown };
    if (typeof rec.name !== 'string' || rec.name.length === 0) continue;
    out.push({ name: rec.name, enabled: rec.enabled !== false });
  }
  return out;
}

/** Ask Codex which MCP servers its effective config defines for `cwd`. */
export function listCodexMcpServers(opts: {
  codexBin: string;
  cwd?: string;
  timeoutMs?: number;
}): Promise<CodexMcpServerEntry[]> {
  return new Promise((resolve, reject) => {
    const invocation = resolveWindowsNodeInvocation(opts.codexBin);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const proc = spawn(invocation.command, [...invocation.prefixArgs, 'mcp', 'list', '--json'], {
      cwd: opts.cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: process.platform === 'win32',
    });
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Already gone.
        }
        reject(new Error('Timed out enumerating Codex MCP servers (codex mcp list --json)'));
      });
    }, opts.timeoutMs ?? LIST_TIMEOUT_MS);
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      // Kept only to say that something was printed; never echoed (config errors can quote values).
      stderr += d.toString();
    });
    proc.on('error', (err) => {
      settle(() => reject(new Error(`Cannot run codex to enumerate MCP servers: ${err.message}`)));
    });
    proc.on('close', (code) => {
      settle(() => {
        if (code !== 0) {
          reject(
            new Error(
              `codex mcp list --json exited with code ${code}${stderr.trim() ? ' (see the Codex log for details)' : ''}`,
            ),
          );
          return;
        }
        try {
          resolve(parseCodexMcpList(stdout));
        } catch (err) {
          reject(err as Error);
        }
      });
    });
  });
}

/**
 * The `-c` arguments that leave only `keep` running among the servers `servers`
 * defines. Unknown or already-disabled selections throw, naming the servers.
 */
export function buildMcpDisableArgs(servers: CodexMcpServerEntry[], keep: string[]): string[] {
  const known = new Map(servers.map((s) => [s.name, s]));
  const unknown = keep.filter((n) => !known.has(n));
  if (unknown.length > 0) {
    const available = servers.map((s) => s.name);
    throw new Error(
      `Unknown MCP server${unknown.length > 1 ? 's' : ''} in codexMcpServers: ${unknown.join(', ')}. ` +
        `Servers in the Codex config: ${available.length > 0 ? available.join(', ') : '(none)'}`,
    );
  }
  const off = keep.filter((n) => known.get(n)!.enabled === false);
  if (off.length > 0) {
    throw new Error(
      `MCP server${off.length > 1 ? 's' : ''} selected in codexMcpServers ${off.length > 1 ? 'are' : 'is'} disabled in the Codex config: ${off.join(', ')}`,
    );
  }
  const keepSet = new Set(keep);
  const args: string[] = [];
  for (const s of servers) {
    if (keepSet.has(s.name)) continue;
    args.push('-c', `mcp_servers.${tomlKey(s.name)}.enabled=false`);
  }
  return args;
}

/**
 * Enumerate the configured servers and return the `-c` arguments that disable
 * all but `keep` (empty `keep` = all of them). Throws when enumeration fails:
 * starting anyway would load the servers the caller asked to avoid.
 */
export async function resolveCodexMcpDisableArgs(opts: {
  codexBin: string;
  cwd?: string;
  keep: string[];
}): Promise<string[]> {
  const servers = await listCodexMcpServers({ codexBin: opts.codexBin, cwd: opts.cwd });
  return buildMcpDisableArgs(servers, opts.keep);
}
