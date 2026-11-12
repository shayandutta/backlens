import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { routeOf } from '../analysis/index.js';
import { usageOf } from '../diff/impact.js';
import { readLedger } from '../evidence/ledger.js';
import { recallText } from '../memory/recall.js';
import { projectDir } from '../shared/project-config.js';

/**
 * App memory, the dashboard side: notes in .backlens/memory.json (mode 600, text only, at most
 * MAX_NOTES), and recall over the ledger, the baseline and recorded traffic (see src/memory/recall.js).
 */

const MAX_NOTES = 200;
const MAX_TEXT = 500;

export function createMemory({ root, store, behavior }) {
  const file = join(projectDir(root), 'memory.json');

  function notes() {
    try {
      const m = JSON.parse(readFileSync(file, 'utf8'));
      return Array.isArray(m.notes) ? m.notes : [];
    } catch {
      return [];
    }
  }

  function save(list) {
    mkdirSync(projectDir(root), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ version: 1, notes: list.slice(-MAX_NOTES) }, null, 1)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }

  /** Adds a note ({ text, route, file }) or removes one ({ forget: id }). */
  function note({ text, route = null, file: f = null, forget = null }) {
    const list = notes();
    if (forget) {
      const left = list.filter((n) => n.id !== forget);
      if (left.length === list.length) return { error: `No note ${forget}.` };
      save(left);
      return { forgot: forget, notes: left.length };
    }
    const clean = String(text || '').trim().slice(0, MAX_TEXT);
    if (!clean) return { error: 'Give the note text.' };
    const id = `n${(list.reduce((m, n) => Math.max(m, Number(String(n.id).slice(1)) || 0), 0) + 1)}`;
    list.push({ id, at: Date.now(), text: clean, route: route || null, file: f || null });
    save(list);
    return { id, notes: list.length };
  }

  /** route -> { files, tables }, from the baseline's saved usage and the traffic recorded since. */
  function uses() {
    const byRoute = new Map();
    for (const t of store.traces) {
      const r = routeOf(t.method, t.url, t.template);
      if (!byRoute.has(r)) byRoute.set(r, []);
      byRoute.get(r).push(t);
    }
    const out = new Map();
    const b = behavior.list();
    for (const e of (b && b.entries) || []) if (e.uses) out.set(e.route, { files: [...e.uses.files], tables: [...e.uses.tables] });
    for (const [r, ts] of byRoute) {
      const u = usageOf(ts);
      const had = out.get(r) || { files: [], tables: [] };
      out.set(r, { files: [...new Set([...had.files, ...u.files])], tables: [...new Set([...had.tables, ...u.tables])] });
    }
    return out;
  }

  function recall({ route = null, file: f = null } = {}) {
    const { routes, issues } = store.summary();
    return recallText({ route, file: f, routes, uses: uses(), issues, ledger: readLedger(root), notes: notes() });
  }

  return { recall, note, notes };
}
