import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CommandInvocation {
  command: string;
  prefixArgs: string[];
  /** Environment the launcher script would have set; merged over the caller's by the spawner. */
  env?: Record<string, string>;
}

function npmEntryFromShim(shim: string): string | undefined {
  const cmdMatch = /%dp0%[\\/]([^"'\r\n]+?\.js)(?=["'\s]|$)/i.exec(shim);
  if (cmdMatch) return cmdMatch[1];

  const psMatch = /\$basedir[\\/]([^"'\r\n]+?\.js)(?=["'\s]|$)/i.exec(shim);
  return psMatch?.[1];
}

// ─── Cursor's own Windows installer ────────────────────────────────────────
//
// Cursor does not install an npm shim. `%LOCALAPPDATA%\cursor-agent` holds
// `cursor-agent.cmd` / `agent.cmd`, which run Windows PowerShell 5.1 on the
// sibling `cursor-agent.ps1`, which in turn starts `versions\<ver>\node.exe
// versions\<ver>\index.js`. Claw never runs Windows PowerShell 5.1, so the
// wrapper is resolved here to the same node.exe + index.js pair.

/**
 * Version directory names, exactly as cursor-agent.ps1 filters them: the legacy
 * `YYYY.MM.DD-<hash>` form and the `YYYY.MM.DD-HH-MM-SS-<hash>` form. (-match in
 * PowerShell is case-insensitive.)
 */
const CURSOR_VERSION_DIR = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-[a-f0-9]+$/i;

/** `[date, build time]` of a version directory name, or undefined when the name is not a version. */
function cursorVersionOrder(name: string): [number, number] | undefined {
  const match = CURSOR_VERSION_DIR.exec(name);
  if (!match) return undefined;
  const date = Number(match[1]) * 10_000 + Number(match[2]) * 100 + Number(match[3]);
  const time = Number(match[4] ?? 0) * 10_000 + Number(match[5] ?? 0) * 100 + Number(match[6] ?? 0);
  return [date, time];
}

export interface CursorRuntime {
  node: string;
  entry: string;
}

/**
 * The node.exe + index.js a Cursor installer wrapper in `launcherDir` would run,
 * chosen at call time so a Cursor self-update takes effect on the next launch.
 *
 * Follows cursor-agent.ps1: a `node.exe` next to the wrapper wins; otherwise the
 * newest `versions\<ver>` directory by its `YYYY.MM.DD` date. The script sorts by
 * date only and leaves same-day builds in directory order; here the build time in
 * the newer name form, then the name, break the tie so the later build wins. The
 * script also commits to the newest directory even when its node.exe is missing
 * (a half-extracted update) and fails; here the next newest complete version is
 * used instead, so a launch during an update still reaches a working Cursor.
 */
export function resolveCursorRuntime(launcher: string): CursorRuntime {
  const launcherDir = path.dirname(launcher);
  const directNode = path.join(launcherDir, 'node.exe');
  const directEntry = path.join(launcherDir, 'index.js');
  if (fs.existsSync(directNode) && fs.existsSync(directEntry)) return { node: directNode, entry: directEntry };

  const versionsDir = path.join(launcherDir, 'versions');
  let names: string[];
  try {
    names = fs
      .readdirSync(versionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    throw new Error(`Cursor launcher ${launcher} has no versions directory at ${versionsDir}`, { cause: error });
  }

  const versions = names
    .flatMap((name) => {
      const order = cursorVersionOrder(name);
      return order ? [{ name, order }] : [];
    })
    .sort((a, b) => b.order[0] - a.order[0] || b.order[1] - a.order[1] || b.name.localeCompare(a.name));
  if (versions.length === 0) {
    throw new Error(`Cursor launcher ${launcher} has no version directory (YYYY.MM.DD-<hash>) in ${versionsDir}`);
  }

  for (const version of versions) {
    const node = path.join(versionsDir, version.name, 'node.exe');
    const entry = path.join(versionsDir, version.name, 'index.js');
    if (fs.existsSync(node) && fs.existsSync(entry)) return { node, entry };
  }
  throw new Error(
    `Cursor launcher ${launcher} has no usable node.exe/index.js runtime; checked ${versions
      .map((v) => v.name)
      .join(', ')} in ${versionsDir}`,
  );
}

/**
 * Environment cursor-agent.ps1 sets before starting node: which name Cursor was
 * invoked as (it changes behaviour for `agent` versus `cursor-agent`) and the
 * Node compile cache.
 */
export function cursorLauncherEnv(launcher: string): Record<string, string> {
  const env: Record<string, string> = { CURSOR_INVOKED_AS: path.basename(launcher) };
  if (!process.env.NODE_COMPILE_CACHE && process.env.LOCALAPPDATA) {
    env.NODE_COMPILE_CACHE = path.join(process.env.LOCALAPPDATA, 'cursor-compile-cache');
  }
  return env;
}

/** Whether a `.cmd` / `.ps1` is Cursor's installer wrapper: it names `CURSOR_INVOKED_AS`, or is the stock `(cursor-)agent` launcher. */
function isCursorInstallerWrapper(launcher: string, content: string): boolean {
  return content.includes('CURSOR_INVOKED_AS') || /^(?:cursor-)?agent\.(?:cmd|ps1)$/i.test(path.basename(launcher));
}

/**
 * A bare command name (`cursor-agent`) on Windows is not something `spawn()`
 * can run without a shell: only `.exe` is found on PATH, not the installer's
 * `.cmd`. Looks the name up on PATH the way a shell would (`.exe`, then `.cmd`)
 * and returns the full path, or the name unchanged when nothing matches.
 */
export function resolveWindowsBareCommand(
  command: string,
  platform = process.platform,
  searchPath = process.env.PATH ?? process.env.Path ?? '',
): string {
  if (platform !== 'win32' || /[\\/]/.test(command) || path.extname(command) !== '') return command;
  for (const rawDir of searchPath.split(path.delimiter)) {
    const dir = rawDir.trim().replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    for (const extension of ['.exe', '.cmd']) {
      const candidate = path.join(dir, command + extension);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return command;
}

/**
 * Resolve an npm-generated Windows `.cmd` / `.ps1` shim to Node plus the
 * JavaScript entry point it wraps. Node's `spawn()` cannot execute these
 * scripts directly without a shell (`spawn EINVAL`), while enabling a shell
 * flashes console windows and weakens argument handling. Resolving the shim
 * keeps launches native, headless, and argument-safe.
 *
 * Cursor's own installer wrapper (see above) is resolved to the node.exe and
 * index.js of its newest installed version. Any other wrapper is refused.
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
    if (isCursorInstallerWrapper(engineBin, shim)) {
      const runtime = resolveCursorRuntime(engineBin);
      return { command: runtime.node, prefixArgs: [runtime.entry], env: cursorLauncherEnv(engineBin) };
    }
    throw new Error(`Windows launcher ${engineBin} is not a recognized npm Node shim or Cursor installer wrapper`);
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
