import { test } from 'node:test';
import assert from 'node:assert/strict';

import { displayName, nameMap, subagentName } from '../dist/timeline.js';

test('a coordinator is named for its crew, never for its channel snowflake', () => {
  const name = displayName('Hamachi', { id: '1467070145343258628', crew: 'hamachi', role: 'coordinator' });
  assert.equal(name, 'Hamachi coordinator');
  assert.doesNotMatch(name, /\d{10,}/);
});

test('an engineer is the crew label plus its id with the crew prefix removed', () => {
  assert.equal(displayName('Hamachi', { id: 'hamachi-engineer1', crew: 'hamachi', role: 'engineer' }), 'Hamachi engineer1');
  assert.equal(displayName('Clawcius', { id: 'clawcius-host', crew: 'clawcius', role: 'host' }), 'Clawcius host');
});

test('an id without the crew prefix is shown whole', () => {
  assert.equal(displayName('Hamachi', { id: 'poster', crew: 'hamachi', role: 'poster' }), 'Hamachi poster');
});

test('two coordinators of one crew get distinct names in the order given', () => {
  const names = nameMap('Clawcius', [
    { id: '1105739162230984735', crew: 'clawcius', role: 'coordinator' },
    { id: '307031296788398080', crew: 'clawcius', role: 'coordinator' },
    { id: 'clawcius-engineer1', crew: 'clawcius', role: 'engineer' },
  ]);
  assert.equal(names.get('1105739162230984735'), 'Clawcius coordinator');
  assert.equal(names.get('307031296788398080'), 'Clawcius coordinator 2');
  assert.equal(names.get('clawcius-engineer1'), 'Clawcius engineer1');
});

test('a subagent is its description, else its type, else "subagent"', () => {
  assert.equal(subagentName({ meta: { description: 'Fix OJ review findings', agentType: 'general-purpose' } }, null), 'Fix OJ review findings');
  assert.equal(subagentName({ meta: { description: null, agentType: 'Explore' } }, null), 'Explore');
  assert.equal(subagentName({ meta: null }, { description: 'Research bulbs', subagentType: 'general-purpose' }), 'Research bulbs');
  assert.equal(subagentName({ meta: null }, null), 'subagent');
});
