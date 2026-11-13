/**
 * Guards for the error events of a spawned child process.
 *
 * An `error` event nobody listens for is thrown by EventEmitter from inside the
 * callback that raised it, which is an uncaught exception that ends the host. The
 * broker hosts every session on the machine, so one child that cannot be spawned
 * (ENOENT, EACCES), or one that closes its stdin before a write lands (EPIPE),
 * must be an error on that session and nothing more. Node raises these on the
 * ChildProcess itself and on each of its three pipes, none of which the session
 * manager's guard on the session EventEmitter can see.
 */

import type { ChildProcess } from 'node:child_process';
import { SESSION_EVENT } from './constants.js';

export type ChildStreamName = 'stdin' | 'stdout' | 'stderr';

interface Listenable {
  on?: (event: 'error', listener: (err: Error) => void) => unknown;
}

/**
 * Give stdin, stdout and stderr of `child` an `error` listener for their whole
 * life. `onError` decides what the fault means; without one it is dropped, which
 * is right for streams nothing writes to or reads whole (the process `close` or
 * `exit` carries the outcome). Tolerates stand-ins without pipes or without `on`.
 */
export function guardChildStreams(child: ChildProcess, onError?: (stream: ChildStreamName, err: Error) => void): void {
  const streams: Array<[ChildStreamName, Listenable | null | undefined]> = [
    ['stdin', child.stdin as Listenable | null],
    ['stdout', child.stdout as Listenable | null],
    ['stderr', child.stderr as Listenable | null],
  ];
  for (const [name, stream] of streams) {
    if (typeof stream?.on !== 'function') continue;
    stream.on('error', (err: Error) => {
      try {
        onError?.(name, err);
      } catch {
        /* a failing report must not become the uncaught exception it prevents */
      }
    });
  }
}

/**
 * Report an error on a session emitter without throwing.
 *
 * `emit('error')` throws when nothing listens. The session manager always
 * listens, but a stream fault arrives on a callback of its own, and reporting it
 * must never be the thing that ends the process. Without a listener the message
 * goes to the log event instead.
 */
export function reportSessionError(
  emitter: {
    listenerCount(event: string): number;
    emit(event: string, ...args: unknown[]): boolean;
  },
  err: Error,
  logPrefix: string,
): void {
  if (emitter.listenerCount(SESSION_EVENT.ERROR) > 0) {
    emitter.emit(SESSION_EVENT.ERROR, err);
  } else {
    emitter.emit(SESSION_EVENT.LOG, `${logPrefix} ${err.message}`);
  }
}

/**
 * A stdin fault reporter that reports each distinct error once.
 *
 * Node raises a failed write twice: through the write callback and through the
 * stream's `error` event, with the same Error object. Both paths are needed (a
 * write on an already destroyed stream calls back without an event), so the
 * reporter folds them into one session error.
 */
export function createStdinErrorReporter(
  report: (err: Error) => void,
  describe: (err: Error) => Error = (err) => new Error(`Failed to write to stdin: ${err.message}`),
): (err: Error | null | undefined) => void {
  const seen = new WeakSet<Error>();
  return (err) => {
    if (!err || seen.has(err)) return;
    seen.add(err);
    report(describe(err));
  };
}
