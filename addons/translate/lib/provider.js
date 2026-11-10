'use strict';
// @ts-check
/**
 * The model that translates: an OpenAI-compatible chat completions API, `POST {baseUrl}/chat/completions`, its answer
 * streamed as server-sent events. Nothing of it goes through the agent.
 *
 * addons.translate.provider: { "baseUrl": "https://…/v1", "model": "…", "apiKeyFile": "~/.config/ccs/translate.key",
 *   "apiKeyEnv": "CCS_TRANSLATE_API_KEY", "timeoutMs": 60000, "temperature": 0.2, "body": {…}, "headers": {…} }. A baseUrl
 * that is only a server, with no path, means the API at its /v1, where OpenAI-compatible servers serve it. The key is read
 * from the file, which only its owner may read, or else from the variable; a server that wants none is given none. An
 * agent's editor for a draft runs with the agent's environment, which has no CCS_ variables: there only the file serves.
 *
 * Servers differ in what they take, and this takes each as it is: a model's reasoning, which a server sends beside the
 * answer (`reasoning`, `reasoning_content`), is not the answer; a server that will not stream answers whole; a model that
 * takes no temperature but its own, as reasoning models do, is asked again without one (and `"temperature": null` never
 * sends one); `body` is merged into each request, for what one server alone takes, such as
 * `{ "chat_template_kwargs": { "enable_thinking": false } }`, and `headers` into its headers, such as Azure's `api-key`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** @typedef {{baseUrl: string, model: string, key: string|null, timeoutMs: number, temperature: number|null,
 *            body: Record<string, unknown>, headers: Record<string, string>}} Provider */

class ProviderError extends Error {}

/** @param {string} p */
const expand = (p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

/**
 * The provider a configuration names. Throws a ProviderError that says what to fix.
 * @param {any} section addons.translate @param {Record<string, string|undefined>} [env] @returns {Provider}
 */
function providerOf(section, env = process.env) {
  const p = section && typeof section.provider === 'object' && section.provider ? section.provider : {};
  let url = null;
  try { url = typeof p.baseUrl === 'string' && /^https?:\/\//.test(p.baseUrl) ? new URL(p.baseUrl) : null; } catch { /* not a URL */ }
  if (!url) throw new ProviderError('addons.translate.provider.baseUrl must be the API\'s URL, such as https://api.example.com/v1');
  if (typeof p.model !== 'string' || !p.model) throw new ProviderError('addons.translate.provider.model must name a model');
  let key = null;
  if (typeof p.apiKeyFile === 'string' && p.apiKeyFile) {
    const file = expand(p.apiKeyFile);
    let st;
    try { st = fs.statSync(file); } catch (e) { throw new ProviderError(`the key file ${file} cannot be read (${/** @type {Error} */ (e).message})`); }
    if (st.mode & 0o077) throw new ProviderError(`the key file ${file} may be read by others: chmod 600 it`);
    key = fs.readFileSync(file, 'utf8').trim() || null;
  }
  if (!key) key = env[typeof p.apiKeyEnv === 'string' && p.apiKeyEnv ? p.apiKeyEnv : 'CCS_TRANSLATE_API_KEY'] || null;
  const timeoutMs = Number.isSafeInteger(p.timeoutMs) && p.timeoutMs > 0 ? p.timeoutMs : 60000;
  const temperature = typeof p.temperature === 'number' ? p.temperature : p.temperature === null ? null : 0.2;
  const object = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (p.body !== undefined && !object(p.body)) throw new ProviderError('addons.translate.provider.body must be an object of request fields');
  if (p.headers !== undefined && !(object(p.headers) && Object.values(p.headers).every((h) => typeof h === 'string'))) {
    throw new ProviderError('addons.translate.provider.headers must be an object of header names and texts');
  }
  const baseUrl = url.pathname === '/' && !url.search ? `${url.origin}/v1` : p.baseUrl.replace(/\/+$/, '');
  return { baseUrl, model: p.model, key, timeoutMs, temperature, body: p.body || {}, headers: p.headers || {} };
}

/** What a failed answer says about itself, briefly. @param {Response} res */
async function failure(res) {
  let text = '';
  try { text = await res.text(); } catch { /* nothing more to say */ }
  let said = text;
  try { const j = JSON.parse(text); said = (j.error && (j.error.message || j.error)) || j.message || text; } catch { /* not JSON */ }
  return new ProviderError(`the API answered ${res.status}${said ? `: ${String(said).slice(0, 300)}` : ''}`);
}

/**
 * One request, its failure to be reached said as where and why.
 * @param {Provider} p @param {{role: string, content: string}[]} messages @param {number|null} temperature
 * @param {AbortSignal|undefined} signal
 */
async function post(p, messages, temperature, signal) {
  const url = `${p.baseUrl}/chat/completions`;
  const timeout = AbortSignal.timeout(p.timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(p.key ? { authorization: `Bearer ${p.key}` } : {}), ...p.headers },
      body: JSON.stringify({ model: p.model, messages, ...(temperature === null ? {} : { temperature }), stream: true, ...p.body }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (e) {
    if (signal && signal.aborted) throw e;
    if (timeout.aborted) throw new ProviderError(`no answer from ${url} within ${Math.round(p.timeoutMs / 1000)} s (addons.translate.provider.timeoutMs)`);
    const cause = /** @type {any} */ (e).cause;
    throw new ProviderError(`could not reach ${url}: ${(cause && (cause.message || cause.code)) || /** @type {Error} */ (e).message}`);
  }
}

/**
 * The model's answer to these messages, piece by piece as it comes.
 * @param {Provider} p @param {{role: string, content: string}[]} messages @param {{signal?: AbortSignal}} [o]
 * @returns {AsyncGenerator<string>}
 */
async function* complete(p, messages, { signal } = {}) {
  let res = await post(p, messages, p.temperature, signal);
  if (res.status === 400 && p.temperature !== null) {
    const refused = await failure(res);
    // a model that takes no temperature but its own
    if (!/temperature/i.test(refused.message)) throw refused;
    res = await post(p, messages, null, signal);
  }
  if (!res.ok || !res.body) throw await failure(res);
  if (!/event-stream/.test(res.headers.get('content-type') || '')) {
    // a server that would not stream: the whole answer at once
    const j = /** @type {any} */ (await res.json());
    const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (typeof text !== 'string') throw new ProviderError('the API answered with no text');
    yield text;
    return;
  }
  const decoder = new TextDecoder();
  let carry = '';
  for await (const bytes of /** @type {AsyncIterable<Uint8Array>} */ (res.body)) {
    carry += decoder.decode(bytes, { stream: true });
    const lines = carry.split('\n');
    carry = lines.pop() || '';
    for (const line of lines) {
      const data = line.startsWith('data:') ? line.slice(5).trim() : null;
      if (data === null || data === '') continue;
      if (data === '[DONE]') return;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new ProviderError(`the API failed: ${j.error.message || JSON.stringify(j.error)}`);
      const piece = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
      if (typeof piece === 'string' && piece) yield piece;
    }
  }
}

module.exports = { providerOf, complete, ProviderError };
