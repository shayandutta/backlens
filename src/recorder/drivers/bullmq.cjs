'use strict';
/**
 * BullMQ: the work a request hands to a queue, and the work a worker does for it.
 *
 *  - Queue.add / addBulk inside a request: a `job` span (with the code line) carrying the queue,
 *    job name and job id, so the request shows what it queued.
 *  - Worker.callProcessJob: each job run becomes its own trace (method JOB, url /<queue>/<name>),
 *    so the queries a job makes are recorded and checked like a request's. Its `job` field
 *    ({ queue, name, id, attempt }) lets the dashboard link it to the request that queued it.
 *
 * Job data is never recorded: only a hash of it.
 */

const { randomUUID } = require('node:crypto');
const { begin, now, round, storage } = require('../context.cjs');
const { hashValues } = require('../privacy.cjs');
const { send } = require('../transport.cjs');

const qname = (q) => (q && (q.name || q.qualifiedName)) || 'queue';

function patchBullmq(mod) {
  const Queue = mod && mod.Queue;
  const Worker = mod && mod.Worker;
  if (Queue && Queue.prototype && !Queue.prototype.__backlens && typeof Queue.prototype.add === 'function') {
    Queue.prototype.__backlens = true;
    const add = Queue.prototype.add;
    Queue.prototype.add = function (name, data) {
      const end = begin('job', `ENQUEUE ${qname(this)}:${name}`, { params: hashValues(data) });
      const p = add.apply(this, arguments);
      if (end && p && typeof p.then === 'function') {
        const queue = qname(this);
        p.then((job) => end({ job: { queue, name, id: job && job.id != null ? String(job.id) : null } }), () => end({ error: true }));
      }
      return p;
    };
    if (typeof Queue.prototype.addBulk === 'function') {
      const addBulk = Queue.prototype.addBulk;
      Queue.prototype.addBulk = function (jobs) {
        const n = Array.isArray(jobs) ? jobs.length : 0;
        const end = begin('job', `ENQUEUE ${qname(this)} x${n}`, { params: hashValues(Array.isArray(jobs) ? jobs.map((j) => j && j.data) : null) });
        const p = addBulk.apply(this, arguments);
        if (end && p && typeof p.then === 'function') {
          const queue = qname(this);
          p.then((list) => end({ jobs: (list || []).map((j) => ({ queue, name: j && j.name, id: j && j.id != null ? String(j.id) : null })) }), () => end({ error: true }));
        }
        return p;
      };
    }
  }
  if (Worker && Worker.prototype && !Worker.prototype.__backlens && typeof Worker.prototype.callProcessJob === 'function') {
    Worker.prototype.__backlens = true;
    const callProcessJob = Worker.prototype.callProcessJob;
    Worker.prototype.callProcessJob = function (job) {
      const queue = qname(this);
      const name = (job && job.name) || 'job';
      const trace = {
        id: randomUUID(),
        pid: process.pid,
        method: 'JOB',
        url: `/${queue}/${name}`,
        template: `/${queue}/${name}`,
        status: 0,
        at: Date.now(),
        began: now(),
        duration: 0,
        spans: [],
        job: { queue, name, id: job && job.id != null ? String(job.id) : null, attempt: (job && job.attemptsMade) || 0 },
      };
      const finish = (ok) => {
        trace.status = ok ? 200 : 500;
        trace.duration = round(now() - trace.began);
        delete trace.began;
        trace.spans.sort((a, b) => a.start - b.start);
        send(trace);
      };
      const args = arguments;
      return storage.run(trace, () => {
        let p;
        try {
          p = callProcessJob.apply(this, args);
        } catch (err) {
          finish(false);
          throw err;
        }
        if (p && typeof p.then === 'function') p.then(() => finish(true), () => finish(false));
        else finish(true);
        return p;
      });
    };
  }
}

module.exports = { patchBullmq };
