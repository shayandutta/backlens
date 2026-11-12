// Numbers, uuids, long hex, and long mixed-case tokens. Lowercase slugs like backend-engineering-vol-2 stay.
const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|(?=[\w-]*\d)(?=[\w-]*[A-Z])(?=[\w-]*[a-z])[\w-]{16,})$/;

/** /v1/lessons/3f8a…/start becomes /v1/lessons/:id/start. A framework's own template wins when known. */
export function routeOf(method, url, template) {
  if (template) return `${method} ${template}`;
  const path = url
    .split('/')
    .map((s) => (ID_SEGMENT.test(s) ? ':id' : s))
    .join('/');
  return `${method} ${path || '/'}`;
}

/** The route of a recorded trace. */
export const routeOfTrace = (t) => routeOf(t.method, t.url, t.template);
