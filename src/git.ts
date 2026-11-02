import { execFile } from 'node:child_process';
import { access, appendFile, readdir, readFile, rm, stat, utimes } from 'node:fs/promises';
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
const bare = (repo: string, ...args: string[]) => git(['--git-dir', bareRepoPath(repo), ...args]);

export const repoExists = async (repo: string): Promise<boolean> =>
  access(join(bareRepoPath(repo), 'HEAD')).then(() => true, () => false);

export const refExists = async (repo: string, ref: string): Promise<boolean> =>
  bare(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${ref}^{commit}`).then(() => true, () => false);

/** Resolves a branch, or a raw commit sha that may survive in the object store after its branch was deleted. */
export const resolveCommit = async (repo: string, refOrSha: string): Promise<string | undefined> =>
  bare(repo, 'rev-parse', '--verify', '--quiet', `${refOrSha}^{commit}`).then((sha) => sha || undefined, () => undefined);

export const createBranch = (repo: string, ref: string, sha: string): Promise<string> =>
  bare(repo, 'update-ref', `refs/heads/${ref}`, sha);

export interface Workspace {
  dir: string;
  baseSha: string;
  reused: boolean;
}

const isWorktreeOn = async (dir: string, ref: string): Promise<boolean> =>
  git(['symbolic-ref', '--short', 'HEAD'], dir).then((head) => head === ref, () => false);

/**
 * Checks out the impl branch in a worktree of the delegate's private bare repo.
 * Round 0 branches impl from base. Later rounds reuse the task's existing worktree when it's still there,
 * so installed dependencies and build caches survive between rounds; tracked changes are reset to the
 * impl branch and untracked, non-ignored files are cleaned (ignored files like node_modules are kept).
 * Commits land directly in the bare repo — no push, and no credentials for any other remote.
 */
export const prepareWorktree = async (task: Task): Promise<Workspace> => {
  const dir = join(config.worktreesDir, task.id);
  let reused = false;

  if ((await refExists(task.repo, task.implRef)) && (await isWorktreeOn(dir, task.implRef))) {
    await git(['reset', '--hard', '-q', task.implRef], dir);
    await git(['clean', '-fdq'], dir);
    reused = true;
  } else {
    await rm(dir, { recursive: true, force: true });
    await bare(task.repo, 'worktree', 'prune');
    if (await refExists(task.repo, task.implRef)) {
      await bare(task.repo, 'worktree', 'add', dir, task.implRef);
    } else {
      await bare(task.repo, 'worktree', 'add', '-b', task.implRef, dir, task.baseRef);
    }
  }
  const now = new Date();
  await utimes(dir, now, now); // marks the worktree as recently used for cleanup

  // Keep the daemon's scratch files out of every commit.
  const excludePath = resolve(dir, await git(['rev-parse', '--git-path', 'info/exclude'], dir));
  const existing = await readFile(excludePath, 'utf8').catch(() => '');
  if (!existing.split('\n').includes('.delegate/')) await appendFile(excludePath, '\n.delegate/\n');

  const baseSha = await git(['rev-parse', `refs/heads/${task.baseRef}`], dir);
  return { dir, baseSha, reused };
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
  await bare(repo, 'worktree', 'remove', '--force', dir).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
};

/**
 * Removes worktrees unused for longer than the TTL (except `keep`), then prunes every bare repo.
 * Returns the names removed.
 */
export const pruneStaleWorktrees = async (keep?: string): Promise<string[]> => {
  const cutoff = Date.now() - config.agent.worktreeTtlMinutes * 60_000;
  const removed: string[] = [];
  const entries = await readdir(config.worktreesDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keep) continue;
    const dir = join(config.worktreesDir, entry.name);
    const { mtimeMs } = await stat(dir);
    if (mtimeMs >= cutoff) continue;
    await rm(dir, { recursive: true, force: true });
    removed.push(entry.name);
  }
  if (removed.length) {
    const repos = await readdir(config.reposDir).catch(() => [] as string[]);
    for (const name of repos.filter((r) => r.endsWith('.git'))) {
      await git(['--git-dir', join(config.reposDir, name), 'worktree', 'prune']).catch(() => undefined);
    }
  }
  return removed;
};
