# Worklog

Newest first. One entry per working session: what was done, what was learned, what is next.
Numbers come from real runs; say so when something was not measured.

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
