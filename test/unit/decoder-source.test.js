'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { dependencySource } = require('../../tools/decoder-source.js');

function resolve(primary, modules, roots) {
  const prefix = `\0${modules.join('\0')}\0`;
  const binary = prefix + primary + '\0';
  return dependencySource(binary, prefix.length, prefix.length + primary.length, roots);
}

test('dependency resolution preserves module scope when helpers reuse binding names', () => {
  const primary = 'import{helper as imported}from"bundle";var value=7;function decoder(n){return imported(n)+value}';
  const helper = 'var value=3;function helper(n){return n+value}export{helper};';
  const source = resolve(primary, [helper], ['decoder']);
  const ctx = vm.createContext({});
  vm.runInContext(source, ctx);
  assert.equal(ctx.decoder(2), 12);
});

test('missing and ambiguous bundle dependencies fail instead of guessing helpers', () => {
  const primary = 'import{helper}from"bundle";function decoder(n){return helper(n)}';
  assert.throws(() => resolve(primary, [], ['decoder']), /0 candidate modules/);
  assert.throws(() => resolve(primary, [
    'function helper(n){return n}export{helper};',
    'function helper(n){return n+1}export{helper};',
  ], ['decoder']), /2 candidate modules/);
});

test('helper dependencies follow parameter bindings and computed properties', () => {
  const primary = 'import{helper}from"bundle";function decoder(n){return helper(n)}';
  const helper = 'var table={x:4};var key="x";function helper(n){const local=n;return table[key]+local}export{helper};';
  const ctx = vm.createContext({});
  vm.runInContext(resolve(primary, [helper], ['decoder']), ctx);
  assert.equal(ctx.decoder(5), 9);
});


test('terminal environment checks only dependencies reachable from the decoder', () => {
  const primary = 'import{env}from"bundle";function decoder(){return env.TERM}function unused(){return env.secret}';
  const ctx = vm.createContext({});
  vm.runInContext(resolve(primary, [], ['decoder']), ctx);
  assert.equal(ctx.decoder(), 'xterm-256color');
});
