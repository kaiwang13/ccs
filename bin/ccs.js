#!/usr/bin/env node
'use strict';
// ccs entry point. Installed for M1 as ~/.local/bin/ccs, a sh wrapper that sets UV_THREADPOOL_SIZE=16 and
// runs this file with the absolute node path (docs/RUNBOOK.md).
require('../src/common/warnings.js').suppressExperimentalSqliteWarning();
const { main } = require('../src/cli/main.js');

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
    // Everything should already be closed; this unref'd timer only guarantees a prompt exit if a stray
    // handle survived (it never fires while the process would exit anyway).
    setTimeout(() => process.exit(code), 1000).unref();
  },
  (err) => {
    process.stderr.write(`ccs: internal error: ${(err && err.stack) || err}\n`);
    process.exit(1);
  },
);
