import { spawn } from 'node:child_process';

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const MAX_LINES = 3000;

/**
 * One child process, its whole process tree, and its output. Started in its own process group,
 * so stopping it also stops whatever it spawned (pnpm → node, nest --watch → node).
 */
export class Runner {
  constructor({ env, mirror }) {
    this.env = env;
    this.mirror = mirror;
    this.lines = [];
    this.seq = 0;
    this.status = 'idle';
    this.child = null;
    this.argv = null;
    this.cwd = null;
    this.exitCode = null;
    this.startedAt = null;
    this.port = null;
    this.onExit = null;
    this.partial = { out: '', err: '' };
  }

  log(text, stream = 'out') {
    const chunk = this.partial[stream] + text.replace(ANSI, '');
    const parts = chunk.split(/\r?\n/);
    this.partial[stream] = parts.pop();
    for (const line of parts) this.push(line, stream);
  }

  push(text, stream) {
    this.lines.push({ seq: ++this.seq, text, stream });
    if (this.lines.length > MAX_LINES) this.lines.shift();
    if (this.mirror) this.mirror(text, stream);
  }

  since(seq) {
    return this.lines.filter((l) => l.seq > seq).slice(-800);
  }

  start(argv, cwd, extraEnv = {}) {
    if (this.child) return;
    this.argv = argv;
    this.cwd = cwd;
    this.status = 'running';
    this.exitCode = null;
    this.port = null;
    this.stopping = false;
    this.startedAt = Date.now();
    this.push(`$ ${argv.join(' ')}`, 'sys');
    const windows = process.platform === 'win32';
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: { ...this.env, ...extraEnv, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !windows,
      shell: windows,
    });
    this.child = child;
    child.stdout.on('data', (d) => this.log(String(d), 'out'));
    child.stderr.on('data', (d) => this.log(String(d), 'err'));
    child.on('error', (err) => {
      this.push(`could not start: ${err.message}`, 'sys');
    });
    child.on('exit', (code, signal) => {
      for (const s of ['out', 'err']) if (this.partial[s]) this.push(this.partial[s], s);
      this.partial = { out: '', err: '' };
      this.child = null;
      this.exitCode = code ?? (signal ? 1 : 0);
      this.status = this.stopping ? 'stopped' : code === 0 ? 'exited' : 'crashed';
      this.push(this.stopping ? 'stopped' : `exited with code ${this.exitCode}`, 'sys');
      if (this.onExit) this.onExit(this.status, this.exitCode);
    });
  }

  kill(signal) {
    const child = this.child;
    if (!child) return;
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {}
    }
  }

  stop() {
    if (!this.child) return Promise.resolve();
    this.stopping = true;
    const child = this.child;
    return new Promise((resolve) => {
      const force = setTimeout(() => this.kill('SIGKILL'), 5000);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      this.kill('SIGTERM');
    });
  }

  async restart() {
    const { argv, cwd } = this;
    await this.stop();
    if (argv) this.start(argv, cwd);
  }

  snapshot() {
    return { status: this.status, command: this.argv ? this.argv.join(' ') : null, pid: this.child ? this.child.pid : null, port: this.port, startedAt: this.startedAt, exitCode: this.exitCode, seq: this.seq };
  }
}
