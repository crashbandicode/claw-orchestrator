import * as fs from 'node:fs';

/**
 * Make a rename durable. Linux can fsync the parent directory. Windows
 * returns EPERM for that call, so the file fsync above the rename is the
 * durability Windows can actually provide.
 */
export function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const dirfd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(dirfd);
  } finally {
    fs.closeSync(dirfd);
  }
}
