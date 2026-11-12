/**
 * Mutants: small, deliberate breaks of a guard, to find out whether anything (tests, the behavior
 * diff) notices. Pure: from a file's text and a TypeScript module (the project's own, or none).
 *
 * Operators, each a single exact text replacement:
 *   remove-guard     `if (cond) throw …` / `if (cond) return <error>` is removed
 *   remove-decorator `@UseGuards(…)`, `@Roles(…)` and similar access decorators are removed
 *   boundary         `>=` ↔ `>` and `<=` ↔ `<` inside a guard's condition
 *
 * Each mutant: { id, file, operator, line, before, after, start, end, describe }.
 */

const ACCESS_DECORATORS = /^(UseGuards|Roles|RequireRoles?|Permissions|RequirePermissions?|Authorized|Auth|Public)$/;
const ERROR_RETURN = /\b(status\s*\(\s*4\d\d|forbidden|unauthori[sz]ed|notFound|badRequest|reply\.code\s*\(\s*4\d\d|4\d\d\b)/i;

/** Mutants for one file. `ts` is a TypeScript module with createSourceFile, or null (no mutants). */
export function mutantsOf(file, text, ts) {
  if (!ts) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const out = [];
  const add = (operator, node, start, end, after, describe) => {
    const before = text.slice(start, end);
    if (before === after) return;
    out.push({ id: `${file}:${line(node.getStart(sf))}:${operator}:${out.length}`, file, operator, line: line(node.getStart(sf)), start, end, before, after, describe });
  };

  // A guard: an if whose only job is to stop the request (throw, or return an error response).
  const stops = (stmt) => {
    if (!stmt) return false;
    if (ts.isBlock(stmt)) return stmt.statements.length >= 1 && stmt.statements.length <= 2 && stops(stmt.statements[stmt.statements.length - 1]);
    if (ts.isThrowStatement(stmt)) return true;
    if (ts.isReturnStatement(stmt) && stmt.expression) return ERROR_RETURN.test(stmt.expression.getText(sf));
    return false;
  };

  const visit = (node) => {
    if (ts.isIfStatement(node) && !node.elseStatement && stops(node.thenStatement)) {
      const cond = node.expression.getText(sf).replace(/\s+/g, ' ').slice(0, 80);
      add('remove-guard', node, node.getStart(sf), node.getEnd(), '/* backlens mutant: guard removed */', `removed the check \`if (${cond})\``);
      // Boundaries inside the guard's condition.
      const walk = (n) => {
        if (ts.isBinaryExpression(n)) {
          const k = n.operatorToken.kind;
          const swap = { [ts.SyntaxKind.GreaterThanEqualsToken]: '>', [ts.SyntaxKind.GreaterThanToken]: '>=', [ts.SyntaxKind.LessThanEqualsToken]: '<', [ts.SyntaxKind.LessThanToken]: '<=' }[k];
          if (swap) add('boundary', n, n.operatorToken.getStart(sf), n.operatorToken.getEnd(), swap, `changed \`${n.operatorToken.getText(sf)}\` to \`${swap}\` in \`if (${cond})\``);
        }
        ts.forEachChild(n, walk);
      };
      walk(node.expression);
    }
    if (ts.isDecorator(node)) {
      const e = node.expression;
      const name = ts.isCallExpression(e) ? e.expression.getText(sf) : e.getText(sf);
      if (ACCESS_DECORATORS.test(name)) add('remove-decorator', node, node.getStart(sf), node.getEnd(), '/* backlens mutant: decorator removed */', `removed \`${node.getText(sf).slice(0, 60)}\``);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Applies one mutant to its file's text. */
export const apply = (text, m) => text.slice(0, m.start) + m.after + text.slice(m.end);
