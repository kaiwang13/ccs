'use strict';
// @ts-check
/** A ccs session spec turned into what the host needs to run it. */
const path = require('node:path');
const { CCS_MESSAGES, keysWith } = require('./messages.js');
const { attachActions } = require('../addon/host.js');

const CCSD_MAIN = path.join(__dirname, '..', 'ccsd', 'main.js');

/**
 * What the host needs that ccs does not offer as a setting, under the host's names: the bar says ccs's keys, and those of the
 * add-ons that were on when the session started. @param {any} config
 */
function hostConfig(config) {
  return { ...config, notices: { bellOnAttention: config.notices.bellOnNeedsYou }, stream: { repaint: true },
    overlay: { ...config.overlay, timeZone: config.env.timezone }, keys: keysWith(attachActions(config).keys) };
}

/**
 * The keys and their guards are declared here because they are enforced on every keystroke, by the host, with or without ccsd.
 * @param {import('./spec').SessionSpec} spec @param {any} config @param {{suspendBanner: string}} screens
 */
function hostSpec(spec, config, screens) {
  return { id: spec.ccsId, name: spec.name, runtimeDir: spec.runtimeDir,
    child: { argv: spec.claude.argv, env: spec.claude.env, cwd: spec.claude.cwd }, pty: spec.pty, termColors: spec.termColors,
    spool: spec.historyDir ? { maxBytes: 0, keep: true, dir: spec.historyDir } : null,
    nestEnv: 'CCS_ID', holderEnv: { CCS_RUNTIME_DIR: spec.runtimeDir }, config: hostConfig(config), messages: CCS_MESSAGES,
    managed: { stays: true, detachKeys: ['Z', 'Q'], forwardFocus: false, guards: [{ keys: ['C', 'D'], marginMs: config.input.exitGuardMarginMs, code: 'EXIT_KEY_HELD' }],
      match: [screens.suspendBanner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')], stopGraceMs: config.stop.exitWaitMs,
      welcome: { ccsId: spec.ccsId }, attrs: { ccsId: spec.ccsId, setupKind: null, claude: { pid: null, status: null, waitingFor: null, name: spec.name, sessionId: null, bridgeSessionId: null } },
      command: { argv: [process.execPath, CCSD_MAIN] } },
    agentSpec: spec };
}

module.exports = { hostSpec, hostConfig, CCSD_MAIN };
