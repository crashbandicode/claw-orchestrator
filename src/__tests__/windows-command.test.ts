import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveWindowsNodeInvocation } from '../windows-command.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryLauncher(): { directory: string; launcher: string; entry: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-windows-launcher-'));
  temporaryDirectories.push(directory);
  const entry = path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '#!/usr/bin/env node\n');
  const launcher = path.join(directory, 'codex.cmd');
  fs.writeFileSync(
    launcher,
    '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
  );
  return { directory, launcher, entry };
}

describe('resolveWindowsNodeInvocation', () => {
  it('resolves an npm cmd shim without a shell', () => {
    const { launcher, entry } = temporaryLauncher();

    expect(resolveWindowsNodeInvocation(launcher, 'win32', 'C:\\runtime\\node.exe')).toEqual({
      command: 'C:\\runtime\\node.exe',
      prefixArgs: [entry],
    });
  });

  it('prefers a node executable bundled next to the npm shim', () => {
    const { directory, launcher, entry } = temporaryLauncher();
    const bundledNode = path.join(directory, 'node.exe');
    fs.writeFileSync(bundledNode, '');

    expect(resolveWindowsNodeInvocation(launcher, 'win32', 'C:\\runtime\\node.exe')).toEqual({
      command: bundledNode,
      prefixArgs: [entry],
    });
  });

  it('leaves native launchers unchanged', () => {
    expect(resolveWindowsNodeInvocation('C:\\tools\\codex.exe', 'win32')).toEqual({
      command: 'C:\\tools\\codex.exe',
      prefixArgs: [],
    });
  });

  it('rejects non-npm Windows wrappers instead of invoking a shell', () => {
    const { launcher } = temporaryLauncher();
    fs.writeFileSync(launcher, '@ECHO off\r\necho unrelated\r\n');

    expect(() => resolveWindowsNodeInvocation(launcher, 'win32')).toThrow(/not a recognized npm Node shim/);
  });
});
