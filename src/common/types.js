'use strict';
// @ts-check
/** @typedef {import('nmux/base/types').Clock} Clock */
/** @typedef {{liveStatus: boolean, assignableSessionId: boolean, nameInArgv: boolean,
 *             remoteControl: 'per-session'|'daemon'|false, trustGate: boolean, emptyLastRow: boolean}} Capabilities */
/** @typedef {{id: string, label: string, capabilities: Capabilities, draftKey: string,
 *             resolveBin: Function, buildLaunch: Function, writeSettingsFile: Function,
 *             observe: Function, preflight: Function, doctorChecks: Function,
 *             discoverSessionId: Function, extraArgsAllow: Function, findResumeSession: Function,
 *             matchSetup?: (screen: string) => 'login'|'trust'|null}} Agent */
module.exports = {};
