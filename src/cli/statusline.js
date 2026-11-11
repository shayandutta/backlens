import { dim, bold } from '../shared/ansi.js';
import { install, runStatusline, uninstall } from '../statusline/statusline.js';

/** `backlens statusline [--install | --uninstall]`; with neither flag it runs as the status line itself. */
export async function runStatuslineCommand({ args }) {
  if (args.has('--uninstall')) {
    const r = uninstall();
    console.log(r.changed ? `backlens: status line restored${r.restored ? ` to ${r.restored}` : ' (none was set before)'}.` : 'backlens: the status line is not backlens; nothing changed.');
    return;
  }
  if (!args.has('--install')) {
    await runStatusline();
    return;
  }
  const r = install();
  if (r.already) {
    console.log(`backlens: already recording plan limits${r.wrap ? `, and running your status line: ${r.wrap}` : ''}.`);
    return;
  }
  console.log(`backlens: Claude Code's status line now goes through backlens, which records only your plan's 5-hour and weekly limit use.`);
  console.log(r.wrap ? `  your status line still runs, unchanged: ${dim(r.wrap)}` : '  you had no status line, so it stays empty.');
  console.log(`  changed: ${dim('statusLine')} in ${dim('~/.claude/settings.json')}. Undo: backlens statusline --uninstall`);
  if (r.inNpxCache) console.log(`  note: this points into npx's cache, which can be cleared. ${bold('npm i -g backlens')} and install again to keep it.`);
  console.log('  Takes effect on the next status line update in Claude Code.');
}
