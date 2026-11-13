import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { fsyncDirectory } from '../remote/durable-fsync.js';
import { assertSocketPath, isWindowsPipePath } from '../remote/qualified-name.js';

describe('socket paths', () => {
  it('accepts an absolute unix socket', () => {
    expect(() => assertSocketPath('/run/user/1000/clawo/broker.sock')).not.toThrow();
    expect(isWindowsPipePath('/run/user/1000/clawo/broker.sock')).toBe(false);
  });

  it('accepts an owner-only Windows pipe', () => {
    const pipe = '\\\\.\\pipe\\clawo-broker';
    expect(isWindowsPipePath(pipe)).toBe(true);
    expect(() => assertSocketPath(pipe)).not.toThrow();
    expect(() => assertSocketPath('\\\\?\\pipe\\clawo-broker')).not.toThrow();
  });

  it('fsyncs a directory on linux', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c23-fsync-'));
    try {
      expect(() => fsyncDirectory(dir)).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('rejects a pipe name that is not a single path segment', () => {
    expect(() => assertSocketPath('\\\\.\\pipe\\clawo\\broker')).toThrow(/absolute single-line path/);
    expect(() => assertSocketPath('\\\\.\\pipe\\')).toThrow(/absolute single-line path/);
    expect(() => assertSocketPath('C:\\Users\\intpa\\broker.sock')).toThrow(/absolute single-line path/);
  });
});
