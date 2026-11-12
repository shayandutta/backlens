# What backlens does (v0.6.0)

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
| Index advisor | `EXPLAIN (GENERIC_PLAN)` on each distinct SELECT (Postgres 16+, never runs the query); flags sequential scans filtered on columns no index starts with, including the ORDER BY columns worth adding; sends the table's row estimate and each filter column's `n_distinct` from `pg_stats` |
| Index create / drop | from the dashboard, through the app's own pool, from checked identifiers only; checks the plan can use it |
| Privacy | values hashed with a key made fresh per app process (HMAC-SHA-256); emails, IPs, UUIDs and long numbers masked in Redis keys; `AUTH`/`HELLO`/`ACL`/`CONFIG`/`MIGRATE` shown by name only |
| Safety | off unless started by backlens; installed once; every patch swallows its own errors; framework assets (`/_next/`, Vite, favicons, source maps) ignored |

## 2. Analysis (pure)

`src/analysis/`

| Check | Fires when | Severity |
|---|---|---|
| N+1 | one statement ran ≥ 3 times with ≥ 3 different values in a request | warn |
| Repeat | same statement (or Redis read) with the same values twice; grouped by where the code paths part | warn |
| Serial | ≥ 2 reads from one function awaited back to back, not overlapping, no write between, no data dependency, same kind (cache-then-DB is left alone) | hint |
| Missing index | advisor flagged a full-table read on a table of ≥ 1000 rows (smaller tables: no issue); hint instead of warn when every filter column holds ≤ 10 different values, with a partial-index suggestion | warn / hint |

Every issue carries a confidence (`src/analysis/confidence.js`): *confirmed* / *likely* / *check*,
with the evidence and the doubts. Evidence is merged across requests (a doubt in any request
stays). A repeat is *check* when a copy has no code line, copies overlap in time, a write to the
table came between, or it is seen in under half of 3+ requests. An N+1 is *confirmed* at 5+ calls
with 5+ values from one line. A serial await is at best *likely*, and *check* without value
fingerprints, when a call takes a lock, or after an empty result (a fallback). An index hint is
*confirmed* at 10,000+ rows on a selective column, *check* on few-valued columns. CI never fails on
*check* alone.

Cost per issue is the median over the requests it was seen in (cold first requests no longer inflate
it) and is worded as an estimate: serial is "up to ~N ms saved if run together".

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
| Verify | before any edit: restart and measure the old code (warm-up until stable + 5 runs); then typecheck (errors sent back, up to 2 rounds) → build if the app runs built output → restart → the same measurement → issue gone and same status class → tests pass and issue gone from test traffic |
| Verdict | proven / unverified (nothing could check it) / failed; time shown as faster / slower / within noise (see Measurement below); Keep or Revert (never overwrites later edits); escalate once to a stronger model |
| Cost control | estimate before sending; daily budget (default $1); usage and history logs per project |
| Keys | Claude key tested for free, stored in `~/.config/backlens` (mode 600), never sent to the browser |
| Local models | Ollama detection, size recommendation by RAM, download with progress |

## 5. MCP server for agents

`src/mcp/`, `backlens mcp` over stdio. Finds the running dashboard through
`.backlens/session.json` (this folder, above, or up to 3 below).

| Tool | What the agent gets |
|---|---|
| `status` | recording?, app state, traffic and issue counts; recorder and MCP versions, with a warning and the fix when they differ |
| `list_issues` | issues worst first with route, `file:line`, statements, fix, example; falls back to the last test run |
| `list_routes`, `list_requests` | route stats; recent requests with ids (`from: "tests"` for the last test run) |
| `get_request` | waterfall of one request with code per call |
| `measure_request` | replay a recorded GET (app or test traffic; `as` a role; writes with `sandbox: true`, see 5d) with its headers (works for signed-in routes) on a fresh app run; median with p25–p75; compared with the last measurement of the same request: faster / slower / within noise; issues still present |
| `measure_url` | the same for a plain GET to a path, no headers |
| `app_logs`, `restart_app`, `run_tests` | app output; restart and wait for the port; tests with their issues |
| `save_login` | save how to sign in as a role from a recorded sign-in request (see 5c) |
| `report` | Markdown evidence for a PR (see 5e) |
| `diff` | behavior diff of every baseline route (see 5b) |
| `accept` | take routes' current behavior into the baseline |
| `usage` | tokens / dollars / plan-limit share of this prompt, session, 30 days; estimate of source an agent would have read instead |

## 5b. Behavior diff

`src/diff/` (pure), `src/dashboard/behavior.js`, `src/recorder/shape.cjs`. Surfaces: MCP `diff` /
`accept`, CLI `backlens diff [--route] [--time] [--json]` (exit 1 on broken, 2 if it could not
run) and `backlens accept [route...]`, API `POST /api/behavior/diff|accept`, `GET /api/behavior`.

| Part | Detail |
|---|---|
| Baseline | newest replayable GET per route (status < 500), most-called first, up to 30; taken on a fresh app run with no traffic; `.backlens/behavior.json` mode 600, no headers or values; a secret-looking query (`token`, `code`, `key`…) is dropped from the saved URL |
| Replay | 1 warm-up + 3 runs per route, in a fixed order, on a fresh run (restart unless the run has had no traffic); `x-backlens-shape: 1`, `accept-encoding: identity`; 429 runs dropped; a route with no request in memory and auth headers is skipped with the reason |
| Fingerprint | status; JSON shape (paths → types, computed inside the app); normalized query counts; Redis commands; outgoing hosts; failing calls with `file:line`; perf issues from the checks; timing |
| ✗ broken | 2xx/3xx → 4xx or 5xx; a field removed; a field's type changed; a new failing call |
| ~ changed | more queries or a new statement; more Redis or outgoing calls; a new outgoing host; a new perf issue; a new field; slower (only with `--time`) |
| ↑ better | fewer queries or calls; an issue gone; 4xx/5xx → 2xx; faster (only with `--time`) |
| Reads that write | a GET that changed data when recorded (SQL writes, outgoing non-GET calls) is never replayed and is listed as skipped; a read that starts writing after a change is `~ now writes when read`; Redis writes from reads (caches, rate limits) do not count; writes nearly every request makes (≥ 80% of reads, ≥ 2 routes) are infrastructure, saved with the baseline |
| Noise rules | an empty array or a null value hides its subtree (data drift); null ↔ type is not a type change; a status class change skips the other comparisons; time is opt-in, needs more than 2× and 10 ms with every run past every baseline run, is re-run to confirm, and is dropped when a third of the routes move together |

## 5c. Access broker (login profiles)

`src/access/`, `src/dashboard/routes/access.js`. MCP `save_login`; `as` on `measure_url`,
`measure_request`; `diff` uses profiles for signed-in routes.

| Part | Detail |
|---|---|
| Save | from a recorded sign-in request (POST): body values found in the project's `.env` files (this folder and up to 3 above) become `${env:NAME}`; a secret-looking field (`password`, `token`, `otp`…) whose value is in no `.env` keeps the profile in memory for the session only, never written |
| File | `.backlens/profiles.json`, mode 600, names and env references only; first saved profile is the default |
| Sign in | the dashboard sends the login unrecorded, keeps a bearer token (`accessToken`, `token`, `jwt`… up to 2 levels deep) or `Set-Cookie` cookies in memory for 10 min; again after an app restart |
| As a role | the replay's `authorization` / `cookie` are swapped for the role's; the token never reaches the agent or the browser |
| Diff | a route's request lost after a dashboard restart is sent as its role, or the default profile; a 401/403 from the default profile is a skip, not a break |
| Test traffic | requests from `run_tests` are kept for replay (`list_requests from: tests`, `measure_request`) |

## 5d. Write sandbox

`src/recorder/sandbox.cjs`, `src/dashboard/sandbox-policy.js`. `measure_request` with `sandbox: true`.

| Part | Detail |
|---|---|
| Transaction | every `pg` query of the replayed request runs on one pinned connection inside `BEGIN … ROLLBACK`; the rollback runs when the response is done, then the connection is destroyed |
| App transactions | `BEGIN`/`START TRANSACTION` → `SAVEPOINT`, `COMMIT`/`END` → `RELEASE`, `ROLLBACK` → `ROLLBACK TO`; a stray `COMMIT` becomes `SELECT 1` |
| Refused | a recorded write that called out over HTTP; one with database calls not made through `pg` (Prisma engine, other drivers) |
| Reported | queries on another connection (leaks: "writes may have reached the database"), rollbacks that failed, Redis writes (not undone), late queries after the response (refused) |
| Limits | fewer warm-ups (Redis writes add up); a replayed create may conflict with what the original request created (another status: reported, not measured); side effects outside pg and HTTP (SMTP, files, queues) are not seen |

## 5e. Harness and evidence

`src/harness/`, `src/evidence/`.

| Part | Detail |
|---|---|
| `backlens init <claude\|codex\|cursor>` | merges a stop hook into `.claude/settings.json` / `.codex/hooks.json` / `.cursor/hooks.json` (timeout 90 s; Cursor `loop_limit: 1`) and the MCP server into `.mcp.json` / `.cursor/mcp.json` (Codex: prints `codex mcp add`); leaves invalid JSON and user-made entries alone; `--uninstall` removes only what it added; takes the baseline if backlens is running |
| Stop hook | silent without a running backlens or without file changes since the last passing check (git status + diff hash); otherwise `diff` within 45 s: broken → block with a short reason (Claude/Codex `decision: block`, Cursor `followup_message`), once per turn; changed/better → accepted and noted to the user (Claude/Codex `systemMessage`); errors and timeouts never block |
| Ledger | `.backlens/evidence.jsonl` (mode 600): every diff, measurement, accept, baseline and hook decision with routes, counts, verdicts, timings; no headers or values |
| Report | `backlens report [--since h] [--all]` / MCP `report`: last check, breaks caught on the way (and how often the agent was sent back), accepted changes with what changed, measured before → after per request |

## Eval harness

`scripts/eval/` (not shipped): runs tasks with and without backlens through `claude -p` in fresh
worktrees, recording success, regressions shipped, tokens, cost and turns. No results yet.

## 5f. Doctor

`src/recorder/adapters.cjs`, `src/dashboard/doctor.js`; `backlens doctor [--json]` (exit 1 when an
adapter is untested or shared), MCP `doctor`, an `adapters:` line in `status`.

| Part | Detail |
|---|---|
| Adapters | reported by the recorder as it patches: http server, http client, fetch, pg, ioredis, node-redis, Prisma, Fastify, with versions; *untested* when the major version is not in the compatibility matrix; *shared* when the methods were already wrapped (shimmer `__wrapped`, OpenTelemetry, APM agents) at first sight |
| Overhead | up to 2 recorded reads (no data writes), 4 warm-up pairs, then 12 alternating pairs with recording on (`x-backlens-replay`) and off (`x-backlens: skip`), timed from outside the app; medians with p25–p75; not counted as traffic |
| Measured | oldmonk: +1.7–2.5 ms (17–31%) a request on light routes |

## 5g. Mutation lab, concurrency probes, counterfactual lab, app memory (1.0)

- **Mutation lab** (`src/mutate/`, `src/dashboard/mutate.js`): it breaks one guard at a time, runs the diff and the tests, and restores the file exactly.
- **Concurrency probes** (`src/race/`, `src/dashboard/race.js`):
  - The group sandbox lives in `src/recorder/sandbox.cjs` (join/leave/guarded/runner).
  - Seq vs conc tallies are compared by `raceFindings`.
  - Jobs are held in the sandbox (`drivers/bullmq.cjs`).
- **Impact-scoped diff** (`src/diff/impact.js`): `changedFiles` (git), `usageOf` (frames → files and tables), and `impactOf` (none / some / all, with reasons). `behavior.diff({ changed })`; the stop hook uses it.
- **Counterfactual lab** (`src/trial/`, `src/dashboard/trial.js`): `checkFixes`/`applyFix` (exact, unique replace), `rankFixes`, and `recoverTrial` on start.
- **App memory** (`src/memory/recall.js`, `src/dashboard/memory.js`): `historyOf(ledger)` and `recallText`, plus notes in `.backlens/memory.json`.
- **API:** `POST /api/race`, `POST /api/trial`, `GET /api/memory`, `POST /api/memory/note` (`routes/labs.js`; the race and trial labs run one at a time).

## Measurement (how a before → after is decided)

`src/shared/compare.js`, `src/dashboard/replay.js`, `src/dashboard/routes/measure.js`

- **Fresh app run each time.** A long-running dev process answered the same code ~2× faster than a
  fresh one (4.3 vs 8.2 ms on oldmonk), and a code change restarts the app. So backlens restarts
  the app before measuring, unless this run has not been measured yet and has served ≤ 50
  requests (the run right after a code change). Cost: one restart, ~7 s on oldmonk.
- **Warm-up until stable.** Windows of 3 requests until a window is no longer ≥ 10% faster than the
  one before, at most 30.
- **Then N measured runs** (default 5, up to 20). Runs answering another status (a 429 from a rate
  limiter) are left out and reported.
- **Verdict.** Median against median. A change is reported only when it is ≥ 1 ms and the p25–p75
  ranges do not overlap; otherwise "within noise", with no percentage.
- **Recorded traffic** is shown for context and never used for a percentage.

## 6. CI

`backlens test -- <test command>`: records test traffic (supertest, fetch), prints the report,
exits 1 on a new warning (`--strict`: on new hints too); `--update-baseline`, `--baseline`,
`--json` for artifacts. Baseline keys ignore line numbers.

## 7. Agent cost tracking

`src/agent-usage/`, `src/statusline/`: reads Claude Code's own session logs (counts and tool names
only, never prompts or code) for prompts that called backlens, including subagents; API-price
dollars or, on a Claude plan, the share of the 5-hour and weekly limits through a status line
wrapper that keeps the user's own status line running.

## Known gaps (seen in real use)

Fixed in Phase 1 (2026-11-12), see WORKLOG.md:

- ~~measure compared a warm median with one cold recorded request~~ → fresh-run, warm vs warm, noise-aware verdict
- ~~serial "ms lost" from cold traffic~~ → median per request, worded as an estimate
- ~~index hints on tiny tables and few-valued columns~~ → none under 1000 rows; few-valued columns are hints
- ~~`status` showed only the MCP version~~ → both versions, mismatch warning
- ~~unpinned `npx backlens mcp` reused a cached version~~ → README pins `@latest`

Open:

1. Login profiles handle JSON or form logins that answer with a token or cookie; OAuth-only,
   CSRF-protected or multi-step (OTP) logins are not handled.
2. Writes replay only in the sandbox (pg only), only through `measure_request`; `diff` covers reads.
3. Postgres only for the index advisor (16+); no mysql2 or MongoDB; macOS-tested.
4. Measuring costs an app restart (~7 s on oldmonk); so does a `diff` when the app has had traffic
   since it started (none after a code change, since the watcher already restarted it). Small real gains (≈ 1–1.5 ms) can come out
   "within noise": the verdict leans to under-claiming.
5. A rate limiter can eat replays: 30 warm-ups + 20 runs is 50 requests per measurement, and a
   30-route diff is 120 requests.
6. `diff` covers reads only, one request per route, and only routes the app served; signed-in
   routes need a request in the dashboard's memory or a saved login profile.
7. `diff` time is too noisy right after a code change to be on by default.
8. Shape checks cannot see value changes, so a field that is always null in the baseline cannot
   show a regression.
9. An expired token on a route where sign-in is optional reads as fewer queries (anonymous), not a
   401, so the role retry does not catch it.
10. Queries an app runs inside its own transaction (a client from `pool.connect`, driven by an ORM
   from a microtask) can go unrecorded: `POST /v1/lessons/:id/complete` on oldmonk shows 1 query
   while its sandboxed replay ran 11 statements. Query counts in `diff` undercount such routes.
