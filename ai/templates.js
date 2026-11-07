import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * Fixes backlens writes itself, with no model: always the same shape, so always correct when they
 * apply. Each returns { edits, explanation } or { reason } saying why it does not apply here.
 */

const require = createRequire(import.meta.url);

/** The project's own TypeScript when it has the classic API, otherwise backlens's copy. */
function typescript(root) {
  try {
    const ts = createRequire(join(root, 'package.json'))('typescript');
    if (typeof ts.createSourceFile === 'function') return ts;
  } catch {}
  return require('typescript');
}

/**
 * Calls awaited one after another that only read and do not use each other's results:
 *
 *   const a = await getA(id);            const [a, b] = await Promise.all([
 *   const b = await getB(id);     →        getA(id),
 *                                          getB(id),
 *                                        ]);
 *
 * Only when the calls are whole statements, next to each other in one block, with no type
 * annotations or comments between them, and no later call uses a name an earlier one declared.
 */
export function promiseAll(root, issue) {
  const files = [...new Set(issue.sites.map((s) => s.replace(/:\d+$/, '')))];
  if (files.length !== 1) return { reason: 'the calls are in different files' };
  const file = files[0];
  const siteLines = issue.sites.map((s) => Number(s.match(/:(\d+)$/)[1]));
  let text;
  try {
    text = readFileSync(join(root, file), 'utf8');
  } catch {
    return { reason: `could not read ${file}` };
  }
  const ts = typescript(root);
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

  // The innermost statement directly inside a block that covers each recorded line.
  function statementAt(line) {
    let found = null;
    const visit = (node) => {
      const start = lineOf(node.getStart(sf));
      const end = lineOf(node.getEnd());
      if (line < start || line > end) return;
      if ((ts.isExpressionStatement(node) || ts.isVariableStatement(node)) && node.parent && ts.isBlock(node.parent)) found = node;
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  }
  const statements = [...new Set(siteLines.map(statementAt))];
  if (statements.some((s) => !s)) return { reason: 'a call is not a plain statement' };
  statements.sort((a, b) => a.pos - b.pos);
  if (statements.length < 2) return { reason: 'the calls are inside one statement' };
  const block = statements[0].parent;
  if (statements.some((s) => s.parent !== block)) return { reason: 'the calls are in different blocks' };
  const index = statements.map((s) => block.statements.indexOf(s));
  if (index.some((n, i) => i > 0 && n !== index[i - 1] + 1)) return { reason: 'other code runs between the calls' };

  const parts = [];
  for (const s of statements) {
    if (ts.isExpressionStatement(s) && ts.isAwaitExpression(s.expression)) {
      parts.push({ binding: null, names: [], expr: s.expression.expression, kind: null });
      continue;
    }
    if (ts.isVariableStatement(s)) {
      const list = s.declarationList;
      const decl = list.declarations.length === 1 ? list.declarations[0] : null;
      if (!decl || !decl.initializer || !ts.isAwaitExpression(decl.initializer)) return { reason: 'a call is not a single "const x = await …"' };
      if (decl.type) return { reason: 'a result has a type annotation that would be lost' };
      const kind = list.flags & ts.NodeFlags.Const ? 'const' : list.flags & ts.NodeFlags.Let ? 'let' : null;
      if (!kind) return { reason: 'var declarations are left alone' };
      const names = [];
      const collect = (n) => {
        if (ts.isIdentifier(n) && !(n.parent && ts.isBindingElement(n.parent) && n.parent.propertyName === n)) names.push(n.text);
        ts.forEachChild(n, collect);
      };
      collect(decl.name);
      parts.push({ binding: decl.name.getText(sf), names, expr: decl.initializer.expression, kind });
      continue;
    }
    return { reason: 'a call is not awaited on its own line' };
  }

  // No later call may use a name an earlier one declared.
  for (let i = 1; i < parts.length; i++) {
    const earlier = new Set(parts.slice(0, i).flatMap((p) => p.names));
    let uses = null;
    const scan = (n) => {
      if (uses) return;
      if (ts.isIdentifier(n) && earlier.has(n.text) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)) uses = n.text;
      ts.forEachChild(n, scan);
    };
    scan(parts[i].expr);
    if (uses) return { reason: `a later call uses ${uses} from an earlier one` };
  }

  // Comments between the statements would be lost or moved.
  for (const s of statements.slice(1)) {
    if ((ts.getLeadingCommentRanges(text, s.pos) || []).length) return { reason: 'there are comments between the calls' };
  }

  const first = statements[0];
  const last = statements.at(-1);
  const from = lineOf(first.getStart(sf));
  const to = lineOf(last.getEnd());
  const lines = text.split('\n');
  const startCol = sf.getLineAndCharacterOfPosition(first.getStart(sf)).character;
  if (lines[from - 1].slice(0, startCol).trim()) return { reason: 'other code shares the first line' };
  if (lines[to - 1].slice(sf.getLineAndCharacterOfPosition(last.getEnd()).character).trim()) return { reason: 'other code shares the last line' };
  const indent = lines[from - 1].match(/^\s*/)[0];

  const items = parts.map((p) => {
    const [head, ...rest] = p.expr.getText(sf).split('\n');
    return [`${indent}  ${head}`, ...rest.map((l) => `  ${l}`)].join('\n') + ',';
  });
  const bound = parts.some((p) => p.binding);
  const kind = parts.some((p) => p.kind === 'let') ? 'let' : 'const';
  const head = bound ? `${kind} [${parts.map((p) => p.binding || '').join(', ')}] = await Promise.all([` : 'await Promise.all([';
  const replace = `${indent}${head}\n${items.join('\n')}\n${indent}]);`;
  const find = lines.slice(from - 1, to).join('\n');
  return {
    edits: [{ file, from, to, find, replace }],
    explanation: `These ${parts.length} calls only read, and none uses another's result, so they can run at the same time. backlens rewrote them with Promise.all itself, without a model.`,
  };
}
