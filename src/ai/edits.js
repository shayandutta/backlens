import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { insideProject } from './context.js';

/**
 * A model's edits, made safe to apply: cleaned of fences and copied line numbers, checked against
 * exactly the code the model was shown, turned into exact line replacements, rendered as diffs,
 * and written only if the file still matches.
 */

/** Strips code fences, copied line numbers and trailing spaces from a model's code block. */
export function cleanCode(code) {
  let lines = String(code ?? '').replace(/\r\n/g, '\n').split('\n');
  if (/^```/.test(lines[0] || '')) lines = lines.slice(1);
  if (/^```\s*$/.test(lines.at(-1) || '')) lines = lines.slice(0, -1);
  const filled = lines.filter((l) => l.trim());
  if (filled.length && filled.filter((l) => /^ {0,6}\d+ {1,2}/.test(l)).length / filled.length >= 0.6) lines = lines.map((l) => l.replace(/^ {0,6}\d+ {1,2}/, ''));
  return lines.map((l) => l.replace(/\s+$/, '')).join('\n');
}

/** The statements an issue is about, for telling whether it is still there after a fix. */
const statements = (issue) => new Set(String(issue.sql || '').split('\n').map((s) => s.trim()).filter(Boolean));

/** Whether two issues are the same problem: same type, and at least one statement in common. */
export function sameIssue(a, b) {
  if (a.type !== b.type) return false;
  const sa = statements(a);
  for (const s of statements(b)) if (sa.has(s)) return true;
  return false;
}

/**
 * Turns the model's edits into exact line replacements, refusing any that touch lines it was not
 * shown, overlap, or change nothing. Recorded fixtures may use find/replace text instead.
 *
 * shownFiles: the context files the model saw, [{ path, from, to }].
 */
export function normalizeEdits(root, shownFiles, raw) {
  const shown = new Map();
  for (const f of shownFiles) shown.set(f.path, [...(shown.get(f.path) || []), { from: f.from, to: f.to }]);
  const ok = [];
  const rejected = [];
  for (const e of Array.isArray(raw) ? raw : []) {
    const abs = typeof e.file === 'string' ? insideProject(root, e.file) : null;
    const file = abs && relative(root, abs);
    if (!abs || !existsSync(abs) || !shown.has(file)) {
      rejected.push({ file: e.file, reason: `${e.file} is not one of the files you were shown (${[...shown.keys()].join(', ')})` });
      continue;
    }
    const lines = readFileSync(abs, 'utf8').split('\n');
    let from;
    let to;
    let replace;
    if (Number.isInteger(e.from_line) && Number.isInteger(e.to_line)) {
      from = e.from_line;
      to = e.to_line;
      replace = cleanCode(e.new_code);
      const ranges = shown.get(file);
      if (from < 1 || to < from || to > lines.length || !ranges.some((r) => from >= r.from && to <= r.to)) {
        // Small models often number later edits as if the earlier ones were already applied.
        const shift = ok
          .filter((o) => o.file === file && o.to < from)
          .reduce((n, o) => n + o.replace.split('\n').length - (o.to - o.from + 1), 0);
        const was = { from: from - shift, to: to - shift };
        const shifted = shift !== 0 && ranges.some((r) => was.from >= r.from && was.to <= r.to);
        rejected.push({
          file,
          from,
          to,
          reason: shifted
            ? `lines ${from}-${to} are numbered as if your earlier edit were already applied. Number every edit by the original lines shown: these look like lines ${was.from}-${was.to}`
            : `lines ${from}-${to} are outside what you were shown in ${file} (${ranges.map((r) => `${r.from}-${r.to}`).join(', ')})`,
        });
        continue;
      }
    } else if (typeof e.find === 'string' && e.find) {
      const content = lines.join('\n');
      const find = content.split(e.find).length === 2 ? e.find : null;
      if (!find) {
        rejected.push({ file, reason: 'the text to replace was not found exactly once' });
        continue;
      }
      // Widen to whole lines, keeping whatever sits before and after the text on its first and last line.
      const idx = content.indexOf(find);
      const lineStart = content.lastIndexOf('\n', idx - 1) + 1;
      const endIdx = idx + find.length;
      let lineEnd = content.indexOf('\n', endIdx);
      if (lineEnd === -1) lineEnd = content.length;
      from = content.slice(0, lineStart).split('\n').length;
      to = from + content.slice(lineStart, lineEnd).split('\n').length - 1;
      replace = content.slice(lineStart, idx) + String(e.replace ?? '') + content.slice(endIdx, lineEnd);
    } else {
      rejected.push({ file, reason: 'the edit has no line numbers' });
      continue;
    }
    const find = lines.slice(from - 1, to).join('\n');
    if (find === replace) {
      rejected.push({ file, from, to, reason: `the edit to lines ${from}-${to} changes nothing` });
      continue;
    }
    if (ok.some((o) => o.file === file && from <= o.to && to >= o.from)) {
      rejected.push({ file, from, to, reason: `lines ${from}-${to} overlap another edit` });
      continue;
    }
    ok.push({ file, from, to, find, replace });
  }
  return { ok, rejected };
}

/** A small diff of one edit: three lines of context, then what was removed and added. */
export function diffOf(root, e) {
  const lines = readFileSync(join(root, e.file), 'utf8').split('\n');
  let removed = e.find.split('\n');
  let added = e.replace === '' ? [] : e.replace.split('\n');
  let head = 0;
  while (head < removed.length - 1 && head < added.length - 1 && removed[head] === added[head]) head++;
  let tail = 0;
  while (tail < removed.length - head - 1 && tail < added.length - head - 1 && removed[removed.length - 1 - tail] === added[added.length - 1 - tail]) tail++;
  const start = e.from + head;
  const keptAfter = removed.slice(removed.length - tail);
  removed = removed.slice(head, removed.length - tail);
  added = added.slice(head, added.length - tail);
  return {
    file: e.file,
    line: start,
    before: lines.slice(Math.max(0, start - 4), start - 1).map((text, i) => ({ n: Math.max(1, start - 3) + i, text })),
    removed: removed.map((text, i) => ({ n: start + i, text })),
    added: added.map((text, i) => ({ n: start + i, text })),
    after: [...keptAfter, ...lines.slice(e.to, e.to + 3)].slice(0, 3).map((text, i) => ({ n: start + added.length + i, text })),
  };
}

/** Writes edits bottom-up per file, refusing if a file no longer matches what the edits replace. */
export function writeEdits(root, edits) {
  const byFile = new Map();
  for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) || []), e]);
  for (const [file, list] of byFile) {
    const abs = join(root, file);
    const lines = readFileSync(abs, 'utf8').split('\n');
    for (const e of [...list].sort((a, b) => b.from - a.from)) {
      if (lines.slice(e.from - 1, e.to).join('\n') !== e.find) throw new Error(`${file} changed since this suggestion. Ask for a new one.`);
      lines.splice(e.from - 1, e.to - e.from + 1, ...(e.replace === '' ? [] : e.replace.split('\n')));
    }
    writeFileSync(abs, lines.join('\n'));
  }
}
