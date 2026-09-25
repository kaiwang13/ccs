'use strict';
// @ts-check
/**
 * `ccs feishu setup` (spec §4.2, §11): bind a Feishu app to this host. Spawned by the launcher with the terminal
 * attached. Either scan a QR code (registerApp creates or picks an app and returns its credentials) or pass
 * `--app-id` and type the secret. The credentials are verified with Feishu before anything is written.
 */
const { resolvePaths } = require('../../src/common/paths.js');
const { loadSdk, domainFor, quietLogger } = require('./lib/gateway.js');
const { saveConfig, setEnabled } = require('./lib/config.js');
const { writeSecret } = require('./lib/secrets.js');

/** Scopes beyond the Feishu app template that ccs needs: group messages without an @-mention, and creating groups. */
const REQUIRED_SCOPES = ['im:message.group_msg', 'im:chat'];

const NOTICE = [
  'ccs Feishu add-on setup',
  '- Everything shown in a session\'s Feishu group (your prompts, the agent\'s replies, tool output) is also visible to Feishu the service.',
  '- Use one Feishu app per host: two hosts connected to one app would split its messages between them at random.',
  '',
].join('\n');

/** @param {string[]} argv */
function parse(argv) {
  /** @type {{appId: string|null, tenant: 'feishu'|'lark'|null}} */
  const o = { appId: null, tenant: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--app-id' || a === '--tenant') {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      if (a === '--app-id') o.appId = v;
      else if (v === 'feishu' || v === 'lark') o.tenant = v;
      else throw new Error('--tenant must be feishu or lark');
    } else throw new Error(`unknown option ${a}`);
  }
  return o;
}

/** Thrown by readLine's TTY branch on Ctrl-C (M4); runSetup catches it and returns exit code 130. */
class SetupAborted extends Error {}

/** One line from a stream (the secret). A terminal gets a prompt, no echo, and (M4) Backspace/Ctrl-C handling: a
 *  non-TTY stream (piped input, or a test) is read as whole lines, unchanged. @param {any} stdin
 *  @param {{write(s: string): void}} out @returns {Promise<string>} */
async function readLine(stdin, out) {
  if (!stdin.isTTY) {
    let buf = '';
    for await (const chunk of stdin) {
      buf += chunk.toString('utf8');
      const nl = buf.search(/\n/);
      if (nl >= 0) { buf = buf.slice(0, nl); break; }
    }
    return buf.replace(/\r$/, '').trim();
  }
  out.write('App secret (input hidden): ');
  stdin.setRawMode(true);
  let restored = false;
  const restore = () => { if (!restored) { restored = true; stdin.setRawMode(false); } };
  let buf = '';
  try {
    line: for await (const chunk of stdin) {
      for (const ch of chunk.toString('utf8')) {
        const code = ch.charCodeAt(0);
        if (code === 0x03) { restore(); out.write('\n'); throw new SetupAborted('setup cancelled'); } // Ctrl-C
        if (code === 0x7f || code === 0x08) { buf = buf.slice(0, -1); continue; } // Backspace/^H
        if (code === 0x0d || code === 0x0a) break line; // Enter
        buf += ch;
      }
    }
  } finally {
    restore();
  }
  out.write('\n');
  return buf.trim();
}

/** @param {string} url @param {{write(s: string): void}} out */
function printQr(url, out) {
  try {
    require('qrcode-terminal').generate(url, { small: true }, (/** @type {string} */ s) => out.write(`${s}\n`));
  } catch { /* no QR renderer installed: the link printed above works on its own */ }
}

/**
 * @param {{argv: string[], env: Record<string, string|undefined>, io: {out: {write(s: string): void}, err: {write(s: string): void}, stdin: any}}} a
 * @returns {Promise<number>}
 */
async function runSetup({ argv, env, io }) {
  let opts;
  try { opts = parse(argv); } catch (e) {
    io.err.write(`ccs: ${/** @type {Error} */ (e).message}\nusage: ccs feishu setup [--app-id ID] [--tenant feishu|lark]\n`);
    return 2;
  }
  io.out.write(NOTICE);
  const paths = resolvePaths(env);
  const sdk = loadSdk(env);
  let appId;
  let appSecret;
  let tenant = opts.tenant || 'feishu';
  if (opts.appId) {
    appId = opts.appId;
    try { appSecret = await readLine(io.stdin, io.out); }
    catch (e) { if (e instanceof SetupAborted) return 130; throw e; }
    if (!appSecret) { io.err.write('ccs: the app secret is empty\n'); return 2; }
  } else {
    io.out.write('Scan the QR code with the Feishu app and create (or choose) an app for ccs.\n');
    const r = await sdk.registerApp({
      source: 'ccs',
      onQRCodeReady: (/** @type {{url: string, expireIn: number}} */ q) => {
        io.out.write(`Link (valid ${Math.max(1, Math.round(q.expireIn / 60))} min): ${q.url}\n`);
        printQr(q.url, io.out);
      },
      onStatusChange: (/** @type {{status: string}} */ s) => { if (s.status === 'domain_switched') io.out.write('Lark (international) tenant detected.\n'); },
      appPreset: { name: 'ccs · {user}', desc: 'ccs sessions in Feishu' },
      addons: { scopes: { tenant: REQUIRED_SCOPES }, events: { items: { tenant: ['im.message.receive_v1'] } }, callbacks: { items: ['card.action.trigger'] } },
    });
    appId = r.client_id;
    appSecret = r.client_secret;
    if (!opts.tenant && r.user_info && r.user_info.tenant_brand === 'lark') tenant = 'lark';
  }

  // Verify before writing anything: the owner lookup is the call the connector depends on first. M3: the SDK's
  // default logger can be handed a transport failure's request config (which, for the token call, includes the
  // app_secret body) — drop it entirely here rather than let it reach the terminal.
  const ch = sdk.createLarkChannel({ appId, appSecret, domain: domainFor(tenant), source: 'ccs', logger: quietLogger(() => {}) });
  let info;
  try { info = await ch.getAppInfo({ userIdType: 'open_id' }); } catch (e) {
    io.err.write(`ccs: could not verify the app with Feishu: ${String(/** @type {any} */ (e).message || e)}\n`);
    return 1;
  }
  if (!info || !info.ownerId) {
    io.err.write('ccs: the app has no owner visible to it; grant it the application-info scope in the Feishu developer console\n');
    return 1;
  }
  try {
    const app = (await ch.rawClient.application.v6.application.get({ path: { app_id: appId }, params: { lang: 'en_us' } })).data?.app;
    const granted = new Set(((app && app.scopes) || []).map((/** @type {any} */ s) => s.scope));
    const missing = REQUIRED_SCOPES.filter((s) => !granted.has(s));
    if (missing.length) {
      io.out.write(`Warning: the app is missing these scopes: ${missing.join(', ')}.\n`);
      io.out.write('Add them in the Feishu developer console (Permissions & Scopes), publish a new version, then start the connector.\n');
    }
  } catch { /* scope listing is best-effort; docs/feishu.md lists what to check */ }

  saveConfig(paths, { appId, tenant });
  writeSecret(paths, 'appSecret', appSecret);
  setEnabled(paths, true);
  io.out.write(`Bound Feishu app ${info.appName || appId} (${tenant}); its owner is the only person who can use it.\n`);
  io.out.write('Start the connector: ccs feishu start\n');
  return 0;
}

if (require.main === module) {
  runSetup({ argv: process.argv.slice(2), env: process.env, io: { out: process.stdout, err: process.stderr, stdin: process.stdin } })
    .then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`ccs: setup failed: ${String(e && e.message || e)}\n`); process.exitCode = 1; });
}

module.exports = { runSetup, REQUIRED_SCOPES };
