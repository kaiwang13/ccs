'use strict';
// @ts-check
/**
 * What the host does not do yet, by test. See lib/known.js for why an entry must keep failing, and failing this way. Each
 * group names the part of the design that removes it: docs/superpowers/specs/2026-11-01-nmux-standalone-host-design.md.
 * @type {Record<string, {failsWith: RegExp, why: string}>}
 */
const KNOWN = {
  // §6.2: the emulator is a fixed 240x150, so what wrapped or scrolled in the real terminal did not in the emulator.
  'a line longer than the terminal (80x24): rejoin': { failsWith: /^differs: screen,cursor,transcript$/m, why: 'the fixed-width emulator never wrapped the line' },
  'running a command longer than the terminal (80x24): rejoin': { failsWith: /^differs: screen,cursor,transcript$/m, why: 'the fixed-width emulator garbles a wrapped command line' },
  'editing a command longer than the terminal (80x24): rejoin': { failsWith: /^differs: screen,transcript$/m, why: 'the fixed-width emulator garbles a wrapped command line' },
  'shrinking the terminal (80x24): rejoin': { failsWith: /^differs: screen,cursor,transcript$/m, why: 'history in the fixed-width emulator does not follow a resize' },
  'a scroll region (120x40): rejoin': { failsWith: /^differs: screen,transcript$/m, why: 'a scroll region lands in the wrong rows of the 150-row emulator' },
  'a pager, still open (80x24): rejoin': { failsWith: /^differs: screen,style,modes$/m, why: 'a pager scrolls by line feed, which the 150-row emulator does not scroll on, and its modes are not restored' },

  // §6.4: a join restores the screen but not every mode the session set.
  'vim, still open (80x24): rejoin': { failsWith: /^differs: modes$/m, why: 'application cursor and keypad modes are not restored, so arrow keys send the wrong sequences' },

  // §7: control characters are dropped whenever the terminal has signals enabled, which protects Claude and breaks a shell.
  'Ctrl+C twice at the prompt (80x24): live': { failsWith: /timed out waiting for the first interrupt/, why: 'the COOKED gate drops Ctrl+C' },
  'Ctrl+C interrupts a foreground program': { failsWith: /timed out waiting for the prompt to come back/, why: 'the COOKED gate drops Ctrl+C' },
  'Ctrl+D ends the shell': { failsWith: /timed out after 5000 ms waiting for the client to exit/, why: 'the COOKED gate drops Ctrl+D, and without it a client still stays attached to the ended session' },

  // §4.4: the keys belong to the program.
  'Ctrl+Z suspends the foreground job': { failsWith: /timed out waiting for the job to stop/, why: 'Ctrl+Z detaches' },

  // §6.1: output is lost, or parsed far too slowly, when it arrives faster than the emulator takes it.
  'a flood loses nothing': { failsWith: /^lost \d+ MB of output$/m, why: 'the holder overwrites bytes the server has not read yet' },
  'line-by-line output keeps up': { failsWith: /timed out after 15000 ms waiting for the output to be parsed/, why: 'the emulator takes about 1,000 chunks a second, however small' },

  // §6.3: a client that falls behind is disconnected instead of skipped ahead.
  'a flood keeps a reading client attached': { failsWith: /the client was dropped: OVERFLOW/, why: 'more than 1 MiB behind is a disconnect' },
  'a stalled terminal stays attached': { failsWith: /the client gave up in round 4/, why: 'the fourth overflow in five minutes ends the client' },

  // §6.2: clients taller than the pty.
  'a taller client: a scroll region': { failsWith: /timed out waiting for the tall client to match/, why: 'the row rewrite does not cover DECSTBM' },
};

module.exports = { KNOWN };
