'use strict';
// @ts-check
/**
 * What an add-on reaches ccs with (src/addon/host.js says what an add-on is). It is the one file of ccs an add-on loads: a
 * bundled add-on by its path. Everything here runs in the add-on's own process.
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { loadConfig } = require('../common/config.js');
const { resolvePaths } = require('../common/paths.js');
const { applyProxyEnv } = require('../common/proxy.js');
const { sectionOf } = require('./host.js');
const { createRegistry } = require('../common/registry.js');
const { parseClaudeRecord, findClaudeTranscript } = require('../agents/transcript/claude.js');
const { parseCodexRecord, findCodexRollout } = require('../agents/transcript/codex.js');
const { controlRequest } = require('nmux/sdk');

/** How much of the end of a transcript is read for its turns. */
const TURNS_READ = 4 * 1024 * 1024;

/**
 * ccs's configuration, from the file CCS_CONFIG names or ccs's own, and the add-on's section of it ({} when there is none).
 * @param {string} name @param {Record<string, string|undefined>} [env]
 */
function addonConfig(name, env = process.env) {
  const config = loadConfig(resolvePaths(env).configFile);
  return { config, section: sectionOf(config, name) };
}

/**
 * A directory of the add-on's own for what lasts until the machine restarts, only this user's: in ccs's runtime directory.
 * @param {string} name @param {Record<string, string|undefined>} [env]
 */
function stateDir(name, env = process.env) {
  const dir = path.join(resolvePaths(env).runtimeDir, 'addons', name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * The session an action was run from, as nmux's attach client tells it; null outside one.
 * @param {Record<string, string|undefined>} [env] @returns {{name: string, sock: string}|null}
 */
function currentSession(env = process.env) {
  return env.NMUX_SOCK ? { name: env.NMUX_SESSION || '', sock: env.NMUX_SOCK } : null;
}

/**
 * Puts text in the agent's input as if it were typed, a paste when it has more than one line, and with `submit` sends it.
 * @param {{sock: string}} session @param {string} text @param {{submit?: boolean, label?: string}} [o]
 */
async function insert(session, text, { submit = false, label = 'addon' } = {}) {
  const r = await controlRequest(session.sock, 'SEND', { text, enter: submit }, { label });
  if (!r.ok) throw new Error(`the session did not take it (${r.error})`);
}

/**
 * The turns of a session's agent, from its transcript, the newest last: each the prompt that began it and what the agent
 * wrote in answer, its tools and thinking left out. Only those in the last few MiB of the transcript, and none before the
 * agent has written one.
 * @param {{sock: string}} session @param {{last?: number, env?: Record<string, string|undefined>}} [o]
 * @returns {Promise<{prompt: string, text: string, done: boolean}[]>}
 */
async function turns(session, { last = 50, env = process.env } = {}) {
  const paths = resolvePaths(env);
  const rec = await createRegistry(paths, { nfsTimeoutMs: loadConfig(paths.configFile).registry.nfsTimeoutMs }).get(path.basename(path.dirname(session.sock)));
  if (!rec) return [];
  const codex = rec.intent.agent === 'codex';
  const id = (rec.state && rec.state.lastSessionId) || rec.intent.initialSessionId;
  const file = codex ? findCodexRollout(path.join(paths.codexHome, 'sessions'), id) : findClaudeTranscript(paths.claudeProjectsDir, id);
  if (!file) return [];
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - TURNS_READ);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  const parse = codex ? parseCodexRecord : parseClaudeRecord;
  /** @type {{prompt: string, text: string, done: boolean}[]} */
  const out = [];
  const seen = new Set();
  let turn = null;
  for (const line of text.split('\n')) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    for (const ev of parse(r)) {
      if (seen.has(ev.key)) continue;
      seen.add(ev.key);
      if (ev.kind === 'prompt') { turn = { prompt: ev.text, text: '', done: false }; out.push(turn); }
      else if (ev.kind === 'text') {
        if (!turn) { turn = { prompt: '', text: '', done: false }; out.push(turn); }
        turn.text += (turn.text ? '\n\n' : '') + ev.text;
      } else if (ev.kind === 'turn_end' && turn) turn.done = true;
    }
  }
  return out.filter((t) => t.text).slice(-last);
}

/**
 * Makes this process's fetch() go through a proxy: a URL, 'none' for none, or null for the one in the environment it was
 * started with. Node's fetch speaks only http(s) proxies.
 * @param {string|null|undefined} setting
 */
function useProxy(setting) {
  if (setting) applyProxyEnv(/** @type {Record<string, string>} */ (process.env), setting);
  try { http.setGlobalProxyFromEnv(); } catch { /* a value Node cannot read leaves fetch going direct */ }
}

module.exports = { addonConfig, stateDir, currentSession, insert, turns, useProxy };
