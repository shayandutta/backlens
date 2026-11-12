# Roadmap: from query fixer to the runtime layer for coding agents

## Thesis

Coding agents work blind. They read code to guess what it does, claim "done" without running it,
and spend most of a session finding out how to run, sign in to and check the app. backlens already
sits where that is cheapest to fix: inside the running app, with every request, call and code line.

The product shift: **backlens tells the agent what its change did to the running app, after every
turn, and stays silent when nothing changed.** Performance becomes one lens among several:
errors, behavior changes, cost.

Pitch it as runtime truth that leads to fewer wrong fixes and fewer unverified claims. Fewer tokens
follows from that, but it is not the headline.

## The problems it answers

| Problem with agents today | What it costs | backlens answer |
|---|---|---|
| Cold start: how to run, sign in, seed, hit a route | 10–20 tool calls per session | Access broker (one call) |
| Behavior guessed by reading code | many file reads, wrong guesses | "What runs for this URL" from traces |
| Claims without proof | false "done", wasted review | Measured before/after, honest numbers |
| Tests pass while behavior changed | silent regressions | Behavior diff across all routes |
| Breaking a route the agent never touched | late, expensive bugs | Behavior diff across all routes |
| Fragile env handling (ports, stale processes, versions) | stalled sessions | backlens owns the app lifecycle |
| Secrets in model context, writes to real data | leaks, damage | Credentials injected, replays read-only or sandboxed |
| Human review is the bottleneck | throughput cap | Evidence report on every PR |
| Naive code ships (N+1, serial awaits, chatty APIs) | cloud and API bills | Today's checks, kept |

Out of scope: project conventions, scope creep, non-determinism. These are not runtime problems.

## Principles

1. **Silent unless something changed.** No output, or at most five lines. Noise makes people turn it off.
2. **Evidence, not claims.** Every number is measured. A comparison is warm against warm, median against median, with the noise band shown.
3. **Fast.** A check finishes in seconds, or it will not run after every turn.
4. **Safe by default.** Replays are read-only. Writes run only in a sandbox. Credentials and values never reach the model. A production database is refused.
5. **Local-first, zero setup.** One command. Nothing leaves the machine unless the user picks a cloud model.
6. **Works with any agent.** The core does not depend on a harness. Small adapters connect it to Claude Code, Cursor, Codex and others.

## The guardrail layer

```
 Agent harness (Claude Code / Cursor / Codex / CI)
   │ hooks: Stop, PostToolUse        │ MCP tools
   ▼                                 ▼
 ┌──────────────── harness adapters  (src/harness/) ─────────────────┐
 │ init <agent>: writes hooks + MCP config; turns verdicts into       │
 │ block / allow decisions in each agent's own hook format            │
 └──────────────────────────────┬────────────────────────────────────┘
                                ▼
 ┌──────────── guard core (local, no network) ────────────────────────┐
 │ access broker   (src/access/)  run · auth profiles · seed · hit    │
 │ behavior diff   (src/diff/)    baseline · fingerprints · compare   │
 │ verification gate              verdicts: ✗ broken / ↑ better / ~   │
 │ write sandbox   (src/sandbox/) rolled-back tx or DB branch  [v2]   │
 │ evidence ledger (src/evidence/) per-turn record → PR report [v2]   │
 │ policy          budgets · read-only · no-prod · secret scrubbing   │
 └──────────────────────────────┬────────────────────────────────────┘
                                ▼
   existing: recorder · analysis · replay · dashboard · agent-usage
```

### 1. Access broker

- **Login profiles.** Capture a login once per role (admin, learner, anonymous), either from a recorded login request or from a small config. Refresh expired tokens by replaying the login.
- **Replay as a role.** Any recorded or synthetic GET can run as any role. The agent names the role and never sees the token or password.
- **Run and seed.** Start the app, wait for its port, and run the seed script when needed. This is mostly there today.
- **Test traffic becomes replayable.** Keep replay payloads for test requests, so the requests that `run_tests` makes can be measured.

### 2. Behavior diff

- **Baseline.** One representative GET per route (up to about 30), picked from dev and test traffic. Stored in `.backlens/baseline/`.
- **Fingerprint per request:**
  - status code
  - response shape: JSON keys and types, no values
  - normalized query fingerprints and their count
  - Redis and HTTP calls
  - errors with `file:line`
  - median latency
- **Compare.** Replay the baseline with 1 warm-up and 3 runs. Flag:
  - a status class change
  - a new error or a changed shape
  - a query-count change, or a new N+1 or serial await
  - a new outgoing call
  - latency: off by default since Phase 2 (see WORKLOG 2026-11-12: right after a code change a
    dev watcher compiling in the background made clean routes look 2–4× slower). Opt in with
    `--time` / `time: true`: more than 2× and 10 ms, every run past every baseline run, re-run to
    confirm, dropped when a third of the routes move together.
- **Accept.** `backlens accept [route]` takes an intended change into the baseline.

### 3. Verification gate (harness)

- **Claude Code.** A `Stop` hook runs the diff. A break (✗) blocks the stop and hands the agent a five-line reason, so the agent fixes it in the same turn. Improvements (↑) are reported and don't block.
- **MCP.** A `diff` tool lets any agent ask on demand, and an `accept` tool records intended changes.
- **CI.** `backlens diff --ci` fails the build on breaks, with the existing baseline mechanics.
- **Adapters.** Cursor and Codex adapters come later, with the same core and verdicts.

### 4. Write sandbox (v2)

Replay POST, PUT and DELETE requests inside a transaction that is rolled back. Where the app's
connection handling prevents that, use a database branch or a template database. This covers the
routes where most bugs live, and it is the hardest part for anyone else to copy.

### 5. Evidence ledger and PR report (v2)

- Record each turn's verdicts and measurements.
- `backlens report --pr` writes a before → after table from real runs into the PR description, which gives reviewers proof.

### 6. Policy

These already exist and stay on:
- daily AI budget
- secret scrubbing
- read-only replay
- values hashed

New:
- Refuse to run against a database whose host is not local unless explicitly allowed.
- Cap hook runtime, and on a timeout warn instead of blocking.

## Phases

| Phase | Deliverable | Done when |
|---|---|---|
| 0 ✅ | Modular refactor, docs, CI | 60 tests pass; identical e2e output on a real API |
| 1 ✅ | Fix the credibility gaps (FEATURES.md "Known gaps", fixed list) | measure compares warm median vs warm median; index hints skip tiny tables and covered filters; `status` shows MCP and recorder versions and warns on mismatch; README pins `@latest` |
| 2 ✅ | Behavior diff MVP: baseline, fingerprints, diff engine, `backlens diff` CLI + MCP `diff`/`accept` | catches a seeded break (500, shape change, extra query) on a real app in < 5 s for 30 routes; < 1 false alarm per 10 clean runs |
| 3 ✅ | Access broker: login profiles, replay as role, replayable test traffic | an agent measures a signed-in route with zero setup calls |
| 4 ◐ | Harness: `backlens init claude` (Stop-hook gate, MCP config), accept flow | the hook blocks a broken turn and the agent fixes it unaided |
| 5 ◐ | Proof: eval of 20–30 real tasks on 3+ apps, with and without backlens | published numbers: tokens per task, task success, regressions shipped, false alarms |
| 6 ◐ | Write sandbox, PR evidence report, Cursor/Codex adapters, Next.js full-stack | — |

Phase 4 ◐: the hook blocked a real break from a real agent run, and the agent reacted unaided
(it accepted, since the change was intended). A run where the agent must fix an unintended break
is still to do. Phase 5 ◐: eval harness built, no runs. Phase 6 ◐: write sandbox (pg, measure
only), PR report, Codex and Cursor hooks; not Next.js full-stack or sandboxed writes in `diff`.
See WORKLOG 2026-11-12.

Phase 1 comes first because the diff verdicts rely on the same measurement. If backlens overclaims
there, users will stop believing its verdicts.

## Success metrics

- Tokens per task and task success, with and without backlens, measured with the existing `usage`
  tool and the eval harness.
- Regressions caught that tests missed: at least 1 in every 5 sessions with changes.
- False alarms: fewer than 1 in every 10 sessions.
- Diff time: under 5 s for 30 routes.

## Risks

- **Noise** from non-deterministic responses, data drifting between runs, or a slow dev machine. Mitigations: shape fingerprints, medians, thresholds.
- **Baseline drift** without an easy accept flow.
- **Auth edge cases:** OAuth-only apps, CSRF tokens, short-lived tokens.
- **Platforms building their own.** Observability vendors are shipping MCP servers, and agent harnesses are adding "run the app" features. The edge to keep is the local dev loop plus code-line attribution plus replay plus write sandboxing.
- **Restart time** is added to every check.

## Open decisions

1. **Audience first:** engineers using agents (they pay, and want evidence and review) or vibe coders (bigger market, no tests, high churn). Recommended: engineers first, with plain-language verdicts that vibe coders also get.
2. **Packaging:** keep one `backlens` package with a `guard` mode, or split out a second package. Recommended: one package.
3. **TypeScript:** stay with JS and JSDoc (no build step, nothing extra inside users' apps), or migrate. Recommended: add `// @ts-check` and JSDoc types to `src/` first.
4. **Write sandbox approach:** transaction rollback (simple, but breaks apps that manage their own transactions) or database branching (robust, but heavier setup).
