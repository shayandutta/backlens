import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Recorded answers, for tests, demos, and the default when no model is set up: nothing is sent
 * anywhere. Fixes come from .backlens/ai-fixtures.json, [{ match, response }].
 */
export function mockAnswer(task, issue, root) {
  if (task === 'explain') {
    return {
      data: {
        summary: `${issue.title} on ${issue.route}.`,
        why_it_matters: issue.type === 'serial' ? `Running these together could save up to about ${issue.cost} ms per request (an estimate), in ${issue.seen} of ${issue.of} requests seen.` : `Each time, about ${issue.cost} ms goes to work the request already did, in ${issue.seen} of ${issue.of} requests seen.`,
        how_to_fix: issue.fix,
      },
      costUsd: 0,
    };
  }
  const file = join(root, '.backlens', 'ai-fixtures.json');
  if (existsSync(file)) {
    try {
      for (const f of JSON.parse(readFileSync(file, 'utf8'))) {
        if (`${issue.title} ${issue.sites.join(' ')} ${issue.sql}`.includes(f.match)) return { data: f.response, costUsd: 0 };
      }
    } catch {}
  }
  return { data: { explanation: 'The mock provider has no recorded fix for this issue.', confidence: 'low', edits: [], notes: 'Pick the local model or Claude in AI settings for a real suggestion.' }, costUsd: 0 };
}
