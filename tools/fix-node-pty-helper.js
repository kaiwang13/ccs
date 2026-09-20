'use strict';
// @ts-check
/**
 * Restore the execute bit on node-pty's bundled `spawn-helper`.
 *
 * Why this exists: on macOS node-pty does not exec the target program directly. It execs a helper
 * binary, `node_modules/node-pty/prebuilds/darwin-<arch>/spawn-helper`, passing the real program and
 * argv through. If that file is not executable, `posix_spawn` fails with EACCES, which node-pty
 * reports as the thoroughly unhelpful:
 *
 *     Error: posix_spawnp failed.
 *
 * That message names neither the helper nor the permission, and it appears at pty-spawn time rather
 * than at install time, so it reads exactly like a platform incompatibility. It is not one: `chmod
 * +x` fixes it, and `posix_openpt` and `posix_spawn` both work fine on macOS.
 *
 * The published node-pty tarball ships the file without the bit (confirmed on a clean macOS CI
 * runner, not just locally), so this affects everyone rather than being a quirk of one machine.
 * node-pty's own postinstall only prunes its build/ directory and never looks at prebuilds/, so
 * nothing in the dependency fixes it.
 *
 * The alternative would be `npm_config_build_from_source=true`, which makes node-pty compile the
 * helper itself -- but that needs a full toolchain for every install to work around a permission
 * bit. Setting it here is cheaper and leaves the upstream package untouched on disk beyond the mode.
 *
 * Safe to run anywhere: it does nothing on Linux (no such file), nothing when the file is already
 * executable, and it never fails an install -- a missing or unreadable helper is node-pty's problem
 * to report, and failing the install here would replace a clear runtime error with a confusing one.
 */
const fs = require('node:fs');
const path = require('node:path');

/** @param {string} dir @returns {string[]} */
function helperPaths(dir) {
  /** @type {string[]} */
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // no prebuilds directory: nothing to do
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const helper = path.join(dir, e.name, 'spawn-helper');
    if (fs.existsSync(helper)) out.push(helper);
  }
  return out;
}

const prebuilds = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
const fixed = [];
for (const helper of helperPaths(prebuilds)) {
  try {
    const mode = fs.statSync(helper).mode & 0o777;
    if (mode & 0o111) continue; // already executable
    fs.chmodSync(helper, mode | 0o755);
    fixed.push(`${path.relative(process.cwd(), helper)} (${mode.toString(8)} -> ${(mode | 0o755).toString(8)})`);
  } catch {
    // Leave it: node-pty will report the real problem when it tries to spawn.
  }
}

if (fixed.length) {
  process.stdout.write(`ccs: restored the execute bit on node-pty's spawn-helper:\n  ${fixed.join('\n  ')}\n`);
}
