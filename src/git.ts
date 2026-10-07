import { execFile } from 'node:child_process';
import { access, appendFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';
import type { Task } from './types.js';

const pexec = promisify(execFile);

const AGENT_IDENTITY = ['-c', 'user.name=delegate', '-c', 'user.email=delegate@localhost', '-c', 'commit.gpgsign=false'];

export const git = async (args: string[], cwd?: string): Promise<string> => {
  const { stdout } = await pexec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return stdout.trim();
};

export const bareRepoPath = (repo: string): string => join(config.reposDir, `${repo}.git`);

export const repoExists = async (repo: string): Promise<boolean> =>
  access(join(bareRepoPath(repo), 'HEAD')).then(() => true, () => false);

export const refExists = async (repo: string, ref: string): Promise<boolean> =>
  git(['--git-dir', bareRepoPath(repo), 'rev-parse', '--verify', '--quiet', `refs/heads/${ref}^{commit}`])
    .then(() => true, () => false);

export interface Workspace {
  dir: string;
  baseSha: string;
}

/**
 * Checks out the impl branch in a fresh worktree of the delegate's private bare repo.
 * Round 0 branches impl from base; later rounds continue from the existing impl branch.
 * Commits land directly in the bare repo — no push, and no credentials for any other remote.
 */
export const prepareWorktree = async (task: Task): Promise<Workspace> => {
  const bare = bareRepoPath(task.repo);
  const dir = join(config.worktreesDir, task.id);

  await rm(dir, { recursive: true, force: true });
  await git(['--git-dir', bare, 'worktree', 'prune']);

  if (await refExists(task.repo, task.implRef)) {
    await git(['--git-dir', bare, 'worktree', 'add', dir, task.implRef]);
  } else {
    await git(['--git-dir', bare, 'worktree', 'add', '-b', task.implRef, dir, task.baseRef]);
  }

  // Keep the daemon's scratch files out of every commit.
  const excludePath = resolve(dir, await git(['rev-parse', '--git-path', 'info/exclude'], dir));
  const existing = await readFile(excludePath, 'utf8').catch(() => '');
  if (!existing.split('\n').includes('.delegate/')) await appendFile(excludePath, '\n.delegate/\n');

  const baseSha = await git(['rev-parse', `refs/heads/${task.baseRef}`], dir);
  return { dir, baseSha };
};

/** Stages everything and commits if there is anything to commit. Returns HEAD. */
export const commitAll = async (dir: string, message: string): Promise<string> => {
  await git(['add', '-A'], dir);
  const status = await git(['status', '--porcelain'], dir);
  if (status) await git([...AGENT_IDENTITY, 'commit', '--no-verify', '-q', '-m', message], dir);
  return git(['rev-parse', 'HEAD'], dir);
};

export const changedPaths = async (dir: string, fromSha: string): Promise<string[]> => {
  const out = await git(['diff', '--name-only', fromSha, 'HEAD'], dir);
  return out ? out.split('\n') : [];
};

export const diffStat = (dir: string, fromSha: string): Promise<string> =>
  git(['diff', '--stat', fromSha, 'HEAD'], dir);

export const removeWorktree = async (repo: string, dir: string): Promise<void> => {
  await git(['--git-dir', bareRepoPath(repo), 'worktree', 'remove', '--force', dir]).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
};
