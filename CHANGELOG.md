# Changelog

## 0.3.0: thinking control, real time budgets, faster rounds

- **Thinking control.** `think` on `submit_task`, `submit_revision`, and `replay_task` (`auto` | `on` | `off`, default `auto`): off for a task's first attempt, on for revisions. Sent as `reasoning_effort` (`none` when off). Results and the heartbeat report whether thinking was on.
- **Time budget enforced mid-turn.** The model request is cut off at the deadline (`failure: "budget"`, "stopped mid-turn"), and shell commands are capped at the time remaining. Previously a single long thinking turn could run far past the budget.
- **Worktrees kept between rounds**, so revisions reuse installed dependencies and build output. Stale worktrees are removed after 48 hours. Installs default to `npm_config_prefer_offline=true`.
- **`replay_task`** re-runs a past task's spec from its original base under a new slug with different settings, for side-by-side comparison. It still works after `dlg clean` (results record `baseSha`).
- **`/delegate` refuses whole tickets** and points to `/plan-work`. Both commands now include thinking guidance.
- README: health-check section, failure patterns, new settings.

## 0.2.0: heartbeat and budgets

**Daemon**
- `wait_for_task` returns a `progress` heartbeat while a task runs: turn, budget, seconds since last activity, last tool, files changed, context %, output tokens, and stall nudges. Its description tells Claude not to cancel slow tasks.
- Per-task budgets: `submit_task` and `submit_revision` accept `max_turns` and `max_minutes` (defaults 25 / 15). The model is warned near the end, then the run stops with `failure: "budget"`.
- Context guard: the model is warned at 60% of the context window, and the run stops at 85% with `failure: "context"`, before the server would silently truncate.
- Stall detection: a nudge after 10 turns with no file changes; after 2 nudges, the run stops with `failure: "stalled"`.
- Every result has a `failure` kind (`verification`, `protected`, `budget`, `context`, `stalled`, `infra`, `cancelled`).
- Cancelled or failed tasks continue with `submit_revision` on the same branch. Earlier rounds are kept in `history`.
- Smaller tool output (6k chars, 200-line reads by default) and per-turn tokens and timing in the JSONL log.
- Additive database migration; existing tasks are kept.

**Setup**
- `bin/bootstrap`: Ollama install, configuration, model pull, and delegate setup in one command.
- `bin/setup-laptop`: SSH alias (IPv4), key check, tools and commands install, launchd SSH tunnel, and MCP registration.
- The daemon binds to `127.0.0.1` by default; the laptop connects through the SSH tunnel.
- `bin/dlg-db`: read-only database snapshot for IDE database tools.

**Laptop**
- `dlg watch [slug]`: a live one-line-per-event view of a task.
- `dlg link` uses `ssh -n`, so it no longer hangs.
- `/delegate` and `/plan-work`: smaller tasks (1–3 files, about 150 lines), relevant code inline in specs, heartbeat-based cancel/revise rules, and per-failure-kind handling.

## 0.1.0

First version: SQLite queue, native agent harness against an OpenAI-compatible endpoint, independent verification, protected paths, private git remote via `dlg`, and the `/delegate` command.
