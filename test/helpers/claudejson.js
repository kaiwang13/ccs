'use strict';
// Fixtures shaped like ~/.claude.json (spec §3.11 item 2). Never read or write the real file in tests.

/**
 * @param {{fillerKeys?: number, projects?: number, trusted?: string[], onboarding?: boolean, oauth?: boolean, accountUuid?: string}} [o]
 */
function claudeJsonFixture({ fillerKeys = 22, projects = 10, trusted = [], onboarding = true, oauth = true, accountUuid = '11111111-2222-3333-4444-555555555555' } = {}) {
  const obj = {};
  if (onboarding !== null) obj.hasCompletedOnboarding = onboarding;
  if (oauth) obj.oauthAccount = { accountUuid, emailAddress: 'test@example.invalid' };
  obj.theme = 'light';
  obj.projects = {};
  for (let i = 0; i < projects; i++) obj.projects[`/fixture/project-${i}`] = { hasTrustDialogAccepted: false, allowedTools: [] };
  for (const dir of trusted) obj.projects[dir] = { hasTrustDialogAccepted: true, allowedTools: [] };
  for (let i = 0; i < fillerKeys; i++) obj[`fillerKey${i}`] = i;
  return obj;
}

module.exports = { claudeJsonFixture };
