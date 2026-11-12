import { isRead } from '../analysis/index.js';

/**
 * Whether a recorded write may be replayed in the sandbox, judged from what it did when it was
 * recorded. Refused: any outgoing HTTP call (it could send an email or take a payment, and no
 * rollback undoes that) and any database call not made through `pg` (Prisma's own engine, other
 * drivers: outside the transaction). Redis writes are allowed but listed, since they are not undone.
 */
export function sandboxCheck(trace) {
  const spans = trace.spans || [];
  const http = spans.filter((s) => s.kind === 'http');
  if (http.length) return { ok: false, why: `it called out over HTTP (${[...new Set(http.map((s) => String(s.name).split(/\s+/).slice(0, 2).join(' ')))].slice(0, 2).join(', ')}), which a rollback cannot undo` };
  const db = spans.filter((s) => s.kind === 'db');
  if (db.some((s) => s.drv !== 'pg')) return { ok: false, why: 'some of its database calls do not go through pg (Prisma engine or another driver), so they would not be rolled back' };
  const redisWrites = [...new Set(spans.filter((s) => s.kind === 'redis' && !isRead(s)).map((s) => String(s.name).split(/\s+/)[0]))];
  return { ok: true, redisWrites };
}
