'use strict';
// @ts-check
/**
 * An OpenAI-compatible chat completions API on 127.0.0.1, for the translate add-on: it answers each request with
 * `reply(text, system)` (the last user message and the system prompt), streamed in pieces of `piece` characters as
 * server-sent events, or whole as JSON when `stream` is false, or fails with `fail` ({status, message}). It keeps what it was
 * asked in `requests`.
 */
const http = require('node:http');

/**
 * @param {{reply?: (text: string, system: string) => string, stream?: boolean, piece?: number,
 *          fail?: {status: number, message: string}|null, delayMs?: number}} [o]
 */
async function startFakeOpenAI(o = {}) {
  /** @type {{auth: string|undefined, body: any}[]} */
  const requests = [];
  const state = { reply: o.reply || ((t) => `EN<${t}>`), stream: o.stream !== false, piece: o.piece || 4, fail: o.fail || null, delayMs: o.delayMs || 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}');
      requests.push({ auth: req.headers.authorization, body });
      if (req.url !== '/v1/chat/completions') { res.writeHead(404).end('{"error":{"message":"no such path"}}'); return; }
      if (state.fail) { res.writeHead(state.fail.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: state.fail.message } })); return; }
      const msgs = body.messages || [];
      const text = state.reply(msgs[msgs.length - 1].content, msgs[0].content);
      if (!state.stream || !body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chars = [...text];
      for (let i = 0; i < chars.length; i += state.piece) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chars.slice(i, i + state.piece).join('') } }] })}\n\n`);
        if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests, state, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r(null)); }) };
}

module.exports = { startFakeOpenAI };
