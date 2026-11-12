import assert from 'node:assert/strict';
import { test } from 'node:test';
import { raceFindings, tally, usesLocks } from '../src/race/verdict.js';
import { raceText } from '../src/race/format.js';

const t = (status, spans = []) => ({ status, spans });
const dec = { kind: 'db', name: 'update stock set qty = qty - 1 where id = $1', rows: 1 };

test('more successes at once than one after another is a confirmed race', () => {
  const seq = tally([t(200, [dec]), t(409), t(409)]);
  const conc = tally([t(200, [dec]), t(200, [dec]), t(200, [dec])]);
  assert.deepEqual([seq.ok, seq.refused, seq.rows], [1, 2, 1]);
  const f = raceFindings(seq, conc);
  assert.equal(f[0].kind, 'race');
  assert.equal(f[0].confidence, 'confirmed');
  assert.match(f[0].what, /3 of 3 copies succeeded at once, but only 1 one after another/);
});

test('the same outcome both ways is quiet; locks make a finding "check"; jobs and 5xx are counted', () => {
  const same = tally([t(200, [dec]), t(409), t(409)]);
  assert.deepEqual(raceFindings(same, same), []);
  const conc = tally([t(200, [dec]), t(200, [dec]), t(409)]);
  const locked = [t(200, [{ kind: 'db', name: 'select qty from stock where id = $1 for update' }])];
  assert.ok(usesLocks(locked));
  assert.equal(raceFindings(same, conc, { locks: usesLocks(locked) })[0].confidence, 'check');
  const job = { kind: 'job', name: 'ENQUEUE mail:welcome' };
  const jobs = raceFindings(tally([t(200, [job]), t(200)]), tally([t(200, [job]), t(200, [job])]));
  assert.match(jobs.find((x) => /duplicate jobs/.test(x.what)).what, /queued 2 jobs at once against 1/);
  const fails = raceFindings(tally([t(200), t(409)]), tally([t(200), t(500)]));
  assert.equal(fails[0].kind, 'changed');
  assert.match(raceText({ copies: 3, races: 0, results: [{ route: 'POST /buy', seq: same, conc: same, findings: [] }] }), /same outcome at once/);
});
