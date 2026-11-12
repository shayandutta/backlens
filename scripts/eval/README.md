# backlens eval

Does backlens make coding agents better, and at what cost? The same tasks run twice, by Claude
Code headless (`claude -p`), once without backlens and once with it (MCP tools plus the stop
hook). Each run gets a fresh `git worktree` of the app.

```
node scripts/eval/run.mjs scripts/eval/tasks.json --out results.jsonl
```

It spends model tokens: one agent session per task and arm.

## Per run

| Field | From |
|---|---|
| `success` | the task's `check` command exits 0 on the agent's tree |
| `regressions` | routes `backlens diff` finds broken after the agent, against a baseline taken before it started (both arms) |
| `tokens`, `costUsd`, `turns`, `ms` | `claude -p --output-format json` |

## Task fields

| Field | Meaning |
|---|---|
| `id` | name |
| `repo`, `ref` | the app's git repo and the commit to start from |
| `appDir` | where the server lives inside the repo (backlens runs there) |
| `setup` | run once in the worktree (install dependencies) |
| `backlensConfig` | `.backlens/config.json` for the app: which scripts start it and test it |
| `traffic` | a command that uses the app so backlens has requests to replay; gets `APP_PORT` |
| `prompt` | what the agent is asked |
| `check` | success test, run from the worktree root |
| `maxTurns`, `model`, `allowedTools`, `timeoutMin` | agent limits |

## What a fair eval needs (ROADMAP Phase 5)

- **Size:** 20–30 tasks on 3 or more apps.
- **Coverage:** some tasks that tempt breaking a route the agent does not look at (renames, shared helpers), not only perf work.
- **Repeats:** each task repeated (agents vary run to run); report medians and the spread.
- **Publish failures too:** runs where backlens cost more or did not help.

No results are published yet: the harness exists, the runs have not been done.
