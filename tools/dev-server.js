#!/usr/bin/env node
/**
 * Local development server — no Google account needed.
 *
 *   node tools/dev-server.js        (or: npm start)
 *
 * Starts two servers on different origins, like production:
 *   http://localhost:5173            the survey website (static files)
 *   http://localhost:5174/.../exec   a mock "Apps Script" endpoint that runs the
 *                                    real apps-script/Code.gs against an
 *                                    in-memory sheet
 *
 * The mock reproduces the parts of Apps Script that matter to the browser:
 *   • POST /exec answers 302 → a different host (127.0.0.1) that returns the
 *     JSON with Access-Control-Allow-Origin: *  (like script.googleusercontent.com)
 *   • OPTIONS (CORS preflight) is NOT supported → proves the app never needs one
 *
 * MODES
 *   npm start          If js/form-config.js already has an endpoint, the site
 *                      talks to your REAL Google Apps Script (responses go to
 *                      your real Google Sheet). If the endpoint is empty, it
 *                      falls back to the in-memory MOCK.
 *   npm run start:mock Always use the in-memory MOCK (nothing reaches Google).
 *
 * In MOCK mode the served form-config.js has its endpoint pointed at the mock;
 * your real file on disk is not modified.
 *
 * Dev-only helpers (mock server):
 *   GET  /__dev/rows     → current sheet contents as JSON
 *   POST /__dev/reset    → empty the sheet and caches
 *   POST /__dev/config   → JSON: { "delayMs": 1500, "config": { "MIN_FILL_MS": 0 } }
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createBackend } = require('../tests/helpers/gas-harness');

const ROOT = path.join(__dirname, '..');
const WEB_PORT = Number(process.env.WEB_PORT || 5173);
const API_PORT = Number(process.env.API_PORT || 5174);
const ENDPOINT = `http://localhost:${API_PORT}/macros/s/DEV/exec`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function start({ quiet = false, webPort = WEB_PORT, apiPort = API_PORT, mock = true } = {}) {
  const endpoint = `http://localhost:${apiPort}/macros/s/DEV/exec`;
  let backend = createBackend();
  let delayMs = 0;
  let configOverrides = {};
  const pending = new Map(); // one-time redirect tokens → JSON body
  const log = (...a) => { if (!quiet) console.log(...a); };

  /* ---------- Static website ---------- */
  const web = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
    if (!file.startsWith(ROOT) || /[\\/](node_modules|tests|tools|apps-script|\.git)[\\/]/.test(file)) {
      res.writeHead(404); return res.end('Not found');
    }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      let body = buf;
      if (mock && file.endsWith(path.join('js', 'form-config.js'))) {
        body = Buffer.from(buf.toString('utf8').replace(/endpoint:\s*'[^']*'/, `endpoint: '${endpoint}'`));
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    });
  });

  /* ---------- Mock Apps Script ---------- */
  const api = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const cors = { 'Access-Control-Allow-Origin': '*' };

    const sendJson = (status, obj, extra = {}) => {
      res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extra));
      res.end(JSON.stringify(obj));
    };

    // Real Apps Script does not answer CORS preflights usefully.
    if (req.method === 'OPTIONS') { res.writeHead(405); return res.end(); }

    if (url.pathname === '/macros/s/DEV/exec') {
      if (req.method === 'GET') {
        const out = backend.get();
        return sendJson(200, out.json, cors);
      }
      if (req.method === 'POST') {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
        req.on('end', () => {
          setTimeout(() => {
            const out = backend.post(body);
            const token = crypto.randomBytes(12).toString('hex');
            pending.set(token, JSON.stringify(out.json));
            log(`[mock exec] ${out.json.ok ? 'OK  ' + out.json.responseId : 'ERR ' + out.json.error.code}`);
            // Redirect to a *different origin*, like script.googleusercontent.com.
            res.writeHead(302, Object.assign({ Location: `http://127.0.0.1:${apiPort}/macros/echo?user_content_key=${token}` }, cors));
            res.end();
          }, delayMs);
        });
        return;
      }
    }

    if (url.pathname === '/macros/echo' && req.method === 'GET') {
      const token = url.searchParams.get('user_content_key');
      const body = pending.get(token);
      if (!body) return sendJson(404, { error: 'expired' }, cors);
      pending.delete(token);
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
      return res.end(body);
    }

    // ---- dev helpers ----
    if (url.pathname === '/__dev/rows') return sendJson(200, backend.rows(), cors);
    if (url.pathname === '/__dev/reset' && req.method === 'POST') {
      backend = createBackend({ config: configOverrides });
      return sendJson(200, { ok: true }, cors);
    }
    if (url.pathname === '/__dev/config' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const o = JSON.parse(body || '{}');
        if (typeof o.delayMs === 'number') delayMs = o.delayMs;
        if (o.config) { configOverrides = Object.assign({}, configOverrides, o.config); Object.assign(backend.ctx.CONFIG, o.config); }
        sendJson(200, { ok: true, delayMs, config: backend.ctx.CONFIG }, cors);
      });
      return;
    }

    res.writeHead(404); res.end();
  });

  return new Promise((resolve) => {
    const finish = () => resolve({
      webUrl: `http://localhost:${webPort}`,
      apiUrl: `http://localhost:${apiPort}`,
      endpoint,
      backend: () => backend,
      close: () => Promise.all([
        new Promise((r) => web.close(r)),
        new Promise((r) => (api.listening ? api.close(r) : r()))
      ])
    });
    web.listen(webPort, () => {
      log(`Survey website:     http://localhost:${webPort}`);
      if (!mock) {
        log('Backend:            REAL Google Apps Script (from js/form-config.js)');
        log('                    Responses are saved to your REAL Google Sheet.');
        return finish();
      }
      api.listen(apiPort, () => {
        log('Backend:            MOCK (in-memory). Responses are NOT saved to Google Sheets.');
        log(`Mock Apps Script:   ${endpoint}`);
        log(`Mock sheet:         http://localhost:${apiPort}/__dev/rows`);
        finish();
      });
    });
  });
}

if (require.main === module) {
  // Respect a configured endpoint unless --mock is given.
  let configured = false;
  try {
    const cfg = fs.readFileSync(path.join(ROOT, 'js', 'form-config.js'), 'utf8');
    const m = cfg.match(/endpoint:\s*'([^']*)'/);
    configured = !!(m && /^https:\/\//i.test(m[1].trim()));
  } catch (e) { /* fall back to mock */ }
  const useMock = process.argv.includes('--mock') || !configured;
  start({ mock: useMock });
}
module.exports = { start, ENDPOINT };
