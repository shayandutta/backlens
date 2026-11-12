# Changelog

## 1.0.0

backlens now checks what a change does, not just what a request does: races under concurrency,
the routes a change can reach, fixes tried side by side, and a memory of the app across sessions.

- **Concurrency probes:** `backlens race [--id] [--copies 5]` (also an MCP tool `race`).
  - A recorded write is sent N times one after another, then N times at once.
  - Each set runs in one shared, rolled-back transaction, so the copies see each other's writes, as on a real database. Their statements interleave one at a time, each behind its own savepoint, so one failing statement fails only itself.
  - It reports when more copies succeed at once than one after another (a check-then-act race: overselling, double spending, duplicate sign-ups). It also reports duplicate jobs, extra rows written, and 5xx errors that only happen under concurrency. No app knowledge is needed: the one-after-another run is the app's own answer.
  - Code using `SELECT … FOR UPDATE` or advisory locks is only rated *check*: the shared connection holds no locks against itself.
  - **Checked on real Postgres** (compat case): a check-then-decrement is caught (several sales of the last item), the atomic `UPDATE … WHERE qty > 0` is not, and the row is unchanged afterwards.
- **Jobs in the sandbox are held:** inside the write sandbox, BullMQ `add`/`addBulk` is recorded but not queued (a stand-in job is returned), since a worker would run it outside the rollback.
- **Impact-scoped diff:** `diff --changed` (MCP `diff` with `changed: true`).
  - It checks only the routes your uncommitted changes can reach: routes whose recorded calls ran a changed file, plus routes that touch the tables the changed code queries.
  - Config, dependency, schema or migration changes, or a file no request ran, widen it to all routes. Docs and tests reach none.
  - The stop hook uses it, so a turn that only touched docs replays nothing.
  - Without `--changed`, the routes in reach are checked first. Every diff says what the change can reach and why.
  - Baseline entries now keep the files and tables each route used.
- **Counterfactual lab:** MCP tool `try_fixes`; on the command line `backlens try <fixes.json> --id <request> [--keep]`.
  - It takes 1–4 candidate fixes for one request, as exact edits. For each one it applies the edits, restarts the app, replays the request (queries, warm median with p25–p75, status, issues), diffs the routes the fix can reach, runs the tests, and puts the files back exactly.
  - Best fix: no break, same status, tests pass, then fewest queries, then faster beyond noise. `keep` applies the winner.
  - An interrupted run's files are restored on the next start.
- **App memory:** MCP tools `memory` and `remember`; on the command line `backlens memory [route | file]`.
  - **For a route:** the code it runs, its tables and the routes sharing them, its numbers, open issues with confidence, and its history (breaks caught, changes accepted, measurements, races, fixes tried).
  - **For a file:** the routes that run it and the failures around it, mutation gaps included.
  - **Notes** that agents or people leave are kept in `.backlens/memory.json` (mode 600).
  - It is built from the evidence ledger, the baseline and recorded traffic, so it carries over between sessions.

- **Mutation lab:** `backlens mutate [--max 8] [--no-tests]` (also an MCP tool `mutate`).
  - In the files real requests ran through, it breaks one guard at a time: removes an `if (…) throw` / error-return check, removes an access decorator (`@UseGuards`, `@Roles`…), or shifts a `>=`/`<=` boundary.
  - For each, it restarts the app, runs the behavior diff and the tests, and puts the file back exactly.
  - It reports each change nothing noticed: a gap an agent could fall into silently. Exit 1 on a gap.
  - An interrupted run's file is restored on the next start.
- **`diff`:** a refused request (401/403) that now gets through is reported as *broken*, not *better*.
- **BullMQ:**
  - **Enqueues:** `Queue.add` / `addBulk` inside a request become `job` spans, with the code line and the job id.
  - **Job runs:** each run (`Worker.callProcessJob`) is its own trace (`JOB /<queue>/<name>`), so a job's queries are recorded and checked like a request's: N+1s, repeats.
  - **Links:** a request links to the jobs it queued and their runs (retries included; `get_request` notes a job that ran more than once), and a run links back to its request.
  - **Checked** in the compatibility matrix with real BullMQ 5 on Redis.

## 0.7.0

- **Compatibility matrix:** `npm run test:compat`, also run in CI. The recorder runs against real pg (8.11 and the latest 8), drizzle-orm, Kysely, ioredis 5, node-redis 4 and 5, Express 4 and 5, and Fastify 4 and 5, on real Postgres and Redis. Each call must be recorded once, in its request, with the app's code line. It fails on 0.6.0's double count.
- **Value hashes are keyed per app process (HMAC-SHA-256)**, so a likely value (an email, a small id) can't be matched to its hash.
- **Reads that write:**
  - `diff` no longer replays a GET that changed data when it was recorded (SQL writes or outgoing non-GET calls), and says why.
  - It reports `now writes when read: …` when a change makes a read start writing.
  - `measure` warns when a replayed read changed data.
  - Redis writes from a read (cache fills, rate limits) only get a note.
  - Writes nearly every request makes are treated as infrastructure and ignored.

- **`backlens doctor`** (also an MCP tool; adapters also shown in `status`):
  - **Adapters:** which libraries the recorder hooked into, with versions, flagged *untested* when a major version isn't in the compatibility matrix and *shared* when another instrumentation tool wrapped the same methods first.
  - **Cost of recording:** the same request with recording on and off, alternated and timed from outside the app. On a real NestJS app it measured +1.7–2.5 ms (17–31%) a request.

- **Confidence on every finding:** *confirmed*, *likely* or *check*, with the evidence and the doubts. It shows in MCP, the dashboard, the CI report and `list_issues`.
  - **Repeats** become *check* when a copy has no code line, when copies overlap in time (the 0.6 false positive), when a write to the table came between them, or when the repeat is seen in under half the requests.
  - **Serial awaits** are never *confirmed*. They are *check* when one call takes a lock (`FOR UPDATE`, advisory locks) or follows an empty result (a fallback lookup).
  - **CI** doesn't fail on a new finding marked *check*; `--strict` still counts it.
  - **On a real app**, all three serial-await hints that an agent had dismissed by reading the code are now *check*, with the same reasons it gave.
- **Code paths:** issues show the chain of app code behind them (handler → service → repository), and N+1 fixes name the caller that likely loops.
- **Expired sign-ins:** a recorded request whose JWT has expired isn't replayed as is. `diff` signs in with the saved login, and `measure` suggests `as`. Before, an optional-auth route quietly answered as an anonymous user and showed up as a break.
- **Fields the diff can't verify:** `diff` reports how many fields were null in every baseline response, since a changed value can't be seen there.
- **Writes in `diff`:** recorded POST/PUT/PATCH/DELETE requests whose changes are in Postgres join the baseline (up to 10). They are replayed in the rolled-back sandbox, and a leak stops write replays with a warning.
- **Diff tab** in the dashboard: run a diff, see what changed, accept routes.
- **Timings are labelled local replays,** not production latency.
- **Deferred to 0.8:** BullMQ job correlation.

## 0.6.1

- **Fixed: a query recorded twice.** After a transaction, a plain `pool.query` in the same request could be recorded twice, the second copy with no code location. pg-pool reuses the client and replaces its `release()`, so the transaction's lease was never cleared. This showed up as a false "same call twice" issue, seen on a real NestJS/drizzle app.
- **Fixed: issues fixed outside the dashboard stayed listed.** That covers fixes by an agent or in your editor. Now, when `measure_request` replays a route on the changed code and an issue the dashboard lists is gone, it is treated as a kept fix. It comes back if a later request shows it again.

## 0.6.0

backlens grows from a query fixer into a check on what every change does to the running app.

### New

- **Behavior diff.** `backlens diff`, MCP `diff`/`accept` and `backlens accept` keep one recorded read per route (up to 30). After a change they replay each route and compare it with the baseline:
  - checks: status, the response's fields and types (computed inside the app, never values), queries, Redis and outgoing calls, failing calls, new N+1 or repeated calls
  - findings: ✗ broken / ~ changed / ↑ better; silent when nothing changed
  - CLI exits 1 on broken
- **Agent gate.** `backlens init claude|codex|cursor` adds the MCP server and a stop hook. When a turn changed files, the hook runs the diff:
  - a break sends the agent back once with the reason
  - other changes are accepted and noted
  - silent without changes or without a running backlens
  - `--uninstall` removes exactly what it added
- **Login profiles.** `save_login` turns a recorded sign-in into a role whose secrets are `${env:NAME}` references to `.env`, never values.
  - `measure_url`, `measure_request` and `diff` sign in by themselves (`as: "admin"`).
  - The agent never sees a token or password.
- **Write sandbox.** `measure_request` with `sandbox: true` replays a recorded POST/PUT/DELETE inside a Postgres transaction that is rolled back.
  - The app's own transactions become savepoints.
  - Requests that called out over HTTP, or whose database calls do not go through `pg`, are refused.
  - Redis writes are listed, since they are not undone.
- **Evidence.** Every diff, measurement, accept and hook decision is logged to `.backlens/evidence.jsonl`. `backlens report` (and MCP `report`) writes it up as Markdown for a pull request.
- **Test traffic is replayable:** `list_requests from: "tests"`, then `measure_request`.
- **`status` shows the recorder and MCP versions** and warns when they differ.

### Changed

- **`measure_request` / `measure_url` compare warm against warm.**
  - Each measurement runs on a fresh app run, warming up until stable.
  - It is compared with the previous measurement of the same request: median with p25–p75.
  - "faster" or "slower" only when the change is at least 1 ms and the ranges do not overlap; otherwise "within noise".
  - Before, they compared against one cold recorded request and overstated gains: −91% shown, −5% real.
- **Fix verification measures the old code the same way** before editing.
- **Issue cost** is the median per request and worded as an estimate.
- **Index hints:**
  - none for tables under 1,000 rows
  - columns with few distinct values (a status) are hints, with a partial-index suggestion
- **Queries an ORM runs on a leased client** (transactions, as drizzle does) are now recorded. They were missed before.
- **The index advisor's own queries** are never recorded into a request.
- **A failing dashboard request** answers 500 instead of crashing the dashboard and the app it runs.
- **`typescript` is now an optional peer dependency**, so `npx backlens` downloads 23 MB less. The no-model `Promise.all` fix uses the project's own TypeScript; without one, that fix goes to the model.
- **Code moved into `src/` layers.** Public paths are unchanged: the `backlens` bin, `backlens/register`, root `statusline.js`.

### Upgrading

Run both halves from the same version:

```
npx backlens@latest
claude mcp add backlens -- npx -y backlens@latest mcp
```

An unpinned `npx backlens mcp` can keep using an older cached copy. `status` now warns when that happens.

## 0.5.0

See the git history.
