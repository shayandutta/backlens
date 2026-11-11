// Parses every source file with `node --check`: a fast guard against syntax errors in files the
// tests do not load (backlens has no build step to catch them).
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(c|m)?js$/.test(e.name)) files.push(p);
  }
};
for (const dir of ['bin', 'src', 'test', 'scripts']) walk(dir);
files.push('statusline.js');
let bad = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    bad++;
    process.stderr.write(`${f}\n${err.stderr}\n`);
  }
}
console.log(`${files.length - bad}/${files.length} files parse`);
process.exit(bad ? 1 : 0);
