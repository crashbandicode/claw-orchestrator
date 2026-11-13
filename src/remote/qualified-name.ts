/** Host-qualified Claw session handles. Native resume ids are never wrapped. */

export const HANDLE_SEPARATOR = '::';
/** Linux `sockaddr_un.sun_path` is 108 bytes including the NUL terminator. */
export const MAX_SOCKET_PATH = 104;

const HOST_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertHostAlias(alias: string): void {
  if (!HOST_ALIAS.test(alias)) {
    throw new Error(`Invalid host alias '${alias.slice(0, 80)}'`);
  }
}

export function assertSocketPath(socketPath: string): void {
  if (
    !socketPath.startsWith('/') ||
    socketPath.includes('\0') ||
    socketPath.includes('\n') ||
    socketPath.includes('\r')
  ) {
    throw new Error('Socket path must be an absolute single-line path');
  }
  if (Buffer.byteLength(socketPath) >= MAX_SOCKET_PATH) {
    throw new Error(`Socket path must be shorter than ${MAX_SOCKET_PATH} bytes`);
  }
}

export function qualifySessionName(host: string, localName: string): string {
  assertHostAlias(host);
  if (!localName || localName.includes(HANDLE_SEPARATOR) || /[\r\n]/.test(localName)) {
    throw new Error('Session name cannot contain :: or a newline');
  }
  return `${host}${HANDLE_SEPARATOR}${localName}`;
}

/**
 * Split `host::name` only when `host` is a configured alias.
 * Any other string, including a native UUID, stays a local name.
 */
export function splitSessionHandle(
  name: string,
  knownHosts: ReadonlySet<string>,
): { host?: string; localName: string } {
  const index = name.indexOf(HANDLE_SEPARATOR);
  if (index <= 0) return { localName: name };
  const host = name.slice(0, index);
  const localName = name.slice(index + HANDLE_SEPARATOR.length);
  if (!knownHosts.has(host) || !localName || localName.includes(HANDLE_SEPARATOR)) {
    return { localName: name };
  }
  return { host, localName };
}
