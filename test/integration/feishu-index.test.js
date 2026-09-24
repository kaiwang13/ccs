'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCcsEnv } = require('../helpers/ccsenv.js');
const { createRegistry } = require('../../src/common/registry.js');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { SessionIndex } = require('../../addons/feishu/lib/sessionindex.js');

test.after(() => closeNfsWorker());

test('the index reports sessions appearing, changing and disappearing', { timeout: 60000 }, async (t) => {
  const ctx = makeCcsEnv(t);
  const registry = createRegistry(ctx.paths);
  const index = new SessionIndex({ registry, paths: ctx.paths });
  /** @type {string[]} */
  const log = [];
  index.on('added', (i) => log.push(`added ${i.name} ${i.agent} live=${i.live}`));
  index.on('changed', (i) => log.push(`changed ${i.name}`));
  index.on('removed', (id) => log.push(`removed ${id}`));
  const rec = await registry.create({ name: 'alpha', cwd: ctx.work, desired: 'stopped' });
  await index.refresh();
  assert.deepEqual(log, ['added alpha claude live=false']);
  assert.equal(index.get(rec.id)?.cwd, ctx.work);
  await index.refresh();
  assert.equal(log.length, 1, 'no change, no event');
  await registry.updateIntent(rec.id, (i) => { i.pendingName = 'beta'; i.pendingNameGen = 1; });
  await index.refresh();
  assert.equal(log[1], 'changed beta');
  await registry.remove(rec.id);
  await index.refresh();
  assert.equal(log[2], `removed ${rec.id}`);
  assert.deepEqual(index.all(), []);
});
