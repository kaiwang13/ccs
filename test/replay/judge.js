'use strict';
// @ts-check
/** Golden-replay judge (spec §9.3): LCS lost/extra line counts plus marker families (ported from vcmp.py / fam.py). */

const SEPARATOR = /^── ccs · /;
/** Marker families written by the spike prompts: R = 100 python rows, L = 3 edited data lines. */
const FAMILIES = Object.freeze({
  R: /row-(\d{3}) stream check/g,
  L: /line-(\d{3}) (?:alpha|OMEGA)/g,
});

/** All lines of a terminal's normal buffer, right-trimmed. @param {any} term @returns {string[]} */
function bufferLines(term) {
  const b = term.buffer.normal;
  const out = [];
  for (let i = 0; i < b.length; i++) { const l = b.getLine(i); out.push(l ? l.translateToString(true).trimEnd() : ''); }
  return out;
}

/** @param {string[]} a @param {string[]} b @returns {number} longest common subsequence length */
function lcsLength(a, b) {
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Lost/extra non-empty lines of `client` against `reference`; ccs's separator line is ignored. @param {string[]} reference @param {string[]} client */
function judgeLines(reference, client) {
  const a = reference.filter((x) => x !== '');
  const b = client.filter((x) => x !== '' && !SEPARATOR.test(x));
  const l = lcsLength(a, b);
  return { refLines: a.length, clientLines: b.length, lost: a.length - l, extra: b.length - l };
}

/** @param {string[]} lines @returns {Record<string, Map<string, number>>} family -> id -> occurrences */
function markerCounts(lines) {
  const text = lines.join('\n');
  /** @type {Record<string, Map<string, number>>} */
  const out = {};
  for (const [fam, re] of Object.entries(FAMILIES)) {
    const m = new Map();
    for (const hit of text.matchAll(new RegExp(re.source, 'g'))) m.set(hit[1], (m.get(hit[1]) || 0) + 1);
    out[fam] = m;
  }
  return out;
}

/**
 * Marker ids of `expected` (normally the emulator, which never reflows) that `client` lacks, and the client's
 * occurrence counts. dupWithin = occurrences − distinct ids (duplicated lines of that family).
 * @param {string[]} expected @param {string[]} client
 */
function judgeMarkers(expected, client) {
  const e = markerCounts(expected);
  const c = markerCounts(client);
  /** @type {Record<string, {expectedIds: number, clientIds: number, missingIds: number, occurrences: number, dupWithin: number}>} */
  const out = {};
  for (const fam of Object.keys(FAMILIES)) {
    let missing = 0;
    let occ = 0;
    for (const id of e[fam].keys()) if (!c[fam].has(id)) missing++;
    for (const n of c[fam].values()) occ += n;
    out[fam] = { expectedIds: e[fam].size, clientIds: c[fam].size, missingIds: missing, occurrences: occ, dupWithin: occ - c[fam].size };
  }
  return out;
}

module.exports = { bufferLines, lcsLength, judgeLines, judgeMarkers, markerCounts, FAMILIES, SEPARATOR };
