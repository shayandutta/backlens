# What backlens does today (v0.5.0)

An inventory of every feature and capability in the code, with where it lives. "Known gaps" are
problems seen in real use (see WORKLOG.md), not wishes.

## 1. Recording (inside the app)

`src/recorder/`, loaded with `NODE_OPTIONS=--require backlens/register`. No code changes.

| Capability | Detail |
|---|---|
| One trace per incoming request | Any framework on Node's `http`/`https` server: express, fastify, Nest, Next.js route handlers, plain `node:http` |
| Route templates | express `req.route`, fastify `onRoute`/`onRequest`; otherwise ids in paths become `:id` |
| Registered routes | fastify routes are reported up front, so never-called routes are listed |
| Postgres | `pg` Client and Pool: drizzle, Kysely, knex, raw SQL, Prisma 7 / driver adapters |
| Prisma 5 and 6 (Rust engine) | through Prisma's tracing hook, with the app's call site kept across lazy, batched promises |
| Redis | ioredis; node-redis v4 and v5 (pipelines and MULTI included) |
| Outgoing HTTP | `http`/`https` (axios, got, node-fetch, SDKs) and global `fetch` |
| Call site per call | first app frames, skipping node, `node_modules`, generated Prisma clients and backlens; source-mapped (TypeScript, Next.js chunks); query-wrapper helpers skipped |
| Dependency fingerprints | short hashes of each parameter and returned value, so "B used A's result" is detectable without values |
| Replay payload | method, url, headers and body (≤ 64 KB) kept in dashboard memory only, for replays |
| Index advisor | `EXPLAIN (GENERIC_PLAN)` on each distinct SELECT (Postgres 16+, never runs the query); flags sequential scans filtered on columns no index starts with, including the ORDER BY columns worth adding |
| Index create / drop | from the dashboard, through the app's own pool, from checked identifiers only; checks the plan can use it |
| Privacy | values hashed; emails, IPs, UUIDs and long numbers masked in Redis keys; `AUTH`/`HELLO`/`ACL`/`CONFIG`/`MIGRATE` shown by name only |
| Safety | off unless started by backlens; installed once; every patch swallows its own errors; framework assets (`/_next/`, Vite, favicons, source maps) ignored |

## 2. Analysis (pure)

`src/analysis/`

| Check | Fires when | Severity |
|---|---|---|
| N+1 | one statement ran ≥ 3 times with ≥ 3 different values in a request | warn |
| Repeat | same statement (or Redis read) with the same values twice; grouped by where the code paths part | warn |
| Serial | ≥ 2 reads from one function awaited back to back, not overlapping, no write between, no data dependency, same kind (cache-then-DB is left alone) | hint |
| Missing index | advisor flagged a full-table read; warn at ≥ 1000 rows, hint below | warn / hint |

Also: per-route calls, p50, p95, queries/Redis/HTTP per request, 5xx count; a map of routes →
tables, Redis key groups and outside hosts, with real problems drawn on the wires; issues hidden
after a kept fix until a request on the new code shows them again.

## 3. Dashboard

`src/dashboard/`, `npx backlens` → `127.0.0.1:7777` (or the next free port).

- Tabs: Map, Routes, Issues (Explain, Suggest fix, example request), Requests (waterfall with code
  per call), Tests, Compare (named snapshots per route), Agents (cost of Claude Code prompts).
- Runs the app from a chosen `package.json` script (or `-- <command>`); start, stop, restart,
  live logs; optional restart on file change.
- Runs the test script with recording on; accepts issues into the baseline.
- Access: host, origin and session-token checks; only package.json scripts by name.

## 4. Fixes with proof

`src/ai/`

| Step | Detail |
|---|---|
| Context | only the enclosing functions of each call site, plus the table definitions (drizzle, Prisma); secrets masked; `.env`, `node_modules` never read; preview of exactly what is sent |
| Routing | Promise.all rewrite and indexes need no model; else mock, local Ollama model, or Claude (Haiku explains; Sonnet or Opus fixes by difficulty and past pass rate; one step up after a failed check) |
| Edit safety | edits only to lines the model was shown, no overlaps, no no-ops; renumbered edits detected and explained back; up to 2 repair rounds |
| Apply | exact backup of each file (uncommitted changes included) |
| Verify | typecheck (errors sent back, up to 2 rounds) → build if the app runs built output → restart → 3 warm-up + 5 measured replays → issue gone and same status class → tests pass and issue gone from test traffic |
| Verdict | proven / unverified (nothing could check it) / failed; Keep or Revert (never overwrites later edits); escalate once to a stronger model |
| Cost control | estimate before sending; daily budget (default $1); usage and history logs per project |
| Keys | Claude key tested for free, stored in `~/.config/backlens` (mode 600), never sent to the browser |
| Local models | Ollama detection, size recommendation by RAM, download with progress |

## 5. MCP server for agents

`src/mcp/`, `backlens mcp` over stdio. Finds the running dashboard through
`.backlens/session.json` (this folder, above, or up to 3 below).

| Tool | What the agent gets |
|---|---|
| `status` | recording?, app state, traffic and issue counts |
| `list_issues` | issues worst first with route, `file:line`, statements, fix, example; falls back to the last test run |
| `list_routes`, `list_requests` | route stats; recent requests with ids |
| `get_request` | waterfall of one request with code per call |
| `measure_request` | replay a recorded GET with its headers (works for signed-in routes); warm-up + median; issues still present |
| `measure_url` | plain GET to a path, no headers |
| `app_logs`, `restart_app`, `run_tests` | app output; restart and wait for the port; tests with their issues |
| `usage` | tokens / dollars / plan-limit share of this prompt, session, 30 days; estimate of source an agent would have read instead |

## 6. CI

`backlens test -- <test command>`: records test traffic (supertest, fetch), prints the report,
exits 1 on a new warning (`--strict`: on new hints too); `--update-baseline`, `--baseline`,
`--json` for artifacts. Baseline keys ignore line numbers.

## 7. Agent cost tracking

`src/agent-usage/`, `src/statusline/`: reads Claude Code's own session logs (counts and tool names
only, never prompts or code) for prompts that called backlens, including subagents; API-price
dollars or, on a Claude plan, the share of the 5-hour and weekly limits through a status line
wrapper that keeps the user's own status line running.

## Known gaps (seen in real use, 2026-11-10)

1. `measure_request` compares a warm median against the single cold recorded request, so headline
   percentages overstate (−91% and −82% shown; real gains were −5% and −23%).
2. Serial-await "ms lost" estimates come from cold test traffic and overstate the real gain.
3. Index hints fire on tiny tables, and on a column when the filter is already served by another
   index's leading column (e.g. a primary key on `user_id`).
4. `status` reports the MCP server's version, not the recorder's; a mismatch is invisible.
5. Unpinned `npx -y backlens mcp` keeps reusing a cached older version.
6. Requests recorded from tests cannot be replayed, and `measure_url` cannot send headers, so
   signed-in routes need a manual login to get something measurable.
7. No replay of writes (POST/PUT/DELETE) except by opt-in, which changes the dev database.
8. Postgres only for the index advisor (16+); no mysql2 or MongoDB; macOS-tested.
