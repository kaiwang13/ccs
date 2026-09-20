'use strict';
// @ts-check
/**
 * Minimal script for test/unit/termcolors.test.js's process-exit regression test. Calls queryTermColors
 * against its own real stdin/stdout — a real pty in that test, which never answers the OSC 10/11 query, so
 * this always resolves via the timeoutMs path — then falls off the end doing nothing else.
 *
 * A correct implementation leaves nothing alive afterward, so this process exits on its own once the
 * promise resolves. The regression this fixture exists to catch: attaching a 'data' listener switches
 * stdin into flowing mode, and if queryTermColors ever restores raw mode without also restoring stdin's
 * paused state, the TTY read handle keeps the event loop alive and this process never exits on its own.
 */
const { queryTermColors } = require('../../src/cli/termcolors.js');

queryTermColors({ stdin: process.stdin, stdout: process.stdout }).then(() => {
  // Deliberately nothing else here — see the comment above.
});
