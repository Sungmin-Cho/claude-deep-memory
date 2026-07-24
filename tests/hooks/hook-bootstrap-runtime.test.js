'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');

const {
  MAX_BREADCRUMB_CHARS,
  run,
} = require('../../scripts/hook-bootstrap.cjs');

function runWithChildEvent(event, args) {
  const messages = [];
  const child = new EventEmitter();
  const promise = run('post-tool-use', {
    exists: () => true,
    stderr: (message) => messages.push(message),
    spawnImpl: () => {
      process.nextTick(() => child.emit(event, ...args));
      return child;
    },
  });
  return promise.then(() => messages);
}

test('hook bootstrap converts spawn errors into bounded fail-open breadcrumbs', async () => {
  const previousRoot = process.env.PLUGIN_ROOT;
  process.env.PLUGIN_ROOT = path.parse(process.cwd()).root;
  try {
    const messages = await runWithChildEvent('error', [new Error('x'.repeat(500))]);
    assert.equal(process.exitCode, 0);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /spawn error/);
    assert.ok(messages[0].length <= MAX_BREADCRUMB_CHARS + '[deep-memory] '.length);
  } finally {
    if (previousRoot === undefined) delete process.env.PLUGIN_ROOT;
    else process.env.PLUGIN_ROOT = previousRoot;
  }
});

test('hook bootstrap also converts synchronous spawn failures into status zero', async () => {
  const previousRoot = process.env.PLUGIN_ROOT;
  process.env.PLUGIN_ROOT = path.parse(process.cwd()).root;
  const messages = [];
  try {
    await run('post-tool-use', {
      exists: () => true,
      stderr: (message) => messages.push(message),
      spawnImpl: () => { throw new Error('synchronous failure'); },
    });
    assert.equal(process.exitCode, 0);
    assert.deepEqual(messages, [
      '[deep-memory] post-tool-use hook: spawn error synchronous failure; capture skipped',
    ]);
  } finally {
    if (previousRoot === undefined) delete process.env.PLUGIN_ROOT;
    else process.env.PLUGIN_ROOT = previousRoot;
  }
});

test('hook bootstrap converts child signals into status zero', async () => {
  const previousRoot = process.env.PLUGIN_ROOT;
  process.env.PLUGIN_ROOT = path.parse(process.cwd()).root;
  try {
    const messages = await runWithChildEvent('exit', [null, 'SIGTERM']);
    assert.equal(process.exitCode, 0);
    assert.deepEqual(messages, [
      '[deep-memory] post-tool-use hook: child signal SIGTERM; capture skipped',
    ]);
  } finally {
    if (previousRoot === undefined) delete process.env.PLUGIN_ROOT;
    else process.env.PLUGIN_ROOT = previousRoot;
  }
});
