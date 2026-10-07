import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { changedPaths, commitAll, diffStat, prepareWorktree, removeWorktree, type Workspace } from './git.js';
import { type Harness, HarnessError, type HarnessOutput } from './harness/types.js';
import type { TaskStore } from './store.js';
import type { FailureKind, Progress, Task, TaskResult } from './types.js';
import { isProtected } from './verify.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Processes one task at a time: the model server is the bottleneck, and one model at full memory beats two. */
export class Worker {
  #current: { id: string; controller: AbortController; progress: Progress } | null = null;
  #stopped = false;

  constructor(private readonly store: TaskStore, private readonly harness: Harness) {}

  start(): void {
    void this.#loop();
  }

  stop(): void {
    this.#stopped = true;
    this.#current?.controller.abort();
  }

  /** Aborts the task if it is the one running now. */
  abort(id: string): void {
    if (this.#current?.id === id) this.#current.controller.abort();
  }

  /** Live heartbeat for the running task, if `id` is the one running. */
  progress(id: string): Progress | undefined {
    return this.#current?.id === id ? this.#current.progress : undefined;
  }

  async #loop(): Promise<void> {
    while (!this.#stopped) {
      const task = this.store.claimNext();
      if (!task) { await sleep(2_000); continue; }
      await this.#process(task).catch((err: Error) => {
        console.error(`[worker] ${task.id} crashed:`, err);
        this.#finish(task.id, { state: 'failed', error: `internal error: ${err.message}` });
      });
    }
  }

  async #process(task: Task): Promise<void> {
    const controller = new AbortController();
    const started = Date.now();
    const progress: Progress = {
      startedAt: started, turn: 0, maxTurns: task.maxTurns, maxMinutes: task.maxMinutes,
      lastActivityAt: started, lastTool: null, filesChanged: [], promptTokens: 0, contextPct: 0,
      outputTokens: 0, verifyAttempts: 0, nudges: 0,
    };
    this.#current = { id: task.id, controller, progress };
    const logFile = join(config.logsDir, `${task.id}.jsonl`);
    const log = (event: Record<string, unknown>) =>
      appendFileSync(logFile, `${JSON.stringify({ ts: new Date().toISOString(), round: task.round, ...event })}\n`);

    log({ type: 'start', harness: this.harness.name, model: config.model.name, maxTurns: task.maxTurns, maxMinutes: task.maxMinutes });
    console.log(`[worker] ${task.id} round ${task.round} started (budget ${task.maxTurns} turns / ${task.maxMinutes} min)`);

    let workspace: Workspace | undefined;
    try {
      workspace = await prepareWorktree(task);
      this.store.update(task.id, { phase: 'implementing' });

      let output: HarnessOutput;
      let harnessError: { message: string; kind: FailureKind } | null = null;
      try {
        output = await this.harness.run({ task, dir: workspace.dir, signal: controller.signal, progress, log });
      } catch (err) {
        if (!(err instanceof HarnessError)) throw err;
        harnessError = { message: err.message, kind: err.kind };
        output = { summary: '', ...err.partial };
      }

      // Commit whatever exists, pass or fail: the reviewer (and the next round) builds on partial work.
      this.store.update(task.id, { phase: 'finalizing' });
      const headSha = await commitAll(workspace.dir, `delegate(${task.id}): round ${task.round}`);
      const violations = (await changedPaths(workspace.dir, workspace.baseSha)).filter((p) => isProtected(p, task.protectedPaths));

      const [failure, error]: [FailureKind | null, string | null] =
        controller.signal.aborted ? ['cancelled', 'cancelled']
        : harnessError ? [harnessError.kind, harnessError.message]
        : violations.length ? ['protected', `modified protected paths: ${violations.join(', ')}`]
        : output.verification?.passed ? [null, null]
        : ['verification', 'verification did not pass'];

      const result: TaskResult = {
        summary: output.summary,
        failure,
        verification: output.verification,
        protectedViolations: violations,
        headSha,
        diffStat: await diffStat(workspace.dir, workspace.baseSha),
        turns: output.turns,
        verifyAttempts: output.verifyAttempts,
        usage: output.usage,
        durationMs: Date.now() - started,
      };

      this.#finish(task.id, { state: error ? 'failed' : 'succeeded', result, error });
      log({ type: 'end', state: error ? 'failed' : 'succeeded', failure, error, headSha, usage: output.usage, turns: output.turns });
      console.log(`[worker] ${task.id} round ${task.round} ${error ? `failed (${failure}): ${error}` : 'succeeded'}`);
    } finally {
      if (workspace) await removeWorktree(task.repo, workspace.dir);
      this.#current = null;
    }
  }

  /** Final state write that never overwrites a cancellation made while the task was running. */
  #finish(id: string, patch: Pick<Task, 'state'> & Partial<Pick<Task, 'result' | 'error'>>): void {
    const current = this.store.get(id);
    const state = current?.state === 'cancelled' ? 'cancelled' : patch.state;
    this.store.update(id, { ...patch, state, phase: null });
  }
}
