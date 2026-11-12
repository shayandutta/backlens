/**
 * Whether a request's sign-in has expired, when it can tell: a bearer JWT carries its own expiry
 * (`exp`). Read without verifying (the app does that); nothing is sent anywhere.
 * Returns true (expired), false (still valid) or null (no JWT, no exp: cannot tell).
 */
export function jwtExpired(headers, now = Date.now()) {
  const auth = headers && (headers.authorization || headers.Authorization);
  const m = typeof auth === 'string' && auth.match(/^Bearer\s+([\w-]+)\.([\w-]+)\.[\w-]*$/i);
  if (!m) return null;
  try {
    const claims = JSON.parse(Buffer.from(m[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (typeof claims.exp !== 'number') return null;
    // A minute of margin: a token about to expire will expire during the replays.
    return claims.exp * 1000 <= now + 60_000;
  } catch {
    return null;
  }
}
