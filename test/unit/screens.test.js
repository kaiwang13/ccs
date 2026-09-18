'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScreens, matchSetup } = require('../../src/sessiond/screens.js');

const S = loadScreens('2.1.267');

test('loadScreens returns the committed 2.1.267 strings; unknown versions fall back to the newest', () => {
  assert.deepEqual(S, {
    onboarding: ['Choose the text style', "Let's get started"],
    login: ['Select login method', 'Paste code here', "Browser didn't open"],
    trust: ['Quick safety check', 'Is this a project you created or one you trust'],
    suspendBanner: 'has been suspended',
  });
  assert.deepEqual(loadScreens('9.9.9'), S);
});

test('login screens (any one string)', () => {
  assert.equal(matchSetup(' Claude Code can be used with your Claude subscription\n\n Select login method:\n ❯ 1. Claude account', S), 'login');
  assert.equal(matchSetup('Opening browser to sign in…\nBrowser didn\'t open? Use the url below to sign in', S), 'login');
  assert.equal(matchSetup('Paste code here if prompted >', S), 'login');
});

test('onboarding theme step needs both strings; the /theme picker alone does not match', () => {
  const onboarding = " Welcome to Claude Code\n\n Let's get started.\n\n Choose the text style that looks best with your terminal\n ❯ 1. Light mode";
  assert.equal(matchSetup(onboarding, S), 'onboarding');
  const themePicker = ' Theme\n\n Choose the text style that looks best with your terminal\n ❯ 1. Light mode';
  assert.equal(matchSetup(themePicker, S), null);
  assert.equal(matchSetup("⏺ Sure! Let's get started with the refactor.", S), null);
});

test('trust dialog wrapped across lines and inside a box still matches', () => {
  const trust = '╭──────────────────────────────────────────────╮\n│ Accessing workspace:                          │\n│ /data3/users/u/project                        │\n│ Quick safety check: Is this a project you     │\n│ created or one you trust? (Like your own code │\n╰──────────────────────────────────────────────╯';
  assert.equal(matchSetup(trust, S), 'trust');
  assert.equal(matchSetup('Quick safety check: nothing else here', S), null);
});

test('order is login, onboarding, trust; ordinary screens match nothing', () => {
  assert.equal(matchSetup("Let's get started. Choose the text style\nSelect login method", S), 'login');
  assert.equal(matchSetup("Let's get started. Choose the text style\nQuick safety check: Is this a project you created or one you trust", S), 'onboarding');
  assert.equal(matchSetup('❯ \n  ? for shortcuts', S), null);
  assert.equal(matchSetup('', S), null);
});
