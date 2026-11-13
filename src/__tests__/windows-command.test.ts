import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cursorLauncherEnv,
  resolveCursorRuntime,
  resolveWindowsBareCommand,
  resolveWindowsNodeInvocation,
} from '../windows-command.js';

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
  fs.writeFileSync(launcher, '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
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

/** Cursor's installer wrapper, as installed on the Windows Ally (cursor-agent.cmd, 363 bytes). */
const CURSOR_CMD = [
  '@echo off',
  'setlocal enabledelayedexpansion',
  'set "CURSOR_INVOKED_AS=%~nx0"',
  'set "SCRIPT_DIR=%~dp0"',
  '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\\cursor-agent.ps1" %*',
  '',
].join('\r\n');

/** A `cursor-agent` install tree: wrapper files plus `versions\<name>` directories. */
function cursorInstall(versions: Array<{ name: string; node?: boolean; entry?: boolean }>): {
  directory: string;
  launcher: string;
  runtimeOf: (name: string) => { node: string; entry: string };
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-cursor-install-'));
  temporaryDirectories.push(directory);
  for (const wrapper of ['cursor-agent.cmd', 'agent.cmd']) fs.writeFileSync(path.join(directory, wrapper), CURSOR_CMD);
  for (const wrapper of ['cursor-agent.ps1', 'agent.ps1']) {
    fs.writeFileSync(
      path.join(directory, wrapper),
      'if (-not $env:CURSOR_INVOKED_AS) { $env:CURSOR_INVOKED_AS = "x" }\r\n',
    );
  }
  for (const version of versions) {
    const dir = path.join(directory, 'versions', version.name);
    fs.mkdirSync(dir, { recursive: true });
    if (version.node !== false) fs.writeFileSync(path.join(dir, 'node.exe'), '');
    if (version.entry !== false) fs.writeFileSync(path.join(dir, 'index.js'), '');
  }
  const runtimeOf = (name: string) => ({
    node: path.join(directory, 'versions', name, 'node.exe'),
    entry: path.join(directory, 'versions', name, 'index.js'),
  });
  return { directory, launcher: path.join(directory, 'cursor-agent.cmd'), runtimeOf };
}

describe('Cursor installer wrapper', () => {
  it('resolves cursor-agent.cmd to the installed version without PowerShell or a shell', () => {
    const { launcher, runtimeOf } = cursorInstall([{ name: '2026.10.01-e373342' }]);
    const runtime = runtimeOf('2026.10.01-e373342');

    const invocation = resolveWindowsNodeInvocation(launcher, 'win32', 'C:\\runtime\\node.exe');
    expect(invocation.command).toBe(runtime.node);
    expect(invocation.prefixArgs).toEqual([runtime.entry]);
    expect(invocation.env?.CURSOR_INVOKED_AS).toBe('cursor-agent.cmd');
  });

  it('keeps the invoked name for the agent.cmd alias and for the .ps1 scripts', () => {
    const { directory, runtimeOf } = cursorInstall([{ name: '2026.10.01-e373342' }]);
    for (const name of ['agent.cmd', 'agent.ps1', 'cursor-agent.ps1']) {
      const invocation = resolveWindowsNodeInvocation(path.join(directory, name), 'win32');
      expect(invocation.command).toBe(runtimeOf('2026.10.01-e373342').node);
      expect(invocation.env?.CURSOR_INVOKED_AS).toBe(name);
    }
  });

  it('chooses the newest version by date, not by name or directory order', () => {
    const { launcher, runtimeOf } = cursorInstall([
      { name: '2026.9.28-aaaaaaa' },
      { name: '2026.10.01-e373342' },
      { name: '2025.12.31-ffffff0' },
      { name: '2026.09.30-0000001' },
    ]);
    expect(resolveCursorRuntime(launcher)).toEqual(runtimeOf('2026.10.01-e373342'));
  });

  it('breaks a same-day tie with the build time of the newer name form, then the name', () => {
    const early = cursorInstall([{ name: '2026.10.01-09-00-00-aaaaaaa' }, { name: '2026.10.01-18-30-00-bbbbbbb' }]);
    expect(resolveCursorRuntime(early.launcher)).toEqual(early.runtimeOf('2026.10.01-18-30-00-bbbbbbb'));

    const sameTime = cursorInstall([{ name: '2026.10.01-aaaaaaa' }, { name: '2026.10.01-bbbbbbb' }]);
    expect(resolveCursorRuntime(sameTime.launcher)).toEqual(sameTime.runtimeOf('2026.10.01-bbbbbbb'));
  });

  it('ignores entries that are not version directories, as cursor-agent.ps1 does', () => {
    const { directory, launcher, runtimeOf } = cursorInstall([{ name: '2026.08.11-e8db854' }]);
    fs.mkdirSync(path.join(directory, 'versions', '2026.12.31-not-a-hash'), { recursive: true });
    fs.mkdirSync(path.join(directory, 'versions', 'latest'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'versions', '2027.01.01-abcdef0'), 'a file, not a directory');
    expect(resolveCursorRuntime(launcher)).toEqual(runtimeOf('2026.08.11-e8db854'));
  });

  it('is resolved on every call, so a Cursor self-update is picked up', () => {
    const { directory, launcher, runtimeOf } = cursorInstall([{ name: '2026.10.01-e373342' }]);
    expect(resolveCursorRuntime(launcher)).toEqual(runtimeOf('2026.10.01-e373342'));

    fs.mkdirSync(path.join(directory, 'versions', '2026.10.20-1234abc'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'versions', '2026.10.20-1234abc', 'node.exe'), '');
    fs.writeFileSync(path.join(directory, 'versions', '2026.10.20-1234abc', 'index.js'), '');
    expect(resolveCursorRuntime(launcher)).toEqual(runtimeOf('2026.10.20-1234abc'));
  });

  it('uses node.exe and index.js next to the wrapper before looking at versions', () => {
    const { directory, launcher } = cursorInstall([{ name: '2026.10.01-e373342' }]);
    fs.writeFileSync(path.join(directory, 'node.exe'), '');
    fs.writeFileSync(path.join(directory, 'index.js'), '');
    expect(resolveCursorRuntime(launcher)).toEqual({
      node: path.join(directory, 'node.exe'),
      entry: path.join(directory, 'index.js'),
    });
  });

  it('falls back to the next newest complete version when the newest is half-extracted', () => {
    const { launcher, runtimeOf } = cursorInstall([
      { name: '2026.10.20-1234abc', node: false },
      { name: '2026.10.10-abcdef1', entry: false },
      { name: '2026.10.01-e373342' },
    ]);
    expect(resolveCursorRuntime(launcher)).toEqual(runtimeOf('2026.10.01-e373342'));
  });

  it('fails clearly when no version has a node.exe and index.js', () => {
    const { launcher } = cursorInstall([
      { name: '2026.10.20-1234abc', node: false },
      { name: '2026.10.01-e373342', entry: false },
    ]);
    expect(() => resolveCursorRuntime(launcher)).toThrow(
      /no usable node\.exe\/index\.js runtime; checked 2026\.10\.20-1234abc, 2026\.10\.01-e373342/,
    );
    expect(() => resolveWindowsNodeInvocation(launcher, 'win32')).toThrow(/no usable node\.exe\/index\.js runtime/);
  });

  it('fails clearly without a versions directory or without any version in it', () => {
    const none = cursorInstall([]);
    expect(() => resolveCursorRuntime(none.launcher)).toThrow(/no versions directory/);

    fs.mkdirSync(path.join(none.directory, 'versions'));
    expect(() => resolveCursorRuntime(none.launcher)).toThrow(/no version directory/);
  });

  it('sets the invoked name and the compile cache the way cursor-agent.ps1 does', () => {
    const previous = { cache: process.env.NODE_COMPILE_CACHE, local: process.env.LOCALAPPDATA };
    try {
      delete process.env.NODE_COMPILE_CACHE;
      process.env.LOCALAPPDATA = '/local';
      expect(cursorLauncherEnv('/x/agent.cmd')).toEqual({
        CURSOR_INVOKED_AS: 'agent.cmd',
        NODE_COMPILE_CACHE: path.join('/local', 'cursor-compile-cache'),
      });
      process.env.NODE_COMPILE_CACHE = '/already';
      expect(cursorLauncherEnv('/x/agent.cmd')).toEqual({ CURSOR_INVOKED_AS: 'agent.cmd' });
    } finally {
      if (previous.cache === undefined) delete process.env.NODE_COMPILE_CACHE;
      else process.env.NODE_COMPILE_CACHE = previous.cache;
      if (previous.local === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previous.local;
    }
  });

  it('does not take over an unrelated wrapper, even next to a versions directory', () => {
    const { directory } = cursorInstall([{ name: '2026.10.01-e373342' }]);
    const other = path.join(directory, 'other.cmd');
    fs.writeFileSync(other, '@ECHO off\r\necho unrelated\r\n');
    expect(() => resolveWindowsNodeInvocation(other, 'win32')).toThrow(
      /not a recognized npm Node shim or Cursor installer wrapper/,
    );
  });

  it('leaves the npm shim behaviour unchanged when a versions directory sits beside it', () => {
    const { directory, launcher, entry } = temporaryLauncher();
    fs.mkdirSync(path.join(directory, 'versions', '2026.10.01-e373342'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'versions', '2026.10.01-e373342', 'node.exe'), '');
    fs.writeFileSync(path.join(directory, 'versions', '2026.10.01-e373342', 'index.js'), '');
    expect(resolveWindowsNodeInvocation(launcher, 'win32', 'C:\\runtime\\node.exe')).toEqual({
      command: 'C:\\runtime\\node.exe',
      prefixArgs: [entry],
    });
  });

  it('does nothing off Windows', () => {
    const { launcher } = cursorInstall([{ name: '2026.10.01-e373342' }]);
    expect(resolveWindowsNodeInvocation(launcher, 'linux')).toEqual({ command: launcher, prefixArgs: [] });
  });
});

describe('resolveWindowsBareCommand', () => {
  it('finds a bare name on PATH as .cmd, preferring .exe, and leaves anything else alone', () => {
    const { directory, launcher } = cursorInstall([]);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-path-'));
    temporaryDirectories.push(other);
    const searchPath = [other, directory].join(path.delimiter);

    expect(resolveWindowsBareCommand('cursor-agent', 'win32', searchPath)).toBe(launcher);
    fs.writeFileSync(path.join(other, 'cursor-agent.exe'), '');
    expect(resolveWindowsBareCommand('cursor-agent', 'win32', searchPath)).toBe(path.join(other, 'cursor-agent.exe'));

    expect(resolveWindowsBareCommand('nothing-here', 'win32', searchPath)).toBe('nothing-here');
    expect(resolveWindowsBareCommand('cursor-agent', 'linux', searchPath)).toBe('cursor-agent');
    expect(resolveWindowsBareCommand('cursor-agent.cmd', 'win32', searchPath)).toBe('cursor-agent.cmd');
    expect(resolveWindowsBareCommand('C:\\tools\\cursor-agent', 'win32', searchPath)).toBe('C:\\tools\\cursor-agent');
  });
});
