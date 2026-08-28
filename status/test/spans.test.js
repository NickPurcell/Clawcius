import { test } from 'node:test';
import assert from 'node:assert/strict';

import { activitySpans, IDLE_GAP_MS } from '../dist/timeline.js';

const line = (ts, extra = {}) => ({ ts, hasToolUse: false, isToolResult: false, ...extra });

test('lines closer than the idle gap are one span', () => {
  const spans = activitySpans([line(0), line(10_000), line(50_000), line(90_000)]);
  assert.deepEqual(spans, [[0, 90_000]]);
});

test('a gap wider than the idle gap ends a span and starts another', () => {
  const spans = activitySpans([line(0), line(30_000), line(30_000 + IDLE_GAP_MS + 1), line(30_000 + IDLE_GAP_MS + 5_000)]);
  assert.deepEqual(spans, [
    [0, 30_000],
    [30_000 + IDLE_GAP_MS + 1, 30_000 + IDLE_GAP_MS + 5_000],
  ]);
});

test('a tool call bridges any gap to its result: waiting on a tool is working', () => {
  const spans = activitySpans([line(0), line(1_000, { hasToolUse: true }), line(1_000 + 20 * 60_000, { isToolResult: true }), line(1_000 + 20 * 60_000 + 500)]);
  assert.deepEqual(spans, [[0, 1_000 + 20 * 60_000 + 500]]);
});

test('a long gap after a tool call that is not followed by its result is idle', () => {
  const spans = activitySpans([line(0, { hasToolUse: true }), line(10 * 60_000)]);
  assert.deepEqual(spans, [[0, 0], [10 * 60_000, 10 * 60_000]]);
});

test('lines without a timestamp are ignored and order on disk does not matter', () => {
  const spans = activitySpans([line(null), line(5_000), line(null), line(0)]);
  assert.deepEqual(spans, [[0, 5_000]]);
});

test('no lines, no spans', () => {
  assert.deepEqual(activitySpans([]), []);
});

test('the gap is a parameter, so a coarser view can merge short pauses', () => {
  const lines = [line(0), line(2 * 60_000), line(4 * 60_000)];
  assert.equal(activitySpans(lines).length, 3);
  assert.equal(activitySpans(lines, 3 * 60_000).length, 1);
});
