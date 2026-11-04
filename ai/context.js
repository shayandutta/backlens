import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { tablesOf } from '../analyze.js';

/**
 * Collects only the code an issue is about: the whole function around each place backlens
 * recorded, plus how the tables involved are defined. Never reads .env files, node_modules or
 * anything outside the project, and masks secrets in what it does read.
 */

const MAX_FILE = 1024 * 1024;
const MAX_LINES = 700;
const BLOCKED = /(^|[/\\])(node_modules|\.git|\.backlens|dist|build|coverage)([/\\]|$)|(^|[/\\])\.env/;
const FUNCTION_START = /^\s*(export\s+)?(default\s+)?(async\s+)?(function\b|(public|private|protected|static|async|get|set)\s+[\w$]+\s*\(|(?!(?:if|for|while|switch|catch|with|return|await|else|do|try|new|typeof)\b)[\w$]+\s*\([^)]*\)\s*(:[^={]+)?\{|(const|let|var)\s+[\w$]+\s*=\s*(async\s*)?(\([^)]*\)|[\w$]+)\s*=>|[\w$]+\s*:\s*(async\s*)?(function|\())/;

export function insideProject(root, file) {
  const abs = resolve(root, file);
  return (abs === root || abs.startsWith(root + sep)) && !BLOCKED.test(relative(root, abs)) ? abs : null;
}

/** Masks values that look like secrets, so they never reach a model. */
export function scrub(text) {
  return text
    .replace(/((?:api[_-]?key|secret|token|password|passwd|private[_-]?key|auth)\w*["']?\s*[:=]\s*)(["'`])[^"'`\n]{6,}\2/gi, '$1$2***$2')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^:/\s"'`]+:)[^@\s"'`]+@/gi, '$1***@')
    .replace(/\b(sk|pk|rk)[-_](live|test|ant|proj)?[-_]?[A-Za-z0-9_-]{16,}/g, '***')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '***')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '***');
}

const indent = (line) => line.match(/^\s*/)[0].length;

/** The enclosing function of a line: back to its signature, forward to its closing brace. */
export function enclosing(lines, lineNo) {
  const at = Math.min(Math.max(lineNo - 1, 0), lines.length - 1);
  let start = Math.max(0, at - 30);
  for (let i = at; i >= Math.max(0, at - 120); i--) {
    if (FUNCTION_START.test(lines[i]) && indent(lines[i]) <= indent(lines[at])) {
      start = i;
      break;
    }
  }
  let depth = 0;
  let seen = false;
  let end = Math.min(lines.length - 1, at + 30);
  for (let i = start; i < Math.min(lines.length, start + 160); i++) {
    for (const ch of lines[i].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '').replace(/\/\/.*$/, '')) {
      if (ch === '{') {
        depth++;
        seen = true;
      } else if (ch === '}') depth--;
    }
    if (seen && depth <= 0) {
      end = i;
      break;
    }
  }
  return { from: start + 1, to: Math.max(end + 1, lineNo) };
}

function walk(dir, root, out, limit = 3000) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= limit) return;
    const p = join(dir, e.name);
    if (BLOCKED.test(relative(root, p))) continue;
    if (e.isDirectory()) walk(p, root, out, limit);
    else if (/\.(ts|js|mjs|cjs|prisma)$/.test(e.name)) out.push(p);
  }
}

/** Where each table is defined (drizzle pgTable/mysqlTable, prisma model), to show its columns and indexes. */
function schemaFor(root, tables) {
  if (!tables.length) return [];
  const files = [];
  walk(root, root, files);
  const found = [];
  for (const file of files) {
    let text;
    try {
      if (statSync(file).size > MAX_FILE) continue;
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (const t of tables) {
      const re = new RegExp(`(Table\\(\\s*["'\`]${t}["'\`]|@@map\\(\\s*"${t}"\\)|^model\\s+${t}\\b)`, 'i');
      const i = lines.findIndex((l) => re.test(l));
      if (i === -1 || found.some((f) => f.table === t)) continue;
      const { from, to } = enclosing(lines, i + 1);
      found.push({ table: t, path: relative(root, file), from: Math.min(from, i + 1), to: Math.min(to, i + 40) });
    }
  }
  return found;
}

/** The context for one issue, with a preview of exactly what would be sent. */
export function buildContext(root, issue) {
  const wanted = new Map();
  const add = (file, from, to) => {
    const list = wanted.get(file) || [];
    list.push({ from, to });
    wanted.set(file, list);
  };
  const frameSets = (issue.frames || []).filter(Boolean);
  const sites = new Set();
  for (const frames of frameSets) for (const f of frames.slice(0, 3)) sites.add(`${f.file}:${f.line}`);
  for (const s of issue.sites || []) sites.add(s);

  for (const site of sites) {
    const m = site.match(/^(.*):(\d+)$/);
    if (!m) continue;
    const abs = insideProject(root, m[1]);
    if (!abs || !existsSync(abs) || statSync(abs).size > MAX_FILE) continue;
    const lines = readFileSync(abs, 'utf8').split('\n');
    const { from, to } = enclosing(lines, Number(m[2]));
    add(relative(root, abs), from, to);
  }
  const tables = new Set();
  for (const line of String(issue.sql || '').split('\n')) for (const t of tablesOf(line).tables) tables.add(t);
  for (const s of schemaFor(root, [...tables])) add(s.path, s.from, s.to);

  // Merge overlapping ranges per file, then cut to the overall budget.
  const files = [];
  let budget = MAX_LINES;
  for (const [path, ranges] of wanted) {
    ranges.sort((a, b) => a.from - b.from);
    const merged = [];
    for (const r of ranges) {
      const last = merged.at(-1);
      if (last && r.from <= last.to + 3) last.to = Math.max(last.to, r.to);
      else merged.push({ ...r });
    }
    const lines = readFileSync(join(root, path), 'utf8').split('\n');
    for (const r of merged) {
      if (budget <= 0) break;
      const to = Math.min(r.to, r.from + budget - 1);
      const text = lines.slice(r.from - 1, to).map((l, i) => `${String(r.from + i).padStart(5)}  ${l}`).join('\n');
      files.push({ path, from: r.from, to, text: scrub(text) });
      budget -= to - r.from + 1;
    }
  }
  const chars = files.reduce((n, f) => n + f.text.length, 0) + String(issue.sql || '').length + 2000;
  return { files, tokens: Math.round(chars / 3.5), preview: files.map((f) => ({ path: f.path, from: f.from, to: f.to })) };
}
