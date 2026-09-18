'use strict';
// @ts-check
const { EventEmitter } = require('node:events');

/**
 * SuspendNet and the cooked-mode gate (spec §3.8, H2.6, refinement R1). Inputs: the holder's LFLAG{icanon, isig, echo,
 * fgIsClaude} (pushed on change from a 250 ms poll), output text, and tracker.alt. A suspend is CONFIRMED only when
 * Claude itself owns the terminal (fgIsClaude), raw mode was seen before, ICANON is on again, the screen is not alt
 * (alt means an editor handoff), and the "has been suspended" banner appeared: then exactly one SIGCONT. Cooked mode
 * without the banner never gets a signal, only a notice after 3 s. A child owning the terminal (an editor, !sh) resets
 * everything and never gates.
 * Emits 'lifecycle' ('SUSPENDED'|'RUNNING').
 */
class SuspendNet extends EventEmitter {
  /**
   * @param {{clock: import('../common/types').Clock, tracker: {alt: boolean}, signal: (sig: 'SIGCONT') => void,
   *   notice: (code: string, text: string, level?: 'info'|'warn') => void, name?: string, bannerRe?: RegExp}} o
   */
  constructor({ clock, tracker, signal, notice, name = 'NAME', bannerRe = /has been suspended/ }) {
    super();
    this.clock = clock;
    this.tracker = tracker;
    this.signal = signal;
    this.notice = notice;
    this.name = name;
    this.bannerRe = bannerRe;
    /** @type {{icanon: boolean, isig: boolean, echo: boolean, fgIsClaude: boolean}|null} */
    this.lflag = null;
    this.rawSeen = false;
    this.bannerSeen = false;
    this.sigcontSent = false;
    this.suspended = false;
    this.stuckTimer = null;
    this.unconfirmedTimer = null;
  }

  /** @returns {'OPEN'|'SUSPENDED'|'COOKED'} COOKED: c_cc bytes (Ctrl+C would be SIGINT, Ctrl+S XOFF) must not be written */
  get gate() {
    if (this.suspended) return 'SUSPENDED';
    if (this.lflag && (this.lflag.icanon || this.lflag.isig)) return 'COOKED';
    return 'OPEN';
  }

  /** @param {{icanon: boolean, isig: boolean, echo: boolean, fgIsClaude: boolean}} l */
  onLflag(l) {
    this.lflag = l;
    if (!l.icanon) {
      this.rawSeen = true;
      this.bannerSeen = false;
      this.sigcontSent = false;
      this._clear('stuckTimer');
      this._clear('unconfirmedTimer');
      if (this.suspended) {
        this.suspended = false;
        this.emit('lifecycle', 'RUNNING');
        this.notice('RESUMED', 'Claude UI resumed; its repaint duplicates the transcript', 'info');
      }
    }
    this._evaluate();
  }

  /** @param {string} text printable text of an output chunk */
  onText(text) {
    if (this.bannerRe.test(text)) { this.bannerSeen = true; this._evaluate(); }
  }

  _evaluate() {
    const l = this.lflag;
    if (!l) return;
    if (!l.fgIsClaude) {
      this.rawSeen = false;
      this._clear('unconfirmedTimer');
      this._clear('stuckTimer');
      this.suspended = false;
      this.sigcontSent = false;
      return;
    }
    if (!this.rawSeen || !l.icanon || this.tracker.alt) return;
    if (this.bannerSeen && !this.sigcontSent) {
      this.suspended = true;
      this.sigcontSent = true;
      this._clear('unconfirmedTimer');
      this.emit('lifecycle', 'SUSPENDED');
      this.signal('SIGCONT');
      this.stuckTimer = this.clock.setTimeout(() => {
        this.stuckTimer = null;
        if (this.lflag && this.lflag.icanon) this.notice('SUSPEND_STUCK', `Claude is still suspended; 'ccs restart ${this.name}' recovers it (the conversation is kept)`, 'warn');
      }, 5000);
    } else if (!this.bannerSeen && this.unconfirmedTimer === null) {
      this.unconfirmedTimer = this.clock.setTimeout(() => {
        this.unconfirmedTimer = null;
        const x = this.lflag;
        if (x && x.icanon && x.fgIsClaude && this.rawSeen && !this.tracker.alt && !this.bannerSeen) {
          this.notice('COOKED_UNCONFIRMED', `terminal in cooked mode; signal keys blocked. If Claude is frozen: ccs restart ${this.name}`, 'warn');
        }
      }, 3000);
    }
  }

  /** @param {'stuckTimer'|'unconfirmedTimer'} k */
  _clear(k) { if (this[k] !== null) { this.clock.clearTimeout(this[k]); this[k] = null; } }

  dispose() { this._clear('stuckTimer'); this._clear('unconfirmedTimer'); }
}

module.exports = { SuspendNet };
