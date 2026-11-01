'use strict';
// @ts-check
/** The connector's name for a session's control connection: it starts and stops with the connector. */
const { SessionClient } = require('nmux/sdk');

class ControlLink extends SessionClient {
  /** @param {{sockPath: string, label?: string, backoffMs?: number[]}} o */
  constructor({ sockPath, label = 'feishu', backoffMs = [250, 500, 1000, 2000, 5000] }) { super({ sockPath, label, backoffMs }); }
  start() { this.open(); }
  stop() { this.close(); }
}

module.exports = { ControlLink };
