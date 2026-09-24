'use strict';
// @ts-check
/**
 * Finding the processes a test started, platform-blind: the process table comes from the platform seam.
 *
 * A process is matched when its command line mentions the test's root, or -- where the platform can read
 * it -- its environment does; then every descendant of a match is included too. The descendant step is
 * what finds a process whose argv names nothing of ours and whose environment is unreadable (macOS: the
 * fake claude a holder spawns). It is computed from ONE snapshot, before anything is signalled, because a
 * child whose parent has already exited is reparented and can no longer be traced.
 */
const procinfo = require('../../src/common/procinfo');

/**
 * `pid -> full command line` for every process we can see, excluding our own.
 * @returns {Array<{pid: number, argv: string}>}
 */
function allProcessArgvs() {
  /** @type {Array<{pid: number, argv: string}>} */
  const out = [];
  for (const { pid, argv } of procinfo.listProcesses()) {
    if (pid !== process.pid && argv !== null) out.push({ pid, argv });
  }
  return out;
}

/** This process and its ancestors: never signalled, whatever a caller passes. @returns {Set<number>} */
function selfAndAncestors() {
  const out = new Set([process.pid, 1]);
  let p = procinfo.ppid(process.pid);
  for (let i = 0; p !== null && p > 1 && i < 64; i++) {
    out.add(p);
    p = procinfo.ppid(p);
  }
  return out;
}

/**
 * `pids` plus every process descended from one of them.
 * @param {number[]} pids
 * @param {Array<{pid: number, ppid: number|null, argv: string|null}>} [table] one snapshot, if the caller has it
 * @returns {number[]}
 */
function withDescendants(pids, table = procinfo.listProcesses()) {
  /** @type {Map<number, number[]>} */
  const children = new Map();
  for (const { pid, ppid } of table) {
    if (ppid === null) continue;
    const list = children.get(ppid) || [];
    list.push(pid);
    children.set(ppid, list);
  }
  const never = selfAndAncestors();
  /** @type {Set<number>} */
  const out = new Set();
  const stack = [...pids];
  while (stack.length) {
    const pid = /** @type {number} */ (stack.pop());
    if (out.has(pid) || never.has(pid)) continue;
    out.add(pid);
    for (const c of children.get(pid) || []) stack.push(c);
  }
  return [...out];
}

/**
 * Every process (other than this one) belonging to `root`, and their descendants.
 * @param {string} root @returns {number[]}
 */
function processesUnder(root) {
  const table = procinfo.listProcesses();
  const matched = [];
  for (const { pid, argv } of table) {
    if (pid === process.pid) continue;
    if (argv !== null && argv.includes(root)) { matched.push(pid); continue; }
    const env = procinfo.readEnviron(pid);
    if (env && Object.values(env).some((v) => v.includes(root))) matched.push(pid);
  }
  return withDescendants(matched, table);
}

module.exports = { processesUnder, allProcessArgvs, withDescendants };
