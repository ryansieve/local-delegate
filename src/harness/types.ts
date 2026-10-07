import type { FailureKind, Progress, Task, Usage, VerifyReport } from '../types.js';

export interface HarnessInput {
  task: Task;
  /** Worktree root; every path the agent touches resolves inside it. */
  dir: string;
  signal: AbortSignal;
  /** Live heartbeat; the harness mutates it as it works and the MCP layer reads it. */
  progress: Progress;
  log: (event: Record<string, unknown>) => void;
}

export interface HarnessOutput {
  summary: string;
  /** Last verification the harness ran (null if it never got that far). */
  verification: VerifyReport | null;
  turns: number;
  verifyAttempts: number;
  usage: Usage;
}

/**
 * Swappable implementation agent. The native harness talks to an OpenAI-compatible
 * endpoint directly; a CLI-backed harness (pool, OpenCode) can implement the same shape.
 */
export interface Harness {
  readonly name: string;
  run(input: HarnessInput): Promise<HarnessOutput>;
}

export class HarnessError extends Error {
  constructor(message: string, readonly kind: FailureKind, readonly partial: Omit<HarnessOutput, 'summary'>) {
    super(message);
  }
}
