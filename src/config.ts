import { homedir } from 'node:os';
import { join } from 'node:path';

const str = (key: string, fallback?: string): string => {
  const value = process.env[key] ?? fallback;
  if (value === undefined || value === '') throw new Error(`Missing required env var ${key}`);
  return value;
};

const num = (key: string, fallback: number, integer = true): number => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = integer ? Number.parseInt(raw, 10) : Number(raw);
  if (Number.isNaN(value)) throw new Error(`Env var ${key} must be a number, got "${raw}"`);
  return value;
};
const int = (key: string, fallback: number) => num(key, fallback);
const float = (key: string, fallback: number) => num(key, fallback, false);

const optionalNumber = (key: string): number | undefined => {
  const raw = process.env[key];
  return raw === undefined || raw === '' ? undefined : Number(raw);
};

const home = str('DELEGATE_HOME', join(homedir(), 'delegate'));

export const config = Object.freeze({
  /** Bind to 127.0.0.1 and reach it through an SSH tunnel; avoid 0.0.0.0 on untrusted networks. */
  host: str('DELEGATE_HOST', '127.0.0.1'),
  port: int('DELEGATE_PORT', 7420),
  token: str('DELEGATE_TOKEN'),

  home,
  reposDir: join(home, 'repos'),
  worktreesDir: join(home, 'worktrees'),
  logsDir: join(home, 'logs'),
  dbPath: join(home, 'delegate.db'),

  model: Object.freeze({
    /** Any OpenAI-compatible endpoint with tool calling (Ollama, mlx_lm.server, LM Studio). */
    baseUrl: str('MODEL_BASE_URL', 'http://127.0.0.1:11434/v1'),
    name: str('MODEL_NAME', 'laguna-s-2.1:nvfp4'),
    apiKey: process.env.MODEL_API_KEY ?? 'local',
    maxTokens: int('MODEL_MAX_TOKENS', 32_768),
    /** Must match the server's context window (OLLAMA_CONTEXT_LENGTH); drives the context guard. */
    contextTokens: int('MODEL_CONTEXT_TOKENS', 131_072),
    /** Left unset by default so the server/model card default applies. */
    temperature: optionalNumber('MODEL_TEMPERATURE'),
    /** reasoning_effort sent when thinking is on ("none" is sent when off). Ollama maps it per model. */
    thinkEffort: str('MODEL_THINK_EFFORT', 'high'),
    requestTimeoutMs: int('MODEL_REQUEST_TIMEOUT_MS', 60 * 60_000),
  }),

  agent: Object.freeze({
    /** Defaults for submit_task; Claude can override per task. Small budgets keep tasks small. */
    maxTurns: int('AGENT_MAX_TURNS', 25),
    maxMinutes: int('AGENT_MAX_MINUTES', 15),
    maxVerifyAttempts: int('AGENT_MAX_VERIFY_ATTEMPTS', 4),
    /** Turns without a file write before a "start implementing" nudge; after maxNudges more, the run stops as stalled. */
    stallTurns: int('AGENT_STALL_TURNS', 10),
    maxNudges: int('AGENT_MAX_NUDGES', 2),
    /** Fraction of the context window at which the model is told to wrap up, and at which the run stops. */
    contextWarn: float('AGENT_CONTEXT_WARN', 0.6),
    contextStop: float('AGENT_CONTEXT_STOP', 0.85),
    commandTimeoutMs: int('AGENT_COMMAND_TIMEOUT_MS', 10 * 60_000),
    toolOutputChars: int('AGENT_TOOL_OUTPUT_CHARS', 6_000),
    verifyOutputChars: int('AGENT_VERIFY_OUTPUT_CHARS', 8_000),
    readFileLines: int('AGENT_READ_FILE_LINES', 200),
    /** Default thinking mode: auto = off for the first attempt, on for revision rounds. */
    think: str('AGENT_THINK', 'auto') as 'auto' | 'on' | 'off',
    /** Worktrees (with installed dependencies) are kept between rounds and removed after this long unused. */
    worktreeTtlMinutes: int('AGENT_WORKTREE_TTL_MINUTES', 48 * 60),
    /** Sets npm_config_prefer_offline for agent and verify commands, so installs reuse the local package store. */
    preferOffline: (process.env.AGENT_PREFER_OFFLINE ?? 'true') !== 'false',
  }),
});

export type Config = typeof config;
