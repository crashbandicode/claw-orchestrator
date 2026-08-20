import { describe, expect, it } from 'vitest';

import { OrchestrationEventWriter } from '../orchestration-events.js';
import type { OrchestrationAgentContext } from '../types.js';

const context: OrchestrationAgentContext = {
  runId: 'fanout-1234',
  runKind: 'fanout',
  agentKey: 'reviewer',
  agentName: 'Reviewer',
  codename: 'red-team',
  engine: 'codex',
  model: 'gpt-5.6-sol',
  effort: 'high',
  cwd: 'C:\\work\\repo',
};

describe('OrchestrationEventWriter', () => {
  it('appends a versioned, content-free event with stable run and installation identities', () => {
    const lines: string[] = [];
    const writer = new OrchestrationEventWriter({
      outboxFile: 'events.jsonl',
      installationId: 'install-1',
      orchestratorVersion: '5.0.1',
      now: () => new Date('2026-08-20T12:00:00.000Z'),
      uuid: () => 'event-1',
      appendLine: (_file, line) => lines.push(line),
    });

    writer.emit('agent.identity_bound', context, {
      nativeSessionId: 'native-thread-1',
      agentStatus: 'idle',
    });

    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event).toMatchObject({
      schema_version: 1,
      event_id: 'event-1',
      installation_id: 'install-1',
      orchestrator: 'claw-orchestrator',
      orchestrator_version: '5.0.1',
      event: 'agent.identity_bound',
      run_id: 'fanout-1234',
      agent_key: 'reviewer',
      native_session_id: 'native-thread-1',
    });
    expect(JSON.stringify(event)).not.toContain('prompt');
    expect(JSON.stringify(event)).not.toContain('response');
  });

  it('never lets a failed telemetry append break the caller', () => {
    const writer = new OrchestrationEventWriter({
      outboxFile: 'events.jsonl',
      installationId: 'install-1',
      appendLine: () => {
        throw new Error('disk full');
      },
    });

    expect(() => writer.emit('agent.declared', context, { agentStatus: 'declared' })).not.toThrow();
  });

  it('bounds user-controlled fields without collapsing long identities', () => {
    const lines: string[] = [];
    const writer = new OrchestrationEventWriter({
      outboxFile: 'events.jsonl',
      installationId: 'i'.repeat(300),
      uuid: () => 'e'.repeat(300),
      appendLine: (_file, line) => lines.push(line),
    });
    writer.emit('agent.identity_bound', {
      ...context,
      runId: `fanout-${'r'.repeat(500)}`,
      agentKey: `review-${'k'.repeat(500)}`,
      agentName: 'n'.repeat(500),
      cwd: `C:\\${'d'.repeat(5_000)}`,
    }, { nativeSessionId: 's'.repeat(900) });

    const event = JSON.parse(lines[0]);
    expect(event.event_id.length).toBeLessThanOrEqual(128);
    expect(event.installation_id.length).toBeLessThanOrEqual(128);
    expect(event.run_id.length).toBeLessThanOrEqual(256);
    expect(event.agent_key.length).toBeLessThanOrEqual(256);
    expect(event.agent_name.length).toBeLessThanOrEqual(256);
    expect(event.cwd.length).toBeLessThanOrEqual(4096);
    expect(event.native_session_id.length).toBeLessThanOrEqual(512);
    expect(event.run_id).not.toBe(event.agent_key);
  });
});
