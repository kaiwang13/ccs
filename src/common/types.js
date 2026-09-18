'use strict';
// @ts-check
/** @typedef {{now(): number, setTimeout(fn: () => void, ms: number): any, clearTimeout(h: any): void}} Clock */
/** @typedef {'OPEN'|'SETUP'|'SUSPENDED'|'COOKED'|'EXITED'|'STOPPING'} GateKind */
/** @typedef {'STARTING'|'STARTING_SLOW'|'SETUP_GATED'|'RUNNING'|'SUSPENDED'|'EXITED'|'BACKOFF'|'STOPPING'|'STOPPED'|'STOP_STUCK'|'BLOCKED'|'FAILED'|'RECOVERING'} Lifecycle */
module.exports = {};
