# backlens

**See what your Node backend really does on every request, find what is slow, and get the fix proven before you keep it.**

[![npm](https://img.shields.io/npm/v/backlens)](https://www.npmjs.com/package/backlens)
[![license](https://img.shields.io/npm/l/backlens)](LICENSE)
[![node](https://img.shields.io/node/v/backlens)](package.json)

```
npx backlens
```

One command, in your server's folder. No code changes, no account, nothing leaves your machine.

![backlens finding three issues in a NestJS API, fixing one with Promise.all and proving it with a replay, then creating a missing index](https://raw.githubusercontent.com/shayandutta/backlens/main/docs/demo.gif)

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

## In your AI editor (MCP)

Let Claude Code, Cursor or any MCP client see what your requests do, change the code, and check the change on the same request.

```
claude mcp add backlens -- npx -y backlens mcp
```

Cursor (`.cursor/mcp.json`) and others:

```json
{ "mcpServers": { "backlens": { "command": "npx", "args": ["-y", "backlens", "mcp", "--root", "${workspaceFolder}"] } } }
```

Keep `npx backlens` running in the server folder; the MCP server reads that session (it finds it in the project, a folder above, or a few below, like `apps/api`). Tools:

| Tool | What the agent gets |
|---|---|
| `status` | is backlens recording, is the app up, traffic and issue counts |
| `list_issues` | issues worst first, with route, `file:line`, statements, a suggested fix and an example request |
| `list_routes`, `list_requests` | p50, p95, calls per request; recent requests with ids |
| `get_request` | the waterfall of one request: each query, Redis and HTTP call, its time and the code behind it |
| `measure_request` | replays a recorded GET against the code as it is now (warm-up, then median of runs) and compares it with what was recorded |
| `measure_url` | the same for a path sent as a plain GET (no cookies): public routes, or a before when nothing is recorded yet |
| `app_logs`, `restart_app`, `run_tests` | the app's output, a restart, the test script with its issues |
| `usage` | what the work cost: tokens and dollars for this prompt, the session and the last 30 days |

A typical loop: *list_issues → get_request → measure (before) → edit → measure again → run_tests*. On a sample N+1 that went from 6 queries and 6.7 ms to 2 queries and 1.6 ms, checked by replay. Writes are never replayed, and parameter values never reach the agent.

### What it costs

The **Agents** tab lists every Claude Code prompt that used backlens, with what it used, its tokens, time, backlens calls, files read and edits. The agent reports the same at the end with `usage`. Token counts come from Claude Code's own logs in `~/.claude/projects`: counts and tool names only, never your prompts or code.

What "cost" means depends on how you pay, and backlens shows the number that is really yours:

| You pay with | backlens shows | From |
|---|---|---|
| A Claude plan (Pro, Max, Team) | the share of your 5-hour and weekly limits the prompt used, like `4% of your 5-hour limit` | Claude Code itself, the same numbers as `/usage` |
| An API key | dollars | token counts × Anthropic's API prices, which is that bill |

On a plan, the API price is shown next to it only for comparison. Plans need this once:

```
npx backlens statusline --install
```

Claude Code hands its status line your plan's limit use on every update, so backlens sits in front of the status line you already have (it keeps printing exactly what it did), saves only those two percentages to `~/.config/backlens`, and passes everything on. `--uninstall` puts your old status line back. The share covers all your Claude use while the prompt ran, chats included.

One real run, a 59-file NestJS API, one prompt with no file names in it:

```
3 issues found and fixed, tests green          2.5 min, 804k tokens (Opus 5.5, $0.61 at API prices)
backlens calls 10, files read 3, edits 4
backlens handed the agent 5k tokens instead of up to 40k of source: 88% less to read
```

The "without backlens" figure is an estimate: the size of the app's source an agent would have to search, against what backlens gave it. Reading code also can't count queries or time them, so it can't prove a fix.

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
- **Agents**: what each Claude Code prompt that used backlens cost.

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
| Database | Postgres through `pg` (Client and Pool): drizzle, Kysely, knex, raw SQL; Prisma 5, 6 and 7 |
| Cache | `ioredis`, `redis` (node-redis v4 and v5) |
| Outgoing calls | `fetch`, and anything on `http`/`https`: axios, got, node-fetch, most SDKs |
| Modules | CommonJS and ESM, vitest included |
| Runtime | Node 20+, tested on macOS; Linux should work the same way |

Not yet: mysql2, MongoDB, Windows.

Redis passwords never show: `AUTH`, `HELLO` and similar commands are recorded by name only.

## Privacy and safety

- **Values never leave your app.** Query parameters and results become short hashes; emails, IPs and ids in Redis keys are masked.
- **The dashboard is yours only.** It listens on 127.0.0.1, needs the private token in the link it prints, and refuses requests from other websites. For `backlens mcp`, the token is kept in `.backlens/session.json`, readable by you only, ignored by git, and deleted when backlens stops.
- **It runs only scripts from your `package.json`,** by name.
- **Files change only when you click Apply,** with a copy kept first. Revert never overwrites edits you made afterwards.
- **AI sees only what the preview shows.** Secret-looking values are masked; `.env` and `node_modules` are never read.
- **Replaying writes is off by default,** since it changes your dev database again.
- **Agent costs come from counts only.** The Agents tab and `usage` read token counts and tool names from Claude Code's logs on your machine; prompts, code and replies are skipped. `backlens statusline` keeps only your plan's two limit percentages.
- **Indexes are built from checked table and column names** through your app's own connection: backlens never sees a database password.

## How it works

`backlens` starts the dashboard, then runs your app with `NODE_OPTIONS=--require backlens/register`. Inside your app, the recorder:

- times each request on Node's own HTTP server, so any framework on top of it works;
- wraps `pg`, Prisma, `ioredis`, node-redis, `fetch` and outgoing `http`/`https`, and records the line of your code behind each call, through V8's async stack traces for ORMs like drizzle and through source maps for bundled code;
- asks Postgres for each distinct SELECT's plan with `EXPLAIN (GENERIC_PLAN)` (Postgres 16+), which never runs the query, and flags full-table reads no index covers.

## Limits

- The "wait for each other" hint skips calls that use an earlier call's result, but it cannot see every dependency: read it as a question, not a verdict.
- The index advisor needs Postgres 16+ and looks at equality filters and the sort above them. With Prisma it needs a `pg` driver adapter (the default in Prisma 7).
- Prisma on its Rust engine (5 and 6) is read through Prisma's tracing hook. If your app sets up `@prisma/instrumentation` itself, yours takes precedence and backlens sees only Prisma 7 or adapter queries.
- Timings on a dev machine are rough; query counts are exact.

## Develop

```
git clone https://github.com/shayandutta/backlens
cd backlens && npm install
node --test test/
```

Bug reports and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem privately, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Shayan Dutta
