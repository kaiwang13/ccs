'use strict';
// @ts-check
/** Add-ons as ccs sees them (src/addon/host.js): their manifests, what a terminal attaching is given, and their commands. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { manifests, attachActions, addonCommand, draftEditor } = require('../../src/addon/host.js');
const { attachSpec } = require('../../src/cli/attach.js');
const { CCS_KEYS } = require('../../src/sessiond/messages.js');

/** A directory of add-ons with these manifests. @param {import('node:test').TestContext} t @param {Record<string, any>} all */
function addons(t, all) {
  const dir = fs.mkdtempSync('/tmp/ccst-addons-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, m] of Object.entries(all)) {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, 'addon.json'), typeof m === 'string' ? m : JSON.stringify(m));
  }
  return dir;
}

const NOTES = { name: 'notes', api: 1, main: 'main.js', actions: { open: 'notes', edit: 'a draft' }, keys: { n: 'open' }, commands: { notes: 'notes' }, draftEditor: 'edit' };

test('an add-on is a directory with a manifest that says what it is; anything else there is not one', (t) => {
  const dir = addons(t, {
    notes: NOTES, broken: '{', other: { ...NOTES, name: 'notes2' }, old: { ...NOTES, name: 'old', api: 2 },
    stray: { ...NOTES, name: 'stray', keys: { x: 'nothing' } }, up: { ...NOTES, name: 'up', main: '../main.js' },
  });
  assert.deepEqual(manifests(dir).map((m) => m.name), ['notes']);
  assert.ok(manifests().some((m) => m.name === 'translate'), 'the bundled one');
});

test('a terminal attaching is given the actions and keys of the add-ons that are on, and nothing of one that is off', (t) => {
  const dir = addons(t, { notes: NOTES });
  assert.deepEqual(attachActions({ addons: { leader: 'C-]' } }, dir), { actions: {}, keys: null });
  const on = attachActions({ addons: { leader: 'C-]', notes: { enabled: true } } }, dir);
  assert.deepEqual(Object.keys(on.actions), ['notes.open'], 'an agent\'s editor for a draft is no key\'s');
  assert.deepEqual(on.actions['notes.open'].slice(1), [path.join(dir, 'notes', 'main.js'), 'open']);
  assert.deepEqual(on.keys, { leader: 'C-]', bindings: { n: 'notes.open' } });
  const own = attachActions({ addons: { leader: 'M-n', notes: { enabled: true, keys: { o: 'open', z: 'nothing' } } } }, dir);
  assert.deepEqual(own.keys, { leader: 'M-n', bindings: { o: 'notes.open' } });
  assert.equal(attachActions({ addons: { leader: null, notes: { enabled: true } } }, dir).keys, null, 'no keys without a leader');

  const spec = attachSpec({ sockPath: '/s', name: 'api', config: { addons: { leader: 'C-]', notes: { enabled: true } } }, flags: {}, addonsDir: dir });
  assert.deepEqual(spec.config.keys, { ...CCS_KEYS, leader: 'C-]', bindings: { n: 'notes.open' } });
  assert.deepEqual(spec.config.actions, on.actions);
  const plain = attachSpec({ sockPath: '/s', name: 'api', config: { addons: { leader: 'C-]' } }, flags: {}, addonsDir: dir });
  assert.equal(plain.config.keys, CCS_KEYS);
  assert.equal('actions' in plain.config, false);
});

test('a command of an add-on that is on runs it; of one that is off says which; of none is nobody\'s', (t) => {
  const dir = addons(t, { notes: NOTES });
  const on = addonCommand({ addons: { notes: { enabled: true } } }, 'notes', ['a', 'b'], dir);
  assert.ok(on && 'argv' in on);
  assert.deepEqual(on.argv.slice(1), [path.join(dir, 'notes', 'main.js'), 'notes', 'a', 'b']);
  assert.deepEqual(addonCommand({ addons: {} }, 'notes', [], dir), { off: 'notes' });
  assert.equal(addonCommand({ addons: { notes: { enabled: true } } }, 'frobnicate', [], dir), null);
});

test('an agent\'s editor for a draft is a script that runs the add-on, told the configuration and the editors the agent had', (t) => {
  const dir = addons(t, { notes: NOTES });
  const env = { VISUAL: "code --wait it's", EDITOR: 'vi' };
  assert.equal(draftEditor({ addons: { notes: { enabled: false } } }, env, '/s/x', '/c.json', dir), null);
  assert.equal(draftEditor({ addons: { notes: { enabled: true, draftEditor: false } } }, env, '/s/x', '/c.json', dir), null);
  const d = draftEditor({ addons: { notes: { enabled: true } } }, env, '/s/x', '/c.json', dir);
  assert.ok(d);
  assert.equal(d.file, '/s/x');
  assert.match(d.script, /^#!\/bin\/sh\n/);
  assert.match(d.script, /CCS_CONFIG='\/c\.json' CCS_AGENT_VISUAL='code --wait it'\\''s' CCS_AGENT_EDITOR='vi' exec /);
  assert.match(d.script, new RegExp(`'${path.join(dir, 'notes', 'main.js').replace(/[.]/g, '\\.')}' 'edit' "\\$@"\\n$`));
});
