# backlens

**See what your Node backend really does on every request, find what is slow, and get the fix proven before you keep it.**

[![npm](https://img.shields.io/npm/v/backlens)](https://www.npmjs.com/package/backlens)
[![license](https://img.shields.io/npm/l/backlens)](LICENSE)
[![node](https://img.shields.io/node/v/backlens)](package.json)

```
npx backlens
```

One command, in your server's folder. No code changes, no account, nothing leaves your machine.

---

## What it does

backlens runs your app with a small recorder inside it and opens a dashboard in your browser. As you use your app, every request shows up with the database queries, Redis calls and outgoing HTTP calls it made, and the line of your code behind each one.

From that real traffic it finds what makes backends slow:

| Issue | What it looks like | Example |
|---|---|---|
| **N+1** | one query run once per item in a loop | 20 reviews → 20 `select name from users where id = $1` |
| **Repeated calls** | the same query with the same values twice in one request | two services both load the current user |
| **Calls that wait for each other** | independent queries awaited one after another | `await getCounts(); await getRows();` |
| **Missing indexes** | Postgres reads every row to filter a table | `where state = $1 order by updated_at desc`, no index |

Each issue points at the file and line that caused it, opens in your editor, and can be explained or fixed.

## Fixes, with proof

**Suggest fix** shows the change as a diff. **Apply and check** then:

1. keeps an exact copy of every file it touches
2. applies the change and runs your typecheck (type errors go back to the model, up to twice)
3. restarts your app, warms it up, and replays the request that showed the issue
4. runs your tests

Only a change that removes the issue and keeps the tests green is marked **proven**, and you see the same request before and after:

```
                    before      after
time (median)       48 ms   →   21 ms   -56%
database queries    22      →   2       -91%
issue               found   →   gone
```

Then **Keep** it, or **Revert** to the exact files you had.

Some fixes need no AI: running independent calls together (`Promise.all`) and missing indexes are written by backlens itself. A missing index can be created on your dev database from the dashboard, checked against the query's plan, and undone.

## AI: none, local or Claude

Set up in **AI settings**, entirely from the dashboard.

| | Cost | Privacy | Good for |
|---|---|---|---|
| **No model** | free | nothing leaves your machine | plain explanations, the built-in fixes |
| **Local model** via [Ollama](https://ollama.com) | free | code stays on your machine | explaining; fixes are hit-and-miss on small models |
| **Claude**, your own key | a few cents per fix | what the preview shows is sent to Anthropic | the strongest fixes |

- The local card links to the Ollama download, notices when it runs, suggests the `qwen2.5-coder` size that fits your memory and downloads it with a progress bar.
- A Claude key is pasted in the dashboard, checked for free, and saved in your user folder (`~/.config/backlens`, readable by you only), never in the project. Haiku explains; Sonnet or Opus fixes, depending on how hard the issue is. The cost is estimated before sending and a daily budget (default $1) is enforced. A typical fix costs about $0.03.

## In CI: fail the build on new issues

```
npx backlens test -- npx vitest run
```

Runs your tests with recording on, prints every issue, and exits 1 on a new one. Tests that call your app over HTTP (supertest, fetch) count as real traffic.

```
backlens  90 requests (207 queries, 241 redis, 0 http out), 11 of 47 routes called, 3 issues, 2 new
  new   3 calls are made twice in one request  GET /v1/lessons/:id, 5/11 requests
        src/modules/access/access.service.ts:75 → src/modules/access/access.service.ts:55
backlens: 2 new issues. Fix them, or accept with --update-baseline.
```

- `--update-baseline` accepts what this run found, in `backlens.baseline.json`. Commit it.
- `--strict` fails on new hints too. `--json report.json` writes the report for a CI artifact.

## The dashboard

- **Map**: a live diagram of your routes, the tables and Redis keys they touch, and where the issues are.
- **Routes**: every endpoint with calls, p50, p95 and queries per request.
- **Issues**: worst first, with Explain, Suggest fix and the request that showed it.
- **Requests**: a waterfall of any request, with the code behind each call.
- **Tests**: run your test script and see what it hit.
- **Compare**: snapshot, change code, compare per route.

Start, stop, restart and read your app's logs from the same page.

## Getting started

```
cd your-server
npx backlens
```

The first time, pick which `package.json` script starts the app (like `dev`) and which runs the tests. backlens remembers this in `.backlens/` and adds it to your `.gitignore`.

- Keep it in the project: `npm i -D backlens`, `pnpm add -D backlens` or `yarn add -D backlens` (in a pnpm or yarn workspace, use that tool).
- Run one exact command: `npx backlens -- node server.js`.
- Port 7777, or the next free one. `--port` picks one, `--no-open` skips the browser.

## Works with

| | |
|---|---|
| Frameworks | express, fastify, nest, Next.js route handlers, plain `node:http` |
| Database | `pg` (Client and Pool): drizzle, Kysely, knex, raw SQL on Postgres |
| Cache | `ioredis` |
| Outgoing calls | global `fetch` |
| Modules | CommonJS and ESM, vitest included |
| Runtime | Node 20+, tested on macOS; Linux should work the same way |

Not yet: Prisma, mysql2, MongoDB, Windows.

## Privacy and safety

- **Values never leave your app.** Query parameters and results become short hashes; emails, IPs and ids in Redis keys are masked.
- **The dashboard is yours only.** It listens on 127.0.0.1, needs the private token in the link it prints, and refuses requests from other websites.
- **It runs only scripts from your `package.json`,** by name.
- **Files change only when you click Apply,** with a copy kept first. Revert never overwrites edits you made afterwards.
- **AI sees only what the preview shows.** Secret-looking values are masked; `.env` and `node_modules` are never read.
- **Replaying writes is off by default,** since it changes your dev database again.
- **Indexes are built from checked table and column names** through your app's own connection: backlens never sees a database password.

## How it works

`backlens` starts the dashboard, then runs your app with `NODE_OPTIONS=--require backlens/register`. Inside your app, the recorder:

- times each request on Node's own HTTP server, so any framework on top of it works;
- wraps `pg`, `ioredis` and `fetch`, and records the line of your code behind each call, through V8's async stack traces for ORMs like drizzle and through source maps for bundled code;
- asks Postgres for each distinct SELECT's plan with `EXPLAIN (GENERIC_PLAN)` (Postgres 16+), which never runs the query, and flags full-table reads no index covers.

## Limits

- The "wait for each other" hint skips calls that use an earlier call's result, but it cannot see every dependency: read it as a question, not a verdict.
- The index advisor needs Postgres 16+ and looks at equality filters and the sort above them.
- Timings on a dev machine are rough; query counts are exact.

## Develop

```
git clone https://github.com/shayandutta/backlens
cd backlens && npm install
node --test test/
```

Bug reports and pull requests are welcome.

## License

[MIT](LICENSE) © Shayan Dutta
