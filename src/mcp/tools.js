/** The tools backlens offers an agent: names, descriptions and input schemas (MCP tools/list). */

export const TOOLS = [
  {
    name: 'status',
    description: 'Whether backlens is recording this project, the app state, and how much traffic and how many issues it has seen. Call this first.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_issues',
    description:
      'Performance issues found in real requests to the app, worst first: N+1 queries, the same call made twice in one request, independent calls awaited one after another, and missing Postgres indexes. Each has the route, the file:line behind it, the statements involved, a suggested fix and an example request id.',
    inputSchema: { type: 'object', properties: { route: { type: 'string', description: 'Only issues on this route, like "GET /v1/reviews".' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_routes',
    description: 'Every route of the app with calls, p50 and p95 time, and database, Redis and outgoing HTTP calls per request.',
    inputSchema: { type: 'object', properties: { include_uncalled: { type: 'boolean', description: 'Also list routes the app registered that nobody has called yet.' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_requests',
    description: 'Recent requests the app served, newest first, with their ids for get_request and measure_request.',
    inputSchema: {
      type: 'object',
      properties: {
        route: { type: 'string', description: 'Only requests on this route, like "GET /v1/reviews".' },
        limit: { type: 'number', description: 'How many (default 20, at most 100).' },
        from: { type: 'string', enum: ['app', 'tests'], description: '"tests" lists the last run_tests requests instead of app traffic.' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_request',
    description:
      'One recorded request as a waterfall: every SQL query, Redis command and outgoing HTTP call in order, with timing and the file:line of the code that made it, plus the issues in it. Parameter values are never recorded.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'measure_request',
    description:
      'Replays a recorded read request (GET) against the app as it runs now, a few warm-up runs and then measured runs: median time with its p25-p75 range, query count, and which issues are still there. Each measurement is taken on a fresh app run (backlens restarts the app first when needed) and saved; measuring the same request again compares like with like and says whether the time change is real or within noise. Call it BEFORE changing code, then again after. Writes (POST, PUT, DELETE) only with sandbox: true: every replay runs inside a Postgres transaction that is rolled back, and a request that called out over HTTP is refused.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'A request id from list_requests, an issue, or a run_tests request.' }, sandbox: { type: 'boolean', description: 'Replay a write inside a rolled-back transaction (Postgres through pg only; Redis writes are not undone and are listed).' }, runs: { type: 'number', description: 'Measured runs (default 5, at most 20).' }, as: { type: 'string', description: 'Send it signed in as this login profile (a role saved with save_login, like "admin"). backlens signs in and adds the token; you never see it.' } },
      required: ['id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'measure_url',
    description:
      'Sends a GET to a path on the running app (no cookies or headers, or signed in as a login profile with `as`), a few warm-up runs and then measured runs, and compares it with the last measurement of the same path (warm against warm). For public routes, signed-in routes with `as`, or when there is no recorded request to replay. Call it BEFORE changing code, then again after.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'A path on the app, like "/v1/reviews?page=2".' }, runs: { type: 'number', description: 'Measured runs (default 5, at most 20).' }, as: { type: 'string', description: 'Send it signed in as this login profile (a role saved with save_login, like "admin"). backlens signs in and adds the token; you never see it.' } },
      required: ['url'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'app_logs',
    description: "The app's recent output (stdout and stderr), as backlens runs it.",
    inputSchema: { type: 'object', properties: { lines: { type: 'number', description: 'How many lines (default 80, at most 400).' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'restart_app',
    description: 'Restarts the app (or starts it if stopped) and waits until it listens again. backlens may already restart it on file changes.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'run_tests',
    description:
      "Runs the project's test script with recording on and waits for it: the exit code, how many requests the tests made, and the issues found in that traffic (new ones are not in backlens.baseline.json).",
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'save_login',
    description:
      'Saves how to sign in as a role, from a recorded sign-in request (find it with list_requests, usually a POST to a login route): after that, measure_url, measure_request and diff take `as: "<role>"` and backlens signs in by itself. Passwords are stored as references to the project\'s .env variables (or kept in memory for this session when no .env holds them); you never see a password or token. Do this once per role per project.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The role, like "admin" or "learner".' },
        id: { type: 'string', description: 'The recorded sign-in request id.' },
        default: { type: 'boolean', description: 'Use this role for signed-in routes when none is given.' },
      },
      required: ['name', 'id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'diff',
    description:
      "What your change did to the running app: replays one recorded read per route (up to 30) and compares each with the baseline: status, response shape (fields and types, never values), queries, Redis and outgoing calls, errors and new performance issues (time only when asked: it is noisy right after a change; use measure_request for timing). ✗ broken (failing status, lost field, changed type, new error), ~ changed, ↑ better. Silent when nothing changed. The first call takes the baseline; call it again after changing code. Restarts the app first when needed so timings compare fresh against fresh.",
    inputSchema: {
      type: 'object',
      properties: { route: { type: 'string', description: 'Only this route, like "GET /v1/reviews".' }, time: { type: 'boolean', description: 'Also flag routes more than 2x and 10 ms slower (coarse).' } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'accept',
    description: "Takes the routes' current behavior as the new baseline: after a diff showed an intended change. Give routes to accept only those; with none, every route is re-taken from current traffic.",
    inputSchema: { type: 'object', properties: { routes: { type: 'array', items: { type: 'string' }, description: 'Routes to accept, like ["GET /v1/reviews"]. Omit for all.' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'mutate',
    description:
      "Mutation lab: are this app's guards protected? Breaks one guard at a time in the code real requests ran through (removes an auth check or access decorator, shifts a >= boundary), restarts the app, runs the behavior diff and the tests, and puts the file back exactly. Reports each change nothing noticed: a gap an agent could fall into silently. Slow (a restart, a diff and a test run per change).",
    inputSchema: { type: 'object', properties: { max: { type: 'number', description: 'Guard changes to try (default 8, at most 30).' }, tests: { type: 'boolean', description: 'Also run the test script for each (default true).' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'doctor',
    description:
      "Whether backlens's numbers can be trusted on this app: the libraries the recorder hooked into (with versions, and whether each is on a tested version or shared with another instrumentation tool), and the measured cost of recording a request. Call it when results look odd.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'report',
    description:
      'Markdown evidence of what backlens checked during this work, for a pull request description: the last behavior diff, breaks caught on the way, intended changes accepted, and measured before → after per request. From records written as the checks ran.',
    inputSchema: { type: 'object', properties: { hours: { type: 'number', description: 'How far back (default 24).' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'usage',
    description:
      'What this work cost in Claude Code: tokens and dollars for the current prompt, the session and the last 30 days of prompts that used backlens, and an estimate of what finding the same issues by reading code would take. Call it last, and end your report with its first line.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
];
