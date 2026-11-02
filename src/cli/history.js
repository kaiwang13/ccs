'use strict';
// @ts-check
/**
 * Kept histories, as `ccs search` and `ccs view` find them: every session ccs ran with `history.keep`, under the history
 * directory by id, whether it is still running or ended long ago. Reading them is nmux's.
 */
const { history } = require('nmux/sdk');
const { UsageError } = require('./args.js');
const { isLive } = require('./lifecycle.js');

/** The zone times are shown and read in: the one every session runs in. @param {any} config */
const zoneOf = (config) => history.zone(config.env.timezone);

/**
 * A time as a person writes it, in `tz`, or null when none was given.
 * @param {string|undefined} text @param {string} flag @param {string} tz @returns {number|null}
 */
function when(text, flag, tz) {
  if (text === undefined) return null;
  const ms = history.parseWhen(text, Date.now(), tz);
  if (ms === null) throw new UsageError(`${flag}: no time in '${text}': for example 2026-11-01, '2026-11-01 14:00', 14:00, yesterday or 2h`);
  return ms;
}

/**
 * The kept histories with these names, or ids, or all of them, oldest first; each with its socket while it still runs, so that
 * what it has not written yet is read too. A name used again over time finds every session that had it.
 * @param {any} ctx @param {string[]} names @returns {Array<{kept: any, sockPath: string|null}>}
 */
function sourcesFor(ctx, names) {
  const all = history.keptUnder(ctx.paths.historyDir);
  const picked = names.length ? all.filter((k) => names.includes(k.name) || names.includes(k.id)) : all;
  const missing = names.filter((n) => !all.some((k) => k.name === n || k.id === n));
  if (missing.length) {
    const known = [...new Set(all.map((k) => k.name))];
    throw new UsageError(`no kept history for ${missing.map((n) => `'${n}'`).join(', ')}${known.length ? ` (there is ${known.join(', ')})` : ''}`);
  }
  return picked.map((kept) => ({ kept, sockPath: isLive(ctx.paths, kept.id) ? ctx.paths.ctlSock(kept.id) : null }));
}

module.exports = { zoneOf, when, sourcesFor };
