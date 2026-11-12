/**
 * The command line: backlens's own flags before `--`, the app or test command after it.
 *
 *   backlens [flags] [-- command...]
 *   backlens <subcommand> [flags] [-- command...]
 */
export function parseArgs(argv) {
  const split = argv.indexOf('--');
  const own = split === -1 ? argv : argv.slice(0, split);
  const command = split === -1 ? [] : argv.slice(split + 1);
  return {
    own,
    command,
    subcommand: ['test', 'mcp', 'statusline', 'diff', 'accept', 'init', 'hook', 'report', 'doctor', 'mutate'].includes(own[0]) ? own[0] : null,
    has: (name) => own.includes(name),
    /** The value after a flag (`--port 7777`), or undefined. */
    flag: (name) => {
      const i = own.indexOf(name);
      return i === -1 ? undefined : own[i + 1];
    },
  };
}

export const HELP = `usage:
  backlens [--port 7777] [--no-open]
      Open the dashboard. Pick how your app starts once; after that, start, restart,
      run tests and review issues from the browser.

  backlens [--port 7777] -- <command>
      Same, but run this exact command as the app.

  backlens mcp [--root <project folder>]
      For AI editors (Claude Code, Cursor...): an MCP server over stdio that reads the
      running dashboard for this project: issues, requests, replays, logs and tests.

  backlens diff [--route "GET /path"] [--time] [--json]
      With the dashboard running: replay one read per route and compare with the baseline
      (status, response shape, queries, calls, errors; --time adds coarse timing).
      Exit 1 when something broke.
      The first run takes the baseline.

  backlens accept [route...]
      Take the current behavior of these routes (or all) as the new baseline.

  backlens init <claude|codex|cursor> [--uninstall] [--no-mcp] [--local]
      Connect a coding agent: adds the MCP server and a stop hook that runs the behavior
      diff when a turn changed files and sends the agent back when something broke.

  backlens hook stop [--harness claude|codex|cursor]
      The stop hook itself (reads the agent's hook input on stdin).

  backlens doctor [--json]
      With the dashboard running: which libraries the recorder hooked into (and whether
      each is on a tested version), and what recording costs a request on this app.

  backlens mutate [--max 8] [--no-tests]
      Mutation lab: breaks one guard at a time (auth checks, access decorators, boundaries)
      in the code requests ran through, and reports which changes neither the behavior
      diff nor the tests noticed. Files are put back exactly. Exit 1 on a gap.

  backlens report [--since <hours>] [--all]
      Markdown evidence for a pull request: behavior diffs, accepted changes and
      measurements recorded in .backlens/evidence.jsonl.

  backlens statusline --install | --uninstall
      For Claude Pro and Max: lets backlens see how much of your plan's 5-hour and weekly
      limits each prompt uses, through Claude Code's status line. Your own status line
      keeps running as before. --uninstall puts it back exactly.

  backlens test [--baseline file] [--update-baseline] [--strict] [--json file] -- <test command>
      For CI: run your tests, print the report, exit 1 on new issues.
`;
