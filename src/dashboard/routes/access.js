import { validName } from '../../access/profiles.js';
import { json, readJson } from '../http.js';

/**
 * Login profiles. Saving one takes a recorded sign-in request by id; its secrets become ${env:NAME}
 * references (or stay in memory when no .env holds them). Nothing returned here contains a
 * password or token: only names, the login route, and whether signing in works.
 */
export default function accessRoutes({ store, access }) {
  const summary = () => {
    const all = access.profiles.all();
    return {
      default: access.profiles.defaultName(),
      file: access.profiles.file,
      profiles: Object.entries(all).map(([name, p]) => ({ name, sessionOnly: p.sessionOnly, login: `${p.login.method} ${String(p.login.url).split('?')[0]}` })),
    };
  };
  return [
    { method: 'GET', path: '/api/access', handle: (req, res) => json(res, 200, summary()) },
    {
      method: 'POST',
      path: '/api/access/save',
      async handle(req, res) {
        const body = await readJson(req);
        const name = body && body.name;
        if (!validName(name)) return json(res, 400, { error: 'Give the role a short name, like admin or learner.' });
        const payload = body && typeof body.id === 'string' ? store.replayOf(body.id) : null;
        if (!payload) return json(res, 404, { error: 'No recorded request with that id (or it was too large to keep). Sign in once in the app, then list_requests and pick the sign-in request.' });
        if (payload.method === 'GET') return json(res, 400, { error: 'That is a GET. Pick the request that signs in (usually a POST to a login route).' });
        let saved;
        try {
          saved = access.profiles.saveFromRequest(name, payload, access.env(), Boolean(body.default));
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
        access.sessions.forget(name);
        try {
          await access.sessions.headersFor(name, { fresh: true });
          return json(res, 200, { ...saved, signedIn: true, ...summary() });
        } catch (err) {
          return json(res, 200, { ...saved, signedIn: false, why: err.message, ...summary() });
        }
      },
    },
  ];
}
