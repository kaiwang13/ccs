'use strict';
// @ts-check
/**
 * ExitIntent tracker (spec §3.7, decision 63, refinement R10). Attributes a clean Claude exit to the one client whose
 * unbroken, single-client typed run ended in Enter with "/exit" or "/quit", when nothing else was written to Claude
 * after that Enter. It reads the RAW bytes of each forwarded InputToken (classify() names '/' '' and digits "number"):
 * a printable ASCII/UTF-8 character appends, 0x7f/0x08 deletes one character, \r or \n submits, anything else (another
 * control byte, any escape sequence, a lone ESC, a paste) invalidates the draft. Deliberately narrow: a wrong
 * attribution needs an unbroken typed run, so the worst case of a miss is the ordinary unattributed path.
 */
const PRINTABLE_CHAR = /^[^\x00-\x1f\x7f]$/u;
const EXIT_LINE = /^\/(exit|quit)\s*$/i;

class ExitIntent {
  constructor() {
    /** @type {{clientId: string|null, text: string}} */
    this.draft = { clientId: null, text: '' };
    /** @type {{clientId: string, atTotal: number}|null} */
    this.pendingTag = null;
  }

  /**
   * Every token forwarded to Claude on a client's behalf (spec §3.7 step 9 only).
   * @param {string} clientId
   * @param {{kind: string, bytes: Buffer, seq: string}} tok
   * @param {string} cls classify() of the token's first event (not used for attribution, R10)
   * @param {number} writtenTotal the session's forwarded-byte total after this write
   */
  onForwarded(clientId, tok, cls, writtenTotal) {
    void cls;
    if (this.pendingTag && this.pendingTag.atTotal !== writtenTotal) this.pendingTag = null;   // superseded by a later write
    if (tok.kind !== 'seq') { this._clear(); return; }
    if (this.draft.clientId !== null && this.draft.clientId !== clientId) { this._clear(); return; }  // interleaved: unattributable
    const b = tok.bytes;
    if (b.length === 1 && (b[0] === 0x0d || b[0] === 0x0a)) {
      if (this.draft.clientId === clientId && EXIT_LINE.test(this.draft.text)) this.pendingTag = { clientId, atTotal: writtenTotal };
      this._clear();
      return;
    }
    if (b.length === 1 && (b[0] === 0x7f || b[0] === 0x08)) {
      if (this.draft.clientId === null) this.draft = { clientId, text: '' };
      this.draft.text = [...this.draft.text].slice(0, -1).join('');
      return;
    }
    if (PRINTABLE_CHAR.test(tok.seq) && b[0] !== 0x1b) {
      if (this.draft.clientId === null) this.draft = { clientId, text: '' };
      this.draft.text += tok.seq;
      return;
    }
    this._clear();                                                              // arrows, history recall, any control
  }

  /** A bracketed paste was forwarded: pasted text never attributes. */
  onPaste() { this._clear(); }

  /**
   * Consumes the tag when Claude exits. @param {{code: number|null, signal: string|null}} exit @param {number} writtenTotal
   * @returns {string|null} the attributed client id, or null (unattributed)
   */
  take(exit, writtenTotal) {
    const tag = this.pendingTag;
    this.pendingTag = null;
    this._clear();
    if (!tag || tag.atTotal !== writtenTotal) return null;
    if (exit.code !== 0 || exit.signal) return null;
    return tag.clientId;
  }

  _clear() { this.draft = { clientId: null, text: '' }; }
}

module.exports = { ExitIntent };
