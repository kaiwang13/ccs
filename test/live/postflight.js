'use strict';
// Live-test postflight (spec §9.5): ~/.claude.json key/project counts not lower, theme unchanged,
// onboarding still true, claude process count back to baseline, created session ids listed. A violation
// throws and prints the exact restore command.
const fs = require('fs');
const { claudeProcesses, readClaudeJsonSummary, readSettingsTheme, LiveAbort, BASELINE_FILE, REAL_CLAUDE_JSON } = require('./preflight.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} pre livePreflight() result
 * @param {{created: Array<{name: string, id: string, sessionIds: string[]}>}} o
 */
async function livePostflight(pre, { created }) {
  const problems = [];
  const deadline = Date.now() + 60000;
  while (claudeProcesses().length > pre.processBaseline && Date.now() < deadline) await sleep(1000);
  const nowProcs = claudeProcesses();
  if (nowProcs.length > pre.processBaseline) problems.push(`claude process count ${nowProcs.length} > baseline ${pre.processBaseline} (pids ${nowProcs.join(', ')}); inspect them — never force-kill`);
  let cj = null;
  try { cj = readClaudeJsonSummary(); } catch (e) { problems.push(`~/.claude.json no longer parses: ${e.message}`); }
  if (cj) {
    if (cj.keys < pre.keys) problems.push(`~/.claude.json keys dropped ${pre.keys} → ${cj.keys}`);
    if (cj.projects < pre.projects) problems.push(`~/.claude.json projects dropped ${pre.projects} → ${cj.projects}`);
    if (cj.theme !== pre.theme) problems.push(`~/.claude.json theme changed ${pre.theme} → ${cj.theme}`);
    if (!cj.onboarding) problems.push('~/.claude.json hasCompletedOnboarding is no longer true');
  }
  const settingsTheme = readSettingsTheme();
  if (settingsTheme !== pre.settingsTheme) problems.push(`~/.claude/settings.json theme changed ${pre.settingsTheme} → ${settingsTheme}`);
  process.stdout.write(`# live postflight: created sessions: ${created.map((c) => `${c.name} (${c.id}; claude session ids ${c.sessionIds.join(', ') || 'unknown'})`).join('; ') || 'none'}\n`);
  if (problems.length) {
    process.stdout.write(`# live postflight FAILED:\n${problems.map((p) => `#  - ${p}`).join('\n')}\n`);
    process.stdout.write(`# restore (only after confirming no claude is running: pgrep -u "$USER" -fa share/claude/versions):\n#   cp -a '${pre.backupFile}' '${REAL_CLAUDE_JSON}'\n`);
    throw new LiveAbort(problems.join('; '));
  }
  const next = { keys: Math.max(pre.keys, cj.keys), projects: Math.max(pre.projects, cj.projects), at: new Date().toISOString() };
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(next), { mode: 0o600 });
}

module.exports = { livePostflight };
