import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { ensureProjectGitIdentity } from '../council.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('Council Git identity', () => {
  let root: string;
  let repo: string;
  let globalConfig: string;
  let previousGlobalConfig: string | undefined;
  let previousNoSystem: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'council-git-identity-'));
    repo = path.join(root, 'repo');
    globalConfig = path.join(root, 'global.gitconfig');
    fs.mkdirSync(repo);
    fs.writeFileSync(globalConfig, '');
    previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    git(repo, ['init', '-b', 'main']);
  });

  afterEach(() => {
    if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
    if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function setGlobalIdentity(name = 'Patrick Burton', email = 'pburton@example.test'): void {
    git(repo, ['config', '--global', 'user.name', name]);
    git(repo, ['config', '--global', 'user.email', email]);
  }

  it('replaces the legacy Council identity with the user-global identity', async () => {
    setGlobalIdentity();
    git(repo, ['config', '--local', 'user.name', 'Council']);
    git(repo, ['config', '--local', 'user.email', 'council@openclaw']);

    await expect(ensureProjectGitIdentity(repo)).resolves.toEqual({
      name: 'Patrick Burton',
      email: 'pburton@example.test',
    });
    expect(git(repo, ['config', '--local', '--get', 'user.name'])).toBe('Patrick Burton');
    expect(git(repo, ['config', '--local', '--get', 'user.email'])).toBe('pburton@example.test');

    fs.writeFileSync(path.join(repo, 'README.md'), '# identity test\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-m', 'verify repaired identity']);
    expect(git(repo, ['log', '-1', '--format=%an <%ae>|%cn <%ce>'])).toBe(
      'Patrick Burton <pburton@example.test>|Patrick Burton <pburton@example.test>',
    );
  });

  it('repairs a partial legacy override left by an interrupted setup', async () => {
    setGlobalIdentity();
    git(repo, ['config', '--local', 'user.name', 'Project Identity']);
    git(repo, ['config', '--local', 'user.email', 'council@openclaw']);

    await ensureProjectGitIdentity(repo);

    expect(git(repo, ['config', '--local', '--get', 'user.name'])).toBe('Patrick Burton');
    expect(git(repo, ['config', '--local', '--get', 'user.email'])).toBe('pburton@example.test');
  });

  it('repairs the shared identity when Council starts from a linked worktree', async () => {
    setGlobalIdentity();
    git(repo, ['config', '--local', 'user.name', 'Council']);
    git(repo, ['config', '--local', 'user.email', 'council@openclaw']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# linked worktree test\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-m', 'legacy identity commit']);
    const linkedWorktree = path.join(root, 'linked');
    git(repo, ['worktree', 'add', '-b', 'council/TestAgent', linkedWorktree]);

    await ensureProjectGitIdentity(linkedWorktree);

    expect(git(repo, ['config', '--local', '--get', 'user.name'])).toBe('Patrick Burton');
    expect(git(repo, ['config', '--local', '--get', 'user.email'])).toBe('pburton@example.test');
    fs.writeFileSync(path.join(linkedWorktree, 'agent.txt'), 'agent output\n');
    git(linkedWorktree, ['add', 'agent.txt']);
    git(linkedWorktree, ['commit', '-m', 'verify linked identity']);
    expect(git(linkedWorktree, ['log', '-1', '--format=%an <%ae>|%cn <%ce>'])).toBe(
      'Patrick Burton <pburton@example.test>|Patrick Burton <pburton@example.test>',
    );
  });

  it('preserves a legitimate project-local identity', async () => {
    setGlobalIdentity();
    git(repo, ['config', '--local', 'user.name', 'Project Bot']);
    git(repo, ['config', '--local', 'user.email', 'project-bot@example.test']);

    await expect(ensureProjectGitIdentity(repo)).resolves.toEqual({
      name: 'Project Bot',
      email: 'project-bot@example.test',
    });
    expect(git(repo, ['config', '--local', '--get', 'user.name'])).toBe('Project Bot');
    expect(git(repo, ['config', '--local', '--get', 'user.email'])).toBe('project-bot@example.test');
  });

  it('fails without changing the legacy identity when no global fallback exists', async () => {
    git(repo, ['config', '--local', 'user.name', 'Council']);
    git(repo, ['config', '--local', 'user.email', 'council@openclaw']);

    await expect(ensureProjectGitIdentity(repo)).rejects.toThrow('configure global user.name and user.email first');
    expect(git(repo, ['config', '--local', '--get', 'user.name'])).toBe('Council');
    expect(git(repo, ['config', '--local', '--get', 'user.email'])).toBe('council@openclaw');
  });
});
