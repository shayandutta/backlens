import { findDuplicates } from './checks/duplicates.js';
import { findSerial } from './checks/serial.js';
import { stripWrappers, wrapperLines } from './frames.js';

/**
 * Issues found in one trace. Each check is kept narrow so it is right when it fires:
 *  - n-plus-one and repeat (checks/duplicates.js)
 *  - serial                (checks/serial.js), on the spans the first two did not report
 */
export function checkTrace(trace) {
  // Locations skip wrapper lines (a pool.query or logging helper) so they point at the real code.
  const raw = trace.spans.filter((s) => s.kind === 'db' || s.kind === 'redis' || s.kind === 'http');
  const wrappers = wrapperLines(raw);
  const io = raw.map((s) => ({ ...s, frames: stripWrappers(s.frames, wrappers) }));
  const { issues, covered } = findDuplicates(io);
  return [...issues, ...findSerial(io, covered)];
}
