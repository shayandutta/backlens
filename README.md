# backlens

See every request your Node backend handles, every query it makes, and what is wrong with them. No code changes, no account, nothing leaves your machine.

```
npx backlens
```

Run it in your server's folder. Your browser opens the dashboard; the first time, pick which package.json script starts the app and which runs the tests. From then on everything happens in the browser: start, stop and restart the app, read its logs, run the tests, accept known issues, compare before and after.

The link backlens prints carries a private token: keep it to yourself, it controls your app. The dashboard listens on 127.0.0.1 only, refuses requests from other sites, and only ever runs scripts from your package.json by name.

To run one exact command instead: `npx backlens -- node server.js`.

## What you get

- **Routes**: every endpoint your app registers (fastify and nest report them at startup; express routes appear once called), with calls, p50 and p95, and how many database, Redis and outgoing HTTP calls each request makes.
- **Requests**: a waterfall of any single request, with the line of your code behind each call.
- **Issues**: problems found in real traffic, worst first, each pointing at the code that caused it:
  - **Repeated calls**: the same query with the same values twice in one request. backlens names the two places the code paths part, which is where the second fetch comes from.
  - **N+1**: one query run three or more times with different values in one request.
  - **Calls that wait for each other**: two or more calls of the same kind, awaited back to back in one function. Shown as a hint: if they don't depend on each other, `Promise.all` runs them together.

## In CI: fail the build on new issues

```
npx backlens test -- npx vitest run
```

Runs your test command with recording on, prints every issue it found, and exits 1 when there is a new warning. Tests that call the app over HTTP (supertest, fetch) are recorded like real traffic.

- `--update-baseline` accepts everything found in this run as known, in `backlens.baseline.json`. Commit that file. An issue keeps its identity when lines above it move.
- `--strict` fails on new hints too.
- `--json report.json` writes the report for a CI artifact.

```
backlens  90 requests (207 queries, 241 redis, 0 http out), 11 of 47 routes called, 3 issues, 2 new
  new   3 calls are made twice in one request  GET /v1/lessons/:id, 5/11 requests
        src/modules/access/access.service.ts:75 → src/modules/access/access.service.ts:55
  36 routes never called by these tests
backlens: 2 new issues. Fix them, or accept with --update-baseline.
```

## Missing indexes

For each distinct SELECT, backlens asks Postgres for its plan with `EXPLAIN (GENERIC_PLAN)` (Postgres 16+). Plain EXPLAIN never runs the query, and the generic plan needs no parameter values. When a table is read row by row while filtering on columns that no index starts with, the Issues tab names the table and columns and gives the `CREATE INDEX` to add. It checks whether an index exists, not how fast the query was, so it is right on a small dev database too.

## Before and after

In the Compare tab, save a snapshot, change your code, restart, use the same pages, and compare per route: queries and Redis calls per request, p50 and issues. Snapshots are kept in `.backlens/snapshots` in your project; add `.backlens/` to `.gitignore`. Timings only count as a change with 5 or more calls on both sides.

## Explain and fix, with proof

Every issue has **Explain** and **Suggest fix**. A fix goes: a preview of exactly what would be sent and to whom, the model's answer as a diff, **Apply and check** (only on files with no uncommitted changes, with a backup), then backlens rebuilds if needed, restarts your app, replays the request that showed the issue and runs your tests. Only a fix that removes the issue and keeps the tests green is marked proven. Keep it, or revert to the exact files you had.

Who answers is chosen per issue, with the reasons shown:

- **Local model** (free, private): any model in [Ollama](https://ollama.com). Picked by default when Ollama is running.
- **Recorded answers** (free): no model; fixes come from `.backlens/ai-fixtures.json`. For trying the flow and for tests.
- **Claude with your own key**: set `ANTHROPIC_API_KEY` before starting backlens. Explaining uses Claude Haiku 5.5; fixes use Sonnet 5.5 or Opus 5.5 depending on how hard the issue looks (files involved, issue type, test coverage, your past results), one step up after a failed check. Missing indexes never use a model. A daily budget (default $1) is enforced before sending.

Values that look like secrets are masked, `.env` files and `node_modules` are never read, and requests kept for replay stay in memory only. Replaying a POST, PUT or DELETE runs it again against your dev database, so it is off unless you allow it in AI settings.

## How it works

`backlens` starts the dashboard, then runs your command with `NODE_OPTIONS=--require backlens/register`. Inside your app, the register script:

- times each incoming request on Node's own HTTP server, so it works with express, fastify, nest, Next.js and plain `http`, and records requests the client cancels. Framework internals such as `/_next/` assets and favicons are skipped;
- wraps `pg` (Client and Pool), `ioredis` and global `fetch`;
- records where each call came from. For ORMs like drizzle, which call the driver from a microtask, the call site is read from V8's async stack once the query settles. Code run from bundled chunks (Next.js with Turbopack or webpack) is traced back to your source files through their source maps.

Query values are never sent, only a short hash so identical questions can be told apart from different ones. Emails, IP addresses and ids in Redis keys are masked. The dashboard listens on 127.0.0.1 only and keeps the last 1000 requests in memory.

## Limits of this version

- Tested on macOS with Node 20+, on a nest + fastify + drizzle app and a Next.js 16 + drizzle app. Linux should work the same way; Windows is untested.
- Requests, `pg` and `ioredis` are recorded in CommonJS and ESM apps (vitest included). The up-front route list needs fastify loaded through CommonJS, as nest does.
- `pg`, `ioredis` and `fetch` only. No Prisma, mysql or mongo yet.
- The index advisor needs Postgres 16 or newer, and looks at equality filters only.
- The "wait for each other" hint skips calls whose input matches an earlier call's output, but it cannot see every dependency (a value changed before use, an order that matters for side effects), so read it as a question, not a verdict.

## Develop

```
node --test test/
```
