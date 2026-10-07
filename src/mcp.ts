import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from './config.js';
import { refExists, repoExists } from './git.js';
import type { TaskStore } from './store.js';
import { isTerminal, refsFor, type RoundRecord, type Task } from './types.js';
import type { Worker } from './worker.js';

const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const fail = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const seconds = (ms: number) => Math.round(ms / 1000);

const budgetSchema = {
  max_turns: z.number().int().min(3).max(200).optional()
    .describe(`Turn budget for this round (default ${config.agent.maxTurns}). Keep tasks small enough to fit.`),
  max_minutes: z.number().int().min(1).max(240).optional()
    .describe(`Wall-clock budget for this round (default ${config.agent.maxMinutes}).`),
};

/** Status plus, while running, a heartbeat Claude can use to tell "working" from "stuck". */
const status = (t: Task, worker: Worker) => {
  const p = t.state === 'running' ? worker.progress(t.id) : undefined;
  const now = Date.now();
  return {
    task_id: t.id, state: t.state, phase: t.phase, round: t.round, done: isTerminal(t.state),
    failure: t.result?.failure ?? null, error: t.error, updated_at: t.updatedAt,
    ...(p && {
      progress: {
        turn: p.turn,
        max_turns: p.maxTurns,
        elapsed_min: Math.round((now - p.startedAt) / 6_000) / 10,
        max_minutes: p.maxMinutes,
        seconds_since_activity: seconds(now - p.lastActivityAt),
        last_tool: p.lastTool,
        files_changed: p.filesChanged,
        context_pct: p.contextPct,
        output_tokens: p.outputTokens,
        verify_attempts: p.verifyAttempts,
        stall_nudges: p.nudges,
      },
    }),
  };
};

const fetchHint = (t: Task) => ({
  diff: `dlg diff ${t.id}`,
  squash_into_current_branch: `dlg squash ${t.id}`,
  watch_live: `dlg watch ${t.id}`,
});

const roundRecord = (t: Task): RoundRecord => ({
  round: t.round,
  state: t.state,
  failure: t.result?.failure ?? null,
  error: t.error,
  summary: t.result?.summary ?? '',
  turns: t.result?.turns ?? 0,
  usage: t.result?.usage ?? { promptTokens: 0, completionTokens: 0 },
  durationMs: t.result?.durationMs ?? 0,
  ...(t.feedback[t.round - 1] !== undefined && { feedback: t.feedback[t.round - 1] }),
});

/** Builds a fresh MCP server per request (stateless Streamable HTTP); state lives in the store. */
export const buildMcpServer = (store: TaskStore, worker: Worker): McpServer => {
  const server = new McpServer({ name: 'delegate', version: '0.2.0' });

  server.registerTool('submit_task', {
    title: 'Submit task to local delegate',
    description:
      'Queue an implementation task for the local model. Before calling, push the base commit (with the failing tests) ' +
      'with `dlg base <slug>`. Keep tasks small (1–3 files, one behavior) so they fit the turn/minute budget. ' +
      'Returns immediately; follow with wait_for_task.',
    inputSchema: {
      repo: z.string().regex(NAME).describe('Repo name on the delegate (the name used with `dlg link`).'),
      slug: z.string().regex(SLUG).describe('Unique task slug; the base must already exist at dlg/<slug>/base.'),
      spec: z.string().min(1).describe('Markdown spec: Goal, Context (with the relevant code inline), Changes, Constraints, Out of scope, Acceptance.'),
      verify: z.array(z.string().min(1)).min(1).describe('Fresh-checkout commands that must all pass: install first, then typecheck, lint, scoped tests.'),
      protected_paths: z.array(z.string()).default([]).describe('Paths the delegate must not change. "dir/" protects a directory.'),
      ...budgetSchema,
    },
  }, async ({ repo, slug, spec, verify, protected_paths, max_turns, max_minutes }) => {
    if (!(await repoExists(repo))) return fail(`Unknown repo "${repo}". Run \`dlg link ${repo} delegate\` on the laptop first.`);
    if (store.get(slug)) return fail(`Task "${slug}" already exists. Use submit_revision to iterate, or pick a new slug.`);
    const refs = refsFor(slug);
    if (!(await refExists(repo, refs.baseRef))) return fail(`Base ref ${refs.baseRef} not found. Run \`dlg base ${slug}\` first.`);
    const task = store.create({
      id: slug, repo, ...refs, spec, verify, protectedPaths: protected_paths,
      maxTurns: max_turns ?? config.agent.maxTurns, maxMinutes: max_minutes ?? config.agent.maxMinutes,
    });
    return json({ ...status(task, worker), base_ref: task.baseRef, impl_ref: task.implRef,
      budget: { max_turns: task.maxTurns, max_minutes: task.maxMinutes } });
  });

  server.registerTool('wait_for_task', {
    title: 'Wait for delegate task',
    description:
      'Long-poll until the task finishes or the timeout elapses; call repeatedly until done is true. While running, ' +
      '`progress` is a heartbeat. The daemon enforces the budget and stops stalled or context-exhausted runs itself, ' +
      'so never cancel just because a task is slow. A single thinking turn can take several minutes. ' +
      'Healthy: turn advancing, or seconds_since_activity under ~600. Consider cancelling only if seconds_since_activity ' +
      'exceeds ~900, or progress shows the agent heading the wrong way; then cancel_task followed by submit_revision with steering.',
    inputSchema: {
      task_id: z.string(),
      timeout_s: z.number().int().min(1).max(600).default(240),
    },
  }, async ({ task_id, timeout_s }) => {
    const deadline = Date.now() + timeout_s * 1_000;
    for (;;) {
      const task = store.get(task_id);
      if (!task) return fail(`No task "${task_id}".`);
      if (isTerminal(task.state) || Date.now() >= deadline) return json(status(task, worker));
      await sleep(2_000);
    }
  });

  server.registerTool('get_task_result', {
    title: 'Get delegate task result',
    description: 'Full result for the latest round (failure kind, summary, verification output, protected-path violations, diffstat, usage), plus a compact history of earlier rounds.',
    inputSchema: { task_id: z.string() },
  }, async ({ task_id }) => {
    const task = store.get(task_id);
    if (!task) return fail(`No task "${task_id}".`);
    return json({ ...status(task, worker), repo: task.repo, base_ref: task.baseRef, impl_ref: task.implRef,
      budget: { max_turns: task.maxTurns, max_minutes: task.maxMinutes },
      result: task.result, history: task.history, next: fetchHint(task) });
  });

  server.registerTool('submit_revision', {
    title: 'Send review feedback to delegate',
    description:
      'Re-queue a finished, failed, or cancelled task with feedback. The delegate continues on the same impl branch, ' +
      'so partial work is kept. Use after review, after a budget/context/stall failure (narrow the scope or point to ' +
      'the exact code), or after cancelling a stuck run. Optionally adjust the budget.',
    inputSchema: {
      task_id: z.string(),
      feedback: z.string().min(1).describe('Specific, actionable steering: files, current behavior, required behavior.'),
      ...budgetSchema,
    },
  }, async ({ task_id, feedback, max_turns, max_minutes }) => {
    const task = store.get(task_id);
    if (!task) return fail(`No task "${task_id}".`);
    if (!isTerminal(task.state)) return fail(`Task is ${task.state}; wait for it to finish (or cancel it) first.`);
    const updated = store.update(task_id, {
      state: 'queued', phase: null, round: task.round + 1, feedback: [...task.feedback, feedback],
      history: [...task.history, roundRecord(task)], result: null, error: null,
      ...(max_turns !== undefined && { maxTurns: max_turns }),
      ...(max_minutes !== undefined && { maxMinutes: max_minutes }),
    });
    return json({ ...status(updated, worker), budget: { max_turns: updated.maxTurns, max_minutes: updated.maxMinutes } });
  });

  server.registerTool('cancel_task', {
    title: 'Cancel delegate task',
    description: 'Cancel a queued or running task. Work so far is committed to the impl branch; follow with submit_revision to steer and continue.',
    inputSchema: { task_id: z.string() },
  }, async ({ task_id }) => {
    const task = store.get(task_id);
    if (!task) return fail(`No task "${task_id}".`);
    if (isTerminal(task.state)) return json(status(task, worker));
    const updated = store.update(task_id, { state: 'cancelled', error: 'cancelled' });
    worker.abort(task_id);
    return json(status(updated, worker));
  });

  server.registerTool('list_tasks', {
    title: 'List delegate tasks',
    description: 'Most recent tasks first.',
    inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
  }, async ({ limit }) => json(store.list(limit).map((t) => ({ ...status(t, worker), repo: t.repo }))));

  return server;
};
