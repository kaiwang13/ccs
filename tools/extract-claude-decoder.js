#!/usr/bin/env node
'use strict';
// @ts-check
/**
 * Extract Claude Code's input key decoders from the compiled binary, so the port in
 * src/common/vt/keys.js can be tested against the real thing (spec §9.2, contract R4).
 *
 * Anchors are stable literals, never minified identifiers (the bundler renames those every
 * release): the chunk starts at the win32-input-mode regex `/^\x1b\[(\d*(?:;\d*){0,5})_$/`
 * and ends before `var X=50,Y=2000,Z=2000;` (Claude's incomplete-escape and paste timeouts).
 * Inside it the win32 decoder is the function that execs that regex first, and the keypress
 * parser is identified by its default input argument and initial key-event object.
 * A candidate that fails the minimum-content check is ignored, so a short or broken
 * extraction ends in `decoder not found` - a hard failure, never a silent pass.
 *
 * CLI: node tools/extract-claude-decoder.js <claude binary> [--write-baseline <version>]
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseModule, dependencySource } = require('./decoder-source.js');

const BASELINE_FILE = path.resolve(__dirname, '..', 'src', 'claude', 'decoder-baseline.json');
const MIN_FUNCTIONS = 20;
const REQUIRED_LITERALS = [
  '/^\\x1b\\[(\\d+)(?::(\\d*)(?::(\\d+))?)?(?:;(\\d+))?u/', // kitty CSI-u (xf)
  '/^\\x1b\\[27;(\\d+);(\\d+)~/', // modifyOtherKeys (Cf)
  'kind:"key",name:"",fn:!1',
];

/**
 * @param {string} binPath
 * @returns {{text: string, names: {win32: string, keypress: string}, sha256: string, dependencies?: string}}
 */
function extract(binPath) {
  const src = fs.readFileSync(binPath).toString('latin1');
  const startRe = /(?:var |,)(\w+)=\/\^\\x1b\\\[\(\\d\*\(\?:;\\d\*\)\{0,5\}\)_\$\/[;,]/g;
  const endRe = /var (\w+)=50,(\w+)=2000,(\w+)=2000;/g;
  /** @type {Array<{text: string, names: {win32: string, keypress: string}, sha256: string, dependencies?: string}>} */
  const found = [];
  let m;
  while ((m = startRe.exec(src))) {
    endRe.lastIndex = m.index;
    const e = endRe.exec(src);
    if (!e || e.index - m.index > 60000) continue;
    const text = Buffer.from(src.slice(m.index, e.index), 'latin1').toString('utf8');
    let ast;
    try { ast = parseModule(text); } catch { continue; }
    const functions = ast.ast.body.filter((n) => n.type === 'FunctionDeclaration');
    const vp = functions.find((n) => {
      const call = n.body.body[0]?.declarations?.[0]?.init;
      return n.params.length === 2 && call?.type === 'CallExpression'
        && call.callee.type === 'MemberExpression' && call.callee.object.name === m[1]
        && call.callee.property.name === 'exec' && call.arguments[0]?.name === n.params[0]?.name;
    });
    const cr = functions.find((n) => {
      const event = n.body.body[0]?.declarations?.[1]?.init;
      const props = new Map((event?.properties || []).map((p) => [p.key?.name, p.value]));
      return n.params.length === 1 && n.params[0].type === 'AssignmentPattern'
        && n.params[0].right.value === '' && event?.type === 'ObjectExpression'
        && props.get('kind')?.value === 'key' && props.get('name')?.value === ''
        && props.get('fn')?.type === 'UnaryExpression' && props.get('fn').operator === '!'
        && props.get('fn').argument.value === 1;
    });
    if (!vp || !cr) continue;
    if ((text.match(/function [\w$]+\(/g) || []).length < MIN_FUNCTIONS || !REQUIRED_LITERALS.every((lit) => text.includes(lit))) continue;
    const dependencies = dependencySource(src, m.index, e.index, [vp.id.name, cr.id.name]);
    found.push({ text, names: { win32: vp.id.name, keypress: cr.id.name }, dependencies, sha256: crypto.createHash('sha256').update(text).digest('hex') });
  }
  if (!found.length) throw new Error('decoder not found');
  const uniq = [...new Map(found.map((o) => [o.sha256, o])).values()];
  if (uniq.length !== 1) throw new Error(`ambiguous decoder copies: ${uniq.length}`);
  return uniq[0];
}

/**
 * Evaluate resolved bundle dependencies in a fresh vm context. Historical recorded chunks
 * without dependencies use the original 2.1.267 stubs: He/no parse
 * truthy/falsy env strings, bl() returns terminal info (none), sbe/sce are the focus-in/out
 * sequences, Sj is Claude's tokenizer (not extracted, must never be called here).
 * process.env is empty and the platform is linux: the Linux defaults the port assumes.
 * @param {{text: string, names: {win32: string, keypress: string}, dependencies?: string}} ex
 * @returns {{win32: Function, keypress: Function}}
 */
function load(ex) {
  const truthy = (/** @type {unknown} */ v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());
  const falsy = (/** @type {unknown} */ v) => ['0', 'false', 'no', 'off'].includes(String(v ?? '').toLowerCase());
  /** @type {Record<string, unknown>} */
  const ctx = { process: { env: {}, platform: 'linux' }, Buffer, String, Math, Array, parseInt, JSON };
  Object.assign(ctx, {
    He: truthy, no: falsy, bl: () => null, sbe: '\x1b[I', sce: '\x1b[O',
    Sj: () => { throw new Error('tokenizer not extracted'); },
  });
  vm.createContext(ctx);
  vm.runInContext((ex.dependencies || ex.text).replace(/^import\{Buffer as (\w+)\}from"buffer";/, 'var $1=Buffer;'), ctx, { filename: 'claude-decoder.js', timeout: 5000 });
  const win32 = ctx[ex.names.win32];
  const keypress = ctx[ex.names.keypress];
  if (typeof win32 !== 'function' || typeof keypress !== 'function') throw new Error('decoder functions missing after load');
  return { win32, keypress };
}

/**
 * Sanity check an extraction before it is recorded: Ctrl+Z in legacy, kitty and win32 forms.
 * @param {{win32: Function, keypress: Function}} d
 */
function selfCheck(d) {
  const z = d.keypress('\x1a');
  const kz = d.keypress('\x1b[122;5u');
  const w = d.win32('\x1b[90;44;26;1;8;1_', '');
  if (!(z.name === 'z' && z.ctrl) || !(kz.name === 'z' && kz.ctrl) || !w || w.sequences.length !== 1 || w.sequences[0] !== '\x1a') {
    throw new Error('extracted decoder failed the Ctrl+Z self-check');
  }
}

module.exports = { extract, load, selfCheck, BASELINE_FILE };

if (require.main === module) {
  const args = process.argv.slice(2);
  const bin = args[0];
  const wi = args.indexOf('--write-baseline');
  const version = wi >= 0 ? args[wi + 1] : null;
  if (!bin || (wi >= 0 && !/^\d+\.\d+\.\d+$/.test(String(version)))) {
    console.error('usage: node tools/extract-claude-decoder.js <claude binary> [--write-baseline <version>]');
    process.exit(2);
  }
  try {
    const ex = extract(bin);
    selfCheck(load(ex));
    console.log(JSON.stringify({ names: ex.names, sha256: ex.sha256, length: ex.text.length }));
    if (version) {
      /** @type {Record<string, unknown>} */
      const baseline = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) : {};
      baseline.schema = 'ccs.decoderbaseline/1';
      require('./decoder-compatibility.js').verifyRouting(load(ex));
      baseline[version] = { sha256: ex.sha256, names: ex.names, text: ex.text, ...(ex.dependencies ? { dependencies: ex.dependencies } : {}) };
      const ordered = Object.fromEntries(Object.keys(baseline).sort((a, b) => (a === 'schema' ? -1 : b === 'schema' ? 1 : a.localeCompare(b, 'en', { numeric: true }))).map((k) => [k, baseline[k]]));
      fs.writeFileSync(BASELINE_FILE, JSON.stringify(ordered, null, 2) + '\n');
      console.log(`wrote ${version} to ${BASELINE_FILE}`);
    }
  } catch (err) {
    console.error(`extract-claude-decoder: ${/** @type {Error} */ (err).message}`);
    process.exit(1);
  }
}
