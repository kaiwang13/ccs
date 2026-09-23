'use strict';
// @ts-check
/**
 * Finding the processes a test started, platform-blind.
 *
 * The Linux implementation reads `/proc/<pid>/cmdline` and `/proc/<pid>/environ`, which is both
 * exact and free. macOS has neither, so there the same question is answered by asking `ps` for every
 * process's full argv and grepping it. That is coarser in one specific way worth stating: on Linux a
 * process is matched if its *environment* mentions the root even when its argv does not, and macOS
 * cannot see another process's environment at all (the same limitation that makes the orphan scan
 * unavailable -- handoff brief §5a). So on macOS the match is argv-only.
 *
 * Tests that need this are tests about ccs, not about process introspection, so the difference is
 * acceptable as long as it is written down. `terminateAll` is the main consumer and it uses the
 * result only to decide which pids to signal.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const procinfo = require('../../src/common/procinfo');

const IS_DARWIN = require('../../src/common/platform/index.js').capabilities.name === 'darwin';

/**
 * `pid -> full command line` for every process we can see, excluding our own.
 * @returns {Array<{pid: number, argv: string}>}
 */
function allProcessArgvs() {
  /** @type {Array<{pid: number, argv: string}>} */
  const out = [];
  if (IS_DARWIN) {
    let text;
    try {
      text = execFileSync('/bin/ps', ['-Ao', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    } catch {
      return out;
    }
    for (const line of text.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      if (pid === process.pid) continue;
      out.push({ pid, argv: m[2] });
    }
    return out;
  }
  for (const pid of procinfo.listPids()) {
    if (pid === process.pid) continue;
    let argv = '';
    try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' '); } catch { continue; }
    out.push({ pid, argv });
  }
  return out;
}

/**
 * Every process (other than this one) belonging to `root`: its command line mentions the root, or --
 * where the platform allows reading it -- its environment does.
 * @param {string} root @returns {number[]}
 */
function processesUnder(root) {
  const out = [];
  for (const { pid, argv } of allProcessArgvs()) {
    if (argv.includes(root)) { out.push(pid); continue; }
    const env = procinfo.readEnviron(pid); // null on macOS, which is the documented limitation
    if (env && Object.values(env).some((v) => v.includes(root))) out.push(pid);
  }
  return out;
}

module.exports = { processesUnder, allProcessArgvs };
