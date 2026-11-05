'use strict';
// @ts-check
/**
 * Add-ons: programs beside ccs that it runs and never loads, so that ccs behaves the same with or without them
 * (test/unit/addon-isolation.test.js). Each is a directory under addons/ whose addon.json ccs reads:
 *
 *   { "name": "translate", "api": 1, "main": "main.js",
 *     "actions":     { "compose": "…" },    run with the terminal lent, from a key while attached
 *     "keys":        { "e": "compose" },     the key after ccs's leader (config addons.leader) that runs an action
 *     "commands":    { "translate": "…" },  `ccs translate …`
 *     "draftEditor": "editor" }             the action an agent runs as the editor of a draft (VISUAL, EDITOR)
 *
 * One is on when its section of the configuration says `"enabled": true`; `keys` there take the place of the manifest's, and
 * `"draftEditor": false` keeps the agents' own editor. Each is run as `node <dir>/<main> <action or command> …`. An action is
 * run by the attach client (nmux's `actions`), which tells it the session in NMUX_SESSION and NMUX_SOCK; what else it needs
 * it reads with the SDK (src/addon/sdk.js).
 */
const fs = require('node:fs');
const path = require('node:path');

const ADDONS_DIR = path.join(__dirname, '..', '..', 'addons');
const API = 1;

/** @typedef {{name: string, api: number, main: string, actions?: Record<string, string>, keys?: Record<string, string>,
 *            commands?: Record<string, string>, draftEditor?: string, dir: string}} Manifest */

const isPlainObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} v */
const texts = (v) => v === undefined || (isPlainObject(v) && Object.values(/** @type {object} */ (v)).every((t) => typeof t === 'string'));

/** @param {any} m @param {string} name */
function valid(m, name) {
  return isPlainObject(m) && m.name === name && /^[a-z][a-z0-9-]*$/.test(name) && m.api === API
    && typeof m.main === 'string' && !m.main.includes('..') && texts(m.actions) && texts(m.keys) && texts(m.commands)
    && Object.values(m.keys || {}).every((a) => Object.hasOwn(m.actions || {}, a))
    && (m.draftEditor === undefined || Object.hasOwn(m.actions || {}, m.draftEditor));
}

/** Every add-on there is, by its manifest; one whose manifest is missing or wrong is not one. @param {string} [dir] @returns {Manifest[]} */
function manifests(dir = ADDONS_DIR) {
  let names;
  try { names = fs.readdirSync(dir).sort(); } catch { return []; }
  const out = [];
  for (const name of names) {
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(dir, name, 'addon.json'), 'utf8')); } catch { continue; }
    if (valid(m, name)) out.push({ ...m, dir: path.join(dir, name) });
  }
  return out;
}

/** An add-on's section of the configuration, {} when it has none. @param {any} config @param {string} name @returns {any} */
function sectionOf(config, name) {
  const s = config.addons && config.addons[name];
  return isPlainObject(s) ? s : {};
}

/** The add-ons the configuration turns on. @param {any} config @param {string} [dir] */
const enabledAddons = (config, dir) => manifests(dir).filter((m) => sectionOf(config, m.name).enabled === true);

/** How one of an add-on's actions or commands is run. @param {Manifest} m @param {string} verb @param {string[]} [args] */
const argvOf = (m, verb, args = []) => [process.execPath, path.join(m.dir, m.main), verb, ...args];

/**
 * What a terminal attaching is given: the actions of the add-ons that are on, named `<add-on>.<action>`, as commands nmux
 * runs with the terminal lent, and the keys after the leader that run them; no keys without a leader. An agent's editor for
 * a draft is the agent's to run, and no key's.
 * @param {any} config @param {string} [dir]
 * @returns {{actions: Record<string, string[]>, keys: {leader: string, bindings: Record<string, string>}|null}}
 */
function attachActions(config, dir) {
  /** @type {Record<string, string[]>} */
  const actions = {};
  /** @type {Record<string, string>} */
  const bindings = {};
  for (const m of enabledAddons(config, dir)) {
    for (const action of Object.keys(m.actions || {})) {
      if (action !== m.draftEditor) actions[`${m.name}.${action}`] = argvOf(m, action);
    }
    const own = sectionOf(config, m.name).keys;
    const keys = isPlainObject(own) ? own : (m.keys || {});
    for (const [key, action] of Object.entries(keys)) {
      if (typeof action === 'string' && Object.hasOwn(m.actions || {}, action)) bindings[key] = `${m.name}.${action}`;
    }
  }
  const leader = config.addons && config.addons.leader;
  return { actions, keys: leader && Object.keys(bindings).length ? { leader, bindings } : null };
}

/**
 * Who answers `ccs <cmd>`: how an add-on that is on runs it, or the name of one that would if it were on.
 * @param {any} config @param {string} cmd @param {string[]} args @param {string} [dir]
 * @returns {{argv: string[]}|{off: string}|null}
 */
function addonCommand(config, cmd, args, dir) {
  const all = manifests(dir).filter((m) => Object.hasOwn(m.commands || {}, cmd));
  const on = all.find((m) => sectionOf(config, m.name).enabled === true);
  if (on) return { argv: argvOf(on, cmd, args) };
  return all.length ? { off: all[0].name } : null;
}

/** @param {string} s */
const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The editor an agent runs for a draft when an add-on that is on edits drafts: a script, since an agent splits VISUAL on
 * spaces, that runs the add-on and tells it the configuration and the editors the agent would have run otherwise.
 * @param {any} config @param {Record<string, string>} env the agent's environment @param {string} file where the script goes
 * @param {string} configFile @param {string} [dir]
 * @returns {{file: string, script: string}|null}
 */
function draftEditor(config, env, file, configFile, dir) {
  const m = enabledAddons(config, dir).find((a) => a.draftEditor && sectionOf(config, a.name).draftEditor !== false);
  if (!m || !m.draftEditor) return null;
  const vars = [['CCS_CONFIG', configFile], ['CCS_AGENT_VISUAL', env.VISUAL || ''], ['CCS_AGENT_EDITOR', env.EDITOR || '']];
  const script = `#!/bin/sh\n# the ${m.name} add-on, as an agent's editor for a draft: ccs writes this at each start\n`
    + `${vars.map(([k, v]) => `${k}=${shq(v)}`).join(' ')} exec ${argvOf(m, m.draftEditor).map(shq).join(' ')} "$@"\n`;
  return { file, script };
}

module.exports = { ADDONS_DIR, manifests, sectionOf, enabledAddons, attachActions, addonCommand, draftEditor };
