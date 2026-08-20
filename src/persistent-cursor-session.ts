/**
 * Persistent Cursor Session — wraps `cursor-agent` CLI
 *
 * Like Codex/Gemini, each send() spawns a new `cursor-agent` process in
 * headless print mode. Cursor CLI supports `--output-format stream-json`
 * which provides NDJSON events similar to Gemini's stream protocol.
 *
 * The "session" is persistent in the same sense as Codex:
 *   - Working directory carries accumulated code changes across sends
 *   - Stats, history, and cost are tracked continuously
 *   - Consistent lifecycle semantics (start/stop/pause/resume)
 */

import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SessionConfig, SessionSendOptions, StreamEvent, TurnResult } from './types.js';
import { estimateTokens } from './models.js';
import { sanitizeSecrets } from './sanitize.js';
import { SESSION_EVENT } from './constants.js';
import { BaseOneShotSession } from './base-oneshot-session.js';

/**
 * Enforced read-only for Cursor Agent.
 *
 * `--mode plan` is NOT a permission boundary — Cursor's docs say the mode
 * "influences how the agent approaches tasks rather than enforcing permissions",
 * and it was verified empirically to let an adversarial prompt write files
 * (edit-tool calls went through). Cursor's ACTUAL enforcement is the permission
 * config (`.cursor/cli.json`): "Deny rules take precedence over allow rules",
 * and a `deny` was verified to hold even under `--force` and even against a
 * repo that ships a permissive config of its own.
 *
 * `allow: []` means default-allow, so read / grep / search / list still work;
 * only the write vectors are denied. We write this config into a throwaway temp
 * dir and run Cursor with that dir as its process cwd (Cursor reads the config
 * from cwd) while pointing `--workspace` at the real project — so the user's
 * repository is never touched.
 */
const READ_ONLY_CLI_CONFIG = JSON.stringify({
  permissions: { allow: [], deny: ['Write(**)', 'Edit(**)', 'Shell(**)'] },
});

export interface CursorInvocation {
  command: string;
  prefixArgs: string[];
  env: Record<string, string>;
}

function cursorVersionKey(name: string): number {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-/.exec(name);
  if (!match) return 0;
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] || 0),
    Number(match[5] || 0),
    Number(match[6] || 0),
  );
}

/**
 * Cursor's Windows installer exposes `.cmd` / `.ps1` launchers, but
 * `child_process.spawn()` cannot execute those wrappers directly without a
 * shell (`spawn EINVAL`). Avoid shell/cmd indirection by resolving the wrapper
 * to the installed version's bundled node.exe + index.js pair.
 */
export function resolveCursorInvocation(engineBin: string, platform = process.platform): CursorInvocation {
  if (platform !== 'win32' || !/\.(?:cmd|ps1)$/i.test(engineBin)) {
    return { command: engineBin, prefixArgs: [], env: {} };
  }

  const launcherDir = path.dirname(engineBin);
  const directNode = path.join(launcherDir, 'node.exe');
  const directEntry = path.join(launcherDir, 'index.js');
  let runtime: { node: string; entry: string } | undefined;

  if (fs.existsSync(directNode) && fs.existsSync(directEntry)) {
    runtime = { node: directNode, entry: directEntry };
  } else {
    const versionsDir = path.join(launcherDir, 'versions');
    const candidates = fs.existsSync(versionsDir)
      ? fs
          .readdirSync(versionsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && cursorVersionKey(entry.name) > 0)
          .sort((a, b) => cursorVersionKey(b.name) - cursorVersionKey(a.name) || b.name.localeCompare(a.name))
      : [];
    for (const candidate of candidates) {
      const node = path.join(versionsDir, candidate.name, 'node.exe');
      const entry = path.join(versionsDir, candidate.name, 'index.js');
      if (fs.existsSync(node) && fs.existsSync(entry)) {
        runtime = { node, entry };
        break;
      }
    }
  }

  if (!runtime) {
    throw new Error(`Cursor launcher ${engineBin} has no usable node.exe/index.js runtime`);
  }

  const env: Record<string, string> = { CURSOR_INVOKED_AS: path.basename(engineBin) };
  if (!process.env.NODE_COMPILE_CACHE && process.env.LOCALAPPDATA) {
    env.NODE_COMPILE_CACHE = path.join(process.env.LOCALAPPDATA, 'cursor-compile-cache');
  }
  return { command: runtime.node, prefixArgs: [runtime.entry], env };
}

// ─── PersistentCursorSession ────────────────────────────────────────────────

export class PersistentCursorSession extends BaseOneShotSession {
  private _currentRl: readline.Interface | null = null;
  /** Throwaway dir holding the read-only `.cursor/cli.json`; removed on stop(). */
  private _roConfigDir?: string;

  /**
   * Cursor's own chat id, once the first turn has announced one.
   *
   * `agent -p` opens a fresh chat unless `--resume <chatId>` names an existing
   * one. The id was already harvested off the `system` init event for
   * `sessionId`; feeding it back is what gives this engine a real conversation.
   */
  private cursorChatId?: string;

  constructor(config: SessionConfig, cursorBin?: string) {
    super(config, cursorBin || process.env.CURSOR_BIN || 'agent', {
      enginePrefix: 'cursor',
      defaultModel: 'claude-sonnet-4-6',
      defaultModelDisplay: 'cursor-default',
      supportsCachedTokens: true,
      engineDisplayName: 'Cursor',
    });
    // Process-level resume: a persisted id is the raw Cursor chat id, never one
    // of our generated `cursor-<ts>-<rand>` handles.
    if (config.resumeSessionId && !/^cursor-\d+-/.test(config.resumeSessionId)) {
      this.cursorChatId = config.resumeSessionId.replace(/^cursor-live-/, '');
    }
  }

  /** Materialize the read-only permission config once; return the dir to use as cwd. */
  private _ensureReadOnlyConfigDir(): string {
    if (this._roConfigDir) return this._roConfigDir;
    const dir = path.join(os.tmpdir(), `claw-cursor-ro-${this.sessionId}`);
    fs.mkdirSync(path.join(dir, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cursor', 'cli.json'), READ_ONLY_CLI_CONFIG, 'utf8');
    this._roConfigDir = dir;
    return dir;
  }

  protected override _cleanupProc(): void {
    if (this._currentRl) {
      this._currentRl.close();
      this._currentRl = null;
    }
    if (this.currentProc) {
      this.currentProc.stdin?.end();
      this.currentProc.stdout?.destroy();
      this.currentProc.stderr?.destroy();
    }
    if (this._roConfigDir) {
      try {
        fs.rmSync(this._roConfigDir, { recursive: true, force: true });
      } catch {
        // Never created / already gone.
      }
      this._roConfigDir = undefined;
    }
    super._cleanupProc();
  }

  protected _run(message: string, options: SessionSendOptions): Promise<TurnResult> {
    // agent -p <prompt> [--force | --mode plan] --trust --output-format stream-json
    const readOnly = this.options.sandboxMode === 'read-only';
    const args: string[] = ['-p', message];
    // `--mode plan` steers the model toward read-only behavior; the binding
    // guarantee comes from the deny config injected via the process cwd below.
    // Do NOT add `--sandbox` here — it does not restrict in-workspace writes and
    // was verified to override the mode and re-enable them.
    if (readOnly) args.push('--mode', 'plan');
    else args.push('--force');
    args.push('--trust', '--output-format', 'stream-json');

    // Continue Cursor's own chat rather than opening a new one each send.
    // Verified against 2026.08.11: without it the second turn has no memory of
    // the first; with it the same turn recalls the earlier content. `--continue`
    // is avoided on purpose — it resumes "the latest chat", which would collide
    // between concurrent sessions.
    if (this.cursorChatId) args.push('--resume', this.cursorChatId);

    if (this.options.model) args.push('--model', this.options.model);
    // Workspace directory (prefer --workspace over cwd for explicit path)
    if (this.options.cwd) args.push('--workspace', this.options.cwd);

    const timeout = options.timeout || 300_000;

    // Read-only sessions run with an isolated temp dir as their process cwd so
    // Cursor loads our deny config (`.cursor/cli.json`) from there while still
    // operating on the real project via `--workspace`. The repo is never touched.
    const spawnCwd = readOnly ? this._ensureReadOnlyConfigDir() : this.options.cwd;

    return new Promise<TurnResult>((resolve, reject) => {
      const resultText = { value: '' };
      let stderr = '';
      let settled = false;
      let gotUsageFromEvents = false;

      const invocation = resolveCursorInvocation(this.engineBin);
      const proc = spawn(invocation.command, [...invocation.prefixArgs, ...args], {
        cwd: spawnCwd,
        env: { ...process.env, ...invocation.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: process.platform === 'win32',
      });
      this.currentProc = proc;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          proc.kill('SIGTERM');
          reject(new Error('Timeout waiting for Cursor response'));
        }
      }, timeout);

      // Parse stream-json output line by line
      const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
      this._currentRl = rl;
      rl.on('line', (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          this._handleStreamEvent(event, options, resultText, () => {
            gotUsageFromEvents = true;
          });
        } catch {
          // Non-JSON line — treat as plain text
          resultText.value += line + '\n';
          try {
            options.callbacks?.onText?.(line + '\n');
          } catch {
            // User callback error
          }
          this.emit(SESSION_EVENT.TEXT, line + '\n');
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const sanitized = sanitizeSecrets(data.toString());
        stderr += sanitized;
        this.emit(SESSION_EVENT.LOG, `[cursor-stderr] ${sanitized}`);
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        this.currentProc = null;
        if (this._currentRl) {
          this._currentRl.close();
          this._currentRl = null;
        }

        if (settled) return;
        settled = true;

        // One expression for the outcome, feeding the counter here and the
        // `stop_reason` below.
        const ok = code === 0;
        this._recordTurnComplete(ok);

        // Fallback: estimate tokens if stream events didn't provide usage
        if (!gotUsageFromEvents && resultText.value.length > 0) {
          this._stats.tokensIn += estimateTokens(message);
          this._stats.tokensOut += estimateTokens(resultText.value);
          this._updateCost();
          this._markTurnEstimated();
        }

        this._addHistory({ text: resultText.value, code });

        const event: StreamEvent = {
          type: 'result',
          result: resultText.value,
          stop_reason: ok ? 'end_turn' : 'error',
        };

        this.emit(SESSION_EVENT.RESULT, event);
        this.emit(SESSION_EVENT.TURN_COMPLETE, event);

        if (code !== 0) {
          reject(new Error(stderr || `Cursor exited with code ${code}`));
        } else {
          resolve({ text: resultText.value, event });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }

  /** Detect an errored tool call across the shapes Cursor has used for it. */
  private _cursorToolErrored(event: Record<string, unknown>): boolean {
    if (event.is_error === true) return true;
    const status = (event.status as string) || ((event.result as Record<string, unknown>)?.status as string);
    return status === 'error' || status === 'failed';
  }

  // ─── Stream Event Handling ────────────────────────────────────────────

  private _handleStreamEvent(
    event: Record<string, unknown>,
    options: SessionSendOptions,
    resultText: { value: string },
    markUsageReceived: () => void,
  ): void {
    const type = event.type as string;

    switch (type) {
      case 'system':
        // Init event — extract session_id if available
        // The raw id is what `--resume` expects; the prefixed one is our
        // display/persistence handle.
        if (event.session_id && !this.cursorChatId) this.cursorChatId = String(event.session_id);
        if (event.session_id && !this.sessionId?.startsWith('cursor-live-')) {
          this.sessionId = `cursor-live-${event.session_id}`;
        }
        break;

      case 'user':
        // Echo of user prompt — skip
        break;

      case 'assistant': {
        // Cursor format: { type: "assistant", message: { role, content: [{ type, text }] } }
        const msg = event.message as Record<string, unknown> | undefined;
        if (!msg) break;
        const contentArr = msg.content as Array<{ type: string; text?: string }> | undefined;
        if (contentArr) {
          for (const block of contentArr) {
            if (block.type === 'text' && block.text) {
              resultText.value += block.text;
              try {
                options.callbacks?.onText?.(block.text);
              } catch {
                // User callback error
              }
              this.emit(SESSION_EVENT.TEXT, block.text);
            }
          }
        }
        break;
      }

      // Also support generic "message" format for forward compatibility
      case 'message': {
        if (event.role === 'user') break;
        const text = (event.content as string) || '';
        if (text) {
          resultText.value += text;
          try {
            options.callbacks?.onText?.(text);
          } catch {
            // User callback error
          }
          this.emit(SESSION_EVENT.TEXT, text);
        }
        break;
      }

      // Cursor 2026.05+ emits `tool_call` with `subtype: 'started' | 'completed'`
      // (one event each) instead of the older `tool_use` / `tool_result` pair.
      // Count once on 'started'; read error state off the 'completed' event
      // (there is no top-level `is_error` on a separate result event anymore).
      case 'tool_call': {
        const subtype = event.subtype as string | undefined;
        if (subtype === 'started') {
          this._stats.toolCalls++;
          try {
            options.callbacks?.onToolUse?.(event);
          } catch {
            // User callback error
          }
          this.emit(SESSION_EVENT.TOOL_USE, event);
        } else if (subtype === 'completed') {
          try {
            options.callbacks?.onToolResult?.(event);
          } catch {
            // User callback error
          }
          if (this._cursorToolErrored(event)) this._stats.toolErrors++;
          this.emit(SESSION_EVENT.TOOL_RESULT, event);
        }
        break;
      }

      // Legacy event names (older Cursor builds) — keep for back-compat.
      case 'tool_use':
        this._stats.toolCalls++;
        try {
          options.callbacks?.onToolUse?.(event);
        } catch {
          // User callback error
        }
        this.emit(SESSION_EVENT.TOOL_USE, event);
        break;

      case 'tool_result':
        try {
          options.callbacks?.onToolResult?.(event);
        } catch {
          // User callback error
        }
        if (event.is_error) this._stats.toolErrors++;
        this.emit(SESSION_EVENT.TOOL_RESULT, event);
        break;

      case 'result': {
        // Cursor uses camelCase: inputTokens, outputTokens, cacheReadTokens
        const usage = event.usage as Record<string, number> | undefined;
        if (usage) {
          this._stats.tokensIn += usage.inputTokens || usage.input_tokens || usage.prompt_tokens || 0;
          this._stats.tokensOut += usage.outputTokens || usage.output_tokens || usage.completion_tokens || 0;
          const cached = usage.cacheReadTokens || usage.cached_tokens || 0;
          if (cached) this._stats.cachedTokens += cached;
          this._updateCost();
          markUsageReceived();
        }
        // Result text (if not already captured from assistant events)
        const resultStr = event.result as string | undefined;
        if (resultStr && !resultText.value) resultText.value = resultStr;
        break;
      }

      case 'error':
        this.emit(SESSION_EVENT.LOG, `[cursor-error] ${event.error || JSON.stringify(event)}`);
        break;

      default:
        break;
    }
  }

  /**
   * Override getStats to expose the captured chat ID.
   *
   * Consumers use its presence to tell "this session resumes a real conversation"
   * from "the session is merely in the manager's map". Without it a caller has to
   * assume the conversation exists, and a session whose first turn died before the
   * stream announced an id looks identical to a healthy one.
   */
  getStats(): ReturnType<BaseOneShotSession['getStats']> {
    const base = super.getStats();
    return { ...base, cursorChatId: this.cursorChatId };
  }
}
