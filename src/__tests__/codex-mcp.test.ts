/**
 * Codex MCP server selection: validation, `codex mcp list --json` parsing, and
 * the `-c mcp_servers.<name>.enabled=false` overrides built from it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const {
  validateCodexMcpSelection,
  parseCodexMcpList,
  buildMcpDisableArgs,
  tomlKey,
  listCodexMcpServers,
  resolveCodexMcpDisableArgs,
  MAX_CODEX_MCP_SELECTION,
} = await import('../codex-mcp.js');

/** A process that prints `stdout` (and optionally `stderr`) then closes with `code`. */
function listProc(stdout: string, code = 0, stderr = ''): EventEmitter {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  queueMicrotask(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', code);
  });
  return proc;
}

// Shape of `codex mcp list --json` (0.161.0) including the fields that must never leak.
const LIST_JSON = JSON.stringify([
  {
    name: 'maas_slack',
    enabled: true,
    transport: {
      type: 'streamable_http',
      url: 'https://maas.example.invalid/slack/mcp',
      http_headers: { Authorization: 'Bearer SECRET-TOKEN-VALUE' },
    },
  },
  {
    name: 'local-tool',
    enabled: true,
    transport: { type: 'stdio', command: '/bin/x', env: { API_KEY: 'sk-SECRETSECRET' } },
  },
  { name: 'off', enabled: false, transport: { type: 'stdio', command: '/bin/y' } },
]);

describe('validateCodexMcpSelection', () => {
  it('returns undefined when nothing was selected', () => {
    expect(validateCodexMcpSelection({}, 'codex-app')).toBeUndefined();
    expect(validateCodexMcpSelection({ ignoreUserConfig: true }, 'codex')).toBeUndefined();
    // Not selected at all: no engine restriction either, so every other engine keeps working.
    expect(validateCodexMcpSelection({}, 'claude')).toBeUndefined();
  });

  it('accepts names on both codex engines and de-duplicates them', () => {
    const cfg = { ignoreUserConfig: true, codexMcpServers: ['a', 'b_c', 'd-e', 'a'] };
    expect(validateCodexMcpSelection(cfg, 'codex')).toEqual(['a', 'b_c', 'd-e']);
    expect(validateCodexMcpSelection(cfg, 'codex-app')).toEqual(['a', 'b_c', 'd-e']);
  });

  it('treats an empty array as no servers', () => {
    expect(validateCodexMcpSelection({ ignoreUserConfig: true, codexMcpServers: [] }, 'codex-app')).toEqual([]);
  });

  it('rejects engines that would ignore the selection', () => {
    for (const engine of ['claude', 'opencode', 'cursor', 'grok', 'agy', 'custom', undefined] as const) {
      expect(() => validateCodexMcpSelection({ ignoreUserConfig: true, codexMcpServers: ['a'] }, engine)).toThrow(
        /only supported by the 'codex' and 'codex-app' engines/,
      );
    }
  });

  it('requires ignoreUserConfig', () => {
    expect(() => validateCodexMcpSelection({ codexMcpServers: ['a'] }, 'codex-app')).toThrow(
      /requires ignoreUserConfig/,
    );
    expect(() => validateCodexMcpSelection({ ignoreUserConfig: false, codexMcpServers: ['a'] }, 'codex')).toThrow(
      /requires ignoreUserConfig/,
    );
  });

  it('rejects malformed selections', () => {
    const base = { ignoreUserConfig: true };
    const bad = (v: unknown) =>
      expect(() => validateCodexMcpSelection({ ...base, codexMcpServers: v as string[] }, 'codex-app'));
    bad('maas_slack').toThrow(/array of MCP server names/);
    bad([1]).toThrow(/entries must be MCP server names/);
    bad(['']).toThrow(/entries must be MCP server names/);
    bad(['has space']).toThrow(/entries must be MCP server names/);
    bad(['a.b']).toThrow(/entries must be MCP server names/);
    bad(['x'.repeat(65)]).toThrow(/entries must be MCP server names/);
    bad(Array.from({ length: MAX_CODEX_MCP_SELECTION + 1 }, (_, i) => `s${i}`)).toThrow(/at most/);
  });
});

describe('parseCodexMcpList', () => {
  it('keeps only name and enabled', () => {
    const parsed = parseCodexMcpList(LIST_JSON);
    expect(parsed).toEqual([
      { name: 'maas_slack', enabled: true },
      { name: 'local-tool', enabled: true },
      { name: 'off', enabled: false },
    ]);
    expect(JSON.stringify(parsed)).not.toMatch(/SECRET|Bearer|maas\.example/);
  });

  it('skips leading non-JSON lines and rejects garbage', () => {
    expect(parseCodexMcpList('WARNING: something\n[{"name":"a","enabled":true}]')).toEqual([
      { name: 'a', enabled: true },
    ]);
    expect(() => parseCodexMcpList('no json here')).toThrow(/no JSON array/);
    expect(() => parseCodexMcpList('[{"name": ')).toThrow(/not valid JSON/);
    expect(parseCodexMcpList('[]')).toEqual([]);
  });
});

describe('buildMcpDisableArgs', () => {
  const servers = parseCodexMcpList(LIST_JSON);

  it('disables every server when nothing is kept', () => {
    expect(buildMcpDisableArgs(servers, [])).toEqual([
      '-c',
      'mcp_servers.maas_slack.enabled=false',
      '-c',
      'mcp_servers.local-tool.enabled=false',
      '-c',
      'mcp_servers.off.enabled=false',
    ]);
  });

  it('disables exactly the servers that are not selected', () => {
    expect(buildMcpDisableArgs(servers, ['local-tool'])).toEqual([
      '-c',
      'mcp_servers.maas_slack.enabled=false',
      '-c',
      'mcp_servers.off.enabled=false',
    ]);
  });

  it('quotes names that are not valid bare TOML keys', () => {
    expect(tomlKey('plain-name_1')).toBe('plain-name_1');
    expect(tomlKey('dotted.name')).toBe('"dotted.name"');
    expect(tomlKey('has"quote')).toBe('"has\\"quote"');
    expect(buildMcpDisableArgs([{ name: 'a.b', enabled: true }], [])).toEqual([
      '-c',
      'mcp_servers."a.b".enabled=false',
    ]);
  });

  it('rejects unknown names, listing only server names', () => {
    let message = '';
    try {
      buildMcpDisableArgs(servers, ['nope', 'local-tool']);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/Unknown MCP server in codexMcpServers: nope/);
    expect(message).toContain('maas_slack, local-tool, off');
    expect(message).not.toMatch(/SECRET|Bearer/);
    expect(() => buildMcpDisableArgs([], ['x'])).toThrow(/\(none\)/);
  });

  it('rejects a selected server the config has disabled', () => {
    expect(() => buildMcpDisableArgs(servers, ['off'])).toThrow(/is disabled in the Codex config: off/);
  });
});

describe('listCodexMcpServers / resolveCodexMcpDisableArgs', () => {
  beforeEach(() => mockSpawn.mockReset());

  it('runs `codex mcp list --json` in the session cwd and parses names', async () => {
    mockSpawn.mockReturnValueOnce(listProc(LIST_JSON));
    const out = await resolveCodexMcpDisableArgs({ codexBin: 'codex', cwd: '/work', keep: ['maas_slack'] });
    const [cmd, args, opts] = mockSpawn.mock.calls[0] as [string, string[], { cwd: string }];
    expect(cmd).toBeTruthy();
    expect(args.slice(-3)).toEqual(['mcp', 'list', '--json']);
    expect(opts.cwd).toBe('/work');
    expect(out).toEqual(['-c', 'mcp_servers.local-tool.enabled=false', '-c', 'mcp_servers.off.enabled=false']);
  });

  it('fails the start when codex cannot list its servers, without echoing stderr', async () => {
    mockSpawn.mockReturnValueOnce(listProc('', 1, 'bad config: token = SECRET-VALUE'));
    let message = '';
    try {
      await listCodexMcpServers({ codexBin: 'codex' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/exited with code 1/);
    expect(message).not.toMatch(/SECRET/);
  });

  it('fails when codex cannot be run', async () => {
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    queueMicrotask(() => proc.emit('error', new Error('spawn codex ENOENT')));
    mockSpawn.mockReturnValueOnce(proc);
    await expect(listCodexMcpServers({ codexBin: 'codex' })).rejects.toThrow(/Cannot run codex.*ENOENT/);
  });

  it('times out a hung listing', async () => {
    vi.useFakeTimers();
    try {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      mockSpawn.mockReturnValueOnce(proc);
      const pending = listCodexMcpServers({ codexBin: 'codex', timeoutMs: 1000 });
      const assertion = expect(pending).rejects.toThrow(/Timed out enumerating Codex MCP servers/);
      await vi.advanceTimersByTimeAsync(1001);
      await assertion;
      expect(proc.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
