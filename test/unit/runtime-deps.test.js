'use strict';
// @ts-check
/**
 * A release package installs the production dependencies only (`npm ci --omit=dev`), so a package that what it runs requires
 * must be in `dependencies`: one in `devDependencies` is there in a clone and missing from every package. Followed from what a
 * package runs, `bin/`, `src/` and `addons/`, through the files they require and the `tools/` they run by path. An add-on
 * with a package.json of its own has its dependencies too.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');

const ROOT = path.join(__dirname, '..', '..');

/** @param {string} dir @returns {string[]} */
function sources(dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** The package a bare specifier names, or null for a builtin. @param {string} spec */
function packageOf(spec) {
  if (spec.startsWith('node:') || builtinModules.includes(spec.split('/')[0])) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** The dependencies a file's own package.json, and the root's, give it. @param {string} file */
function allowedFor(file) {
  const allowed = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies || {}));
  for (let dir = path.dirname(file); dir.startsWith(ROOT) && dir !== ROOT; dir = path.dirname(dir)) {
    const own = path.join(dir, 'package.json');
    if (fs.existsSync(own)) for (const d of Object.keys(JSON.parse(fs.readFileSync(own, 'utf8')).dependencies || {})) allowed.add(d);
  }
  return allowed;
}

test('every package what a release package runs requires is a runtime dependency', () => {
  const queue = ['bin', 'src', 'addons'].flatMap((d) => sources(path.join(ROOT, d)));
  const seen = new Set(queue);
  /** @type {string[]} */
  const missing = [];
  while (queue.length) {
    const file = /** @type {string} */ (queue.pop());
    const text = fs.readFileSync(file, 'utf8');
    /** @type {string[]} */
    const next = [];
    for (const m of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (m[1].startsWith('.')) next.push(path.resolve(path.dirname(file), m[1]));
      else {
        const pkg = packageOf(m[1]);
        if (pkg && !allowedFor(file).has(pkg)) missing.push(`${path.relative(ROOT, file)}: ${pkg}`);
      }
    }
    // a tool run by path, as doctor runs the decoder's: path.join(__dirname, …, 'tools', 'name.js')
    for (const m of text.matchAll(/'tools',\s*'([\w.-]+\.js)'/g)) next.push(path.join(ROOT, 'tools', m[1]));
    for (const p of next) {
      const js = [p, `${p}.js`, path.join(p, 'index.js')].find((f) => fs.existsSync(f) && fs.statSync(f).isFile() && f.endsWith('.js'));
      if (js && !seen.has(js)) { seen.add(js); queue.push(js); }
    }
  }
  assert.ok([...seen].some((f) => f.endsWith(path.join('tools', 'decoder-source.js'))), 'the tools doctor runs are followed');
  assert.deepEqual(missing, [], 'required at run time but not in dependencies');
});
