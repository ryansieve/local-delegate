import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { Agent, fetch } from 'undici';
import { config } from '../config.js';
import { git } from '../git.js';
import { runShell } from '../shell.js';
import type { FailureKind, Task, Usage, VerifyReport } from '../types.js';
import { formatReport, isProtected, runVerify } from '../verify.js';
import { type Harness, HarnessError, type HarnessInput, type HarnessOutput } from './types.js';

// ---------- OpenAI-compatible wire types (just what we use) ----------

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ChatResponse {
  choices: { message: { content: string | null; tool_calls?: ToolCall[] }; finish_reason: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// ---------- Tool definitions ----------

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } }) as const;

const TOOLS = [
  fn('list_files', 'List tracked and untracked (non-ignored) files, optionally under a directory.', {
    path: { type: 'string', description: 'Directory prefix relative to the repo root. Omit for all files.' },
  }, []),
  fn('read_file', 'Read a text file with line numbers.', {
    path: { type: 'string' },
    offset: { type: 'integer', description: '1-based first line to return.' },
    limit: { type: 'integer', description: 'Maximum lines to return (default 400).' },
  }, ['path']),
  fn('write_file', 'Create or overwrite a file with the full content given.', {
    path: { type: 'string' }, content: { type: 'string' },
  }, ['path', 'content']),
  fn('edit_file', 'Replace an exact string in a file. old_string must match exactly once unless replace_all is true.', {
    path: { type: 'string' },
    old_string: { type: 'string' },
    new_string: { type: 'string' },
    replace_all: { type: 'boolean' },
  }, ['path', 'old_string', 'new_string']),
  fn('search', 'Search file contents with an extended regular expression (git grep).', {
    pattern: { type: 'string' },
    path: { type: 'string', description: 'Optional path or directory to limit the search.' },
  }, ['pattern']),
  fn('run', 'Run a shell command at the repo root. Use for builds, tests, and inspection.', {
    command: { type: 'string' },
    timeout_s: { type: 'integer', description: 'Defaults to the daemon command timeout.' },
  }, ['command']),
  fn('finish', 'Call when the work is complete. The daemon then runs the verification commands; if they fail you will get the output and should keep working.', {
    summary: { type: 'string', description: 'What you changed, decisions you made, and any concerns for the reviewer.' },
  }, ['summary']),
];

// ---------- Prompts ----------

const systemPrompt = (task: Task) => `You are an implementation agent working in a git worktree of a Node/TypeScript/Rust codebase.
A senior engineer wrote the specification and the tests. Your job is to implement the specification so that every verification command passes.

Rules:
- Stay within the scope of the specification. Do not refactor unrelated code or add dependencies unless the spec allows it.
- Never modify protected paths. If a protected test looks wrong, do not change it; explain the problem in your finish summary.
- Read the relevant code before editing. Prefer small, targeted edits with edit_file.
- Run the verification commands yourself with the run tool before calling finish. Do not declare success without evidence.
- Do not commit; the daemon commits your work.
- All paths are relative to the repo root.
- The specification includes the code context you need. Don't explore the whole repo; read only what the spec points to, then implement.
- Budget: ${task.maxTurns} turns and ${task.maxMinutes} minutes. Aim to finish well within it. Read output efficiently (use offset/limit, targeted search).

Verification commands (run in order; all must pass):
${task.verify.map((c) => `  $ ${c}`).join('\n')}

Protected paths (read-only for you):
${task.protectedPaths.length ? task.protectedPaths.map((p) => `  - ${p}`).join('\n') : '  (none)'}`;

const userPrompt = (task: Task) => {
  const spec = `# Specification\n\n${task.spec}`;
  if (task.round === 0) return spec;
  const feedback = task.feedback.at(-1) ?? '';
  return `${spec}\n\n# Revision round ${task.round}\n\nThe branch already contains your previous work. A reviewer read the diff and asked for these changes:\n\n${feedback}\n\nAddress every point, then re-run verification and call finish.`;
};

// ---------- Harness ----------

/** Keeps log lines readable: long string args (file contents) are summarized. */
const compactArgs = (args: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(args).map(([k, v]) =>
    [k, typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}… (${v.length} chars)` : v]));

const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 }); // long thinking passes can exceed undici's 5 min defaults
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class NativeHarness implements Harness {
  readonly name = 'native';

  async run({ task, dir, signal, progress, log }: HarnessInput): Promise<HarnessOutput> {
    const { agent, model } = config;
    const messages: Message[] = [
      { role: 'system', content: systemPrompt(task) },
      { role: 'user', content: userPrompt(task) },
    ];
    const usage: Usage = { promptTokens: 0, completionTokens: 0 };
    const deadline = progress.startedAt + task.maxMinutes * 60_000;
    let verification: VerifyReport | null = null;
    let verifyAttempts = 0;
    let idleTurns = 0;
    let lastWriteTurn = 0;
    let warnedContext = false;
    let warnedBudget = false;
    const partial = (turns: number) => ({ verification, turns, verifyAttempts, usage });
    const touch = (tool: string | null) => { progress.lastActivityAt = Date.now(); if (tool) progress.lastTool = tool; };
    const stop = (message: string, kind: FailureKind, turns: number): never => {
      log({ type: 'guard', kind, message });
      throw new HarnessError(message, kind, partial(turns));
    };

    for (let turn = 1; turn <= task.maxTurns; turn++) {
      if (signal.aborted) throw new HarnessError('cancelled', 'cancelled', partial(turn - 1));
      if (Date.now() > deadline) stop(`budget exhausted: ${task.maxMinutes} minutes`, 'budget', turn - 1);
      progress.turn = turn;

      const started = Date.now();
      let response: ChatResponse;
      try {
        response = await this.#chat(messages, signal);
      } catch (err) {
        if (signal.aborted) throw new HarnessError('cancelled', 'cancelled', partial(turn - 1));
        throw new HarnessError(`model request failed: ${(err as Error).message}`, 'infra', partial(turn - 1));
      }
      const promptTokens = response.usage?.prompt_tokens ?? 0;
      const completionTokens = response.usage?.completion_tokens ?? 0;
      usage.promptTokens += promptTokens;
      usage.completionTokens += completionTokens;
      progress.promptTokens = promptTokens;
      progress.contextPct = Math.round((promptTokens / model.contextTokens) * 100);
      progress.outputTokens = usage.completionTokens;
      touch(null);

      const message = response.choices[0]?.message;
      if (!message) throw new HarnessError('model returned no choices', 'infra', partial(turn));
      const calls = message.tool_calls ?? [];
      messages.push({ role: 'assistant', content: message.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) });
      log({ type: 'assistant', turn, ms: Date.now() - started, promptTokens, completionTokens,
        contextPct: progress.contextPct, content: message.content, toolCalls: calls.map((c) => c.function) });

      // Context guard: stop cleanly before the server starts truncating the prompt.
      if (promptTokens >= model.contextTokens * agent.contextStop) {
        stop(`context exhausted: ${progress.contextPct}% of ${model.contextTokens} tokens`, 'context', turn);
      }

      if (!calls.length) {
        if (++idleTurns > 3) throw new HarnessError('model stopped calling tools without finishing', 'stalled', partial(turn));
        messages.push({ role: 'user', content: 'Continue the work using the tools. Call finish when verification passes.' });
        continue;
      }
      idleTurns = 0;

      for (const call of calls) {
        const name = call.function.name;
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          messages.push({ role: 'tool', tool_call_id: call.id, content: 'Error: arguments were not valid JSON. Retry with valid JSON.' });
          continue;
        }
        touch(name);

        if (name === 'finish') {
          verifyAttempts++;
          progress.verifyAttempts = verifyAttempts;
          verification = await runVerify(task.verify, dir, signal);
          touch('verify');
          log({ type: 'verify', attempt: verifyAttempts, passed: verification.passed });
          const summary = String(args.summary ?? '');
          if (verification.passed) return { summary, ...partial(turn) };
          if (verifyAttempts >= agent.maxVerifyAttempts) {
            return { summary: `${summary}\n\n[delegate] verification still failing after ${verifyAttempts} attempts`, ...partial(turn) };
          }
          messages.push({
            role: 'tool', tool_call_id: call.id,
            content: `Verification FAILED (attempt ${verifyAttempts}/${agent.maxVerifyAttempts}). Keep working.\n\n${formatReport(verification)}`,
          });
          continue;
        }

        const output = await this.#execute(name, args, task, dir, signal).catch((err: Error) => `Error: ${err.message}`);
        touch(name);
        if ((name === 'write_file' || name === 'edit_file') && !output.startsWith('Error')) {
          lastWriteTurn = turn;
          const path = String(args.path ?? '');
          if (path && !progress.filesChanged.includes(path)) progress.filesChanged.push(path);
        }
        log({ type: 'tool', turn, name, args: compactArgs(args), output: output.slice(0, 2_000) });
        messages.push({ role: 'tool', tool_call_id: call.id, content: output.length > agent.toolOutputChars
          ? `${output.slice(0, agent.toolOutputChars)}\n… [truncated; read a narrower range]` : output });
      }

      // Steering notes, combined into one message after this turn's tool results.
      const notes: string[] = [];
      if (!warnedContext && promptTokens >= model.contextTokens * agent.contextWarn) {
        warnedContext = true;
        notes.push(`Context is ${progress.contextPct}% full. Stop exploring. Implement the remaining changes now, run verification, and call finish.`);
      }
      const turnsLeft = task.maxTurns - turn;
      const minutesLeft = (deadline - Date.now()) / 60_000;
      if (!warnedBudget && (turnsLeft <= 3 || minutesLeft <= task.maxMinutes * 0.2)) {
        warnedBudget = true;
        notes.push(`Budget almost used (${turnsLeft} turns, ~${Math.max(0, Math.round(minutesLeft))} min left). Finish now: run verification and call finish, summarizing what's done and what's left.`);
      }
      if (turn - lastWriteTurn >= agent.stallTurns) {
        if (progress.nudges >= agent.maxNudges) {
          stop(`stalled: no file changes in ${agent.stallTurns} turns after ${progress.nudges} nudges`, 'stalled', turn);
        }
        progress.nudges++;
        lastWriteTurn = turn; // restart the stall window
        notes.push(`You've made no file changes in ${agent.stallTurns} turns. You have enough context: start implementing now with write_file/edit_file.`);
        log({ type: 'nudge', turn, reason: 'stall' });
      }
      if (notes.length) messages.push({ role: 'user', content: notes.join('\n\n') });
    }
    return stop(`budget exhausted: ${task.maxTurns} turns`, 'budget', task.maxTurns);
  }

  async #chat(messages: Message[], signal: AbortSignal): Promise<ChatResponse> {
    const { baseUrl, name, apiKey, maxTokens, temperature, requestTimeoutMs } = config.model;
    const body = JSON.stringify({
      model: name, messages, tools: TOOLS, tool_choice: 'auto', max_tokens: maxTokens,
      ...(temperature === undefined ? {} : { temperature }),
    });

    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST', dispatcher, body,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
        });
        if (res.ok) return (await res.json()) as ChatResponse;
        const text = await res.text();
        if (res.status < 500 || attempt >= 3) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
      } catch (err) {
        if (signal.aborted || attempt >= 3) throw err;
      }
      await sleep(5_000 * attempt);
    }
  }

  async #execute(name: string, args: Record<string, unknown>, task: Task, dir: string, signal: AbortSignal): Promise<string> {
    const inside = (p: unknown): string => {
      const abs = resolve(dir, String(p ?? '.'));
      if (abs !== dir && !abs.startsWith(dir + sep)) throw new Error(`path escapes the repo: ${String(p)}`);
      return abs;
    };
    const writable = (p: unknown): string => {
      const abs = inside(p);
      const rel = relative(dir, abs);
      if (rel === '.git' || rel.startsWith(`.git${sep}`) || rel.startsWith(`.delegate${sep}`)) throw new Error(`cannot write to ${rel}`);
      if (isProtected(rel, task.protectedPaths)) throw new Error(`${rel} is protected; do not modify it. Explain any issue with it in your finish summary.`);
      return abs;
    };

    switch (name) {
      case 'list_files': {
        const prefix = args.path ? relative(dir, inside(args.path)) : '';
        const out = await git(['ls-files', '--cached', '--others', '--exclude-standard', ...(prefix ? ['--', prefix] : [])], dir);
        return out || '(no files)';
      }
      case 'read_file': {
        const lines = (await readFile(inside(args.path), 'utf8')).split('\n');
        const offset = Math.max(1, Number(args.offset ?? 1));
        const limit = Math.max(1, Number(args.limit ?? config.agent.readFileLines));
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const more = offset - 1 + limit < lines.length ? `\n… (${lines.length} lines total; use offset to read more)` : '';
        return slice.map((line, i) => `${String(offset + i).padStart(5)}  ${line}`).join('\n') + more;
      }
      case 'write_file': {
        const abs = writable(args.path);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, String(args.content ?? ''));
        return `Wrote ${relative(dir, abs)}`;
      }
      case 'edit_file': {
        const abs = writable(args.path);
        const text = await readFile(abs, 'utf8');
        const oldString = String(args.old_string ?? '');
        if (!oldString) throw new Error('old_string must not be empty');
        const count = text.split(oldString).length - 1;
        if (count === 0) throw new Error('old_string not found; read the file and copy the text exactly');
        if (count > 1 && !args.replace_all) throw new Error(`old_string matches ${count} times; add surrounding context or set replace_all`);
        const newString = String(args.new_string ?? '');
        await writeFile(abs, args.replace_all ? text.split(oldString).join(newString) : text.replace(oldString, () => newString));
        return `Edited ${relative(dir, abs)} (${args.replace_all ? count : 1} replacement${count > 1 && args.replace_all ? 's' : ''})`;
      }
      case 'search': {
        const scope = args.path ? ['--', relative(dir, inside(args.path))] : [];
        return git(['grep', '-n', '-I', '--untracked', '-E', '-e', String(args.pattern ?? ''), ...scope], dir)
          .then((out) => out || '(no matches)', () => '(no matches)');
      }
      case 'run': {
        const timeoutMs = args.timeout_s ? Number(args.timeout_s) * 1_000 : config.agent.commandTimeoutMs;
        const r = await runShell(String(args.command ?? ''), dir, Math.min(timeoutMs, config.agent.commandTimeoutMs), config.agent.toolOutputChars, signal);
        return `[exit ${r.timedOut ? 'timeout' : r.exitCode}, ${Math.round(r.durationMs / 1000)}s]\n${r.output}`;
      }
      default:
        throw new Error(`unknown tool ${name}`);
    }
  }
}
