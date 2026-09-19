'use strict';
// Test driver: prints some "shell" lines (so tests can check they end up in scrollback), then runs the
// attach client. Usage: node run-attach.js <ccsId> <name> [--pre N] [--shrink] [--allow-setup]
const { resolvePaths } = require('../../src/common/paths.js');
const { attach } = require('../../src/cli/attach.js');

const argv = process.argv.slice(2);
const [id, name] = argv;
const preIdx = argv.indexOf('--pre');
const pre = preIdx >= 0 ? Number(argv[preIdx + 1]) : 0;
for (let i = 1; i <= pre; i++) process.stdout.write(`shell line ${i}\n`);
if (pre) process.stdout.write(`$ ccs attach ${name}\n`);
attach({ paths: resolvePaths(process.env), id, name, flags: { shrink: argv.includes('--shrink'), allowSetup: argv.includes('--allow-setup') } })
  .then((code) => process.exit(code), (err) => { process.stderr.write(`${err.stack}\n`); process.exit(1); });
