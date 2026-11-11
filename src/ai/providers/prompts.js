/**
 * What every provider is told, and how its answers are read. Fixes come back as plain text with
 * EDIT blocks (code inside JSON is where small models stumble); explanations as JSON.
 */

export const SYSTEM = `You are backlens's fix assistant. backlens watched a Node.js backend serve real requests and found a performance issue: a query or Redis call repeated within one request, an N+1 query loop, or calls awaited one after another.

You get the issue, the statements involved, and the code around every place in the app that made the calls. Every code line is shown with its line number, like "   74  const x = 1;". Line numbers are for reference and never part of the code.

Answer in exactly this format and nothing else:

EXPLANATION:
What the change does and why it removes the issue, or why no change is safe.

CONFIDENCE: high

EDIT src/path/to/file.ts 74-79
\`\`\`
the complete new code for lines 74 to 79, without line numbers, indented like the code around it
\`\`\`

NOTES:
Risks or assumptions, or why there are no edits.

Rules for edits:
- An EDIT replaces whole lines, from the first to the last number given (inclusive), using the numbers shown. The code block is everything that goes there instead; it can have more or fewer lines. An empty code block deletes the lines.
- Every EDIT uses the original line numbers shown, even after an earlier EDIT adds or removes lines. Never renumber.
- Write as many EDIT blocks as needed, or none if no change is safe. CONFIDENCE is high, medium or low.
- Only edit lines you were shown, in files you were shown. Edits must not overlap.
- Change as little as possible. Keep the code's style, names and types. Do not change behaviour: same results, same errors, same order of side effects. Only remove repeated work or run independent work together.
- For calls that wait for each other: first check whether any call uses a result of an earlier one (an id, a row, a value). If any does, they cannot run together: return no edits and say which call depends on which.
- If the issue is not real here, or a safe fix needs code you were not shown, return no edits and say why in notes.
- confidence is how sure you are that the edits compile and remove the issue.
- Write explanations in plain words a busy developer reads in ten seconds.`;

export const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One or two sentences: what is happening.' },
    why_it_matters: { type: 'string', description: 'What it costs: time, load, as the app grows.' },
    how_to_fix: { type: 'string', description: 'The fix in words, naming the functions to change.' },
  },
  required: ['summary', 'why_it_matters', 'how_to_fix'],
  additionalProperties: false,
};

export const FIX_SCHEMA = {
  type: 'object',
  properties: {
    explanation: { type: 'string', description: 'What the change does and why it removes the issue, or why no change is safe.' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          from_line: { type: 'integer' },
          to_line: { type: 'integer' },
          new_code: { type: 'string' },
        },
        required: ['file', 'from_line', 'to_line', 'new_code'],
        additionalProperties: false,
      },
    },
    notes: { type: 'string', description: 'Risks, assumptions, or why no edits were made.' },
  },
  required: ['explanation', 'confidence', 'edits', 'notes'],
  additionalProperties: false,
};

/** Reads the plain-text answer format; returns null if the text does not follow it. */
export function parseAnswer(text) {
  const t = String(text || '').replace(/\r\n/g, '\n');
  const section = (name) => {
    const m = t.match(new RegExp(`(?:^|\\n)${name}:[ \\t]*\\n?([\\s\\S]*?)(?=\\n(?:EXPLANATION:|CONFIDENCE:|EDIT |NOTES:)|$)`));
    return m ? m[1].trim() : '';
  };
  const explanation = section('EXPLANATION');
  const confidence = (t.match(/CONFIDENCE:\s*(high|medium|low)/i) || [])[1];
  const edits = [];
  const re = /(?:^|\n)EDIT[ \t]+(\S+)[ \t]+(\d+)\s*-\s*(\d+)[^\n]*\n```[^\n]*\n([\s\S]*?)\n?```/g;
  let m;
  while ((m = re.exec(t))) edits.push({ file: m[1], from_line: Number(m[2]), to_line: Number(m[3]), new_code: m[4] });
  if (!explanation && !edits.length) return null;
  return { explanation, confidence: confidence ? confidence.toLowerCase() : 'low', edits, notes: section('NOTES') };
}

/** An answer in the task's format: JSON for explain, the EDIT text format for fix. Null if it is neither. */
export function parseFor(task, text) {
  if (task !== 'explain') return parseAnswer(text);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The first user turn: the issue, what backlens suggests, and the code around each call site. */
export function issuePrompt(task, issue, ctx, previous) {
  const parts = [
    `Issue: ${issue.title}`,
    `Route: ${issue.route}`,
    `Seen in ${issue.seen} of ${issue.of} requests, about ${issue.cost} ms lost each time.`,
    `Where the code paths part: ${issue.sites.join(' and ')}`,
    `Statements involved:\n${issue.sql}`,
    `backlens's suggested direction: ${issue.fix}`,
    ...ctx.files.map((f) => `--- ${f.path} (lines ${f.from}-${f.to})\n${f.text}`),
  ];
  if (previous) parts.push(`A previous attempt was applied and failed its check: ${previous.reason}\nTry a different approach.`);
  parts.push(task === 'explain' ? 'Explain this issue.' : 'Propose the smallest safe fix, in the answer format.');
  return parts.join('\n\n');
}
