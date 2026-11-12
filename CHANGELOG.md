# Changelog

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
