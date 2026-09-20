'use strict';
// @ts-check
/**
 * node:sqlite (used by src/codex/threads.js) is a deliberate, reviewed choice in this codebase, not
 * something being migrated away from — but Node prints a process-wide ExperimentalWarning the
 * moment any code first requires it, which is pure noise on an otherwise-clean `ccs` command or
 * daemon log. Call this once, as early as possible in a REAL process entry point — never when a
 * file is merely `require`d as a library, since that would silence warnings for an unrelated host
 * process (e.g. the test runner). Suppresses only this one specific warning; every other warning
 * (deprecations, etc.) still prints exactly as Node would print it by default.
 */
function suppressExperimentalSqliteWarning() {
  process.removeAllListeners('warning');
  process.on('warning', (w) => {
    if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
    console.error(w.stack || `${w.name}: ${w.message}`);
  });
}

module.exports = { suppressExperimentalSqliteWarning };
