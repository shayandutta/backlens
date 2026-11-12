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

Where things live: see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full map and the
dependency rules between layers. In short:

| Folder | What it does |
|---|---|
| `src/recorder/` | the recorder loaded inside the app (CommonJS, no dependencies): requests, `pg`, Redis, Prisma, outgoing HTTP, call sites, the index advisor |
| `src/analysis/` | pure functions: recorded requests → issues, routes and the map |
| `src/dashboard/` | the local server, its API, the app and test processes, replays; `ui.html` is the page |
| `src/ai/` | Explain and Fix: context, providers, the fix pipeline, built-in templates, keys |
| `src/mcp/` | the MCP server for AI editors |
| `src/report/` | the CI report and baseline |
| `src/cli/` | one module per subcommand |

Before a pull request: `npm run check && npm test`. For changes to recording or analysis, also run
`node bin/backlens.js test --json out.json -- <your app's test command>` on a real app before and
after, and compare.

## Pull requests

- Keep each one to one change, with a test in `test/` when behaviour changes.
- `node --test test/` must pass.
- No new runtime dependencies without a good reason: backlens runs inside other people's apps.
- Anything that touches privacy (what is recorded, sent to a model, or written to disk) needs a note in the PR saying why it is safe.

By contributing you agree your work is released under the [MIT license](LICENSE).

## Releasing

1. Bump `version` in `package.json` (and `package-lock.json` via `npm install --package-lock-only`), add a `CHANGELOG.md` entry.
2. Merge to `main` with CI green.
3. Tag and push: `git tag v<version> && git push origin v<version>`. The `release` workflow checks the tag matches `package.json`, runs `check` and the tests, and publishes to npm with provenance through npm trusted publishing (configured on npmjs.com for `shayandutta/backlens`, `release.yml`; no token needed).
