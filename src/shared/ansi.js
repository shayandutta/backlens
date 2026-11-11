/** Terminal escape codes: colour, and the pattern that strips them from captured output. */
export const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export const stripAnsi = (text) => String(text).replace(ANSI, '');

/** Wraps text in an SGR code. `when` decides at call time (e.g. only on a TTY). */
const sgr =
  (code, when = () => true) =>
  (s) =>
    when() ? `\x1b[${code}m${s}\x1b[0m` : s;

export const dim = sgr('2');
export const bold = sgr('1');

/** Colours that switch off when stderr is not a terminal (CI logs). */
const tty = () => process.stderr.isTTY;
export const ttyRed = sgr('31', tty);
export const ttyYellow = sgr('33', tty);
export const ttyDim = sgr('2', tty);
export const ttyBold = sgr('1', tty);
