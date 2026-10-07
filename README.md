# local-delegate

Use a frontier model (Claude Opus/Fable in Claude Code) for planning, design, specs, and review, and delegate the implementation to a local model running on a second Mac. Claude spends tokens on decisions; the local model does the typing, test runs, and iteration for free.

```
Daily driver (Claude Code)                          Delegate Mac (128GB, Ollama + Laguna S 2.1)
  /plan-work  → design, tasks, specs, failing tests
  dlg base     ── git push over SSH ─────────────▶  private bare repo  ~/delegate/repos/<repo>.git
  submit_task  ── MCP over SSH tunnel ───────────▶  daemon: queue → worktree → agent loop → verify → commit
  wait_for_task ◀── heartbeat: turn, files, ctx% ──
  review diff  ◀── git fetch ─────────────────────  dlg/<slug>/impl
  revise / squash → your own commit → your normal PR
```

**How a task runs.** Claude writes a spec (with the relevant code inline) and failing tests, then pushes the base commit. The daemon checks out a fresh worktree and runs the local model in a tool loop (`list_files`, `read_file`, `write_file`, `edit_file`, `search`, `run`, `finish`). When the model calls `finish`, **the daemon runs the verify commands itself** and checks that no protected file changed. The result goes back to Claude for review against the spec. Revisions continue on the same branch.

## Requirements

- **Delegate:** Apple Silicon Mac with 128GB (64GB+ works with smaller models), Homebrew, Node 22+, git (`xcode-select --install`), and the toolchains your repos need (pnpm, cargo, …).
- **Laptop:** macOS, Claude Code, Node not required. Both machines on the same network.

## Setup

### 1. Delegate machine

```bash
git clone <this repo> ~/IdeaProjects/local-delegate
cd ~/IdeaProjects/local-delegate
bin/bootstrap
```

`bin/bootstrap` takes care of the whole server side:
1. Installs Ollama and sets `OLLAMA_CONTEXT_LENGTH`, keep-alive, and the load timeout.
2. Pulls and loads `laguna-s-2.1:nvfp4` (66GB).
3. Runs `bin/setup-delegate`, which:
   - builds the daemon;
   - writes `.env` with a generated token;
   - checks that the model emits tool calls;
   - installs the launchd agent and health-checks it.

Ollama's settings reset on reboot, so re-run `bin/bootstrap` after one; it skips the download. To try another build: `MODEL=laguna-s-2.1:q4_K_M CTX=65536 bin/bootstrap`. Builds over ~90GB also need `sudo sysctl iogpu.wired_limit_mb=118000`.

Then, on the delegate:
- **Remote Login:** System Settings → General → Sharing → Remote Login on. Set "Allow access for" to only your user, and leave "full disk access for remote users" off.
- **No sleep:** `sudo pmset -a disablesleep 1`. A sleeping delegate drops every connection. This keeps it awake even with the lid closed, so it belongs on a desk, plugged in; `sudo pmset -a disablesleep 0` undoes it.
- **Fixed IP:** reserve its IP in your router (DHCP reservation). `setup-delegate` prints the current one.

### 2. Laptop

```bash
git clone <this repo> ~/code/local-delegate
cd ~/code/local-delegate
bin/setup-laptop <delegate-ip> <delegate-user>          # e.g. bin/setup-laptop 10.0.0.66 ryan
```

`bin/setup-laptop` is safe to re-run, for example if the delegate's IP changes. It:
1. Adds an IPv4-pinned `delegate` alias to `~/.ssh/config` and checks key login. If key login fails, it tells you to run `ssh-copy-id delegate`.
2. Installs `dlg` and `dlg-db` to `~/.local/bin`, and `/delegate` and `/plan-work` to `~/.claude/commands`.
3. Installs a launchd **SSH tunnel** from `localhost:7420` to the delegate's `127.0.0.1:7420`.
4. Registers the MCP server at **user scope** with the token, read over SSH.

Restart any open Claude Code sessions afterwards. `claude mcp list` should show `delegate: http://127.0.0.1:7420/mcp ✔ Connected`.

**Lock down SSH once key login works.** On the delegate:

```bash
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' | sudo tee /etc/ssh/sshd_config.d/100-keys-only.conf
```

### 3. Each repo you delegate from

```bash
cd ~/path/to/repo
dlg link <repo-name> delegate
```

This creates the private bare repo on the delegate, adds a `delegate` git remote, and installs a local pre-push guard. The first `/plan-work` in the repo also creates `.delegate/profile.md` (verify commands, conventions, patterns to mirror, areas reserved for Claude) and excludes `.delegate/` via `.git/info/exclude`.

## Daily use

In Claude Code, inside a linked repo, on a feature branch:

```
/plan-work <feature>        design → tasks routed to delegate or Claude → stops for your approval → executes
/plan-work run <slug>       resume a plan
/plan-work status <slug>    progress
/delegate <small change>    one task, outside a plan
```

**Task sizing matters most.** A delegate task should be one behavior, 1–3 files, and under ~150 changed lines, with the relevant code inline in the spec. Tasks this size typically finish in 2–8 minutes on the first verify attempt. Large or vague tasks wander, fill the context, and get stopped by the budget.

**Who handles what:**
- **Claude:** shared types and interfaces (first), cross-cutting changes, security, money, concurrency, wiring between delegated pieces, and the final audit.
- **Delegate:** well-specified, test-backed, local changes.

Claude works on its own tasks while delegate tasks run, polls the heartbeat, reviews each result, and revises (at most 3 rounds) rather than taking over.

| `dlg` command | |
|---|---|
| `dlg link <repo> delegate` | One-time per repo |
| `dlg base <slug>` | Push HEAD as the task's base |
| `dlg diff <slug> [--stat]` / `dlg log <slug>` | Inspect the delegate's work |
| `dlg squash <slug>` | Stage the result on your branch (you commit it) |
| `dlg clean <slug>` | Delete the task's branches on the delegate |
| `dlg list` | Delegate branches still present |
| `dlg watch [slug]` | Live view of turns (default: most recent task) |

| MCP tool | |
|---|---|
| `submit_task(repo, slug, spec, verify[], protected_paths[], max_turns?, max_minutes?)` | Queue a task (defaults: 25 turns / 15 min) |
| `wait_for_task(task_id, timeout_s)` | Long-poll; `progress` heartbeat while running |
| `get_task_result(task_id)` | Result, `failure` kind, verification output, diffstat, usage, round history |
| `submit_revision(task_id, feedback, max_turns?, max_minutes?)` | Continue on the same branch (after review, failure, or cancel) |
| `cancel_task` / `list_tasks` | |

Failure kinds: `verification`, `protected`, `budget`, `context`, `stalled`, `infra`, `cancelled`. Budget, context, and stall failures mean the task needs to be narrowed or split, not taken over.

## Keeping the team's GitHub clean

- **Delegate branches stay private.** They live only on the delegate's bare repo (`dlg/<slug>/{base,impl}`) and as remote-tracking refs on your laptop. No local `dlg/*` branches exist, so `git push origin` can't carry them.
- **Specs and plans stay out of git.** The spec travels over MCP; plans and the profile live in `.delegate/`, which is excluded locally.
- **Your history stays clean.** `dlg squash` stages changes for you to commit in your own words, so the delegate's per-round commits never reach your branch.
- **A push guard backs this up.** The local `pre-push` hook refuses to push `dlg/*` refs anywhere but `delegate`.
- **Nothing lands in team config.** MCP registration and commands are user-scoped, so nothing is added to a repo's `.mcp.json` or `.claude/`.

## Monitoring

```bash
dlg watch                                   # live: turn, tools, tokens in/out, context %, seconds per turn
ssh delegate 'ollama ps'                    # loaded model, memory, context
ssh delegate 'tail -f ~/delegate/daemon.log'
```

Per-task results (SQLite on the delegate):

```bash
ssh delegate 'sqlite3 -header -column ~/delegate/delegate.db' <<'SQL'
select id, state, round,
  json_extract(result_json,'$.failure') as failure,
  json_extract(result_json,'$.turns') as turns,
  json_extract(result_json,'$.usage.promptTokens') as prompt_tok,
  json_extract(result_json,'$.usage.completionTokens') as out_tok,
  round(json_extract(result_json,'$.durationMs')/60000.0,1) as mins
from tasks order by created_at desc limit 20;
SQL
```

`prompt_tok` sums the full prompt re-sent each turn, so it's a context-bloat signal rather than a measure of work. `out_tok` is the real generation work.

**In an IDE database tool:** `dlg-db` copies a consistent read-only snapshot to `~/delegate-db/delegate.db`. Point an SQLite data source at that file, mark it read-only, and reconnect to refresh. To refresh every minute, run it from a launchd agent with `StartInterval` 60.

Per-turn logs live on the delegate at `~/delegate/logs/<slug>.jsonl`.

## Configuration (delegate `.env`)

| Variable | Default | |
|---|---|---|
| `DELEGATE_HOST` / `DELEGATE_PORT` | `127.0.0.1` / `7420` | Keep localhost; the laptop uses the SSH tunnel |
| `MODEL_BASE_URL` / `MODEL_NAME` | Ollama / `laguna-s-2.1:nvfp4` | Any OpenAI-compatible server that emits `tool_calls` |
| `MODEL_CONTEXT_TOKENS` | `131072` | Must match `OLLAMA_CONTEXT_LENGTH` |
| `AGENT_MAX_TURNS` / `AGENT_MAX_MINUTES` | `25` / `15` | Default per-task budget |
| `AGENT_STALL_TURNS` / `AGENT_MAX_NUDGES` | `10` / `2` | Stall detection |
| `AGENT_CONTEXT_WARN` / `AGENT_CONTEXT_STOP` | `0.6` / `0.85` | Context guard |
| `AGENT_TOOL_OUTPUT_CHARS` / `AGENT_READ_FILE_LINES` | `6000` / `200` | Keeps context lean |
| `AGENT_COMMAND_TIMEOUT_MS` | `600000` | Per shell command |
| `CARGO_TARGET_DIR` | unset | Set for Rust repos so rounds share a build cache |

After editing, restart the daemon: `launchctl kickstart -k gui/$(id -u)/local.delegate.daemon`.

## Updating

- **Delegate:** `git pull && bin/setup-delegate`. It rebuilds and restarts the daemon. Run it while no task is running; an interrupted task is requeued.
- **Laptop:** `git pull && bin/setup-laptop <ip> <user>`. Then restart Claude Code sessions.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `claude mcp list`: `EHOSTUNREACH` while `curl` works | macOS Local Network privacy blocks the `claude` binary from LAN addresses. Use the SSH tunnel (`bin/setup-laptop`), so the MCP URL is `127.0.0.1`. |
| `ssh: … Undefined error: 0`, or `dlg link` / `ssh` hangs | The `.local` name resolved to a stale IPv6 link-local address. The alias must use `HostName <ipv4>` and `AddressFamily inet` (`setup-laptop` does this). |
| Everything was working, then `EHOSTUNREACH` / connection refused | The delegate went to sleep. Run `sudo pmset -a disablesleep 1`. The tunnel reconnects on its own. |
| `delegate` MCP failed in an already-open session | MCP servers connect when a session starts. Run `/mcp` → Reconnect, or restart the session. |
| `ssh-copy-id`: `Permission denied (publickey)` | Password logins are already disabled. Remove `/etc/ssh/sshd_config.d/100-keys-only.conf` on the delegate, copy the key, then put the file back. |
| zsh: `parse error near ')'` when pasting commands | zsh doesn't treat `#` as a comment interactively. Paste without comments, or `setopt interactivecomments`. |
| Tasks fail with `budget` / `stalled` / `context` | The task is too big or the spec too vague. Split it, and put the relevant code inline in the spec. |
| Tasks fail on missing dependencies | Each round runs in a fresh checkout. Verify must start with the install step (`pnpm install --frozen-lockfile`, …). |
| `/delegate` appears twice (user + project) | A stale copy is in the repo's `.claude/commands/`. Delete it; the user copy is the current one. |

## Security notes

- **Network:** the daemon listens on localhost only. Access is SSH (key-only) plus a bearer token. The token is stored only in the delegate's `.env` (`chmod 600`) and your user-level Claude config.
- **No sandbox yet:** the agent's `run` tool executes as your user on the delegate, inside the task's worktree. Secrets (`DELEGATE_TOKEN`, `GH_TOKEN`, `SSH_AUTH_SOCK`, …) are stripped from its environment, and the daemon has no GitHub credentials. Don't keep anything on the delegate the agent shouldn't be able to read. Containerized execution is planned.
- **Path checks:** file tools reject paths outside the worktree and writes to protected paths. Protected paths are also enforced after the fact by diffing against the base, which catches edits made through `run`.

## Layout

```
src/index.ts            HTTP server, bearer auth, MCP endpoint (stateless Streamable HTTP)
src/mcp.ts              MCP tools + heartbeat
src/worker.ts           single worker: worktree → harness → commit → protected-path check
src/harness/native.ts   agent loop: tools, budgets, context guard, stall nudges, verification
src/store.ts            SQLite task store (+ migrations)
src/git.ts, verify.ts, shell.ts, config.ts, types.ts
bin/bootstrap           delegate: Ollama + model + setup-delegate
bin/setup-delegate      delegate: build, .env, model probe, launchd agent
bin/start-daemon        launchd entrypoint
bin/setup-laptop        laptop: SSH alias, tools, commands, tunnel, MCP registration
bin/dlg, bin/dlg-db     laptop CLIs
claude/commands/        /plan-work and /delegate for Claude Code
launchd/                daemon LaunchAgent template
```
