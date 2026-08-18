/**
 * The unix socket listeners, and specifically what they refuse to do.
 *
 * These sockets live in `$CLAWCIUS_STATE/run`, which `docker/run-container.sh`
 * bind-mounts READ-WRITE into the agent container. So every case here is a
 * case where the thing on the other side of the socket path can be something
 * an agent put there — including on purpose. Two properties are load-bearing
 * and are what most of this file is about:
 *
 *   1. The service never unlinks anything that is not a socket, so an agent
 *      cannot use it to delete a file it could not delete itself.
 *   2. A socket that cannot be claimed is a WARNING, not a boot failure, so an
 *      agent cannot take the status page down with a `touch`. The unit has
 *      Restart=always and StartLimitIntervalSec=0; a fatal error here would be
 *      a permanent restart loop.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { get } from 'node:http';
import { spawnSync } from 'node:child_process';

import { claimSocketPath, bindUnixSockets, releaseSocketPath } from '../dist/socket.js';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'status-socket-'));
}

test('a path with nothing at it is claimable', async () => {
  const dir = scratch();
  const result = await claimSocketPath(join(dir, 'status.sock'));
  assert.equal(result.ok, true);
});

test('a regular file at the socket path is refused, and survives', async () => {
  const dir = scratch();
  const path = join(dir, 'status.sock');
  writeFileSync(path, 'an agent put this here');

  const result = await claimSocketPath(path);

  assert.equal(result.ok, false);
  assert.match(result.reason, /regular file/);
  // The point of the whole exercise: it is still there.
  assert.equal(readFileSync(path, 'utf8'), 'an agent put this here');
});

test('a symlink at the socket path is refused, and its target survives', async () => {
  // The escalation this defends against: an agent points `status.sock` at
  // something valuable and waits for a restart, hoping the service will
  // "clean up the stale socket" on its behalf. Note that unlink(2) would not
  // follow the link even if this check were missing — that is the second,
  // independent reason it is safe — but the refusal is the first.
  const dir = scratch();
  const target = join(dir, 'hamachi.db');
  const path = join(dir, 'status.sock');
  writeFileSync(target, 'PRECIOUS');
  symlinkSync(target, path);

  const result = await claimSocketPath(path);

  assert.equal(result.ok, false);
  assert.match(result.reason, /symbolic link/);
  assert.equal(readFileSync(target, 'utf8'), 'PRECIOUS');
  assert.ok(existsSync(path), 'the symlink itself is left alone too');
});

test('a directory at the socket path is refused', async () => {
  const dir = scratch();
  const path = join(dir, 'status.sock');
  mkdirSync(path);

  const result = await claimSocketPath(path);

  assert.equal(result.ok, false);
  assert.match(result.reason, /directory/);
  assert.ok(existsSync(path));
});

/**
 * Leave a socket file on disk with nothing listening on it.
 *
 * Node unlinks on a clean close, which is the behaviour we want in production
 * and precisely the obstacle to testing what happens without one. So this
 * spawns a child that binds the path and then SIGKILLs itself — a real unclean
 * exit, which is the only thing that produces a real corpse.
 */
function leaveStaleSocket(path) {
  const result = spawnSync(process.execPath, [
    '-e',
    "const net=require('node:net');" +
      `net.createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'));`,
    path,
  ]);
  assert.equal(result.signal, 'SIGKILL', 'the child must die uncleanly for this to be a corpse');
  assert.ok(existsSync(path), 'an unclean exit leaves the socket file behind');
}

test('a stale socket is claimed and removed', async () => {
  // The EADDRINUSE case that is not really in use. A unix socket file outlives
  // the process that bound it, so an unclean exit — SIGKILL, OOM, power loss —
  // leaves one behind and the next listen() fails on a path nothing is using.
  const dir = scratch();
  const path = join(dir, 'status.sock');
  leaveStaleSocket(path);
  assert.ok(statSync(path).isSocket(), 'and what it leaves behind is a socket');

  const result = await claimSocketPath(path);

  assert.equal(result.ok, true);
  assert.equal(existsSync(path), false, 'the corpse is removed so listen() can succeed');
});

test('the service can bind straight over a stale socket', async () => {
  // The end-to-end version of the case above: this is what a restart after an
  // OOM kill actually does, and it must not need a human to rm the file.
  const dir = scratch();
  const path = join(dir, 'status.sock');
  leaveStaleSocket(path);

  const outcomes = await bindUnixSockets([path], (_request, response) => response.end('ok'));

  assert.equal(outcomes[0].listening, true, outcomes[0].reason ?? '');
  outcomes[0].server.close();
  releaseSocketPath(path);
});

test('a socket with a live server on it is refused, not stolen', async () => {
  const dir = scratch();
  const path = join(dir, 'status.sock');
  const live = createServer();
  await new Promise((resolve) => live.listen(path, resolve));

  try {
    const result = await claimSocketPath(path);
    assert.equal(result.ok, false);
    assert.match(result.reason, /live server/);
    assert.ok(existsSync(path), 'the live socket is left in place');
  } finally {
    await new Promise((resolve) => live.close(resolve));
  }
});

test('bindUnixSockets serves HTTP and locks the socket down to 0600', async () => {
  const dir = scratch();
  const path = join(dir, 'status.sock');

  const outcomes = await bindUnixSockets([path], (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('served');
  });

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].listening, true);

  try {
    // The socket is only useful if a plain HTTP client can speak to it — this
    // is what the in-container forwarder does on every request.
    const body = await new Promise((resolve, reject) => {
      get({ socketPath: path, path: '/' }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => resolve(text));
      }).on('error', reject);
    });
    assert.equal(body, 'served');

    // 0600, not the 0755 a default umask would leave. The run directory is
    // world-traversable, so the mode is the only thing between the socket and
    // any other local account.
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    outcomes[0].server.close();
    releaseSocketPath(path);
  }
});

test('an unbindable socket is a warning, not a throw — the page still comes up', async () => {
  // The DoS this prevents: an agent writes a regular file at the socket path.
  // If that were fatal the unit would restart forever (Restart=always,
  // StartLimitIntervalSec=0) and the container would have killed a host
  // service. Instead the TCP listener is untouched and this is reported.
  const dir = scratch();
  const blocked = join(dir, 'status.sock');
  writeFileSync(blocked, 'nope');
  const missingParent = join(dir, 'no-such-dir', 'status.sock');

  const outcomes = await bindUnixSockets([blocked, missingParent], () => {});

  assert.equal(outcomes.length, 2);
  for (const outcome of outcomes) {
    assert.equal(outcome.listening, false);
    assert.ok(outcome.reason.length > 0, 'every refusal explains itself');
  }
  assert.equal(readFileSync(blocked, 'utf8'), 'nope');
});

test('releaseSocketPath removes a socket and nothing else', async () => {
  const dir = scratch();
  const decoy = join(dir, 'decoy');
  writeFileSync(decoy, 'keep me');

  releaseSocketPath(decoy);
  assert.equal(readFileSync(decoy, 'utf8'), 'keep me');

  const path = join(dir, 'status.sock');
  const outcomes = await bindUnixSockets([path], () => {});
  outcomes[0].server.close();
  releaseSocketPath(path);
  assert.equal(existsSync(path), false);
});
