'use strict';
// @ts-check
/** Incremental reader of an append-only JSONL file: complete lines only, each exactly once, from a byte cursor. */
const fs = require('node:fs');

const MAX_READ = 4 * 1024 * 1024;

class TranscriptTail {
  /** @param {{file: string, offset?: number}} o */
  constructor({ file, offset = 0 }) {
    this.file = file;
    this.offset = offset;
    /** Inside a line longer than MAX_READ: discard up to its end. */
    this.skipping = false;
  }

  /** Complete lines appended since the last read. A file that shrank is read again from the start. @returns {string[]} */
  read() {
    let fd;
    try { fd = fs.openSync(this.file, 'r'); } catch { return []; }
    try {
      const size = fs.fstatSync(fd).size;
      if (size < this.offset) { this.offset = 0; this.skipping = false; }
      if (size === this.offset) return [];
      const len = Math.min(size - this.offset, MAX_READ);
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, this.offset);
      let start = 0;
      if (this.skipping) {
        const first = buf.indexOf(0x0a);
        if (first < 0 || first >= n) { this.offset += n; return []; }
        start = first + 1;
        this.skipping = false;
      }
      const nl = buf.lastIndexOf(0x0a, n - 1);
      if (nl < start) {
        if (n === MAX_READ) { this.offset += n; this.skipping = true; }
        return [];
      }
      const text = buf.subarray(start, nl).toString('utf8');
      this.offset += nl + 1;
      return text.split('\n').filter((l) => l.length > 0);
    } finally {
      fs.closeSync(fd);
    }
  }
}

module.exports = { TranscriptTail, MAX_READ };
