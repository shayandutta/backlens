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
    subcommand: ['test', 'mcp', 'statusline'].includes(own[0]) ? own[0] : null,
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

  backlens statusline --install | --uninstall
      For Claude Pro and Max: lets backlens see how much of your plan's 5-hour and weekly
      limits each prompt uses, through Claude Code's status line. Your own status line
      keeps running as before. --uninstall puts it back exactly.

  backlens test [--baseline file] [--update-baseline] [--strict] [--json file] -- <test command>
      For CI: run your tests, print the report, exit 1 on new issues.
`;
