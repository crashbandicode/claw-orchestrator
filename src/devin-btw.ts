/**
 * Devin `/btw` as a side question that leaves the parent thread in place.
 *
 * The ACP client advertises `cognition.ai/chains`, then sends `/btw`. Current
 * Devin builds still answer that the client does not use side chains, and they
 * do not store the question. The fallback opens a second session, answers from
 * a bounded copy of the parent transcript, rejects permission requests, and
 * closes that session. The side record is what Memento collects.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);

const TRANSCRIPT_CHARS = 12_000;

const REFUSAL =
  /needs side-chain support|\/btw is not available yet|side subagent spawn failed|side prompt abandoned|already running on this chain|already streaming on this chain/i;

export function devinBtwPrompt(question: string): string {
  const trimmed = question.trim();
  if (!trimmed) throw new Error('Devin /btw requires a question');
  return `/btw ${trimmed}`;
}

export function devinBtwRefusal(text: string): boolean {
  const body = text.trim();
  return body.length > 0 && body.length <= 400 && REFUSAL.test(body);
}

export function devinDataRoot(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'devin');
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'devin');
}

export function devinSideId(): string {
  return `btw-${randomBytes(4).toString('hex')}`;
}

export function devinSideQuestion(transcript: string, question: string): string {
  const body = transcript.trim().slice(-TRANSCRIPT_CHARS);
  const context = body ? `Conversation so far:\n${body}\n\n` : '';
  return (
    'Answer one side question about this Devin conversation. ' +
    'Use only the conversation text. Do not edit files, run commands, or continue the main task.\n\n' +
    context +
    `Question: ${question.trim()}`
  );
}

export interface DevinSideRecord {
  parentSessionId: string;
  sideSessionId: string;
  question: string;
  answer: string;
  model?: string;
  native: boolean;
}

export function devinSideDocument(record: DevinSideRecord): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    schema_version: 'ATIF-v1.7',
    session_id: record.sideSessionId,
    thread_source: 'side',
    parent_thread_id: record.parentSessionId,
    side_status: 'closed',
    agent: {
      name: 'devin',
      model_name: record.model || '',
    },
    steps: [
      { step_id: 'user-1', source: 'user', timestamp: now, message: record.question },
      { step_id: 'agent-1', source: 'agent', timestamp: now, message: record.answer },
    ],
    extra: { native_btw: record.native },
  };
}

export function writeDevinSideDocument(root: string, record: DevinSideRecord): string {
  const dir = path.join(root, 'cli', 'sides');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${record.sideSessionId}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(devinSideDocument(record)));
  fs.renameSync(tmp, file);
  return file;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(messageText).join('');
  if (content && typeof content === 'object' && 'text' in content) {
    return messageText((content as { text: unknown }).text);
  }
  return '';
}

type SqliteDb = {
  prepare: (sql: string) => {
    all: (id: string) => unknown[];
    run: (id: string) => unknown;
  };
  close: () => void;
};

function openDevinDb(dbPath: string, readOnly: boolean): SqliteDb | null {
  try {
    const mod = require('node:sqlite') as {
      DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDb;
    };
    return new mod.DatabaseSync(dbPath, readOnly ? { readOnly: true } : undefined);
  } catch {
    return null;
  }
}

/** Newest parent turns, oldest last in the returned text, within the budget. */
export function readDevinTranscript(root: string, sessionId: string): string {
  const dbPath = path.join(root, 'cli', 'sessions.db');
  if (!sessionId || !fs.existsSync(dbPath)) return '';
  const db = openDevinDb(dbPath, true);
  if (!db) return '';
  try {
    const rows = db
      .prepare(
        `SELECT chat_message FROM message_nodes
          WHERE session_id = ?
          ORDER BY row_id DESC
          LIMIT 40`,
      )
      .all(sessionId);
      const lines: string[] = [];
      let used = 0;
      for (const row of rows) {
        const raw = row && typeof row === 'object' && 'chat_message' in row ? (row as { chat_message: unknown }).chat_message : row;
        let message: unknown = raw;
        if (typeof raw === 'string') {
          try {
            message = JSON.parse(raw);
          } catch {
            continue;
          }
        }
        if (!message || typeof message !== 'object') continue;
        const role = (message as { role?: unknown }).role;
        if (role !== 'user' && role !== 'assistant') continue;
        const text = messageText((message as { content?: unknown }).content).replace(/\s+/g, ' ').trim();
        if (!text || text.startsWith('/btw ')) continue;
        const line = `${role}: ${text.slice(0, 2000)}`;
        if (used + line.length > TRANSCRIPT_CHARS) break;
        lines.push(line);
        used += line.length + 1;
      }
    return lines.reverse().join('\n');
  } catch {
    return '';
  } finally {
    db.close();
  }
}

/** Keep a temporary side session out of the Devin conversation projector. */
export function hideDevinSession(root: string, sessionId: string): void {
  const dbPath = path.join(root, 'cli', 'sessions.db');
  if (!sessionId || !fs.existsSync(dbPath)) return;
  const db = openDevinDb(dbPath, false);
  if (!db) return;
  try {
    db.prepare('UPDATE sessions SET hidden = 1 WHERE id = ?').run(sessionId);
  } catch {
    // The daemon may hold the write lock. Deleting the session is the other guard.
  } finally {
    db.close();
  }
}
