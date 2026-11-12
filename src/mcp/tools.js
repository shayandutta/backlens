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
      properties: { route: { type: 'string', description: 'Only requests on this route, like "GET /v1/reviews".' }, limit: { type: 'number', description: 'How many (default 20, at most 100).' } },
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
      'Replays a recorded read request (GET) against the app as it runs now, a few warm-up runs and then measured runs: median time with its p25-p75 range, query count, and which issues are still there. Each measurement is taken on a fresh app run (backlens restarts the app first when needed) and saved; measuring the same request again compares like with like and says whether the time change is real or within noise. Call it BEFORE changing code, then again after. Writes are never replayed.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'A request id from list_requests or an issue.' }, runs: { type: 'number', description: 'Measured runs (default 5, at most 20).' } },
      required: ['id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'measure_url',
    description:
      'Sends a plain GET to a path on the running app (no cookies, no headers), a few warm-up runs and then measured runs, and compares it with the last measurement of the same path (warm against warm). For public routes, or when there is no recorded request to replay. Call it BEFORE changing code, then again after.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'A path on the app, like "/v1/reviews?page=2".' }, runs: { type: 'number', description: 'Measured runs (default 5, at most 20).' } },
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
    name: 'usage',
    description:
      'What this work cost in Claude Code: tokens and dollars for the current prompt, the session and the last 30 days of prompts that used backlens, and an estimate of what finding the same issues by reading code would take. Call it last, and end your report with its first line.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
];
