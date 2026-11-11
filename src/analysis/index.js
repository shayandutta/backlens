/**
 * Analysis: turns raw traces into routes, issues and the map. Pure functions, no I/O, so they are
 * easy to test and safe to call from anywhere (dashboard, CI report, MCP, AI fixes).
 */
export { checkTrace } from './check-trace.js';
export { mapOf } from './map.js';
export { routeOf, routeOfTrace } from './routes.js';
export { isRead, keyGroup, normalizeSql, tablesOf } from './statements.js';
export { summarize } from './summarize.js';
