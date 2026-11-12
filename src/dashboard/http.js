import { timingSafeEqual } from 'node:crypto';

/** Small HTTP helpers for the dashboard server: JSON in and out, and its access checks. */

const MAX_BODY = 4 * 1024 * 1024;

export function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export const noContent = (res) => res.writeHead(204).end();

/** The request body as JSON, `{}` when empty, null when it is not JSON or over 4 MB. */
export function readJson(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/**
 * The dashboard listens on 127.0.0.1 only. Every request must name this host (so a DNS-rebinding
 * page cannot reach it) and carry the session token, and browser requests must come from the
 * dashboard's own origin.
 */
export function accessChecks(token, port) {
  const tokenBuf = Buffer.from(token);
  return {
    tokenOk: (value) => typeof value === 'string' && value.length === token.length && timingSafeEqual(Buffer.from(value), tokenBuf),
    hostOk: (host) => [`localhost:${port()}`, `127.0.0.1:${port()}`, `[::1]:${port()}`].includes(host),
    originOk: (origin) => !origin || origin === `http://localhost:${port()}` || origin === `http://127.0.0.1:${port()}`,
  };
}
