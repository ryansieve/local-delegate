export const TERMINAL_STATES = ['succeeded', 'failed', 'cancelled'] as const;

export type TaskState = 'queued' | 'running' | (typeof TERMINAL_STATES)[number];
export type TaskPhase = 'preparing' | 'implementing' | 'finalizing';
export type ThinkMode = 'auto' | 'on' | 'off';
export const THINK_MODES = ['auto', 'on', 'off'] as const;

/** Why a run ended without success — tells the reviewer whether to revise, split, or retry. */
export type FailureKind =
  | 'verification' // finished but verify still failing after max attempts
  | 'protected'    // modified a protected path
  | 'budget'       // ran out of turns or minutes
  | 'context'      // context window nearly full
  | 'stalled'      // no file changes despite nudges
  | 'infra'        // model server / request failure
  | 'cancelled'
  | 'internal';

export interface VerifyStep {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

export interface VerifyReport {
  passed: boolean;
  steps: VerifyStep[];
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface TaskResult {
  summary: string;
  failure: FailureKind | null;
  /** Whether model thinking was on for this round. */
  thinking: boolean;
  /** Base commit of the round's worktree; lets replay_task recreate the base after `dlg clean`. */
  baseSha: string;
  verification: VerifyReport | null;
  protectedViolations: string[];
  headSha: string;
  diffStat: string;
  turns: number;
  verifyAttempts: number;
  usage: Usage;
  durationMs: number;
}

/** Compact record of a finished round, kept when a revision starts a new one. */
export interface RoundRecord {
  round: number;
  state: TaskState;
  failure: FailureKind | null;
  error: string | null;
  summary: string;
  turns: number;
  usage: Usage;
  durationMs: number;
  feedback?: string;
}

/** Live heartbeat for a running task (in memory; not persisted). */
export interface Progress {
  startedAt: number;
  turn: number;
  maxTurns: number;
  maxMinutes: number;
  lastActivityAt: number;
  lastTool: string | null;
  filesChanged: string[];
  promptTokens: number;
  contextPct: number;
  outputTokens: number;
  verifyAttempts: number;
  nudges: number;
  thinking: boolean;
}

export interface Task {
  id: string;
  repo: string;
  baseRef: string;
  implRef: string;
  spec: string;
  verify: string[];
  protectedPaths: string[];
  maxTurns: number;
  maxMinutes: number;
  think: ThinkMode;
  /** Set on replays: the task whose spec this one re-runs. */
  replayOf: string | null;
  state: TaskState;
  phase: TaskPhase | null;
  round: number;
  feedback: string[];
  history: RoundRecord[];
  result: TaskResult | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** auto = off for the first attempt (small, well-specified tasks rarely need it), on for revisions. */
export const thinkingFor = (task: Pick<Task, 'think' | 'round'>): boolean =>
  task.think === 'on' || (task.think === 'auto' && task.round > 0);

export const isTerminal = (state: TaskState): boolean =>
  (TERMINAL_STATES as readonly string[]).includes(state);

export const refsFor = (slug: string) => ({
  baseRef: `dlg/${slug}/base`,
  implRef: `dlg/${slug}/impl`,
});
