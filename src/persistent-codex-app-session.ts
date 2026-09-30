/**
 * Persistent Codex App-Server Session — wraps `codex app-server`
 *
 * Unlike `PersistentCodexSession` (which spawns `codex exec` per send), this
 * session keeps a long-running `codex app-server --listen stdio://` subprocess
 * and speaks Codex's v2 JSON-RPC 2.0 protocol over its stdin/stdout.
 *
 * The motivation is the `/goal` long-horizon objective system, which is
 * exclusively available through the app-server protocol — `codex exec` has no
 * access to it. The flag `goals` is feature-flagged in 0.128 (default off);
 * we lift it per-session via `--enable goals` rather than touching global
 * config.
 *
 * Protocol notes (verified against codex-cli 0.128.0):
 *   - Frames are line-delimited JSON-RPC 2.0 messages over stdio.
 *   - Lifecycle: `initialize` → `thread/start` → `turn/start` (per send).
 *   - Goal lifecycle is **observation-only** for clients: there are no
 *     `thread/goal/*` request RPCs. Goal mutation is driven by sending the
 *     slash-commands `/goal <obj>` / `/goal pause` / `/goal resume` /
 *     `/goal clear` as plain user text via `turn/start`; the server-side
 *     parser interprets them and emits `thread/goal/updated` /
 *     `thread/goal/cleared` notifications.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveWindowsNodeInvocation } from './windows-command.js';

import type {
  SessionConfig,
  SessionStats,
  EffortLevel,
  StreamEvent,
  ISession,
  SessionSendOptions,
  TurnResult,
  CostBreakdown,
} from './types.js';
import { getModelPricing, resolveAlias, getContextWindow } from './models.js';
import { SESSION_EVENT, MAX_HISTORY_ITEMS, DEFAULT_HISTORY_LIMIT } from './constants.js';

// ─── Hand-translated protocol types (subset we use) ────────────────────────
//
// Mirrors `codex app-server generate-ts` output. Kept inline because we only
// touch a small slice; if upstream churn becomes painful, swap in the full
// generated bindings under `src/generated/codex-app/`.

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
type ThreadGoalStatus = 'active' | 'paused' | 'budgetLimited' | 'complete';

interface ThreadGoal {
  threadId: string;
  objective: string;
  status: ThreadGoalStatus;
  createdAt: number;
  updatedAt: number;
  timeUsedSeconds: number;
  tokensUsed: number;
  tokenBudget?: number | null;
}

interface ThreadGoalUpdatedNotification {
  goal: ThreadGoal;
  threadId: string;
  turnId?: string | null;
}

interface ThreadStartedNotification {
  thread: { id: string; cwd?: string; status?: string };
}

interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

interface ThreadTokenUsageUpdatedNotification {
  threadId: string;
  turnId: string;
  tokenUsage: { total: TokenUsageBreakdown; last: TokenUsageBreakdown; modelContextWindow?: number | null };
}

interface ItemCompletedNotification {
  threadId: string;
  turnId: string;
  item: { type: string; id?: string; text?: string };
}

interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId?: string;
  delta?: string;
}

interface TurnCompletedNotification {
  threadId: string;
  turn: { id: string; status: string };
}

/** Historical Claw public key `codex-app-<8>-<timestamp>`. Not a Codex thread id. */
function isCodexAppWrapperKey(id: string): boolean {
  return id.startsWith('codex-app-');
}

function threadIdFromResumeResult(result: { thread?: { id?: string } } | undefined): string | undefined {
  const id = result?.thread?.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

// ─── PersistentCodexAppServerSession ───────────────────────────────────────

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

export class PersistentCodexAppServerSession extends EventEmitter implements ISession {
  private options: SessionConfig;
  private codexBin: string;
  private proc: ChildProcess | null = null;
  private _rl: readline.Interface | null = null;
  private _stopping: Promise<void> | null = null;
  private _isReady = false;
  private _isPaused = false;
  private _isBusy = false;
  private _startTime: string | null = null;
  private _nextRpcId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private _history: Array<{ time: string; type: string; event: unknown }> = [];

  // Per-session state populated by notifications
  private threadId?: string;
  /** Thread ids observed from thread/started and handshake responses before READY. */
  private _startupThreadIds: string[] = [];
  /**
   * Set when `start()` opened a fresh thread and `appendSystemPrompt` is set.
   * Nothing passes it to `thread/start`, so the instructions ride on the first
   * turn instead, as for the one-shot engines; a resumed thread already has them.
   */
  private _instructionsPending = false;
  /** Effective initial effort returned by Codex, used to restore auto after a turn override. */
  private _sessionDefaultEffort?: string;
  private currentTurnId?: string;
  private currentGoal: ThreadGoal | null = null;

  // Per-turn buffers (reset at each send)
  private turnAssistantText = '';
  private turnResolve: ((r: TurnResult) => void) | null = null;
  private turnReject: ((e: Error) => void) | null = null;

  public sessionId?: string;
  private _stats = {
    turns: 0,
    turnsSucceeded: 0,
    toolCalls: 0,
    toolErrors: 0,
    tokensIn: 0,
    tokensOut: 0,
    cachedTokens: 0,
    costUsd: 0,
    lastActivity: null as string | null,
  };

  /** This turn's own prompt size, from `tokenUsage.last` — see _estimateContextPercent(). */
  private _lastTurnTokensIn = 0;
  /** The window the app-server is enforcing, from `tokenUsage.modelContextWindow`. */
  private _modelContextWindow?: number;

  constructor(config: SessionConfig, codexBin?: string) {
    super();
    this.codexBin = codexBin || process.env.CODEX_BIN || 'codex';
    this.options = { ...config, permissionMode: config.permissionMode || 'bypassPermissions' };
  }

  // ── Property Accessors ─────────────────────────────────────────────────

  get pid(): number | undefined {
    return this.proc?.pid ?? undefined;
  }
  get isReady(): boolean {
    return this._isReady;
  }
  get isPaused(): boolean {
    return this._isPaused;
  }
  get isBusy(): boolean {
    return this._isBusy;
  }
  get goal(): ThreadGoal | null {
    return this.currentGoal;
  }
  get codexThreadId(): string | undefined {
    return this.threadId;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start(): Promise<this> {
    if (this.options.cwd) {
      this.options.cwd = path.resolve(this.options.cwd);
      if (!fs.existsSync(this.options.cwd)) fs.mkdirSync(this.options.cwd, { recursive: true });
    }

    const resumeId = this.options.resumeSessionId?.trim() || undefined;
    if (resumeId && isCodexAppWrapperKey(resumeId)) {
      throw new Error(
        `Cannot resume Codex app-server from Claw wrapper key '${resumeId}'. Pass the full Codex thread UUID from stats.codexThreadId; wrapper keys of the form codex-app-<prefix>-<timestamp> are not native thread ids and are not guessed.`,
      );
    }

    try {
      const args = ['app-server', '--listen', 'stdio://', '--enable', 'goals'];
      const invocation = resolveWindowsNodeInvocation(this.codexBin);
      this.proc = spawn(invocation.command, [...invocation.prefixArgs, ...args], {
        cwd: this.options.cwd,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: process.platform === 'win32',
      });

      this._rl = readline.createInterface({ input: this.proc.stdout!, crlfDelay: Infinity });
      this._rl.on('line', (line) => this._handleLine(line));

      this.proc.stderr?.on('data', (data: Buffer) => {
        this.emit(SESSION_EVENT.LOG, `[codex-app-stderr] ${data.toString()}`);
      });

      this.proc.on('exit', (code) => {
        this._isReady = false;
        // Reject any pending requests so callers don't hang.
        for (const pending of this.pendingRequests.values()) {
          pending.reject(new Error(`codex app-server exited (code=${code}) before responding`));
        }
        this.pendingRequests.clear();
        if (this.turnReject) {
          this.turnReject(new Error(`codex app-server exited mid-turn (code=${code})`));
          this.turnReject = null;
          this.turnResolve = null;
        }
        this.emit(SESSION_EVENT.CLOSE, code ?? 0);
      });

      await this._handshake(resumeId);
      return this;
    } catch (err) {
      await this._abortStartup();
      throw err;
    }
  }

  /**
   * initialize → thread/resume or thread/start. Session effort belongs in
   * `config.model_reasoning_effort` (ThreadStartParams has no top-level effort).
   * An explicit resume never falls back to a fresh thread.
   */
  private async _handshake(resumeId: string | undefined): Promise<void> {
    await this._request('initialize', {
      clientInfo: { name: 'claw-orchestrator', title: null, version: '3.0.0' },
    });

    const startParams: Record<string, unknown> = {
      cwd: this.options.cwd,
      model: this.options.model,
      sandbox: (this.options.sandboxMode || 'workspace-write') as SandboxMode,
    };
    const sessionEffort = this._rpcEffort(this.options.effort);
    if (sessionEffort) startParams.config = { model_reasoning_effort: sessionEffort };

    let threadResp: { thread?: { id?: string }; reasoningEffort?: string | null };
    let resumed = false;
    if (resumeId) {
      try {
        threadResp = (await this._request('thread/resume', { threadId: resumeId, ...startParams })) as {
          thread?: { id?: string };
          reasoningEffort?: string | null;
        };
      } catch (err) {
        throw new Error(
          `Failed to resume Codex app-server thread '${resumeId}': ${(err as Error).message}. The session was not started; no fresh thread was created.`,
        );
      }
      this._noteStartupThreadId(threadIdFromResumeResult(threadResp));
      this._assertResumeIdentity(resumeId);
      this.threadId = resumeId;
      resumed = true;
    } else {
      threadResp = (await this._request('thread/start', startParams)) as {
        thread?: { id?: string };
        reasoningEffort?: string | null;
      };
      this._noteStartupThreadId(threadIdFromResumeResult(threadResp));
      if (!this.threadId && threadResp?.thread?.id) {
        this.threadId = threadResp.thread.id;
      }
      if (!this.threadId) {
        throw new Error('codex app-server did not return a thread id from thread/start');
      }
    }

    const initialEffort = threadResp.reasoningEffort;
    this._sessionDefaultEffort = typeof initialEffort === 'string' ? initialEffort : sessionEffort;
    this._instructionsPending = !resumed && !!this.options.appendSystemPrompt?.trim();

    this.sessionId = this.threadId;
    this._startTime = new Date().toISOString();
    this._isReady = true;
    this.emit(SESSION_EVENT.READY);
    this.emit(SESSION_EVENT.INIT, { type: 'system', subtype: 'init', session_id: this.sessionId });
  }

  private _noteStartupThreadId(id: string | undefined): void {
    if (typeof id === 'string' && id.length > 0) this._startupThreadIds.push(id);
  }

  private _assertResumeIdentity(resumeId: string): void {
    const ids = [...new Set(this._startupThreadIds)];
    if (ids.length === 0) {
      throw new Error(
        `Codex app-server thread/resume did not return a thread id for '${resumeId}'. The session was not started; no fresh thread was created.`,
      );
    }
    const mismatch = ids.find((id) => id !== resumeId);
    if (mismatch) {
      throw new Error(
        `Codex app-server thread/resume identity mismatch: requested '${resumeId}', got '${mismatch}'. The session was not started; no fresh thread was created.`,
      );
    }
  }

  /** Kill the app-server we spawned, close readline, and drop pending RPCs. */
  private async _abortStartup(): Promise<void> {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error('codex app-server startup aborted'));
    }
    this.pendingRequests.clear();
    this.threadId = undefined;
    this.sessionId = undefined;
    this._startupThreadIds.length = 0;
    this._isReady = false;
    await this.stop();
  }

  stop(): Promise<void> {
    if (this._stopping) return this._stopping;
    if (this._rl) {
      this._rl.close();
      this._rl = null;
    }
    const proc = this.proc;
    this.proc = null;
    this._isReady = false;
    this._isPaused = false;
    if (!proc || proc.exitCode != null || proc.signalCode != null) return Promise.resolve();

    // Codex holds an exclusive thread writer until app-server exits. Do not
    // acknowledge stop (or restart for model/tools) while that writer is alive.
    this._stopping = new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // The close event below remains the completion signal.
        }
      }, 5000);
      forceKill.unref();
      proc.once('close', () => {
        clearTimeout(forceKill);
        resolve();
      });
      try {
        proc.kill('SIGTERM');
      } catch {
        // An already-exiting process will still emit close.
      }
    }).finally(() => {
      this._stopping = null;
    });
    return this._stopping;
  }

  pause(): void {
    this._isPaused = true;
    this.emit(SESSION_EVENT.PAUSED, { sessionId: this.sessionId });
  }
  resume(): void {
    this._isPaused = false;
    this.emit(SESSION_EVENT.RESUMED, { sessionId: this.sessionId });
  }

  // ── send() ─────────────────────────────────────────────────────────────

  async send(
    message: string | unknown[],
    options: SessionSendOptions = {},
  ): Promise<TurnResult | { requestId: number; sent: boolean }> {
    if (!this._isReady) throw new Error('Session not ready. Call start() first.');
    if (!this.threadId) throw new Error('Session has no thread id (start() did not complete?)');
    let text = typeof message === 'string' ? message : JSON.stringify(message);
    const instructions = this._instructionsPending ? this.options.appendSystemPrompt?.trim() : undefined;
    this._instructionsPending = false;
    if (instructions) text = `${instructions}\n\n---\n\n${text}`;

    if (!options.waitForComplete) {
      this._fireAndForgetTurn(text, options).catch((err) => this.emit(SESSION_EVENT.ERROR, err));
      return { requestId: this._nextRpcId, sent: true };
    }

    this._isBusy = true;
    try {
      return await this._runTurn(text, options);
    } finally {
      this._isBusy = false;
    }
  }

  private async _fireAndForgetTurn(text: string, options: SessionSendOptions = {}): Promise<void> {
    await this._request('turn/start', this._turnStartParams(text, options.effort));
  }

  private async _runTurn(text: string, options: SessionSendOptions): Promise<TurnResult> {
    const timeout = options.timeout || 600_000;
    this.turnAssistantText = '';

    const turnPromise = new Promise<TurnResult>((resolve, reject) => {
      this.turnResolve = resolve;
      this.turnReject = reject;
    });

    // Wire up text streaming for this turn
    const onText = (chunk: string) => {
      try {
        options.callbacks?.onText?.(chunk);
      } catch {
        // User callback errors are not fatal.
      }
    };
    this.on(SESSION_EVENT.TEXT, onText);

    const timer = setTimeout(() => {
      if (this.turnReject) {
        const r = this.turnReject;
        this.turnResolve = null;
        this.turnReject = null;
        r(new Error('Timeout waiting for Codex app-server turn to complete'));
      }
    }, timeout);

    try {
      await this._request('turn/start', this._turnStartParams(text, options.effort));
      const result = await turnPromise;
      return result;
    } finally {
      clearTimeout(timer);
      this.removeListener(SESSION_EVENT.TEXT, onText);
    }
  }

  // ── JSON-RPC plumbing ──────────────────────────────────────────────────

  private _request(method: string, params: unknown): Promise<unknown> {
    if (!this.proc?.stdin?.writable) {
      return Promise.reject(new Error('codex app-server stdin not writable'));
    }
    const id = this._nextRpcId++;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, method });
      this.proc!.stdin!.write(msg, (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  private _handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: {
      jsonrpc?: string;
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code?: number; message?: string };
    };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.emit(SESSION_EVENT.LOG, `[codex-app-stdout] ${trimmed}`);
      return;
    }

    this._addHistory({ time: new Date().toISOString(), type: 'event', event: msg });

    // Response (has id, no method)
    if (typeof msg.id === 'number' && msg.method === undefined) {
      const pending = this.pendingRequests.get(msg.id);
      if (!pending) return;
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(`${pending.method} failed: ${msg.error.message ?? 'unknown error'}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Notification (has method, no id)
    if (msg.method) {
      this._dispatchNotification(msg.method, msg.params);
    }
  }

  private _dispatchNotification(method: string, params: unknown): void {
    switch (method) {
      case 'thread/started': {
        const p = params as ThreadStartedNotification;
        if (p.thread?.id) {
          this._noteStartupThreadId(p.thread.id);
          if (!this.threadId) this.threadId = p.thread.id;
        }
        break;
      }
      case 'turn/started': {
        const p = params as { threadId: string; turn: { id: string } };
        this.currentTurnId = p.turn?.id;
        break;
      }
      case 'item/agentMessage/delta': {
        const p = params as AgentMessageDeltaNotification;
        if (typeof p.delta === 'string' && p.delta.length > 0) {
          this.turnAssistantText += p.delta;
          this.emit(SESSION_EVENT.TEXT, p.delta);
        }
        break;
      }
      case 'item/completed': {
        const p = params as ItemCompletedNotification;
        if (p.item?.type === 'agentMessage' && typeof p.item.text === 'string') {
          // Agent messages may arrive as one final text payload (when no
          // delta stream was used). Only append if we haven't already
          // accumulated this turn's text via deltas.
          if (this.turnAssistantText.length === 0) {
            this.turnAssistantText = p.item.text;
            this.emit(SESSION_EVENT.TEXT, p.item.text);
          }
        }
        break;
      }
      case 'thread/tokenUsage/updated': {
        const p = params as ThreadTokenUsageUpdatedNotification;
        if (p.tokenUsage?.total) {
          // Replace (not increment) — the server reports cumulative totals.
          this._stats.tokensIn = p.tokenUsage.total.inputTokens;
          this._stats.tokensOut = p.tokenUsage.total.outputTokens + p.tokenUsage.total.reasoningOutputTokens;
          this._stats.cachedTokens = p.tokenUsage.total.cachedInputTokens;
          this._updateCost();
        }
        // `last` is this turn's own prompt, which for a thread-resuming engine
        // is the live context occupancy; `total` only ever grows and would pin
        // contextPercent at 100 on any long session.
        if (typeof p.tokenUsage?.last?.inputTokens === 'number') {
          this._lastTurnTokensIn = p.tokenUsage.last.inputTokens;
        }
        if (typeof p.tokenUsage?.modelContextWindow === 'number') {
          this._modelContextWindow = p.tokenUsage.modelContextWindow;
        }
        break;
      }
      case 'thread/goal/updated': {
        const p = params as ThreadGoalUpdatedNotification;
        if (p.goal) this.currentGoal = p.goal;
        this.emit('goal:updated', this.currentGoal);
        break;
      }
      case 'thread/goal/cleared': {
        this.currentGoal = null;
        this.emit('goal:cleared');
        break;
      }
      case 'turn/completed': {
        const p = params as TurnCompletedNotification;
        // This notification can itself report how the turn ended. The engine's
        // TurnStatus is `completed | interrupted | failed | inProgress`, so the counter
        // tests for completion rather than for the absence of failure: an interrupted
        // turn — which `interrupt()` on this class produces on purpose — resolves with
        // partial text and is not a success. `stop_reason` keeps its own two-state
        // mapping, so `interrupted` stays out of the error bucket there.
        const failed = p.turn?.status === 'failed';
        this._stats.turns++;
        if (p.turn?.status === 'completed') this._stats.turnsSucceeded++;
        this._stats.lastActivity = new Date().toISOString();
        // Clear the active-turn id so a later interrupt()/steer() does not target
        // an already-finished turn (only clear if it is the turn that completed).
        if (p.turn?.id && this.currentTurnId === p.turn.id) this.currentTurnId = undefined;
        const turnText = this.turnAssistantText;
        const event: StreamEvent = {
          type: 'result',
          result: turnText,
          stop_reason: failed ? 'error' : 'end_turn',
          session_id: this.threadId,
        };
        this.emit(SESSION_EVENT.RESULT, event);
        this.emit(SESSION_EVENT.TURN_COMPLETE, event);
        // A failed turn is surfaced as a rejection (mirrors the exec wrapper),
        // not an empty-text resolve, so callers see the failure.
        if (failed && this.turnReject) {
          this._stats.toolErrors++;
          const rej = this.turnReject;
          this.turnResolve = null;
          this.turnReject = null;
          rej(new Error(`Codex app-server turn failed${turnText ? `: ${turnText}` : ''}`));
          break;
        }
        if (this.turnResolve) {
          const r = this.turnResolve;
          this.turnResolve = null;
          this.turnReject = null;
          r({ text: turnText, event });
        }
        break;
      }
      case 'error': {
        const p = params as { message?: string };
        this.emit(SESSION_EVENT.ERROR, new Error(p.message ?? 'codex app-server error'));
        break;
      }
      default:
        // Unhandled notifications still go to history for debugging
        break;
    }
  }

  // ── ISession surface ───────────────────────────────────────────────────

  getStats(): SessionStats & { sessionId?: string; uptime: number; goal?: ThreadGoal | null } {
    return {
      turns: this._stats.turns,
      turnsSucceeded: this._stats.turnsSucceeded,
      toolCalls: this._stats.toolCalls,
      toolErrors: this._stats.toolErrors,
      tokensIn: this._stats.tokensIn,
      tokensOut: this._stats.tokensOut,
      cachedTokens: this._stats.cachedTokens,
      costUsd: Math.round(this._stats.costUsd * 10000) / 10000,
      isReady: this._isReady,
      startTime: this._startTime,
      lastActivity: this._stats.lastActivity,
      contextPercent: this._estimateContextPercent(),
      retries: 0,
      sessionId: this.sessionId,
      uptime: this._startTime ? Math.round((Date.now() - new Date(this._startTime).getTime()) / 1000) : 0,
      codexThreadId: this.threadId,
      goal: this.currentGoal,
    };
  }

  getHistory(limit = DEFAULT_HISTORY_LIMIT): Array<{ time: string; type: string; event: unknown }> {
    return this._history.slice(-limit);
  }

  async compact(_summary?: string): Promise<TurnResult> {
    // Codex has its own `thread/compact/start` RPC, but the existing public
    // ISession contract returns a TurnResult. Wire it as a request, ignore
    // the response shape, and return a synthesized result.
    if (!this.threadId) throw new Error('No thread id');
    await this._request('thread/compact/start', { threadId: this.threadId });
    const event: StreamEvent = { type: 'result', result: 'Codex thread compaction started' };
    return { text: 'Codex thread compaction started', event };
  }

  getEffort(): EffortLevel {
    return this.options.effort || 'auto';
  }
  setEffort(level: EffortLevel): void {
    this.options.effort = level;
  }

  resolveModel(alias: string): string {
    return resolveAlias(alias);
  }

  getCost(): CostBreakdown {
    const pricing = getModelPricing(this.options.model, 'gpt-5.5');
    const cachedPrice = pricing.cached ?? 0;
    const nonCachedIn = Math.max(0, this._stats.tokensIn - this._stats.cachedTokens);
    return {
      model: this.options.model || 'gpt-5.5',
      tokensIn: this._stats.tokensIn,
      tokensOut: this._stats.tokensOut,
      cachedTokens: this._stats.cachedTokens,
      pricing: { inputPer1M: pricing.input, outputPer1M: pricing.output, cachedPer1M: cachedPrice || undefined },
      breakdown: {
        inputCost: (nonCachedIn / 1_000_000) * pricing.input,
        cachedCost: (this._stats.cachedTokens / 1_000_000) * cachedPrice,
        outputCost: (this._stats.tokensOut / 1_000_000) * pricing.output,
      },
      totalUsd: this._stats.costUsd,
    };
  }

  // ── Public goal helpers (used by codex_goal_* tools) ───────────────────

  /**
   * Send a `/goal <args>` slash command as a regular user turn. The
   * server-side parser handles the actual goal mutation and emits a
   * `thread/goal/updated` or `thread/goal/cleared` notification.
   *
   * Awaits the resulting turn, then returns the cached goal state at
   * turn-end (which reflects the post-mutation state in the common case).
   */
  async sendGoalCommand(slashArgs: string, timeoutMs = 120_000): Promise<{ text: string; goal: ThreadGoal | null }> {
    const text = `/goal${slashArgs.length > 0 ? ' ' + slashArgs : ''}`;
    const result = (await this.send(text, { waitForComplete: true, timeout: timeoutMs })) as TurnResult;
    return { text: result.text, goal: this.currentGoal };
  }

  // ── App-server v2 RPCs (Codex 0.137) ───────────────────────────────────
  //
  // Method names + param shapes verified against `codex app-server
  // generate-json-schema` (TurnInterruptParams/TurnSteerParams/ThreadForkParams/
  // ThreadRollbackParams/ModelListResponse/ThreadGoal*Params).

  /** The id of the most recent turn (set by the `turn/started` notification). */
  get activeTurnId(): string | undefined {
    return this.currentTurnId;
  }

  /** Cancel the in-flight turn (`turn/interrupt`). No-op when no turn is active. */
  async interrupt(): Promise<{ interrupted: boolean }> {
    if (!this.threadId) throw new Error('No thread id');
    if (!this.currentTurnId) return { interrupted: false };
    await this._request('turn/interrupt', { threadId: this.threadId, turnId: this.currentTurnId });
    return { interrupted: true };
  }

  /**
   * Add input to the in-flight turn without restarting it (`turn/steer`). When
   * no turn is in flight, falls back to a normal turn so the message is not lost.
   */
  async steer(text: string): Promise<{ steered: boolean; turnId?: string; text?: string }> {
    if (!this.threadId) throw new Error('No thread id');
    if (this._isBusy && this.currentTurnId) {
      const resp = (await this._request('turn/steer', {
        threadId: this.threadId,
        expectedTurnId: this.currentTurnId,
        input: [{ type: 'text', text, text_elements: [] }],
      })) as { turnId?: string };
      return { steered: true, turnId: resp?.turnId };
    }
    const r = (await this.send(text, { waitForComplete: true })) as TurnResult;
    return { steered: false, text: r.text };
  }

  /** Branch this thread into a new one (`thread/fork`); returns the forked thread id. */
  async forkThread(): Promise<{ threadId: string }> {
    if (!this.threadId) throw new Error('No thread id');
    const resp = (await this._request('thread/fork', { threadId: this.threadId })) as { thread?: { id?: string } };
    const newId = resp?.thread?.id;
    if (!newId) throw new Error('thread/fork did not return a forked thread id');
    return { threadId: newId };
  }

  /** Drop the last `numTurns` turns from this thread (`thread/rollback`). */
  async rollback(numTurns: number): Promise<void> {
    if (!this.threadId) throw new Error('No thread id');
    if (!Number.isInteger(numTurns) || numTurns < 1) throw new Error('rollback: numTurns must be a positive integer');
    await this._request('thread/rollback', { threadId: this.threadId, numTurns });
  }

  /** List available models (`model/list`); returns the `data` array. */
  async listModels(): Promise<unknown[]> {
    const resp = (await this._request('model/list', {})) as { data?: unknown[] };
    return resp?.data ?? [];
  }

  /** List threads (`thread/list`) with optional filters + pagination. */
  async listThreads(
    opts: { cwd?: string; searchTerm?: string; archived?: boolean; cursor?: string; limit?: number } = {},
  ): Promise<{ data: unknown[]; nextCursor: string | null }> {
    const params: Record<string, unknown> = {};
    if (opts.cwd !== undefined) params.cwd = opts.cwd;
    if (opts.searchTerm !== undefined) params.searchTerm = opts.searchTerm;
    if (opts.archived !== undefined) params.archived = opts.archived;
    if (opts.cursor !== undefined) params.cursor = opts.cursor;
    if (opts.limit !== undefined) params.limit = opts.limit;
    const resp = (await this._request('thread/list', params)) as { data?: unknown[]; nextCursor?: string | null };
    return { data: resp?.data ?? [], nextCursor: resp?.nextCursor ?? null };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /**
   * Map engine-agnostic effort onto the app-server `ReasoningEffort` string.
   * Native 0.155.1 `codex_protocol::openai_models::ReasoningEffort` wire values
   * are none|minimal|low|medium|high|xhigh|max|ultra (plus persistent/custom,
   * which are not in our union). `auto` / omitted leave the engine default.
   * Levels are forwarded exactly — `max`/`ultra` stay themselves.
   */
  private _rpcEffort(effort?: EffortLevel): string | undefined {
    if (!effort || effort === 'auto') return undefined;
    const known: ReadonlySet<string> = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    return known.has(effort) ? effort : undefined;
  }

  /**
   * `TurnStartParams.effort` overrides reasoning for this turn and subsequent
   * turns. Always send the effective explicit level so a later turn restores
   * the session default.
   *
   * Do **not** send `effort: null` to unpin. rust-v0.155.1
   * `turn_processor.rs` maps `params.effort` with `.map(Some)` and comments
   * "public null does not clear effort" (same as `thread/settings/update`).
   * JSON null deserializes like omission for this single `Option` field.
   * There is no public double-option clear, unlike `service_tier`. Restore the
   * initial effective session effort from thread/start or thread/resume instead.
   * This also keeps an auto session from inheriting a one-turn override forever.
   */
  private _turnStartParams(text: string, turnEffort?: EffortLevel): Record<string, unknown> {
    const params: Record<string, unknown> = {
      threadId: this.threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    };
    const explicitTurn = turnEffort !== undefined;
    const value = this._rpcEffort(explicitTurn ? turnEffort : this.options.effort) ?? this._sessionDefaultEffort;
    if (value) params.effort = value;
    return params;
  }

  private _addHistory(entry: { time: string; type: string; event: unknown }): void {
    this._history.push(entry);
    if (this._history.length > MAX_HISTORY_ITEMS) this._history.shift();
  }

  /**
   * How full the thread's context is right now.
   *
   * Both inputs come straight from `thread/tokenUsage/updated`: the turn's own
   * prompt (`last`) and the window the server is actually enforcing. The
   * registry window is only a fallback — it holds the model's published maximum
   * (1.05M for gpt-5.x) while codex caps threads far below that, so measuring
   * against it reads several times too low.
   */
  private _estimateContextPercent(): number {
    if (this._lastTurnTokensIn <= 0) return 0;
    const ctx = this._modelContextWindow ?? getContextWindow(this.options.model || 'gpt-5.5');
    if (!ctx) return 0;
    return Math.min(100, Math.round((this._lastTurnTokensIn / ctx) * 100));
  }

  private _updateCost(): void {
    const pricing = getModelPricing(this.options.model, 'gpt-5.5');
    const cachedPrice = pricing.cached ?? 0;
    const nonCachedIn = Math.max(0, this._stats.tokensIn - this._stats.cachedTokens);
    this._stats.costUsd =
      (nonCachedIn / 1_000_000) * pricing.input +
      (this._stats.cachedTokens / 1_000_000) * cachedPrice +
      (this._stats.tokensOut / 1_000_000) * pricing.output;
  }
}
