---
description: Delegate one implementation task to the local model, then review and land it
argument-hint: <what to build> | <plan-slug>#<task-id>
---

# Delegate one task

Input: $ARGUMENTS

You (the frontier model) own the spec, the tests, and the review. The local delegate (MCP server `delegate`) owns implementation. Spend Claude tokens on decisions and review, not on typing code the delegate can write.

Hard rules:
- Delegate traffic stays on the private `delegate` git remote. Never push `dlg/*` refs, `.delegate/`, or plan files to origin. Don't push anything unless I ask.
- Never weaken or edit protected tests to make delegate work pass.
- If the `delegate` MCP tools are unavailable, stop and tell me. Don't quietly do the work yourself.

## 0. Context
- Read `.delegate/profile.md` if it exists. It has this repo's verify commands, test conventions, patterns to mirror, and Claude-only areas. If it's missing, work it out from the repo and suggest `/plan-work` to create it.
- `repo` for submit_task is the basename of `git remote get-url delegate`, without `.git`.
- If the input is `<plan-slug>#<task-id>`, read `.delegate/plans/<plan-slug>.md` and use that task's spec, tests, verify, and protected paths as written. Don't re-plan.
- **Size**: one behavior, 1–3 files, under ~150 changed lines. It should fit in ~20 turns and ~10 minutes; small tasks finish, big ones wander. If the work is bigger, or touches a Claude-only area, say so and stop. Suggest splitting it or doing it yourself.

## 1. Spec
Write the spec as markdown with these sections:
- **Goal**: the behavior that exists when done, in 1–2 sentences.
- **Context**: why this exists, plus the relevant code **inline**: the interfaces and types it uses, the key part of the pattern file to mirror, and the exact functions it calls. The delegate should be able to start writing without exploring the repo; exploration is what bloats context and burns its budget.
- **Changes**: exact files to create or modify, exported signatures and types, and error behavior.
- **Constraints**: no new dependencies unless stated; style rules from the profile.
- **Out of scope**: what must not be touched or refactored.
- **Acceptance**: the tests that must pass, plus typecheck and lint clean.

Make every decision you care about. Anything left open is a guess by a weaker model. Keep the spec focused: include the code it needs, not whole files.

## 2. Tests (the contract)
- Write tests that encode every behavior and edge case that matters, following the profile's test conventions.
- Run them and confirm they fail because the implementation is missing, not because of a mistake in the test.
- Commit them on the current branch with a normal commit.
- Pick a slug: lowercase with hyphens. Under a plan, use `<plan-slug>-<task-id>`; otherwise make it short and descriptive. If submit reports it already exists, append `-2`.
- Run `dlg base <slug>`. The base is HEAD, so everything the task depends on must already be committed.

## 3. Submit
Call `submit_task(repo, slug, spec, verify, protected_paths, max_turns?, max_minutes?)`:
- **verify**: fresh-checkout commands from the profile, in order: install (lockfile-respecting), typecheck, lint, then the tests scoped to this task. The delegate runs every round in a clean checkout with no installed dependencies.
- **protected_paths**: every test file you wrote, plus anything the spec forbids touching.
- **Budget**: leave the defaults (25 turns / 15 minutes) unless the task is unusually small or large. A task that needs much more is too big; split it instead of raising the budget.

## 4. Wait (read the heartbeat; don't guess)
Call `wait_for_task` until `done` is true. Under `/plan-work`, poll with `timeout_s: 1` between your own tasks instead of blocking.

While running, the response includes `progress`: turn/max_turns, elapsed_min/max_minutes, seconds_since_activity, last_tool, files_changed, context_pct, stall_nudges.
- **Never cancel because a task is slow.** One thinking turn can take several minutes, and the daemon enforces the budget and stops stalled or context-exhausted runs itself.
- **Healthy**: the turn number advances between polls, or seconds_since_activity is under ~600.
- **Intervene only if** seconds_since_activity exceeds ~900, or files_changed / last_tool shows the agent working on the wrong thing. Then `cancel_task` and immediately `submit_revision` with specific steering. Its partial work is kept on the branch.

## 5. Review
- Call `get_task_result` and act on `failure`:
  - `null` (succeeded): review as below.
  - `infra` / `internal`: `submit_revision` with "Retry: infrastructure error. Continue from the current branch state." This doesn't count as a review round.
  - `budget` / `context` / `stalled`: the task was too big or the spec too vague. Check `dlg diff <slug> --stat` to see how far it got, then `submit_revision` with the remaining work narrowed to concrete steps and the needed code inline. If the remaining work is still large, split it into a new task instead.
  - `verification`: read the verification output; revise with the specific failures and what correct behavior looks like.
  - `protected`: revise with "Do not modify <paths>; the tests define the contract", plus the actual issue it was working around.
- Run `dlg diff <slug> --stat` first, then `dlg diff <slug>`. For large diffs, limit the full diff to the paths that matter.
- Audit against the spec:
  - every acceptance item
  - correctness and edge cases
  - error handling as specified
  - follows the named pattern
  - no out-of-scope changes and no new dependencies
  - no debug leftovers or dead code
  - clear naming
- If changes are needed, `submit_revision` with numbered items, each giving the file, the current behavior, and the required behavior. If a missing behavior needs a test, include the exact test code and tell the delegate to add it in a new test file. Then return to step 4.
- At most **3 review rounds** (cancel-then-revise steering counts as one). Taking over is the last resort: it spends Claude tokens on exactly the work you meant to offload. If it's still not right after 3 rounds, land what's usable and finish it yourself, and note the takeover in the report.

## 6. Land
- Run `dlg squash <slug>`. Re-run verify locally; re-run install only if the lockfile changed.
- Make any final touch-ups, then commit with a normal descriptive message. Don't mention slugs, `dlg`, or the delegate.
- Run `dlg clean <slug>`.
- Report: slug, review rounds, verdict, what you changed after the delegate, and the delegate's turns, tokens, and duration from the result. Under `/plan-work`, update the plan file instead of writing a long report.
