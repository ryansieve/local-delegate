---
description: Design a feature, split it into tasks for Claude and the local delegate, then execute the plan
argument-hint: <feature to build> | run <plan-slug> | status <plan-slug>
---

# Plan work

Input: $ARGUMENTS

You are the architect. Get as much of the implementation as possible done by the local delegate (free) without lowering quality. Keep design, judgment, and integration for yourself.

Modes:
- **`<feature description>`**: run Phases 0–2, then **stop for my approval**. If I approve in this session ("go", "approved", or with edits), continue to Phase 3.
- **`run <plan-slug>`**: run Phase 3 from the plan's current state. Plans are resumable.
- **`status <plan-slug>`**: summarize the plan's progress and any blockers.

Never commit or push `.delegate/`. Don't push anything unless I ask.

## Phase 0: Setup (first time in a repo)
1. Keep `.delegate/` out of git locally. Never use `.gitignore`, which is a team file:
   ```bash
   f="$(git rev-parse --git-path info/exclude)"; grep -qxF '.delegate/' "$f" || printf '\n.delegate/\n' >> "$f"
   ```
2. Check that the delegate is linked (`git remote get-url delegate`) and reachable (call `list_tasks`). If not, stop and tell me: run `dlg link <repo> delegate`, or check the SSH tunnel.
3. If `.delegate/profile.md` is missing, or out of date with the repo's manifests, create it by reading the repo. Keep it under ~80 lines:
   - Stack, package manager, and repo layout (workspaces, crates).
   - **Fresh-checkout verify commands**: install (lockfile-respecting), typecheck, lint, full test run, and how to scope tests to a path or crate. Run them once to confirm they work, and note any caveats.
   - Test conventions: location, naming, framework, helpers and fixtures to reuse.
   - Patterns to mirror: paths of exemplary modules, by kind.
   - **Claude-only areas**: auth, crypto, migrations, money/ledger math, concurrency, public API contracts, CI/build config, plus anything else risky in this repo. I'll confirm or add to these at approval.
   - The `repo` name for `submit_task`.

## Phase 1: Design
- Read the relevant code. Ask me only questions whose answers would change the design. Otherwise make the call and record it as an assumption.
- Decide the architecture, module boundaries, data model changes, error model, and test strategy.
- Fix the **interfaces between pieces** up front: exact types and signatures. Delegated tasks must code against stable contracts.

## Phase 2: Tasks and routing
Split the work into tasks, each one cohesive change. Route each task:

**delegate**: well-specified, checkable by tests, and local. Examples: new modules behind a defined interface, adapters and mappers, validation, CRUD layers, pure functions, test-backed bug fixes, mechanical migrations or renames, boilerplate. **Size: one behavior, 1–3 files, under ~150 changed lines**, so it fits the default budget of 25 turns / 15 minutes. Prefer more small delegate tasks over fewer large ones; small tasks finish, large ones wander and get stopped. Leave `think` at its default (`auto`) unless a task needs real reasoning the spec can't spell out; then mark it `think: on` in the task details.

**claude**: anything that needs judgment. Examples: shared types and interfaces that other tasks depend on, cross-cutting refactors, Claude-only areas from the profile, ambiguous behavior, code where concurrency, security, or performance is critical, wiring between delegated pieces, final docs.

Rules:
- Shared contracts are Claude tasks and come first. Delegate tasks depend on them.
- Tasks that touch the same file must be ordered via `depends_on`.
- If the delegate's share is small (under ~30% of the work), say so and recommend doing the feature directly instead.

Write `.delegate/plans/<plan-slug>.md`:

```markdown
---
plan: <plan-slug>
branch: <current branch>
start: <HEAD sha at planning time>
status: awaiting-approval   # awaiting-approval | running | blocked | done
created: <YYYY-MM-DD>
---
# <Feature>

## Goal

## Design
Decisions; interfaces (exact types and signatures); data flow; error model.
Assumptions (each flagged so I can correct it).

## Tasks
| id | owner | depends_on | status | summary |
|----|-------|------------|--------|---------|
| t1 | claude | – | pending | Define shared types and errors |
| t2 | delegate | t1 | pending | Implement reverseJournal() |

## Task details
### t2: Implement reverseJournal() (delegate)
- Files:
- Spec: full Goal / Context / Changes / Constraints / Out of scope / Acceptance, ready to submit as written. Context includes the relevant code inline (interfaces, the pattern to mirror, functions it calls), so the delegate doesn't need to explore
- Tests to write: file path and cases
- Verify: [install, typecheck, lint, scoped tests]
- Protected: [test files, plus anything off-limits]
- Think: auto (or `on`, with a one-line reason)

### t1: Define shared types and errors (claude)
- Files, approach, done-when

## Final audit
Feature-level acceptance checklist.

## Log
```

Task status values: `pending`, `in-progress`, `delegated (<slug>)`, `in-review`, `done`, `taken-over`, `blocked`.

**Stop here.** Show me the design summary, the task table, the delegate/Claude split, your assumptions, and (for a new profile) the Claude-only areas. Wait for approval or edits.

## Phase 3: Execute
Set the plan's status to `running`. Confirm HEAD is on the plan's branch; if it isn't, stop.

Repeat until every task is done:
1. **Ready tasks** are `pending` tasks whose dependencies are all `done`.
2. **Start ready delegate tasks first**, so the delegate is never idle. Follow `~/.claude/commands/delegate.md` steps 2–3, using the spec, tests, verify, and protected paths from the plan. Use slug `<plan-slug>-<id>` and mark the task `delegated (<slug>)`. Independent delegate tasks can be queued back to back; the delegate runs them one at a time.
3. **Do ready Claude tasks yourself while delegate tasks run.** Implement each one, run the profile's verify for the affected area, and commit it (one commit per task, with a descriptive message that doesn't mention the plan or `dlg`). Never edit files owned by an in-flight delegate task.
4. **Between your own steps, poll** in-flight tasks with `wait_for_task(timeout_s: 1)` and read the `progress` heartbeat per `delegate.md` step 4. Never cancel for slowness. When one finishes, handle it per `delegate.md` steps 5–6: a `budget`/`context`/`stalled` failure means revise with narrower scope or split the task (add the new task to the plan), not take over. At most 3 review rounds, then take over and mark it `taken-over`. Then mark it `done`.
5. If nothing is ready but tasks are in flight, call `wait_for_task` with the default timeout.
6. After every state change, update the plan file (task status plus a one-line log entry) so `run <plan-slug>` can resume after an interruption.

Stop and ask me only if:
- the design turns out to be wrong in a way that affects other tasks,
- a task needs a Claude-only area that wasn't planned,
- verify is broken for reasons outside the task, or
- the delegate becomes unreachable.

In those cases, set the status to `blocked` and log the reason.

## Phase 4: Final audit
1. Run the profile's full verify on the branch.
2. Review the complete diff from `start` to HEAD against the Goal, the Design, and the Final audit checklist. Pay particular attention to the seams between delegated pieces.
3. Fix small issues directly. For anything larger, add a task and run it.
4. Set the plan's status to `done` and report:
   - what was built, and the commits
   - delegate vs. Claude task counts
   - revisions and takeovers
   - where the delegate struggled, to improve future routing
   - anything I should check before opening the PR

Don't push.
