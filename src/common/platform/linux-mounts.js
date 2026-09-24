'use strict';
// @ts-check
/**
 * Parsing of the Linux mount table, kept apart from linux.js so it is a pure function testable on any OS.
 */

/** True when /proc is mounted with hidepid (anything but 0/off). When /proc is mounted more than once the
 *  last entry is the one actually in effect, so the last matching line wins rather than the first hidepid-on
 *  one — an earlier mount's hidepid must not mask a later mount without it.
 *  @param {string} mountsText contents of /proc/mounts */
function hidepidEnabled(mountsText) {
  let enabled = false;
  for (const line of mountsText.split('\n')) {
    const f = line.split(' ');
    if (f.length < 4 || f[1] !== '/proc' || f[2] !== 'proc') continue;
    const m = /(?:^|,)hidepid=([^,]+)/.exec(f[3]);
    enabled = !!(m && m[1] !== '0' && m[1] !== 'off');
  }
  return enabled;
}

module.exports = { hidepidEnabled };
