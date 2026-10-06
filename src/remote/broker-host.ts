import type { EffortLevel, SessionConfig, SessionInfo } from '../types.js';

export interface RemoteSendOptions {
  timeout?: number;
  effort?: EffortLevel;
  plan?: boolean;
}

export interface RemoteBrokerHost {
  startSession(config: Partial<SessionConfig> & { name?: string }): Promise<SessionInfo>;
  sendMessage(
    name: string,
    message: string,
    options?: RemoteSendOptions,
  ): Promise<{ output: string; sessionId?: string; error?: string }>;
  stopSession(name: string): Promise<void>;
  listSessions(): SessionInfo[];
  listPersistedSessions(): Array<{
    name: string;
    cwd?: string;
    model?: string;
    engine?: string;
    claudeSessionId?: string;
  }>;
  getStatus(name: string): SessionInfo;
  health(): {
    ok: boolean;
    sessions: number;
    sessionNames: string[];
    details: Array<{ name: string }>;
  };
  holdSession(name: string): void;
  releaseSessionHold(name: string): void;
  hasLiveSession(name: string): boolean;
  isSessionBusy(name: string): boolean;
  shutdown(): Promise<void>;
}
