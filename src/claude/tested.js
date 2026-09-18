'use strict';
// @ts-check
/**
 * Claude Code versions ccs is tested against. A version is "tested" only if its key
 * decoder was extracted and recorded in decoder-baseline.json (spec §9.2): the differential
 * test then proves src/common/vt/keys.js matches that binary.
 */
const fs = require('node:fs');
const path = require('node:path');

const BASELINE_FILE = path.join(__dirname, 'decoder-baseline.json');

/** @returns {Record<string, {sha256: string, names: {win32: string, keypress: string}, text: string}>} */
function loadDecoderBaseline() {
  const raw = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  /** @type {Record<string, {sha256: string, names: {win32: string, keypress: string}, text: string}>} */
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (/^\d+\.\d+\.\d+$/.test(k)) out[k] = v; // skip "schema"
  }
  return out;
}

/** @type {string[]} */
const TESTED_VERSIONS = Object.keys(loadDecoderBaseline()).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

module.exports = { TESTED_VERSIONS, loadDecoderBaseline };
