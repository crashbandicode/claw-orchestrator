/**
 * Persistent OpenCode Session — wraps `opencode run` (sst/opencode CLI).
 *
 * Each send() spawns a new `opencode` process in non-interactive mode.
 * `--format json` streams NDJSON events. The schema (from
 * packages/opencode/src/cli/cmd/run.ts) is:
 *
 *     { type, timestamp, sessionID, ...data }
 *
 * with these event types:
 *   - text          { part: { type:"text", text, id, ... } }
 *   - reasoning     { part: { type:"reasoning", text, ... } }
 *   - tool_use      { part: { type:"tool", callID, tool, state, ... } }
 *                   (re-emitted as state transitions; no separate tool_result)
 *   - step_start    { part: { type:"step-start", ... } }
 *   - step_finish   { part: { type:"step-finish", tokens:{input,output,
 *                             reasoning,cache:{read,write}}, cost, ... } }
 *   - error         { error: ... }
 *
 * `text` and `tool_use` events are CUMULATIVE — each emission carries the
 * latest snapshot of the same `part.id`. We diff against the previous
 * snapshot to compute streaming deltas for onText callbacks, and collapse
 * to the final per-part value at turn close.
 *
 * Provider-agnostic: opencode's `--model` uses `provider/model` form (e.g.
 * `anthropic/claude-sonnet-4`). We pass `--model` through only when the
 * configured value contains a `/`; otherwise opencode's default applies.
 *
 * Permissions: on opencode 1.17.15's `run`, a tool that would prompt for a
 * permission is auto-REJECTED in non-interactive mode (it does not hang), so a
 * write-enabled session needs no skip flag. (`--dangerously-skip-permissions`,
 * `--auto`, and `--yolo` do exist as of opencode 1.4.0 if an allow-all run is
 * ever wanted — verified against 1.17.15.)
 */

import { execEngine, killEngineTree, spawnEngine } from './engine-spawn.js';
import type { ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import { randomBytes } from 'node:crypto';
import * as readline from 'node:readline';

import type { EffortLevel, SessionConfig, SessionSendOptions, StreamEvent, TurnResult } from './types.js';
import { estimateTokens } from './models.js';
import { sanitizeSecrets } from './sanitize.js';
import { SESSION_EVENT } from './constants.js';
import { BaseOneShotSession } from './base-oneshot-session.js';

/**
 * Read-only enforcement for opencode.
 *
 * opencode ships a `plan` agent, but it is a user-overridable preset: on a
 * stock install its rules begin with `{"permission":"*","action":"allow"}` and
 * deny neither `bash` nor `edit`, so a "read-only" session could still author
 * files through a shell heredoc. We therefore define our own agent and hand it
 * to the CLI via `OPENCODE_CONFIG_CONTENT`, with the write paths denied at the
 * permission-engine level AND the corresponding tools removed.
 *
 * Verify this config only with adversarial writes, and include prompts that ask
 * the agent to delegate — `opencode agent list` renders compiled rules that look
 * identical for a safe and an unsafe agent, and a probe that only asks the agent
 * to write directly passes even when the delegation path is wide open.
 */
const READ_ONLY_AGENT = 'clawo-readonly';
const READ_ONLY_AGENT_CONFIG = JSON.stringify({
  agent: {
    [READ_ONLY_AGENT]: {
      mode: 'primary',
      permission: {
        edit: 'deny',
        bash: 'deny',
        external_directory: 'deny',
        // Denying the write tools is not enough on its own: the agent can hand
        // the work to a subagent via `task`, and the subagent runs under the
        // default (writable) agent, so the denials above never apply to it.
        // Asked to "delegate this to a subagent", a session denied only
        // edit/bash/external_directory wrote to disk on every attempt.
        task: 'deny',
        webfetch: 'deny',
      },
      // Belt-and-suspenders: drop the tools outright as well, so enforcement
      // does not depend on the permission engine resolving our rules the way we
      // expect. `task` is the escalation path; the rest are the direct ones.
      tools: {
        task: false,
        write: false,
        edit: false,
        bash: false,
        patch: false,
      },
    },
  },
});

interface TurnState {
  /** Per-part latest text snapshot, keyed by part.id (preserves insertion order). */
  textParts: Map<string, string>;
  /** Tool callIDs we've seen (count once per unique tool invocation). */
  seenTools: Set<string>;
  /** Tool callIDs that ended in error state. */
  erroredTools: Set<string>;
  gotUsage: boolean;
}

// ─── OpenCode 2 ─────────────────────────────────────────────────────────────

/**
 * What `opencode --version` says, once per binary per process. `undefined`
 * when it could not be read — a check that cannot run blocks nothing.
 */
const versionCache = new Map<string, Promise<string | undefined>>();

function opencodeVersion(bin: string): Promise<string | undefined> {
  let v = versionCache.get(bin);
  if (!v) {
    v = execEngine(bin, ['--version'], { timeout: 15_000 }).then(
      (r) => `${r.stdout}${r.stderr}`.trim() || undefined,
      () => undefined,
    );
    versionCache.set(bin, v);
  }
  return v;
}

/**
 * OpenCode 2 — `opencode upgrade --major`, beta-only builds versioned
 * `0.0.0-beta-N` (as of 2026-10-11) — keeps `run --format json` but breaks this
 * wrapper three ways, each measured on 0.0.0-beta-17823:
 *   - `--variant` is gone (effort moved into `provider/model#variant`), so any
 *     session with an effort level fails every turn;
 *   - no `step_finish` event, so a turn reports no tokens and no cost;
 *   - the read-only agent could not be verified: with it, OpenCode's free
 *     tier answers 403 ("can only be used from within OpenCode").
 * Stable 2.x puts effort on `provider/model#variant` and serves `/goal` over
 * its HTTP API. A beta build still uses the variant form so `--variant` is not
 * passed to a CLI that rejects it.
 */
export function isOpencodeV2(version: string | undefined): boolean {
  if (!version) return false;
  if (/\b0\.0\.0-(beta|next|dev)/.test(version) || /\bopencode2\b/.test(version)) return true;
  return opencodeMajorFromVersion(version) >= 2;
}

/**
 * Numeric major from `opencode --version`. `1.19.0` and `opencode v2.2.5` both
 * count. A `0.0.0-beta` build stays on the 1.x command set: `/goal` is a 2.x
 * stable command, and that beta string is not major 2.
 */
export function opencodeMajorFromVersion(version: string | undefined): number {
  if (!version) return 1;
  const match = /(?:^|\s)v?(\d+)\.\d+\.\d+/.exec(version);
  if (!match) return 1;
  const major = Number(match[1]);
  return Number.isInteger(major) && major > 0 ? major : 1;
}

/**
 * Arguments of an OpenCode 2 `/goal` command.
 *
 * `undefined` means the message is an ordinary prompt. An empty string is the
 * status query. OpenCode 1 has no goal command, so the same text stays a prompt.
 */
export function opencodeGoalArguments(message: string, major: number): string | undefined {
  if (major < 2) return undefined;
  const match = /^\/goal(?:\s+([\s\S]*))?$/.exec(message.trim());
  if (!match) return undefined;
  return (match[1] ?? '').trim();
}

/** Split `provider/model` and an effort into the 2.x model reference. */
export function opencodeModelRef(
  model: string | undefined,
  effort: EffortLevel | undefined,
): { id: string; providerID: string; variant?: string } | undefined {
  if (!model || !model.includes('/')) return undefined;
  const base = model.split('#')[0];
  const slash = base.indexOf('/');
  const providerID = base.slice(0, slash);
  const id = base.slice(slash + 1);
  if (!providerID || !id) return undefined;
  const variant = effort && effort !== 'auto' ? effort : undefined;
  return variant ? { id, providerID, variant } : { id, providerID };
}

// ─── PersistentOpencodeSession ──────────────────────────────────────────────

export class PersistentOpencodeSession extends BaseOneShotSession {
  private _currentRl: readline.Interface | null = null;

  /**
   * OpenCode's own session id, once the first turn has announced one.
   *
   * `opencode run` starts a brand-new session unless `--session <id>` names an
   * existing one, so without this every send was an amnesiac first turn. The id
   * was already being harvested off the event stream for `sessionId`; it just
   * was never fed back, which is what made this engine look like it had no
   * conversation of its own.
   */
  private opencodeSessionId?: string;
  /** True when `opencode --version` is 2.x or a 0.0.0-beta/next build. */
  private opencodeV2 = false;
  /** Numeric major used to recognize `/goal`. Beta `0.0.0` stays at 1. */
  private opencodeMajor = 1;
  /** Private `opencode serve` used only while a 2.x `/goal` command is in flight. */
  private goalApi?: { port: number; password: string; proc: ChildProcess };
  private lastGoalEvent = '';

  /**
   * Spend opencode reported itself, summed over every `step_finish.cost`.
   * Undefined until a step reports one. When present it is the bill: the model
   * opencode picked is not in its JSON output, so pricing tokens against the
   * registry charged a free default model at Sonnet rates.
   */
  private _reportedCostUsd?: number;

  protected override _continuesConversation(): boolean {
    return !!this.opencodeSessionId;
  }

  override async start(): Promise<this> {
    const version = await opencodeVersion(this.engineBin);
    this.opencodeV2 = isOpencodeV2(version);
    this.opencodeMajor = opencodeMajorFromVersion(version);
    return super.start();
  }

  constructor(config: SessionConfig, opencodeBin?: string) {
    super(config, opencodeBin || process.env.OPENCODE_BIN || 'opencode', {
      enginePrefix: 'opencode',
      defaultModel: 'claude-sonnet-4-6',
      defaultModelDisplay: 'opencode-default',
      supportsCachedTokens: true,
      // `tokens.total` is input + output + cache.read + cache.write, so
      // `tokens.input` holds only the uncached remainder. On a resumed turn
      // that remainder is tiny next to the cached part (58 vs 26240), which is
      // exactly where subtracting one from the other goes wrong.
      inputIncludesCachedTokens: false,
      engineDisplayName: 'OpenCode',
    });
    // Process-level resume: a persisted id comes back as the raw OpenCode id,
    // never one of our generated `opencode-<ts>-<rand>` handles.
    if (config.resumeSessionId && !/^opencode-\d+-/.test(config.resumeSessionId)) {
      this.opencodeSessionId = config.resumeSessionId.replace(/^opencode-live-/, '');
    }
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
    super._cleanupProc();
  }

  private _modelArgs(turnEffort?: EffortLevel): string[] {
    const configured = this.options.model && this.options.model.includes('/') ? this.options.model : undefined;
    const effort = turnEffort ?? this.options.effort;
    const variant = effort && effort !== 'auto' ? effort : undefined;
    if (this.opencodeV2) {
      if (!configured) return [];
      const base = configured.split('#')[0];
      return ['--model', variant ? `${base}#${variant}` : configured];
    }
    const args: string[] = [];
    if (configured) args.push('--model', configured);
    if (variant) args.push('--variant', variant);
    return args;
  }

  private _autoApproves(): boolean {
    const readOnly = this.options.sandboxMode === 'read-only';
    return (
      !readOnly &&
      this.options.permissionMode !== 'plan' &&
      (this.options.permissionMode === 'bypassPermissions' ||
        this.options.permissionMode === 'auto' ||
        !!this.options.dangerouslySkipPermissions ||
        !!this.options.enableAutoMode)
    );
  }

  private _stopGoalServer(): void {
    const proc = this.goalApi?.proc;
    this.goalApi = undefined;
    if (!proc || proc.killed) return;
    killEngineTree(proc);
  }

  private async _startGoalServer(): Promise<void> {
    if (this.goalApi) return;
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const chosen = address && typeof address === 'object' ? address.port : 0;
        server.close(() => resolve(chosen));
      });
    });
    const password = randomBytes(16).toString('hex');
    const proc = spawnEngine(this.engineBin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      launcher: this.options.launcher,
      cwd: this.options.cwd,
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let ready = false;
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    this.goalApi = { port, password, proc };
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('OpenCode serve did not start')), 20_000);
        let stdout = '';
        proc.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          if (!ready && stdout.includes('listening')) {
            ready = true;
            clearTimeout(timer);
            resolve();
          }
        });
        proc.once('exit', (code) => {
          if (ready) return;
          clearTimeout(timer);
          reject(new Error(sanitizeSecrets(stderr).slice(0, 500) || `OpenCode serve exited ${code}`));
        });
      });
    } catch (error) {
      this._stopGoalServer();
      throw error;
    }
  }

  private async _goalFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const api = this.goalApi;
    if (!api) throw new Error('OpenCode goal server is not running');
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Basic ${Buffer.from(`opencode:${api.password}`).toString('base64')}`);
    headers.set('x-opencode-directory', this.options.cwd || process.cwd());
    if (init.body) headers.set('Content-Type', 'application/json');
    return fetch(`http://127.0.0.1:${api.port}${path}`, { ...init, headers });
  }

  private async _responseMessage(response: Response): Promise<string> {
    const text = await response.text();
    if (!text) return '';
    try {
      const body = JSON.parse(text) as { message?: unknown };
      return typeof body.message === 'string' ? body.message : text.slice(0, 500);
    } catch {
      return text.slice(0, 500);
    }
  }

  private _sessionIdFrom(body: unknown): string | undefined {
    if (!body || typeof body !== 'object') return undefined;
    const record = body as { id?: unknown; data?: { id?: unknown } };
    if (typeof record.id === 'string') return record.id;
    if (typeof record.data?.id === 'string') return record.data.id;
    return undefined;
  }

  private async _ensureGoalSession(): Promise<void> {
    if (this.opencodeSessionId) return;
    const response = await this._goalFetch('/api/session', {
      method: 'POST',
      body: JSON.stringify({
        title: this.options.name || 'opencode-goal',
        location: { directory: this.options.cwd || process.cwd() },
      }),
    });
    const text = await response.text();
    let body: unknown = {};
    try {
      body = JSON.parse(text);
    } catch {
      body = {};
    }
    const id = this._sessionIdFrom(body);
    if (!response.ok || !id) {
      throw new Error(sanitizeSecrets(text).slice(0, 500) || `OpenCode did not create a session (${response.status})`);
    }
    this.opencodeSessionId = id;
    if (!this.sessionId?.startsWith('opencode-live-')) {
      this.sessionId = `opencode-live-${id}`;
      this.emit(SESSION_EVENT.NATIVE_IDENTITY, id);
    }
  }

  private async _selectGoalModel(effort: EffortLevel | undefined): Promise<void> {
    const ref = opencodeModelRef(this.options.model, effort ?? this.options.effort);
    if (!ref || !this.opencodeSessionId) return;
    const response = await this._goalFetch(`/api/session/${this.opencodeSessionId}/model`, {
      method: 'POST',
      body: JSON.stringify({ model: ref }),
    });
    if (!response.ok) {
      throw new Error(
        sanitizeSecrets(await this._responseMessage(response)) || `OpenCode rejected the model (${response.status})`,
      );
    }
  }

  private async _goalStatusMessage(): Promise<string> {
    const response = await this._goalFetch(`/api/session/${this.opencodeSessionId}/command`, {
      method: 'POST',
      body: JSON.stringify({ name: 'goal', text: '' }),
    });
    return this._responseMessage(response);
  }

  private async _postGoal(text: string, signal: AbortSignal): Promise<string> {
    const response = await this._goalFetch(`/api/session/${this.opencodeSessionId}/command`, {
      method: 'POST',
      body: JSON.stringify({ name: 'goal', text }),
      signal,
    });
    const message = await this._responseMessage(response);
    if (!response.ok && !message.startsWith('Goal ') && !message.startsWith('No ') && !message.startsWith('Usage:')) {
      throw new Error(sanitizeSecrets(message) || `OpenCode /goal failed (${response.status})`);
    }
    return message;
  }

  private async _approveGoalPermission(event: { type?: string; data?: Record<string, unknown> }): Promise<void> {
    if (!this._autoApproves() || event.type !== 'permission.asked' || !event.data) return;
    const id = event.data.id;
    const sessionID = event.data.sessionID;
    if (typeof id !== 'string' || typeof sessionID !== 'string' || sessionID !== this.opencodeSessionId) return;
    const response = await this._goalFetch(`/api/session/${sessionID}/permission/${id}/reply`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'once' }),
    });
    if (!response.ok) {
      throw new Error(
        sanitizeSecrets(await this._responseMessage(response)) || `OpenCode permission reply failed (${response.status})`,
      );
    }
  }

  private async _watchGoal(signal: AbortSignal, ready: () => boolean): Promise<string> {
    const response = await this._goalFetch('/api/event', { signal });
    if (!response.ok || !response.body) throw new Error(`OpenCode event stream failed (${response.status})`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';
        for (const chunk of chunks) {
          const data = chunk
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('');
          if (!data) continue;
          let event: { type?: string; data?: Record<string, unknown> };
          try {
            event = JSON.parse(data) as { type?: string; data?: Record<string, unknown> };
          } catch {
            continue;
          }
          if (event.type) this.lastGoalEvent = event.type;
          const sessionID = event.data?.sessionID;
          if (typeof sessionID === 'string' && sessionID !== this.opencodeSessionId) continue;
          await this._approveGoalPermission(event);
          if (!ready()) continue;
          if (
            event.type !== 'session.idle' &&
            event.type !== 'session.execution.succeeded' &&
            event.type !== 'session.execution.failed' &&
            event.type !== 'session.execution.interrupted'
          ) {
            continue;
          }
          const message = await this._goalStatusMessage();
          if (!message.startsWith('Goal active')) return message;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const message = await this._goalStatusMessage();
    if (!message.startsWith('Goal active')) return message;
    throw new Error(`OpenCode goal is still active (${this.lastGoalEvent || 'no events'})`);
  }

  private _finishGoal(text: string): TurnResult {
    this._recordTurnComplete(true);
    this._addHistory({ text, code: 0 });
    const event: StreamEvent = { type: 'result', result: text, stop_reason: 'end_turn' };
    this.emit(SESSION_EVENT.RESULT, event);
    this.emit(SESSION_EVENT.TURN_COMPLETE, event);
    return { text, event };
  }

  private async _runGoal(text: string, options: SessionSendOptions): Promise<TurnResult> {
    const timeout = options.timeout || 300_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let posted = false;
    let watching: Promise<string> = Promise.resolve('');
    try {
      await this._startGoalServer();
      await this._ensureGoalSession();
      await this._selectGoalModel(options.effort);
      watching = this._watchGoal(controller.signal, () => posted).catch((error: unknown) => {
        if (controller.signal.aborted) return '';
        throw error;
      });
      const message = await this._postGoal(text, controller.signal);
      posted = true;
      const immediate = text === '' || /^(?:pause|clear)$/i.test(text);
      const status = immediate ? message : await this._goalStatusMessage();
      if (immediate || !status.startsWith('Goal active')) {
        controller.abort();
        await watching;
        return this._finishGoal(status || message);
      }
      const settled = await watching;
      return this._finishGoal(settled || status);
    } catch (error) {
      const timedOut = controller.signal.aborted;
      controller.abort();
      await watching.catch(() => undefined);
      if (this.opencodeSessionId && this.goalApi) {
        await this._goalFetch(`/api/session/${this.opencodeSessionId}/interrupt`, { method: 'POST' }).catch(
          () => undefined,
        );
      }
      this._recordTurnComplete(false);
      const reason = error instanceof Error ? error.message : String(error);
      if (timedOut) throw new Error(`Timeout waiting for OpenCode goal (${this.lastGoalEvent || 'no events'})`);
      throw new Error(sanitizeSecrets(reason));
    } finally {
      clearTimeout(timer);
      this._stopGoalServer();
    }
  }

  protected _run(message: string, options: SessionSendOptions): Promise<TurnResult> {
    const goalText = opencodeGoalArguments(message, this.opencodeMajor);
    if (goalText !== undefined) return this._runGoal(goalText, options);
    // opencode run --format json [--session <id>], with the message on stdin.
    // On Windows `opencode` is an npm `.cmd` shim that runs through cmd.exe,
    // which would cut a message at its first newline; stdin carries it unchanged.
    const args: string[] = ['run', '--format', 'json'];

    // Continue OpenCode's own session rather than starting a fresh one. Verified
    // against 1.18.18: without this the second turn answers "you never asked me
    // to remember anything"; with it the same turn recalls the first turn's
    // content. `--continue` is deliberately not used — it means "the last
    // session on this machine", which would collide across concurrent sessions.
    if (this.opencodeSessionId) args.push('--session', this.opencodeSessionId);

    const readOnly = this.options.sandboxMode === 'read-only';
    if (readOnly) {
      // NOT opencode's built-in `plan` agent: that is a user-overridable preset
      // whose rules start with {"permission":"*","action":"allow"} and deny
      // neither `bash` nor `edit` — a "read-only" session could still write via
      // a shell heredoc. Instead we inject our own agent whose permissions deny
      // edit/bash/external_directory outright, so read-only is enforced by the
      // permission engine rather than requested politely.
      args.push('--agent', READ_ONLY_AGENT);
    } else if (this._autoApproves()) {
      args.push('--auto');
    }

    args.push(...this._modelArgs(options.effort));

    const timeout = options.timeout || 300_000;

    return new Promise<TurnResult>((resolve, reject) => {
      const state: TurnState = {
        textParts: new Map(),
        seenTools: new Set(),
        erroredTools: new Set(),
        gotUsage: false,
      };
      let stderr = '';
      let settled = false;
      // Read-only safety: if our injected agent fails to load, opencode prints
      // `agent "clawo-readonly" not found. Falling back to default agent` (to
      // stdout) and silently runs the DEFAULT, writable agent. We must never let
      // a read-only session degrade to writable — detect that line and fail.
      let readOnlyAgentMissing = false;

      const proc = spawnEngine(this.engineBin, args, {
        launcher: this.options.launcher,
        cwd: this.options.cwd,
        env: readOnly ? { ...process.env, OPENCODE_CONFIG_CONTENT: READ_ONLY_AGENT_CONFIG } : { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.currentProc = proc;
      // Writing the message closes stdin too; opencode waits for EOF before it starts.
      proc.stdin?.on('error', () => {});
      proc.stdin?.end(message);

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          killEngineTree(proc);
          reject(new Error('Timeout waiting for OpenCode response'));
        }
      }, timeout);

      const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
      this._currentRl = rl;
      rl.on('line', (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          this._handleStreamEvent(event, options, state);
        } catch {
          // Non-JSON line — opencode banner or stray text. Treat as plain text.
          if (readOnly && /\bnot found\. Falling back to default agent/i.test(line)) {
            readOnlyAgentMissing = true;
          }
          const fallback = line + '\n';
          // Accumulate fallback text under one stable key (the old code wrote to
          // __raw_<size> but read __raw_acc, so it never actually accumulated).
          state.textParts.set('__raw_acc', (state.textParts.get('__raw_acc') || '') + fallback);
          try {
            options.callbacks?.onText?.(fallback);
          } catch {
            // User callback error
          }
          this.emit(SESSION_EVENT.TEXT, fallback);
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const sanitized = sanitizeSecrets(data.toString());
        stderr += sanitized;
        this.emit(SESSION_EVENT.LOG, `[opencode-stderr] ${sanitized}`);
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

        // A read-only session whose enforcement agent failed to load ran writable.
        // Refuse the result rather than hand back output produced without the
        // sandbox the caller asked for.
        if (readOnlyAgentMissing) {
          // Refused on purpose: it reached the engine, so it counts as a turn, but
          // it is not a success by any reading.
          this._recordTurnComplete(false);
          reject(
            new Error(
              "OpenCode read-only enforcement failed: the 'clawo-readonly' agent did not load, so the session " +
                'would have run with write access. Refusing the turn. (Check that OPENCODE_CONFIG_CONTENT is honored ' +
                'by this opencode version.)',
            ),
          );
          return;
        }

        // Collapse per-part text snapshots to a single string in insertion order.
        const finalText = Array.from(state.textParts.values()).join('');

        // Account tool usage stats (count uniques only).
        this._stats.toolCalls += state.seenTools.size;
        this._stats.toolErrors += state.erroredTools.size;

        // One expression for the outcome, feeding the counter here and the
        // `stop_reason` below.
        const ok = code === 0;
        this._recordTurnComplete(ok);

        // Fallback: estimate tokens if step_finish never arrived.
        if (!state.gotUsage && finalText.length > 0) {
          this._stats.tokensIn += estimateTokens(message);
          this._stats.tokensOut += estimateTokens(finalText);
          this._markTurnEstimated();
          this._updateCost();
        }

        this._addHistory({ text: finalText, code });

        const event: StreamEvent = {
          type: 'result',
          result: finalText,
          stop_reason: ok ? 'end_turn' : 'error',
        };

        this.emit(SESSION_EVENT.RESULT, event);
        this.emit(SESSION_EVENT.TURN_COMPLETE, event);

        if (code !== 0) {
          reject(new Error(stderr || `OpenCode exited with code ${code}`));
        } else {
          resolve({ text: finalText, event });
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

  // ─── Stream Event Handling ────────────────────────────────────────────

  private _handleStreamEvent(event: Record<string, unknown>, options: SessionSendOptions, state: TurnState): void {
    const type = event.type as string;

    // Capture session id from envelope on first event that carries one. The raw
    // id is kept separately because that is the form `--session` expects; the
    // prefixed one is our display/persistence handle.
    const sid = (event.sessionID as string) || (event.sessionId as string) || (event.session_id as string);
    if (sid && !this.opencodeSessionId) {
      this.opencodeSessionId = sid;
      this.emit(SESSION_EVENT.NATIVE_IDENTITY, sid);
    }
    if (sid && !this.sessionId?.startsWith('opencode-live-')) {
      this.sessionId = `opencode-live-${sid}`;
    }

    const part = event.part as Record<string, unknown> | undefined;

    switch (type) {
      case 'text': {
        if (!part) break;
        const text = (part.text as string) || '';
        const partId = (part.id as string) || `text-${state.textParts.size}`;
        const prev = state.textParts.get(partId) || '';
        if (text === prev) break;
        // Compute streaming delta (text events are cumulative snapshots).
        const delta = text.startsWith(prev) ? text.slice(prev.length) : text;
        state.textParts.set(partId, text);
        if (delta) {
          try {
            options.callbacks?.onText?.(delta);
          } catch {
            // User callback error
          }
          this.emit(SESSION_EVENT.TEXT, delta);
        }
        break;
      }

      case 'reasoning': {
        // Surface reasoning text on the log channel, but don't include it in
        // the user-visible result — it's the model's internal scratchpad.
        if (!part) break;
        const text = (part.text as string) || '';
        if (text) this.emit(SESSION_EVENT.LOG, `[opencode-reasoning] ${text}`);
        break;
      }

      case 'tool_use': {
        if (!part) break;
        const callID = (part.callID as string) || (part.id as string) || '';
        if (!callID) break;
        if (!state.seenTools.has(callID)) {
          state.seenTools.add(callID);
          try {
            options.callbacks?.onToolUse?.(event);
          } catch {
            // User callback error
          }
          this.emit(SESSION_EVENT.TOOL_USE, event);
        }
        // State transitions get re-emitted on the same callID. Check for terminal
        // states to mark errors and emit tool_result.
        const toolState = part.state as Record<string, unknown> | undefined;
        const status = toolState?.status as string | undefined;
        if (status === 'error' && !state.erroredTools.has(callID)) {
          state.erroredTools.add(callID);
        }
        if (status === 'completed' || status === 'error') {
          try {
            options.callbacks?.onToolResult?.(event);
          } catch {
            // User callback error
          }
          this.emit(SESSION_EVENT.TOOL_RESULT, event);
        }
        break;
      }

      case 'step_start':
        // No-op: lifecycle marker only.
        break;

      case 'step_finish': {
        if (!part) break;
        const tokens = part.tokens as
          | { input?: number; output?: number; cache?: { read?: number; write?: number } }
          | undefined;
        if (tokens) {
          const cacheRead = tokens.cache?.read || 0;
          const cacheWrite = tokens.cache?.write || 0;
          this._stats.tokensIn += tokens.input || 0;
          this._stats.tokensOut += tokens.output || 0;
          this._stats.cachedTokens += cacheRead;
          this._stats.cacheCreationTokens += cacheWrite;
          // `tokens.input` is only the uncached remainder, so the context this
          // turn actually filled is the whole input side.
          this._reportTurnInputTokens((tokens.input || 0) + cacheRead + cacheWrite);
          if (typeof part.cost === 'number' && Number.isFinite(part.cost)) {
            this._reportedCostUsd = (this._reportedCostUsd ?? 0) + part.cost;
          }
          this._updateCost();
          state.gotUsage = true;
        }
        break;
      }

      case 'error':
        this.emit(SESSION_EVENT.LOG, `[opencode-error] ${event.error || JSON.stringify(event)}`);
        break;

      default:
        // Unknown event type — ignore for forward compatibility.
        break;
    }
  }

  protected override _updateCost(): void {
    if (this._reportedCostUsd !== undefined) this._stats.costUsd = this._reportedCostUsd;
    else super._updateCost();
  }

  /**
   * Override getStats to expose the captured session ID.
   *
   * Consumers use its presence to tell "this session resumes a real conversation"
   * from "the session is merely in the manager's map". Without it a caller has to
   * assume the conversation exists, and a session whose first turn died before the
   * run reported an id looks identical to a healthy one.
   */
  getStats(): ReturnType<BaseOneShotSession['getStats']> {
    const base = super.getStats();
    return { ...base, opencodeSessionId: this.opencodeSessionId };
  }
}
