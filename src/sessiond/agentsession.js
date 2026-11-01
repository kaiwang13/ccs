'use strict';
// @ts-check
/** A ccs session spec turned into what the host needs, and the session that runs it. */
const { Session } = require('nmux/server/session/session');
const { AgentController } = require('../agents/controller.js');
const { CCS_MESSAGES } = require('./messages.js');

/** @param {import('./spec').SessionSpec} spec */
function hostSpec(spec) {
  return { id: spec.ccsId, name: spec.name, runtimeDir: spec.runtimeDir, stateFile: spec.stateFile,
    child: { argv: spec.claude.argv, env: spec.claude.env, cwd: spec.claude.cwd }, pty: spec.pty, termColors: spec.termColors,
    nestEnv: 'CCS_ID', holderEnv: { CCS_RUNTIME_DIR: spec.runtimeDir } };
}

/** The config file's names for what the host calls otherwise. @param {any} config */
function hostConfig(config) {
  return { ...config, notices: { bellOnAttention: config.notices.bellOnNeedsYou } };
}

/**
 * @param {{spec: import('./spec').SessionSpec, config: any, clock: import('nmux/base/types').Clock, log: any, paths: any, screens: any,
 *   timers?: object, initialState?: any} & Record<string, any>} o the rest is passed to Session
 */
function createAgentSession({ spec, config, clock, log, paths, screens, timers = {}, initialState = null, ...rest }) {
  const controller = new AgentController({ spec, config, clock, log, paths, screens, timers, initialState });
  return new Session({ spec: hostSpec(spec), config: hostConfig(config), clock, log, layout: paths, controller, messages: CCS_MESSAGES, timers, initialState, ...rest });
}

module.exports = { createAgentSession, hostSpec, hostConfig };
