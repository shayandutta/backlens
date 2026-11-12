# Worklog

Newest first. One entry per working session: what was done, what was learned, what is next.
Numbers come from real runs; say so when something was not measured.

---

## 2026-11-13: 0.7 started, trust before features (branch `v0.7/compat-matrix`)

### Done

- **Compatibility matrix** (`test/compat/`, `npm run test:compat`, CI job with Postgres 16 and Redis 7).
  - Libraries: pg 8.11 and the latest 8, drizzle, Kysely, ioredis 5, node-redis 4 and 5, Express 4 and 5, Fastify 4 and 5.
  - Each scenario checks every call is recorded once, in its request, with an app line. Postgres scenarios: a plain query, two transactions then a pooled query, the callback API, an error, parallel queries.
  - Against 0.6.0's pg adapter it fails on pg 8.11, pg 8 and drizzle, which is the double count. Kysely is unaffected.
- **Salted hashes:** HMAC-SHA-256 with a key per app process. Before, plain SHA-1 let anyone match a guessed email or id to its hash.
- **Reads that write:** see FEATURES 5b. It is checked on oldmonk:
  - The first heuristic wrongly excluded 3 of 17 routes: per-route rate-limit keys (`rl:route:*`) and a cache `SET`.
  - Now Redis writes from reads only get a note, and SQL or outgoing writes exclude a route.
  - Result on oldmonk: 17/17 routes in the baseline, a clean diff, and `measure` notes the rate limiter.
- 97 tests pass; the matrix passes (11 cases).

### Next in 0.7

`backlens doctor` (2), confidence labels (5), caller chains (6), BullMQ (7), "local replay" labels (8), 0.6 leftovers (9).

---

## 2026-11-12 (night): 0.6.1, two bugs found by the first real use

An agent ran 0.6.0 on a real app ("find and fix performance issues"):
- It fixed a real double read: quiz −24%, outside noise; complete 11 → 8 queries, time within noise.
- It flagged a likely backlens false positive: on fake payment, the same query twice, the second with no code location.
- The user noticed the dashboard still listed the issues the agent had fixed.

- **Double count.** Reproduced with real drizzle and pg: two transactions, then `db.execute`, recorded `select 4` twice in 0.6.0.
  - Cause: pg-pool assigns a new `release()` on every acquire. backlens wrapped it only once per client, so a later lease was never cleared, and the client was still marked "leased" when `pool.query` reused it.
  - Fix: re-wrap on every lease, and never treat `pool.query`'s own client as leased.
  - Test: `test/register.test.js` "a pooled client reused after a transaction" fails on 0.6.0 and passes now.
- **Stale issues.** Issues are hidden only by Keep or by a new real request, and replays never count as requests.
  - Fix: `measure_request` marks a route's listed issue fixed when the replay of the new code no longer shows it (same type and statements). The replay becomes the after-fix request.
  - Test: `test/stale-issues.test.js` fails without the fix.
- 92 tests pass.

---

## 2026-11-12 (release): 0.6.0 hardening (branch `release/0.6.0`)

### Done

- **Transactions were not recorded.**
  - **Gap:** queries an ORM ran on a client from `pool.connect()` went unrecorded. A real drizzle transaction on oldmonk showed only the query before it.
  - **Cause:** drizzle drives the client from callbacks that lose the async stack, so no app frame was seen.
  - **Fix:** clients the app leases inside a request are recorded for that request only. `pool.query`'s own connect is excluded, so nothing is counted twice.
  - **Check:** probed with oldmonk's drizzle, pg and dev DB (before: `select 1` only; after: `select 1, begin, select 2, select 3, commit`). A regression test fails without the fix and passes with it.
- **An older leak:** the index advisor's own `EXPLAIN`s could be recorded into a request when pg-pool resumed them in that request's context. The advisor now tags its queries, and the pg patch skips tagged ones.
- **Dashboard crash:** a handler that threw would crash the whole dashboard on Node 20, taking down the app it runs. Requests now answer 500 instead. The dashboard and the MCP server log stray rejections instead of exiting. Bad URLs answer 400.
- **Release:** version 0.6.0, `CHANGELOG.md` (shipped in the package), new description and keywords, lockfile synced.
- **Dashboard API check:**
  - every endpoint `ui.html` uses answers correctly on oldmonk (12 GET and 2 POST checked)
  - the page and its script load and parse
  - The browser extension was not connected, so nobody has clicked through the page since the refactor. This is still open.

### Checked

- 90 tests pass; 118 files parse.
- `npm pack`: 106 files, no tests or scripts.

### Open, by choice

- `typescript` (~20 MB) and `@anthropic-ai/sdk` stay runtime dependencies. They are loaded lazily, and the project's own TypeScript is used first. Making them optional would shrink `npx` installs and is worth doing.
- The eval pilot still needs to be run by the user (the permission classifier blocked it).

---

## 2026-11-12 (last): Phases 3–6 built and run (branch `phase3/access-broker`)

The code was written while the machine was overloaded (load average about 13 from other work), with nothing run. It was all run afterwards; timings from this session are void, and the checks below are not affected by load.

### Built

- **Phase 3, access broker** (`src/access/`):
  - login profiles with `${env:NAME}` secrets
  - the dashboard signs in itself
  - `as` on the measure tools
  - `diff` uses the role or the default profile
  - test-run requests are replayable
- **Phase 4, harness** (`src/harness/`):
  - `backlens init claude|codex|cursor`
  - `backlens hook stop`: block once on a break; accept other changes
- **Phase 6, in part:**
  - evidence ledger and `backlens report`
  - write sandbox for pg (`measure_request sandbox: true`)
  - Codex and Cursor hook formats, checked against their docs
- **Phase 5:** eval harness (`scripts/eval/`).

### Verified

| Check | Result |
|---|---|
| `npm test`, `npm run check` | 89/89 passing, 118 files parse (the first run after writing everything blind) |
| Phase 3: diff after a dashboard restart, nothing recorded | 17/17 routes checked, 0 skipped; signed-in routes went through the saved admin login |
| Phase 3: `measure_request` on a request recorded from the test run | replayed against the dev app: 200 |
| Phase 3: `save_login`, then `measure_url as admin` | profile holds only `${env:...}`; 200 as admin, 401 without |
| Sandbox: 3 replays of `POST /v1/lessons/:id/complete` (runs in the app's own transaction) | `updated_at` and row counts of `lesson_progress`, `chapter_unlocks`, `audit_log` unchanged; 33 statements rolled back; Redis `EVAL` (rate limiter) listed as not undone; refused without `sandbox: true` |
| `init` and `--uninstall` for claude, codex and cursor in an empty folder | install writes the 5 expected files; uninstall leaves nothing; a user's own `settings.json` is kept intact |
| Agent run 1 (Sonnet, headless): "select only the columns admin/users needs" | the agent found nothing to change, made no edits, and suggested measuring first. Hook ran: clean, silent. $0.08, 3 turns |
| Agent run 2 (Sonnet): "remove the lessonsCompleted and lastActiveAt subqueries from the admin users list" | the hook **blocked**: `✗ GET /v1/admin/users response lost $.items[].lessonsCompleted`. The agent judged it intended and called `accept`, and told the user the shared contract, the web page and `test/admin.test.ts` still expect the field. The retry stop was clean. $0.16, 13 turns |

### Found and fixed during the runs

- **Expired tokens:** recorded signed-in requests carried sign-ins that had expired, and `diff` reported 11 routes as `401 (was 200)`.
  - Fix: a route that used to work and now refuses is retried once as the saved role.
  - `accept` (both paths) never stores a 401/403 over a working baseline.
  - `measure_request` suggests `as`.
  - A test (`test/access.test.js`) restarts the app to kill its tokens and checks the diff stays clean.
- **`init --uninstall` left empty `{}` files and folders.** Now removed.
- **`backlens report`** described an accepted change using a diff from after the accept. It now uses the last diff before it.
- **Side effect worth knowing:** a hook written to `.claude/settings.json` was picked up live by the Claude Code session already running in that folder (this one).

### Learned

- **Phase 4's "done when" is half met.** The hook blocked a real break and the agent responded unaided. It chose "intended, accept" rather than "fix", which was right for the task as worded. A task where the break is clearly unintended is still to be run.
- **What blocking added:** the agent went and found the contract, UI and test that depend on the field before finishing.
- **Shape checks can't see a field that is always null in the baseline.** `lastActiveAt` was null for every seeded user, so only a missing field or a changed type would show.
- **An expired token on a route where sign-in is optional** reads as `fewer queries` (anonymous) rather than a 401, so it is not caught by the retry.
- **Queries inside an app's own transaction can go unrecorded** (FEATURES gap 10).

### Not done

- **Eval pilot (Phase 5): blocked.** The Claude Code permission classifier denied running `scripts/eval/run.mjs` (headless agents with Bash in new worktrees). Run it yourself, or allow it:
  `node scripts/eval/run.mjs <tasks.json> --out results.jsonl`.
- **Next.js full-stack, and write replays inside `diff`.**

---

## 2026-11-12 (later): Phase 2, behavior diff (branch `phase2/behavior-diff`)

### Done

- **Recorder** (`recorder/shape.cjs`): on replays sent with `x-backlens-shape: 1`, the JSON
  response's shape (paths and types) is computed inside the app; values never leave it.
- **`src/diff/`** (pure): `fingerprint` (status, shape, query, Redis and HTTP counts, failing
  calls, perf issues, timing), `compareFingerprints` (✗ broken / ~ changed / ↑ better, with
  data-drift rules) and text formatting.
- **`dashboard/behavior.js`**:
  - baseline: the newest replayable GET per route, up to 30, saved to `.backlens/behavior.json`
    (mode 600, no headers or values, secret-looking query dropped)
  - diff: 1 warm-up + 3 runs per route
  - accept
- **`dashboard/fresh.js`**: one fresh-run rule shared by `measure` and `diff`.
- **Surfaces:** MCP `diff` and `accept`; CLI `backlens diff` (exit 1 on broken) and
  `backlens accept`; the MCP instructions now end the loop with `diff`.
- **Tests:** 75 in all.
  - `test/diff.test.js`: shape, drift and rule unit tests.
  - `test/behavior.test.js`: end to end, with a real dashboard and a tiny app under the recorder.
    Baseline, quiet, lost field, 500, accept.

### Measured on oldmonk (17 GET routes, signed in as admin)

| Check | Result |
|---|---|
| Seeded: `me()` drops `email` | ✗ response lost `$.email` (0.5 s) |
| Seeded: `me()` reads the user twice | ~ 1 more query (1 → 2), ~ new issue: repeat (0.6 s) |
| Seeded: `me/orders` throws | ✗ answers 500 (was 200) (0.7 s); CLI exit 1 |
| Restored | no behavior change (0.6 s); CLI exit 0 |
| 10 clean runs, final design | 10/10 "no behavior change" |
| Clean runs with time on, first design | 4/5 with false "slower" |
| Clean runs with time on, after a fresh-run fix | 1/6 false |
| Clean runs with time on, after machine-wide suppression | 2 false among the seed rounds |
| Seeded 50 ms sleep with time on | lost: 15 routes looked slower together, so it was suppressed as machine noise |
| Structural signals (status, shape, queries, calls) | 0 false findings in every clean run (more than 25) |
| Time per diff | 0.5–0.9 s for 17 routes when the app had just restarted for a code change; 7–12 s when backlens had to restart it |

### Learned

- **Structural signals are exact and free of noise; time is not.**
  - Right after a code change, the dev watcher (likely recompiling) loads the machine. Clean routes
    then read 2–4× slower at random.
  - So time is off by default in `diff` (`--time` to opt in), and precise timing stays with
    `measure_request`.
- **Baseline and diff must start from the same app state.** The first baseline was taken on a run
  that had served traffic; every diff after a restart then looked slower.
- **The agent flow is the cheap case:** edit, then the watcher restarts, then `diff` runs on a
  fresh run with no extra restart, in under 1 s.

### Not done or not verified

- Routes beyond 17: the target was 30. Time per route was about 35 ms, so 30 routes should take
  about 1 s, but this was not measured.
- Dashboard UI: there is no diff view yet (CLI and MCP only), and the UI was still not clicked
  through.
- After a dashboard restart, signed-in routes are skipped until used once. Phase 3 (login
  profiles) removes this.
- Writes are not covered.

### Next

- Phase 3: access broker (login profiles, replay as a role, replayable test traffic).
- Or Phase 4 first: `backlens init claude` with a Stop hook running `backlens diff`. The diff is
  fast enough in the edit flow, and exit 1 already means "broken".

---

## 2026-11-12: Phase 1, honest measurement (branch `phase1/honest-measurement`)

### Done

- **measure_request / measure_url.**
  - Every measurement is saved and compared with the last one of the same request: median against
    median with the p25–p75 range.
  - Verdict "faster" or "slower" only when the change is ≥ 1 ms and the ranges do not overlap;
    otherwise "within noise", with no percentage.
  - Recorded traffic is shown but never compared.
- **Fresh app run per measurement.** backlens restarts the app first, unless the run is unmeasured
  and has served ≤ 50 requests.
- **Warm-up until stable.** Replaces the fixed 3 warm-ups.
- **Runs answering another status** (a 429) are dropped and reported.
- **AI fix verify** measures the old code (fresh, warm) before writing edits, so its compare card is
  warm against warm too. The UI shows ranges and "within noise".
- **Issue cost** is the median per request, not the mean. Serial is worded "up to ~N ms saved if
  run together (estimate)".
- **Index hints.**
  - No issue on tables under 1000 rows.
  - Hint (not warn) when every filter column has ≤ 10 distinct values (`pg_stats.n_distinct`),
    with a partial-index suggestion.
- **`status`** shows the recorder and MCP versions and warns on a mismatch. `session.json` and
  `/api/config` carry `version`.
- **README** pins `backlens@latest` for the MCP server and explains why.
- **Tests:** 67 (7 new) — `test/honest-numbers.test.js` plus a status assertion in the MCP test.

### Measured on oldmonk (20 runs per measurement)

| Check | Before Phase 1 | After |
|---|---|---|
| `backlens test`, fixed code | 2 issues (tiny-table index hints) | 0 issues, exit 0 |
| `backlens test`, pre-fix code | 5 issues | 3 (the real repeat + 2 serial), exit 1 |
| Same code measured twice, fixed 3 warm-ups | "faster −47%" (false) | — |
| Same code measured after a restart, adaptive warm-up but no fresh run | "slower +91%" (false) | — |
| Same code, 6 comparisons, final design | — | 6/6 "within noise" |
| Pre-fix code vs fixed | — | users/:id slower +70%, insights slower +52% |
| Fixed again vs pre-fix | — | insights faster −36%; users/:id "within noise" (−1.44 ms, ranges touched) |

### Learned

- **Process age dominates timing on a dev machine.** The same code answered in ~4 ms in a process
  that had served hundreds of requests and ~8 ms in a fresh one. Any before → after across a
  restart (that is, every code change) must compare fresh against fresh.
- **Unrecorded requests warm up in ~30 requests; recorded ones take longer.** The recorder adds
  ~2× at first.
- **oldmonk rate-limits at ~170 requests a minute.** Long warm-ups can hit it, so status filtering
  is needed.
- **The verdict now leans to under-claiming:** a real −1.4 ms gain can read "within noise". That
  is the right side to err on for a gate.

### Not done or not verified

- Dashboard UI not clicked through (the compare card and issue meta changed). Same as before the
  refactor.
- The version-mismatch branch of `status` is not covered by a test; only the matching case is.
- Not published; `package.json` is still 0.5.0.

### Next

- Phase 2: behavior diff. It can reuse `measure`'s fresh-run and noise rules.
- Consider a cheaper restart, or a shared fresh run for a whole diff, since 30 routes × 7 s is too
  slow for the < 5 s target.

---

## 2026-11-10 → 11-12: real-world run, product direction, modular refactor

### Ran backlens 0.4.0 → 0.5.0 on a real NestJS API (oldmonk, 59 files, 486 test requests)

- Found 5 issues: a repeated order read in `POST /v1/payments/fake/:orderId`, two serial-await
  hints (admin insights, admin user detail), and two index hints.
- Fixed 3 (repeat, both serial). Skipped all 4 index hints, which were tiny tables or filters
  already covered by a primary key prefix.
- Measured with `measure_request`, 20 runs each, warm medians:
  - `GET /v1/admin/insights`: 5.42 → 5.14 ms
  - `GET /v1/admin/users/:id`: 7.34 → 5.64 ms (−23%)
  - Tests green; the 3 fixed issues are gone.
- The headline percentages backlens printed (−91%, −82%) compared against one cold recorded
  request. They overstate; see FEATURES.md "Known gaps".

### Learned (product)

- Where an agent's tokens went in that session:
  - ~2 calls finding issues (backlens gave `file:line`)
  - ~6 working out how to sign in as admin
  - ~10 starting the app, npx cache and version mismatch
  - ~4 writing a benchmark script, which `measure_request` replaced
- Discovery and verification cost far more than the fix. That is the case for the direction in
  ROADMAP.md.
- Gaps found: overstated measure headline, overstated serial "ms lost", noisy index hints,
  `status` showing the MCP version instead of the recorder's, unpinned `npx backlens mcp` stuck on
  the cached version, test traffic not replayable, `measure_url` without headers.

### Refactor: flat files → `src/` layers (branch `refactor/modular`)

- `register.cjs` (848 lines) → `src/recorder/`: env, context, frames, privacy, transport,
  incoming, index-advisor, loader, `drivers/` (pg, redis, prisma, outgoing),
  `frameworks/fastify`.
- `analyze.js` → `src/analysis/`: `checks/duplicates`, `checks/serial`, check-trace,
  index-advice, summarize, map, routes, statements, frames.
- `server.js` (551 lines) → `src/dashboard/`: server, store, processes, replay, test-report,
  app-command, http, and `routes/` (ingest, traffic, project, measure, indexes, ai).
- `ai/fixes.js` (730 lines) → `src/ai/`: fix-jobs, edits, settings, workspace, index.
  `ai/providers.js` → `src/ai/providers/`: prompts, mock, ollama, anthropic.
- Replay and measure moved from the AI module to `dashboard/replay.js`. AI now receives a replayer
  through `deps` and no longer depends on the dashboard.
- `mcp.js` → `src/mcp/`: server, session, tools, handlers, format, version.
- `agent-usage.js` → `src/agent-usage/`: pricing, plan, transcripts, source, usage, text.
- CLI → `src/cli/`: args, studio, ci, statusline. `bin/backlens.js` only dispatches.
- `src/shared/`: config-dir (it was duplicated in two places), project, project-config, stats,
  ansi, replay-policy (replay constants, previously duplicated).
- Stable public paths kept: `bin/backlens.js`, `backlens/register` (now
  `src/recorder/index.cjs` via `exports`), and root `statusline.js`, which installed status
  lines point at.
- Added `npm run check` (every file parses), a CI workflow (Node 20/22/24), and docs:
  ARCHITECTURE, FEATURES, ROADMAP, this log.

### Verification of the refactor

- `npm test`: 60/60 pass, the same suites with only import paths updated.
- `npm pack`: 86 files (bin, src, statusline.js, README, LICENSE, package.json); no tests or
  scripts shipped.
- End-to-end on oldmonk, `backlens test --json` before and after the refactor:
  - Fixed code: 486 requests, the same 2 issues, identical per-route stats, exit 0 both times.
  - Pre-fix code: 486 requests, the same 5 issues (repeat, 2 serial, 2 index), identical
    per-route stats, exit 1 both times.
- Studio and MCP smoke test on a scratch app:
  - recording, outgoing fetch capture and session file all work
  - `status` and `list_requests` work
  - `measure_request` replayed with headers
  - Ctrl+C stopped the app and removed `session.json`
- Not covered by automation: the dashboard UI in a browser. `ui.html` is unchanged and the API
  routes keep their paths and payloads, but no one has clicked through it since the refactor.

### Next

- Phase 1 of ROADMAP.md: fix known gaps 1–5.
- Click through the dashboard once on the refactor branch before merging.
