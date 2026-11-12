# Architecture

backlens is one npm package with no build step and no runtime dependencies besides the optional
Claude SDK and TypeScript (used only to rewrite code safely). Code is plain ES modules, except the
recorder, which is CommonJS because it is loaded with `node --require` inside other people's apps.

## Processes

```
            your terminal                               your app (child process)
 ┌──────────────────────────────────┐        ┌─────────────────────────────────────────┐
 │ bin/backlens.js                  │ spawns │ NODE_OPTIONS=--require src/recorder      │
 │  └ src/cli/studio.js             │───────▶│  recorder patches http, pg, redis,      │
 │     └ src/dashboard/server.js    │        │  prisma, fetch; one trace per request    │
 │        127.0.0.1:7777, token     │◀───────│  POST /ingest /advice /routes /listening │
 │        ├ page  (ui.html)         │        └─────────────────────────────────────────┘
 │        ├ API   (/api/*)          │──────▶ POST /__backlens/index  (create/drop index,
 │        └ replays, test runs      │        through the app's own pg pool, token-checked)
 └──────────────▲───────────────────┘
                │ .backlens/session.json (port + token, mode 600)
 ┌──────────────┴───────────────────┐
 │ backlens mcp  (src/mcp/server.js)│  stdio JSON-RPC ⇄ Claude Code / Cursor / any MCP client
 └──────────────────────────────────┘
```

`backlens test -- <cmd>` (src/cli/ci.js) starts the same server on a free port, runs the command
with the recorder inside, then judges the traces against `backlens.baseline.json`.

## Layout

```
bin/backlens.js            CLI entry: parses args, dispatches to src/cli/*
statusline.js              stable entry for `backlens statusline` (installed paths point here)
src/
  cli/                     one module per subcommand: studio, ci, diff (+ accept), statusline; args + help
  recorder/   (CommonJS)   runs inside the app
    index.cjs              entry (`backlens/register`): installs patches once, only if BACKLENS_URL
    env.cjs                what the dashboard passes through the environment
    context.cjs            AsyncLocalStorage per request; begin() = one span
    frames.cjs             app call sites from stack traces, through source maps
    privacy.cjs            hashes and fingerprints instead of values; key redaction
    transport.cjs          reports to the dashboard; token check
    incoming.cjs           http/https servers: one trace per request, replay payload
    shape.cjs              JSON response shape (paths and types, no values), on replays that ask
    index-advisor.cjs      EXPLAIN (GENERIC_PLAN) advice; create/drop the suggested index
    loader.cjs             patches libraries as they load (CJS hook + ESM via shared cache)
    drivers/               pg, redis (ioredis + node-redis), prisma, outgoing (http/https/fetch)
    frameworks/fastify.cjs route templates and registered routes
  analysis/   (pure)       traces → issues, routes, map. No I/O.
    check-trace.js         runs the checks on one trace
    checks/duplicates.js   n-plus-one, repeat
    checks/serial.js       calls awaited one after another
    index-advice.js        recorder advice → index issues
    summarize.js, map.js, routes.js, statements.js, frames.js
  diff/       (pure)       behavior diff: fingerprint of a request, compare with baseline, text
  report/                  baseline file, judge (new vs known), terminal format
  dashboard/               the local server
    server.js              composes everything; access checks; route table
    store.js               in-memory traces, test run, replays, fixed markers
    processes.js           the app and test child processes; file watching; recorder env
    replay.js              replay a recorded request and wait for its trace; measure (warm-up until stable)
    fresh.js               fresh app runs: restart before measuring when the run is used
    behavior.js            behavior diff: baseline per route, replay, compare, accept
    runner.js              one child process tree and its output
    test-report.js, app-command.js, http.js
    routes/                ingest, traffic, project, measure, behavior, indexes, ai
    ui.html                the dashboard page: one file, no build
  ai/                      Explain and Fix
    index.js               createAI(deps): status, explain, keys, fix jobs
    fix-jobs.js            the fix pipeline: propose → apply → typecheck → restart → replay → tests
    edits.js               model edits → exact, checked line replacements; diffs
    settings.js            per-project AI settings, daily budget, usage and history logs
    workspace.js           git state, package scripts, build detection
    context.js             the code an issue is about (enclosing functions, table definitions)
    router.js              who answers: template, local model, or which Claude tier
    templates.js           fixes written without a model (Promise.all)
    credentials.js         the user's Claude key in ~/.config/backlens
    providers/             mock, ollama, anthropic, shared prompts and answer parsing
  mcp/                     the MCP server: session discovery, tools, handlers, text formats
  agent-usage/             what Claude Code prompts using backlens cost (from its own logs)
  statusline/              Claude Code status line wrapper recording plan-limit use
  shared/                  small helpers used across layers (ansi, stats, project, config dir)
test/                      node:test suites, one per area
scripts/check-syntax.mjs   `npm run check`: parses every file
```

## Dependency rules

Arrows point from a layer to what it may import.

```
cli ─▶ dashboard ─▶ ai ─▶ analysis ─▶ shared
 │        │          │
 │        ├────────▶ diff ─▶ analysis
 │        ├────────▶ report ─▶ analysis
 │        └────────▶ agent-usage ─▶ statusline ─▶ shared
 ├──▶ report, statusline, diff (format)
 └──▶ mcp ─▶ agent-usage, diff (format)
recorder (CommonJS): imports only itself and node builtins
```

- `analysis/` and `diff/` are pure: no fs, no network, no clock except what traces carry.
- `ai/` never imports `dashboard/`: what it needs (restart the app, replay a request, run the
  tests) arrives as `deps` from `dashboard/server.js`.
- `recorder/` stays dependency-free and never throws into the app.
- `shared/` imports nothing from other layers.

## Stable public surface

These paths are used outside this repo and must not move:

| Path | Used by |
|---|---|
| `bin/backlens.js` (`backlens` bin) | users, `npx backlens` |
| `backlens/register` → `src/recorder/index.cjs` | `NODE_OPTIONS=--require backlens/register` |
| `statusline.js` (package root) | `~/.claude/settings.json` after `backlens statusline --install` |
| `.backlens/session.json` shape `{ port, token, pid, root, startedAt, version }` (`version` since 0.6; readers must accept it missing) | `backlens mcp` of another version |
| dashboard HTTP API `/api/*`, `/ingest`, `/advice`, `/routes`, `/listening` | `ui.html`, `backlens mcp`, the recorder |
| `backlens.baseline.json` and `stableKey` | committed by users for CI |
| `.backlens/behavior.json` `{ version: 1, at, entries: [{ route, method, path, url, authed, fingerprint, at }] }`, mode 600, no headers or values | `backlens diff` of another version |
| replay headers `x-backlens-replay`, `x-backlens-shape: 1` | the recorder inside the app (may be another version) |

## Conventions

- ES modules with explicit `.js` extensions; CommonJS (`.cjs`) only in `recorder/`.
- Each module starts with a comment saying what it is for; functions say why, not what.
- Factories (`createStore`, `createAI`, `createProcesses`) instead of classes, except `Runner`.
- Errors shown to users are full sentences that say what to do next.
- Privacy-affecting changes (what is recorded, sent to a model, or written to disk) need a note in
  the PR explaining why they are safe.

## Testing

- `npm test`: unit and integration suites (`node --test test/`). The recorder suite spawns real
  child processes with the recorder loaded.
- `npm run check`: every file parses.
- End-to-end: `node bin/backlens.js test --json out.json -- <an app's test command>` on a real
  project, and compare `out.json` before and after a change (issues, routes, counts).
