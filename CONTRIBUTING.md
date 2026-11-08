# Contributing to backlens

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an issue with:

- what you ran (`npx backlens`, `backlens test -- …`) and your Node version
- your stack: framework (express, fastify, nest, Next.js…), database driver and ORM
- what you expected and what happened, with the dashboard's message or the terminal output

Please leave out secrets, database contents and real user data. backlens never needs them to reproduce a problem.

## Working on the code

```
git clone https://github.com/shayandutta/backlens
cd backlens && npm install
node --test test/
```

To try your copy on an app, run it from that app's folder:

```
node /path/to/backlens/bin/backlens.js
```

Where things live:

| File | What it does |
|---|---|
| `register.cjs` | the recorder loaded inside the app: requests, `pg`, `ioredis`, node-redis, `fetch`, outgoing `http`/`https`, call sites, the index advisor |
| `analyze.js` | turns recorded requests into issues, routes and the map |
| `server.js` | the dashboard server and its API |
| `ui.html` | the dashboard, one file, no build step |
| `ai/` | explain and fix: context, providers, the fix loop, built-in templates, saved keys |
| `report.js` | the CI report and baseline |

## Pull requests

- Keep each one to one change, with a test in `test/` when behaviour changes.
- `node --test test/` must pass.
- No new runtime dependencies without a good reason: backlens runs inside other people's apps.
- Anything that touches privacy (what is recorded, sent to a model, or written to disk) needs a note in the PR saying why it is safe.

By contributing you agree your work is released under the [MIT license](LICENSE).
