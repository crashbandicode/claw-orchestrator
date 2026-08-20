/**
 * Shared validation utilities for input sanitization.
 *
 * Used by both the plugin tool handlers (index.ts) and the embedded HTTP
 * server (embedded-server.ts) to ensure consistent protection regardless
 * of entry point.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import RE2 from 're2';

// ─── Blocked Path Prefixes ─────────────────────────────────────────────────

/** System-critical directories that must never be used as a working directory */
const BLOCKED_PREFIXES = ['/etc', '/proc', '/sys', '/var/run', '/var/log', '/boot', '/sbin'];
const BLOCKED_WINDOWS_PREFIXES = [
  'c:/windows',
  'c:/program files',
  'c:/program files (x86)',
  'c:/programdata',
  'c:/recovery',
  'c:/system volume information',
];

/** Sensitive directories under the user's home that must never be used as cwd */
const BLOCKED_HOME_SUBDIRS = ['.ssh', '.gnupg', '.aws', '.config/gcloud'];

// ─── sanitizeCwd ────────────────────────────────────────────────────────────

/**
 * Resolve and validate a working directory path.
 *
 * Prevents path traversal and blocks access to system-critical and
 * sensitive directories. Resolves symlinks where possible to defeat
 * symlink-based bypasses.
 */
export function sanitizeCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;

  const isPosixAbsolute = path.posix.isAbsolute(cwd);
  // win32.isAbsolute('/tmp') is true because Windows accepts rooted paths
  // without a drive. Treat only a drive-qualified or UNC path as explicitly
  // Windows so a genuine POSIX path survives a Windows -> WSL launch intact.
  const isWindowsAbsolute = /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(cwd);
  const usesNativeGrammar = process.platform === 'win32'
    ? isWindowsAbsolute || !isPosixAbsolute
    : !isWindowsAbsolute;

  // Logical path: resolves .. and . but does NOT follow symlinks.
  // Resolve with the caller's path grammar. Claw can launch an agent in a
  // different environment (for example WSL from Windows), so using only the
  // host grammar would silently turn /tmp/project into C:\tmp\project.
  const logical = isPosixAbsolute
    ? path.posix.resolve(cwd)
    : isWindowsAbsolute
      ? path.win32.resolve(cwd)
      : path.resolve(cwd);

  // Real path: follows symlinks. This catches symlink-based bypasses
  // (e.g. /tmp/safe → /etc). Falls back to logical for non-existent paths.
  let real: string;
  try {
    real = usesNativeGrammar ? fs.realpathSync(cwd) : logical;
  } catch {
    real = logical;
  }

  // Collect all paths to check — logical, real, and their de-prefixed
  // variants for macOS where /etc → /private/etc, /var → /private/var.
  const pathsToCheck = new Set([logical, real]);
  // A host process can be asked to launch a different-platform CLI (notably
  // Windows Claw launching a WSL agent). Preserve the caller's path grammar
  // as an additional validation view instead of letting path.resolve('/etc')
  // reinterpret it as C:\etc on Windows.
  if (isPosixAbsolute) pathsToCheck.add(path.posix.resolve(cwd));
  if (isWindowsAbsolute) pathsToCheck.add(path.win32.resolve(cwd));
  for (const p of [logical, real]) {
    if (p.startsWith('/private/')) {
      pathsToCheck.add(p.slice('/private'.length));
    }
  }

  // Block filesystem root
  for (const check of pathsToCheck) {
    if (check === '/') {
      throw new Error(`Unsafe working directory: ${logical}`);
    }
  }

  // Block system-critical prefixes
  for (const check of pathsToCheck) {
    for (const prefix of BLOCKED_PREFIXES) {
      const normalized = check.replaceAll('\\', '/');
      if (normalized === prefix || normalized.startsWith(prefix + '/')) {
        throw new Error(`Unsafe working directory: ${logical}`);
      }
    }
    const normalizedWindows = check.replaceAll('\\', '/').toLocaleLowerCase();
    for (const prefix of BLOCKED_WINDOWS_PREFIXES) {
      if (
        normalizedWindows === prefix
        || normalizedWindows.startsWith(prefix + '/')
      ) {
        throw new Error(`Unsafe working directory: ${logical}`);
      }
    }
  }

  // Block sensitive home subdirectories
  const home = os.homedir();
  for (const check of pathsToCheck) {
    for (const subdir of BLOCKED_HOME_SUBDIRS) {
      const sensitive = path.join(home, subdir);
      const normalizedCheck = check.replaceAll('\\', '/').toLocaleLowerCase();
      const normalizedSensitive = sensitive.replaceAll('\\', '/').toLocaleLowerCase();
      if (
        normalizedCheck === normalizedSensitive
        || normalizedCheck.startsWith(normalizedSensitive + '/')
      ) {
        throw new Error(`Unsafe working directory: ${logical}`);
      }
    }
  }

  return real;
}

// ─── validateRegex ──────────────────────────────────────────────────────────

/**
 * Compile a user-supplied pattern into an RE2 regex.
 *
 * RE2 runs in linear time and never backtracks, so it is immune to ReDoS
 * patterns like `(a+)+$`. Some PCRE features (lookbehind, backreferences)
 * are not supported and will throw at compile time.
 */
export function validateRegex(pattern: string): RegExp {
  try {
    return new RE2(pattern, 'i');
  } catch (err) {
    throw new Error(`Invalid regex pattern: ${(err as Error).message}`);
  }
}

// ─── validateName ───────────────────────────────────────────────────────────

const VALID_NAME = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate a resource name (agent, skill, rule) to prevent path injection.
 *
 * Only allows alphanumeric characters, hyphens, and underscores.
 * Rejects empty strings, dots, slashes, spaces, and any other characters
 * that could be used for path traversal.
 */
export function validateName(name: string): string {
  if (!name || !VALID_NAME.test(name)) {
    throw new Error(`Invalid name '${name}': must be non-empty and match /^[a-zA-Z0-9_-]+$/`);
  }
  return name;
}
