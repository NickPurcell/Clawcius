import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mailEntry, mailOrigin, mergeByTime, parseDiscordBundle, parseMailWake, shapeLines } from '../dist/lane.js';

const SELF = '1105739162230984735';
const names = new Map([
  [SELF, 'Clawcius coordinator'],
  ['clawcius-engineer1', 'Clawcius engineer1'],
]);
const nameOf = (id) => names.get(id) ?? id;

const userLine = (n, text, extra = {}) => ({
  n,
  type: 'user',
  role: 'user',
  ts: `2026-08-27T16:00:0${n}.000Z`,
  isMeta: false,
  summary: null,
  blocks: [{ kind: 'text', text, truncated: false }],
  ...extra,
});

const BUNDLE = [
  'You are the team leader — the main agent for this channel.',
  '',
  '2 new messages:',
  '',
  '[18:18] brutaltomrammen: hello there',
  'second line of the same message',
  '[18:19] guitargoblin: and me',
  '',
  'channel_id: 1105739162230984735',
  'latest message_id: 1541481950978642094',
  'To reply to the latest:',
  '  /home/npurcell/clawcius/discord-cli/discord reply -c 1105739162230984735 -m 1541481950978642094 -t "..."',
].join('\n');

const WAKE = [
  'checkMail →',
  '',
  '2 messages.',
  '',
  `── [DM] from ${SELF} · 2026-08-27 09:00 PT`,
  'subject: Reminder: Nvidia reported on 26 Aug. Check the market note.',
  'A reminder you armed for yourself.',
  '',
  'Your own note to yourself:',
  '',
  '── [DM] from clawcius-engineer1 · 2026-08-27 09:01 PT',
  'subject: PR 12 is green',
  'Merged and deployed.',
].join('\n');

test('a Discord bundle splits into one entry per message, labelled by author', () => {
  const messages = parseDiscordBundle(BUNDLE);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { time: '18:18', author: 'brutaltomrammen', content: 'hello there\nsecond line of the same message' });
  assert.deepEqual(messages[1], { time: '18:19', author: 'guitargoblin', content: 'and me' });

  const entries = shapeLines([userLine(1, BUNDLE)], SELF, nameOf);
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.label]), [
    ['discord', 'Discord · brutaltomrammen'],
    ['discord', 'Discord · guitargoblin'],
  ]);
  assert.equal(entries[0].text, 'hello there\nsecond line of the same message');
  assert.notEqual(entries[0].key, entries[1].key);
});

test('text that is not a bundle is not one', () => {
  assert.equal(parseDiscordBundle('hello\n[18:18] someone: hi'), null);
});

test('a mail wake splits into its messages, each labelled by its origin', () => {
  const messages = parseMailWake(WAKE);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].author, SELF);
  assert.equal(messages[0].subject, 'Reminder: Nvidia reported on 26 Aug. Check the market note.');
  assert.match(messages[0].body, /^A reminder you armed/);
  assert.equal(messages[1].subject, 'PR 12 is green');
  assert.equal(messages[1].body, 'Merged and deployed.');

  const entries = shapeLines([userLine(2, WAKE, { isMeta: true })], SELF, nameOf);
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.label]), [
    ['reminder', 'Reminder (self)'],
    ['mail', 'Mail from Clawcius engineer1'],
  ]);
});

test('an armed condition is told apart by its subject: reminder, schedule, PR watch', () => {
  assert.equal(mailOrigin(SELF, 'Reminder: check vidbot', SELF, nameOf).label, 'Reminder (self)');
  assert.equal(mailOrigin(SELF, 'Schedule: Daily puzzles', SELF, nameOf).kind, 'schedule');
  assert.equal(mailOrigin(SELF, 'watchPr NickPurcell/Clawcius#266 — 1 comment', SELF, nameOf).label, 'PR watch');
  assert.equal(mailOrigin('clawcius-engineer1', 'Reminder: not mine', SELF, nameOf).label, 'Mail from Clawcius engineer1');
});

test('mail from system or deploy is labelled System, whatever the subject', () => {
  assert.equal(mailOrigin('deploy', 'Reminder: deployed a1042e5', SELF, nameOf).label, 'System');
  assert.equal(mailOrigin('system', '', SELF, nameOf).kind, 'system');
});

test('a meta user line that is neither bundle nor mail is System; a typed one is a Prompt', () => {
  const [meta] = shapeLines([userLine(3, 'Continue from where you left off.', { isMeta: true })], SELF, nameOf);
  assert.equal(meta.label, 'System');
  const [typed] = shapeLines([userLine(4, 'You are the team leader — the main agent for this channel.')], SELF, nameOf);
  assert.equal(typed.kind, 'prompt');
});

test('a tool result folds under its call, matched by tool_use id', () => {
  const lines = [
    {
      n: 5, type: 'assistant', role: 'assistant', ts: '2026-08-27T16:00:05.000Z', isMeta: false, summary: null,
      blocks: [
        { kind: 'text', text: 'Looking.', truncated: false },
        { kind: 'tool_use', name: 'Bash', toolUseId: 'toolu_1', input: JSON.stringify({ command: 'ls -la' }), truncated: false },
      ],
    },
    {
      n: 6, type: 'user', role: 'user', ts: '2026-08-27T16:00:06.000Z', isMeta: false, summary: null,
      blocks: [{ kind: 'tool_result', toolUseId: 'toolu_1', text: 'total 0', isError: false, truncated: false }],
    },
  ];
  const entries = shapeLines(lines, SELF, nameOf);
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.label, entry.text, entry.detail]), [
    ['assistant', 'Assistant', 'Looking.', null],
    ['tool', 'Tool: Bash', 'ls -la', 'total 0'],
  ]);
});

test('a result whose call is not on the page stands alone rather than vanishing', () => {
  const entries = shapeLines([
    { n: 7, type: 'user', role: 'user', ts: null, isMeta: false, summary: null, blocks: [{ kind: 'tool_result', toolUseId: 'toolu_x', text: 'late', isError: true, truncated: false }] },
  ], SELF, nameOf);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].label, 'Tool result');
  assert.equal(entries[0].isError, true);
});

test('an MCP tool is named by its tool, and a discord react is one line', () => {
  const lines = [{
    n: 8, type: 'assistant', role: 'assistant', ts: '2026-08-27T16:00:08.000Z', isMeta: false, summary: null,
    blocks: [
      { kind: 'tool_use', name: 'mcp__clawsky__sendMail', toolUseId: 'a', input: JSON.stringify({ to: 'x', subject: 's', body: 'b' }), truncated: false },
      { kind: 'tool_use', name: 'Bash', toolUseId: 'b', input: JSON.stringify({ command: '/home/npurcell/clawcius/discord-cli/discord react -c 1 -m 2 -e 👀 >/dev/null 2>&1\ncd /tmp && ls' }), truncated: false },
    ],
  }];
  const entries = shapeLines(lines, SELF, nameOf);
  assert.equal(entries[0].label, 'Tool: sendMail');
  assert.equal(entries[1].kind, 'react');
  assert.equal(entries[1].label, 'reacted 👀');
  assert.equal(entries[1].text, 'cd /tmp && ls');
});

test('operational records are skipped except a system line, which is shown as such', () => {
  const entries = shapeLines([
    { n: 9, type: 'queue-operation', role: null, ts: null, isMeta: false, summary: 'dequeue', blocks: [] },
    { n: 10, type: 'system', role: null, ts: '2026-08-27T16:00:10.000Z', isMeta: false, summary: 'Conversation compacted', blocks: [] },
  ], SELF, nameOf);
  assert.deepEqual(entries.map((entry) => entry.label), ['System']);
});

test('a board row reads as sent or received, with display names and never ids', () => {
  const sent = mailEntry({ id: 1, author: SELF, recipient: 'clawcius-engineer1', subject: 'Fix it', body: 'please', bodyTruncated: false, sentAt: 1_756_000_000_000 }, SELF, nameOf);
  assert.equal(sent.kind, 'mail-out');
  assert.equal(sent.label, '→ Clawcius engineer1: Fix it');
  assert.equal(sent.key, 'm1');

  const received = mailEntry({ id: 2, author: 'clawcius-engineer1', recipient: SELF, subject: 'Done', body: 'ok', bodyTruncated: true, sentAt: 1_756_000_000_000 }, SELF, nameOf);
  assert.equal(received.label, '← Clawcius engineer1: Done');
  assert.equal(received.text, 'ok…');

  const feed = mailEntry({ id: 3, author: SELF, recipient: '*', subject: 'Post', body: '', bodyTruncated: false, sentAt: 1 }, SELF, nameOf);
  assert.equal(feed.label, '→ feed: Post');

  const system = mailEntry({ id: 4, author: 'deploy', recipient: SELF, subject: 'deployed', body: 'a1042e5', bodyTruncated: false, sentAt: 1 }, SELF, nameOf);
  assert.equal(system.label, 'System');

  const self = mailEntry({ id: 5, author: SELF, recipient: SELF, subject: 'Schedule: puzzles', body: '...', bodyTruncated: false, sentAt: 1 }, SELF, nameOf);
  assert.equal(self.label, 'Schedule');
});

test('mail merges into the transcript by time, and a tie keeps the transcript entry first', () => {
  const at = (s) => `2026-08-27T16:00:${String(s).padStart(2, '0')}.000Z`;
  const t = (key, s) => ({ key, ts: at(s), kind: 'assistant', label: 'Assistant', text: '', detail: null, isError: false, truncated: false });
  const m = (key, s) => ({ key, ts: at(s), kind: 'mail-in', label: '←', text: '', detail: null, isError: false, truncated: false });
  const merged = mergeByTime([t('n1', 1), t('n2', 5), t('n3', 9)], [m('m1', 0), m('m2', 5), m('m3', 7), m('m4', 20)]);
  assert.deepEqual(merged.map((entry) => entry.key), ['m1', 'n1', 'n2', 'm2', 'm3', 'n3', 'm4']);
});
