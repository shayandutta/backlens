import http from 'node:http';

/**
 * Sends one command to the recorder inside the app (see recorder/index-advisor.cjs): create, drop
 * or describe an index, through the app's own database connection. Carries the session token.
 */
export function appCommand(port, token, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: '/__backlens/index', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-backlens-token': token } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let out = null;
          try {
            out = JSON.parse(raw);
          } catch {}
          if (res.statusCode === 200 && out) resolve(out);
          else reject(new Error((out && out.error) || 'The app did not answer. Is it running with backlens?'));
        });
      },
    );
    r.setTimeout(10 * 60 * 1000, () => r.destroy(new Error('Creating the index took over 10 minutes.')));
    r.on('error', (err) => reject(new Error(`Could not reach the app: ${err.message}`)));
    r.end(payload);
  });
}
