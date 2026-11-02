import { spawn } from 'node:child_process';
import { config } from './config.js';

/** Secrets the agent's commands should never see. */
const SCRUBBED_ENV = ['DELEGATE_TOKEN', 'MODEL_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'GIT_ASKPASS', 'SSH_AUTH_SOCK'];

const childEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1', GIT_TERMINAL_PROMPT: '0', FORCE_COLOR: '0', NO_COLOR: '1' };
  for (const key of SCRUBBED_ENV) delete env[key];
  if (config.agent.preferOffline) env.npm_config_prefer_offline ??= 'true';
  return env;
};

/** Keeps the head and tail of long output, which is where errors and summaries live. */
export const truncate = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n… [${text.length - max} chars truncated] …\n\n${text.slice(-half)}`;
};

export interface ShellResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

/**
 * Runs a command through a login shell (so nvm/cargo/pnpm are on PATH even under launchd),
 * in its own process group so a timeout kills the whole tree.
 */
export const runShell = (command: string, cwd: string, timeoutMs: number, maxChars: number, signal?: AbortSignal) =>
  new Promise<ShellResult>((resolve) => {
    const started = Date.now();
    const child = spawn('bash', ['-lc', command], { cwd, env: childEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks: string[] = [];
    let size = 0;
    const capture = (buf: Buffer) => {
      // Bound memory: keep at most ~4x the reported size, truncate at the end.
      if (size > maxChars * 4) chunks.splice(1, 1);
      chunks.push(buf.toString('utf8'));
      size += buf.length;
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    let timedOut = false;
    const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });

    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      resolve({ exitCode, timedOut, durationMs: Date.now() - started, output: truncate(chunks.join(''), maxChars) });
    };
    child.on('close', (code) => finish(code));
    child.on('error', (err) => { chunks.push(String(err)); finish(null); });
  });
