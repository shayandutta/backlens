import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * backlens's folder in the user's config directory (~/.config/backlens): keys, plan limits and the
 * status line state live here, outside every project, so none of it can be committed with the code.
 * BACKLENS_HOME overrides it (tests use this).
 */
export function configDir() {
  if (process.env.BACKLENS_HOME) return process.env.BACKLENS_HOME;
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'backlens');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'backlens');
}
