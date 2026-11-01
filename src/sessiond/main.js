'use strict';
// @ts-check
/**
 * Starts one agent session: `--start <ccsId>` or `--recover <ccsId>`. See startspec.js. A holder started by an older ccs
 * reruns exactly that command from its own release, so that one keeps running what it always ran.
 */
if (require.main === module) {
  require('../common/warnings.js').suppressExperimentalSqliteWarning();
  require('./startspec.js').startMain(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => { process.stderr.write(`ccs-sessiond: ${(err && err.stack) || err}\n`); process.exit(1); },
  );
}
