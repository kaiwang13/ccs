'use strict';
// @ts-check
/** `ccs doctor [--lite] [--accept-config]` — M1 ships only the lite checks (full doctor is M2). */
const { parseArgs } = require('../args.js');
const { runDoctorLite } = require('../doctor.js');

/** @param {string[]} argv @param {any} ctx */
async function run(argv, ctx) {
  const { flags } = parseArgs(argv, { bool: ['--lite', '--accept-config'] });
  if (!flags['--lite'] && !flags['--accept-config']) ctx.out.write('ccs: full doctor arrives in M2; running the --lite checks\n');
  return runDoctorLite({ paths: ctx.paths, config: ctx.config, out: ctx.out, acceptConfig: !!flags['--accept-config'], nfsTimeoutMs: ctx.nfsTimeoutMs });
}

module.exports = { run };
