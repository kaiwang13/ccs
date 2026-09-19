'use strict';
// Live-test preflight (spec §9.5). Aborts the run unless it is safe to start a real claude.
//
// Why so strict: on 2026-09-16 concurrent test claude processes on this NFS home destroyed ~/.claude.json
// (86 → 36 keys, 61 → 1 projects), which dropped every claude into onboarding. Live tests therefore back
// the file up first, run one session at a time, never force-kill, and verify the file afterwards.
// Nothing here executes claude: the version comes from the resolved binary's path (spec §3.2).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolvePaths } = require('../../src/common/paths.js');
const { DEFAULTS } = require('../../src/common/config.js');
const { listPids, readEnviron } = require('../../src/common/procinfo.js');
const { resolveClaudeBin } = require('../../src/sessiond/launcher.js');

const HOME = os.homedir();
const LIVE_DIR = path.join(HOME, '.local', 'state', 'ccs-live');
const BASELINE_FILE = path.join(LIVE_DIR, 'baseline.json');
const REAL_CLAUDE_JSON = path.join(HOME, '.claude.json');
const REAL_SETTINGS = path.join(HOME, '.claude', 'settings.json');

class LiveAbort extends Error {
  constructor(message) { super(`live preflight/postflight abort: ${message}`); this.name = 'LiveAbort'; }
}

/** Our own processes whose executable is a Claude Code version binary. */
function claudeProcesses() {
  let versionsDir;
  try { versionsDir = fs.realpathSync(path.join(HOME, '.local', 'share', 'claude', 'versions')); } catch { return []; }
  const found = [];
  for (const pid of listPids()) {
    if (!readEnviron(pid)) continue; // not ours (EACCES) or gone
    let exe;
    try { exe = fs.realpathSync(`/proc/${pid}/exe`); } catch { continue; }
    if (exe.startsWith(`${versionsDir}/`)) found.push(pid);
  }
  return found;
}

function readClaudeJsonSummary() {
  const text = fs.readFileSync(REAL_CLAUDE_JSON, 'utf8');
  const obj = JSON.parse(text);
  const projects = obj.projects && typeof obj.projects === 'object' ? obj.projects : {};
  return { keys: Object.keys(obj).length, projects: Object.keys(projects).length, theme: obj.theme ?? null, onboarding: obj.hasCompletedOnboarding === true, trusted: projects, text };
}

function readSettingsTheme() {
  try { return JSON.parse(fs.readFileSync(REAL_SETTINGS, 'utf8')).theme ?? null; } catch { return null; }
}

function stamp() { return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, ''); }

async function livePreflight() {
  fs.mkdirSync(path.join(LIVE_DIR, 'backups'), { recursive: true, mode: 0o700 });
  const processBaseline = claudeProcesses().length;
  let cj;
  try { cj = readClaudeJsonSummary(); } catch (e) { throw new LiveAbort(`~/.claude.json does not parse (${e.message}); restore it before running live tests`); }
  if (!cj.onboarding) throw new LiveAbort('~/.claude.json has hasCompletedOnboarding !== true');
  let baseline = { keys: 0, projects: 0 };
  try { baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); } catch { /* first live run */ }
  if (cj.keys < baseline.keys || cj.projects < baseline.projects) {
    throw new LiveAbort(`~/.claude.json has ${cj.keys} keys / ${cj.projects} projects, below the recorded baseline ${baseline.keys} / ${baseline.projects} (${BASELINE_FILE})`);
  }
  const backupFile = path.join(LIVE_DIR, 'backups', `claude.json.${stamp()}.json`);
  fs.writeFileSync(backupFile, cj.text, { mode: 0o600 });

  const realEnv = { ...process.env };
  for (const k of ['CCS_CLAUDE_BIN', 'CCS_CLAUDE_HOME', 'CCS_CLAUDE_JSON']) delete realEnv[k];
  const bin = resolveClaudeBin(resolvePaths(realEnv), DEFAULTS);
  if (!bin || !bin.tested || bin.source !== 'versions') {
    throw new LiveAbort(`the claude ccs would launch is not a tested version (${bin ? `${bin.path} ${bin.version}` : 'none found'}; tested: ${DEFAULTS.claude.testedVersions.join(', ')})`);
  }

  const scratch = process.env.CCS_LIVE_CWD;
  if (!scratch || !fs.existsSync(scratch) || !fs.statSync(scratch).isDirectory()) {
    throw new LiveAbort('set CCS_LIVE_CWD to an existing scratch directory whose basename starts with ccs-live-scratch (run `claude` there once by hand and accept the trust dialog)');
  }
  const scratchReal = fs.realpathSync(scratch);
  if (!path.basename(scratchReal).startsWith('ccs-live-scratch')) throw new LiveAbort(`CCS_LIVE_CWD basename must start with ccs-live-scratch, got ${scratchReal}`);
  if (!cj.trusted[scratchReal] || cj.trusted[scratchReal].hasTrustDialogAccepted !== true) throw new LiveAbort(`${scratchReal} is not trusted in ~/.claude.json; run claude there once by hand and accept the trust dialog`);

  for (const pid of listPids()) {
    let argv = '';
    try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
    if (argv.includes('ccs-test-live-')) throw new LiveAbort(`a previous live test session is still running (pid ${pid}); stop it with ccs before starting another`);
  }
  return { processBaseline, keys: cj.keys, projects: cj.projects, theme: cj.theme, settingsTheme: readSettingsTheme(), backupFile, scratch: scratchReal, bin };
}

module.exports = { livePreflight, claudeProcesses, readClaudeJsonSummary, readSettingsTheme, LiveAbort, LIVE_DIR, BASELINE_FILE, REAL_CLAUDE_JSON };
