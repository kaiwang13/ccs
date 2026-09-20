'use strict';
// @ts-check
/** @typedef {{now(): number, setTimeout(fn: () => void, ms: number): any, clearTimeout(h: any): void}} Clock */
/** @typedef {'OPEN'|'SETUP'|'SUSPENDED'|'COOKED'|'EXITED'|'STOPPING'} GateKind */
/** @typedef {'STARTING'|'STARTING_SLOW'|'SETUP_GATED'|'RUNNING'|'SUSPENDED'|'EXITED'|'BACKOFF'|'STOPPING'|'STOPPED'|'STOP_STUCK'|'BLOCKED'|'FAILED'|'RECOVERING'} Lifecycle */
/** @typedef {{liveStatus: boolean, assignableSessionId: boolean, nameInArgv: boolean,
 *             remoteControl: 'per-session'|'daemon'|false}} Capabilities */
/** @typedef {{id: string, label: string, capabilities: Capabilities,
 *             resolveBin: Function, buildLaunch: Function, writeSettingsFile: Function,
 *             observe: Function, preflight: Function, doctorChecks: Function,
 *             discoverSessionId: Function}} Agent */
module.exports = {};
