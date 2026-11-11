'use strict';
/** Redis through ioredis and node-redis (v4 and v5). Passwords never show; keys are masked. */

const { begin, storage } = require('../context.cjs');
const { hashValues, redact } = require('../privacy.cjs');

// Commands whose first argument is a password or other secret: shown by name only.
const SECRET_COMMANDS = new Set(['AUTH', 'HELLO', 'MIGRATE', 'ACL', 'CONFIG']);
function redisLabel(name, key) {
  if (SECRET_COMMANDS.has(name) || key === undefined || key === null) return name;
  return `${name} ${redact(String(key))}`;
}

function patchIoredis(mod) {
  const Redis = (mod && mod.default) || mod;
  const proto = Redis && Redis.prototype;
  if (!proto || typeof proto.sendCommand !== 'function' || proto.__backlens) return;
  proto.__backlens = true;
  const sendCommand = proto.sendCommand;
  proto.sendCommand = function (command) {
    if (command && command.name) {
      const name = command.name.toUpperCase();
      const key = name === 'EVAL' || name === 'EVALSHA' ? command.args[2] : command.args[0];
      const end = begin('redis', redisLabel(name, key), { params: hashValues(command.args) });
      if (end && command.promise) command.promise.then((v) => end(name === 'GET' ? { hit: v !== null } : null), () => end({ error: true }));
    }
    return sendCommand.apply(this, arguments);
  };
}

// node-redis: every command, pipelines and MULTI included, goes through the queue's addCommand.
// The client keeps its own send path in private methods, so the queue is the one place to wrap.
function patchRedisQueue(mod) {
  const Queue = mod && mod.default;
  const proto = Queue && Queue.prototype;
  if (!proto || typeof proto.addCommand !== 'function' || proto.__backlens) return;
  proto.__backlens = true;
  const addCommand = proto.addCommand;
  proto.addCommand = function (args) {
    const end =
      Array.isArray(args) && args.length && storage.getStore()
        ? (() => {
            const name = String(args[0]).toUpperCase();
            const key = name === 'EVAL' || name === 'EVALSHA' || name === 'FCALL' ? args[3] : args[1];
            return begin('redis', redisLabel(name, key), { params: hashValues(args.slice(1)) });
          })()
        : null;
    const p = addCommand.apply(this, arguments);
    if (end && p && typeof p.then === 'function') {
      const name = String(args[0]).toUpperCase();
      p.then((v) => end(name === 'GET' ? { hit: v !== null } : null), () => end({ error: true }));
    }
    return p;
  };
}

module.exports = { patchIoredis, patchRedisQueue };
