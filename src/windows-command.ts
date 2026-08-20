import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CommandInvocation {
  command: string;
  prefixArgs: string[];
}

function npmEntryFromShim(shim: string): string | undefined {
  const cmdMatch = /%dp0%[\\/]([^"'\r\n]+?\.js)(?=["'\s]|$)/i.exec(shim);
  if (cmdMatch) return cmdMatch[1];

  const psMatch = /\$basedir[\\/]([^"'\r\n]+?\.js)(?=["'\s]|$)/i.exec(shim);
  return psMatch?.[1];
}

/**
 * Resolve an npm-generated Windows `.cmd` / `.ps1` shim to Node plus the
 * JavaScript entry point it wraps. Node's `spawn()` cannot execute these
 * scripts directly without a shell (`spawn EINVAL`), while enabling a shell
 * flashes console windows and weakens argument handling. Resolving the shim
 * keeps launches native, headless, and argument-safe.
 */
export function resolveWindowsNodeInvocation(
  engineBin: string,
  platform = process.platform,
  nodeExecutable = process.execPath,
): CommandInvocation {
  if (platform !== 'win32' || !/\.(?:cmd|ps1)$/i.test(engineBin)) {
    return { command: engineBin, prefixArgs: [] };
  }

  let shim: string;
  try {
    shim = fs.readFileSync(engineBin, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read Windows launcher ${engineBin}`, { cause: error });
  }

  const relativeEntry = npmEntryFromShim(shim);
  if (!relativeEntry) {
    throw new Error(`Windows launcher ${engineBin} is not a recognized npm Node shim`);
  }

  const entry = path.resolve(path.dirname(engineBin), relativeEntry.replace(/[\\/]/g, path.sep));
  if (!fs.existsSync(entry)) {
    throw new Error(`Windows launcher ${engineBin} points to missing entry ${entry}`);
  }

  const bundledNode = path.join(path.dirname(engineBin), 'node.exe');
  return {
    command: fs.existsSync(bundledNode) ? bundledNode : nodeExecutable,
    prefixArgs: [entry],
  };
}
