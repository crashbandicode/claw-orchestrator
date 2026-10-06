import type { SessionManager } from '../session-manager.js';
import type { RemoteBrokerHost } from './broker-host.js';

export function sessionManagerHost(manager: SessionManager): RemoteBrokerHost {
  return {
    startSession: (config) => manager.startSession(config),
    sendMessage: (name, message, options) => manager.sendMessage(name, message, options),
    stopSession: (name) => manager.stopSession(name),
    listSessions: () => manager.listSessions(),
    listPersistedSessions: () => manager.listPersistedSessions(),
    getStatus: (name) => manager.getStatus(name),
    health: () => manager.health(),
    holdSession: (name) => manager.holdSession(name),
    releaseSessionHold: (name) => manager.releaseSessionHold(name),
    hasLiveSession: (name) => manager.hasLiveSession(name),
    isSessionBusy: (name) => manager.isSessionBusy(name),
    shutdown: () => manager.shutdown(),
  };
}
