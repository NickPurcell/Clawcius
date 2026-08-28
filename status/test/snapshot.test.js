import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newestSnapshot, SNAPSHOT_STALE_MS, tagTime } from '../dist/snapshot.js';

const OUTPUT = [
  'snap-20260826-020348 2026-08-26 04:05:10 +0200 CEST',
  'snap-20260828-020755 2026-08-28 04:09:06 +0200 CEST',
  'latest 2026-08-18 07:20:00 +0200 CEST',
  'migrated 2026-08-08 09:40:51 +0200 CEST',
].join('\n');

test('a snapshot tag names a UTC instant', () => {
  assert.equal(tagTime('snap-20260828-020755'), Date.UTC(2026, 7, 28, 2, 7, 55));
  assert.equal(tagTime('latest'), null);
});

test('the newest snap-* tag wins whatever the order, and untagged images are ignored', () => {
  const now = Date.UTC(2026, 7, 28, 8, 0, 0);
  const snapshot = newestSnapshot(OUTPUT, now);
  assert.equal(snapshot.tag, 'snap-20260828-020755');
  assert.equal(snapshot.ageSeconds, Math.round((now - Date.UTC(2026, 7, 28, 2, 7, 55)) / 1000));
  assert.equal(snapshot.stale, false);
});

test('a newest snapshot older than the threshold is stale', () => {
  const now = Date.UTC(2026, 7, 28, 2, 7, 55) + SNAPSHOT_STALE_MS + 1;
  assert.equal(newestSnapshot(OUTPUT, now).stale, true);
});

test('no snap-* tag at all is stale, with nothing to name', () => {
  const snapshot = newestSnapshot('latest 2026-08-18 07:20:00 +0200 CEST\n', Date.now());
  assert.equal(snapshot.tag, null);
  assert.equal(snapshot.stale, true);
});
