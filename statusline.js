#!/usr/bin/env node
/**
 * Stable entry for `backlens statusline --install`: Claude Code's settings.json runs this exact
 * file on every status line update, so it must stay at the package root across versions.
 */
import { fileURLToPath } from 'node:url';
import { runStatusline } from './src/statusline/statusline.js';

export * from './src/statusline/statusline.js';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await runStatusline();
