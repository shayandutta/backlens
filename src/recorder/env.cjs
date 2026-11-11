'use strict';
/** What the dashboard tells the recorder through the environment when it starts the app. */

const fs = require('node:fs');
const path = require('node:path');

/** The dashboard's ingest URL. Without it the recorder stays off. */
const TARGET = process.env.BACKLENS_URL;
const TOKEN = process.env.BACKLENS_TOKEN || '';
/** 'app' or 'test': which process this is. */
const SOURCE = process.env.BACKLENS_SOURCE || 'app';
// Stack traces hold real paths, so a project reached through a symlink must be resolved too.
const ROOT = (() => {
  const root = process.env.BACKLENS_ROOT || process.cwd();
  try {
    return fs.realpathSync(root);
  } catch {
    return root;
  }
})();
/** backlens's own package folder: its frames are never the app's code. */
const SELF = path.resolve(__dirname, '..', '..');

module.exports = { TARGET, TOKEN, SOURCE, ROOT, SELF };
