'use strict';
/**
 * The app code behind a call: the first few stack frames that are neither node, node_modules,
 * generated ORM clients nor backlens, mapped through source maps to the original file and line.
 */

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { ROOT, SELF } = require('./env.cjs');

/**
 * Bundlers (Next.js with Turbopack or webpack, and other build steps) run code from generated
 * chunks, and some, like Next.js, map stack traces themselves instead of letting Node do it. So
 * backlens reads each chunk's source map itself, cached per file until the file changes.
 */
const maps = new Map();
function sourceMapOf(file) {
  if (!/\.[cm]?js$/.test(file)) return null;
  let mtime;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const hit = maps.get(file);
  if (hit && hit.mtime === mtime) return hit.map;
  let map = null;
  try {
    const text = fs.readFileSync(file, 'utf8');
    const url = text.slice(-4096).match(/\/\/[#@] sourceMappingURL=(\S+)\s*$/);
    if (url) {
      const payload = url[1].startsWith('data:')
        ? JSON.parse(Buffer.from(url[1].slice(url[1].indexOf(',') + 1), /;base64,/.test(url[1]) ? 'base64' : 'utf8').toString())
        : JSON.parse(fs.readFileSync(path.resolve(path.dirname(file), decodeURIComponent(url[1])), 'utf8'));
      map = new Module.SourceMap(payload);
    }
  } catch {
    map = null;
  }
  if (maps.size > 500) maps.clear();
  maps.set(file, { mtime, map });
  return map;
}

/** Where a generated line and column came from, or the input unchanged when there is no map. */
function original(file, line, column) {
  const map = sourceMapOf(file);
  if (!map) return { file, line };
  try {
    const entry = map.findEntry(line - 1, column - 1);
    if (!entry || !entry.originalSource) return { file, line };
    let source = entry.originalSource;
    if (source.startsWith('file://')) source = decodeURIComponent(new URL(source).pathname);
    else if (!path.isAbsolute(source)) source = path.resolve(path.dirname(file), map.payload.sourceRoot || '', source);
    return { file: source, line: entry.originalLine + 1 };
  } catch {
    return { file, line };
  }
}

// Generated ORM clients live in the project but are not the app's code (Prisma's `output`).
const GENERATED = /[\\/]generated[\\/]prisma[\\/]/;

function collectFrames() {
  // Database drivers and ORMs alone can fill the default 10 frames; look deeper for app code.
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 80;
  const stack = new Error().stack || '';
  Error.stackTraceLimit = limit;
  const lines = stack.split('\n').slice(2);
  const frames = [];
  for (const line of lines) {
    const m = line.match(/at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);
    if (!m) continue;
    const raw = m[2].replace(/^file:\/\//, '');
    if (raw.startsWith('node:') || raw.includes('node_modules') || raw.startsWith(SELF) || !raw.startsWith('/')) continue;
    // Chunks bundle libraries too, so node_modules is checked again after mapping.
    const at = original(raw, Number(m[3]), Number(m[4]));
    if (at.file.includes('node_modules') || GENERATED.test(at.file) || at.file.startsWith(SELF) || !at.file.startsWith('/')) continue;
    frames.push({ fn: (m[1] || '').replace(/^async /, '') || '(anonymous)', file: path.relative(ROOT, at.file), line: at.line });
    if (frames.length === 8) break;
  }
  return frames;
}

/** The first few frames of app code that led to this call, skipping node, node_modules and backlens. */
function appFrames() {
  // Recording must never break the app: a failure here costs only the location.
  try {
    return collectFrames();
  } catch {
    return [];
  }
}

module.exports = { appFrames };
