import { readFileSync } from 'node:fs';

/** backlens's own version, from package.json. */
export const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
