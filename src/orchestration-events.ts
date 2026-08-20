/**
 * Durable, content-free lifecycle events for external conversation indexers.
 *
 * The transcript remains owned by the native CLI (Claude/Codex/Cursor). This
 * outbox only records enough identity and status metadata to join a Claw run to
 * those native transcripts after short-lived Claw sessions are cleaned up.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import type { Logger } from './logger.js';
import type { OrchestrationAgentContext, OrchestrationAgentStatus, OrchestrationRunStatus } from './types.js';

export const ORCHESTRATION_EVENT_SCHEMA_VERSION = 1 as const;

export type OrchestrationEventName =
  | 'run.started'
  | 'run.status'
  | 'agent.declared'
  | 'agent.identity_bound'
  | 'agent.status';

export interface OrchestrationLifecycleEvent {
  schema_version: typeof ORCHESTRATION_EVENT_SCHEMA_VERSION;
  event_id: string;
  occurred_at: string;
  installation_id: string;
  orchestrator: 'claw-orchestrator';
  orchestrator_version: string;
  event: OrchestrationEventName;
  run_id: string;
  run_kind: OrchestrationAgentContext['runKind'];
  run_status?: OrchestrationRunStatus;
  agent_key?: string;
  agent_name?: string;
  codename?: string;
  engine?: OrchestrationAgentContext['engine'];
  model?: string;
  effort?: OrchestrationAgentContext['effort'];
  cwd?: string;
  native_session_id?: string;
  agent_status?: OrchestrationAgentStatus;
}

export interface OrchestrationEventWriterOptions {
  outboxFile?: string;
  installationId?: string;
  orchestratorVersion?: string;
  now?: () => Date;
  uuid?: () => string;
  appendLine?: (file: string, line: string) => void;
}

export function defaultOrchestrationOutboxFile(): string {
  return (
    process.env.CLAWO_MEMENTO_OUTBOX ||
    path.join(os.homedir(), '.claw-orchestrator', 'memento-events', 'v1', 'events.jsonl')
  );
}

function defaultAppendLine(file: string, line: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line, { encoding: 'utf8', flag: 'a' });
}

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function boundedIdentity(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 16);
  return `${value.slice(0, maximum - digest.length - 1)}-${digest}`;
}

function installationIdFile(outboxFile: string): string {
  return path.join(path.dirname(outboxFile), 'installation-id');
}

function resolveInstallationId(outboxFile: string, explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.CLAWO_INSTALLATION_ID) return process.env.CLAWO_INSTALLATION_ID;
  const file = installationIdFile(outboxFile);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // First run (or an unreadable legacy file): create a fresh local identity.
  }
  const created = randomUUID();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${created}\n`, { encoding: 'utf8', flag: 'wx' });
    return created;
  } catch {
    // Another process may have won the first-run race.
    try {
      const winner = fs.readFileSync(file, 'utf8').trim();
      if (winner) return winner;
    } catch {
      // Keep the process-local id. Event IDs still make every record idempotent.
    }
    return created;
  }
}

export class OrchestrationEventWriter {
  readonly outboxFile: string;
  readonly installationId: string;
  private readonly orchestratorVersion: string;
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly appendLine: (file: string, line: string) => void;

  constructor(
    options: OrchestrationEventWriterOptions = {},
    private readonly logger?: Logger,
  ) {
    this.outboxFile = options.outboxFile || defaultOrchestrationOutboxFile();
    this.installationId = resolveInstallationId(this.outboxFile, options.installationId);
    this.orchestratorVersion = options.orchestratorVersion || 'unknown';
    this.now = options.now || (() => new Date());
    this.uuid = options.uuid || randomUUID;
    this.appendLine = options.appendLine || defaultAppendLine;
  }

  emit(
    event: OrchestrationEventName,
    context: OrchestrationAgentContext,
    values: {
      nativeSessionId?: string;
      agentStatus?: OrchestrationAgentStatus;
      runStatus?: OrchestrationRunStatus;
    } = {},
  ): OrchestrationLifecycleEvent | undefined {
    if (process.env.CLAWO_MEMENTO_EVENTS === '0') return undefined;
    const record: OrchestrationLifecycleEvent = {
      schema_version: ORCHESTRATION_EVENT_SCHEMA_VERSION,
      event_id: boundedIdentity(this.uuid(), 128),
      occurred_at: this.now().toISOString(),
      installation_id: boundedIdentity(this.installationId, 128),
      orchestrator: 'claw-orchestrator',
      orchestrator_version: boundedText(this.orchestratorVersion, 64),
      event,
      run_id: boundedIdentity(context.runId, 256),
      run_kind: context.runKind,
      ...(values.runStatus ? { run_status: values.runStatus } : {}),
      agent_key: boundedIdentity(context.agentKey, 256),
      agent_name: boundedText(context.agentName, 256),
      ...(context.codename ? { codename: boundedText(context.codename, 256) } : {}),
      engine: context.engine,
      ...(context.model ? { model: boundedText(context.model, 256) } : {}),
      ...(context.effort ? { effort: context.effort } : {}),
      cwd: boundedText(context.cwd, 4096),
      ...(values.nativeSessionId
        ? { native_session_id: boundedIdentity(values.nativeSessionId, 512) }
        : {}),
      ...(values.agentStatus ? { agent_status: values.agentStatus } : {}),
    };
    try {
      this.appendLine(this.outboxFile, `${JSON.stringify(record)}\n`);
      return record;
    } catch (err) {
      // Telemetry must never make an orchestrated coding turn fail.
      this.logger?.warn?.(`Failed to append Memento orchestration event: ${(err as Error).message}`);
      return undefined;
    }
  }
}
