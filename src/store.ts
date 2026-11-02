import Database from 'better-sqlite3';
import { config } from './config.js';
import type { RoundRecord, Task, TaskPhase, TaskResult, TaskState, ThinkMode } from './types.js';

interface Row {
  id: string;
  repo: string;
  base_ref: string;
  impl_ref: string;
  spec: string;
  verify_json: string;
  protected_json: string;
  max_turns: number | null;
  max_minutes: number | null;
  think: ThinkMode | null;
  replay_of: string | null;
  state: TaskState;
  phase: TaskPhase | null;
  round: number;
  feedback_json: string;
  history_json: string | null;
  result_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const toTask = (row: Row): Task => ({
  id: row.id,
  repo: row.repo,
  baseRef: row.base_ref,
  implRef: row.impl_ref,
  spec: row.spec,
  verify: JSON.parse(row.verify_json) as string[],
  protectedPaths: JSON.parse(row.protected_json) as string[],
  maxTurns: row.max_turns ?? config.agent.maxTurns,
  maxMinutes: row.max_minutes ?? config.agent.maxMinutes,
  think: row.think ?? config.agent.think,
  replayOf: row.replay_of,
  state: row.state,
  phase: row.phase,
  round: row.round,
  feedback: JSON.parse(row.feedback_json) as string[],
  history: row.history_json ? (JSON.parse(row.history_json) as RoundRecord[]) : [],
  result: row.result_json ? (JSON.parse(row.result_json) as TaskResult) : null,
  error: row.error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export type NewTask = Pick<Task, 'id' | 'repo' | 'baseRef' | 'implRef' | 'spec' | 'verify' | 'protectedPaths' | 'maxTurns' | 'maxMinutes' | 'think'>
  & Partial<Pick<Task, 'replayOf'>>;
export type TaskPatch = Partial<Pick<Task,
  'state' | 'phase' | 'round' | 'feedback' | 'history' | 'result' | 'error' | 'maxTurns' | 'maxMinutes' | 'think'>>;

const now = () => new Date().toISOString();

export class TaskStore {
  readonly #db: Database.Database;

  constructor(path: string) {
    this.#db = new Database(path);
    this.#db.pragma('journal_mode = WAL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id             TEXT PRIMARY KEY,
        repo           TEXT NOT NULL,
        base_ref       TEXT NOT NULL,
        impl_ref       TEXT NOT NULL,
        spec           TEXT NOT NULL,
        verify_json    TEXT NOT NULL,
        protected_json TEXT NOT NULL,
        state          TEXT NOT NULL,
        phase          TEXT,
        round          INTEGER NOT NULL DEFAULT 0,
        feedback_json  TEXT NOT NULL DEFAULT '[]',
        result_json    TEXT,
        error          TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_state_created ON tasks(state, created_at);
    `);
    this.#migrate();
  }

  /** Additive migrations for databases created by earlier versions. */
  #migrate(): void {
    const columns = new Set((this.#db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name));
    const add = (name: string, ddl: string) => { if (!columns.has(name)) this.#db.exec(`ALTER TABLE tasks ADD COLUMN ${ddl}`); };
    add('max_turns', 'max_turns INTEGER');
    add('max_minutes', 'max_minutes INTEGER');
    add('history_json', 'history_json TEXT');
    add('think', 'think TEXT');
    add('replay_of', 'replay_of TEXT');
  }

  create(task: NewTask): Task {
    const ts = now();
    this.#db
      .prepare(
        `INSERT INTO tasks (id, repo, base_ref, impl_ref, spec, verify_json, protected_json, max_turns, max_minutes, think, replay_of, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(task.id, task.repo, task.baseRef, task.implRef, task.spec,
        JSON.stringify(task.verify), JSON.stringify(task.protectedPaths), task.maxTurns, task.maxMinutes,
        task.think, task.replayOf ?? null, ts, ts);
    return this.get(task.id)!;
  }

  get(id: string): Task | undefined {
    const row = this.#db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return row && toTask(row);
  }

  list(limit = 20): Task[] {
    const rows = this.#db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit) as Row[];
    return rows.map(toTask);
  }

  /** Atomically moves the oldest queued task to running. */
  claimNext(): Task | undefined {
    const claim = this.#db.transaction((): Task | undefined => {
      const row = this.#db
        .prepare(`SELECT * FROM tasks WHERE state = 'queued' ORDER BY updated_at ASC LIMIT 1`)
        .get() as Row | undefined;
      if (!row) return undefined;
      this.#db.prepare(`UPDATE tasks SET state = 'running', phase = 'preparing', updated_at = ? WHERE id = ?`)
        .run(now(), row.id);
      return this.get(row.id);
    });
    return claim();
  }

  update(id: string, patch: TaskPatch): Task {
    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => { sets.push(`${column} = ?`); values.push(value); };

    if (patch.state !== undefined) set('state', patch.state);
    if (patch.phase !== undefined) set('phase', patch.phase);
    if (patch.round !== undefined) set('round', patch.round);
    if (patch.maxTurns !== undefined) set('max_turns', patch.maxTurns);
    if (patch.maxMinutes !== undefined) set('max_minutes', patch.maxMinutes);
    if (patch.think !== undefined) set('think', patch.think);
    if (patch.feedback !== undefined) set('feedback_json', JSON.stringify(patch.feedback));
    if (patch.history !== undefined) set('history_json', JSON.stringify(patch.history));
    if (patch.result !== undefined) set('result_json', patch.result && JSON.stringify(patch.result));
    if (patch.error !== undefined) set('error', patch.error);
    set('updated_at', now());

    this.#db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return this.get(id)!;
  }

  /** Tasks left running by a crash or restart go back to the queue. */
  requeueInterrupted(): number {
    return this.#db
      .prepare(`UPDATE tasks SET state = 'queued', phase = NULL, updated_at = ? WHERE state = 'running'`)
      .run(now()).changes;
  }
}
