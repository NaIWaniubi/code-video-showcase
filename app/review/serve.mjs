#!/usr/bin/env node
/**
 * serve.mjs — 评审页的零依赖静态服务器（复用 app/canvas 的 createStaticServer）。
 *
 *   node app/review/serve.mjs                 # http://127.0.0.1:5185/app/review/
 *   node app/review/serve.mjs --port 5185
 *   node app/review/serve.mjs --root .
 *
 * 只读 GET/HEAD；默认服务仓库根，因此评审页可直接读取
 * /out/api/<job>/project.spec.json 与 /out/api/<job>/master.mp4。
 */
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from '../canvas/serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, '..', '..');
export const DEFAULT_PORT = 5185;
// 评审页与 API 不同源（5185 vs 5190），API 默认关 CORS → 跨源 fetch 被拦。
// 同源反代 /jobs/* 与 /health 到 API，评审页默认即可用（无需开 CORS）。
const DEFAULT_API_TARGET = process.env.REVIEW_API || 'http://127.0.0.1:5190';

export function createReviewServer(root = DEFAULT_ROOT, opts = {}) {
  const API_TARGET = opts.apiTarget || DEFAULT_API_TARGET;
  const server = createStaticServer(root);
  const staticHandler = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    let pathname = req.url || '/';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* keep raw */ }
    if (pathname === '/health' || pathname === '/jobs' || pathname.startsWith('/jobs/')) {
      // R3-审计（RT-03 #3/#4）：反代以前无超时、无客户端断连清理、方法/请求体无上限，
      // API 可连不响应时浏览器的轮询 fetch 无限挂死，Node 侧句柄一直驻留。
      // 现在：单跳 8s 超时；浏览器断开即销毁上游；方法收窄为 GET/HEAD/POST；
      // 请求体 1MB 上限（上游 api.mjs 自己的 MAX_BODY_BYTES 同值）。
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'method not allowed', code: 'E_METHOD' }));
        return;
      }
      const target = new URL(API_TARGET);
      let responded = false;
      const fail = (status, message, code) => {
        if (responded || res.headersSent) return;
        responded = true;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: message, code }));
      };
      const presponds = (pres) => {
        res.writeHead(pres.statusCode || 502, pres.headers);
        pres.pipe(res);
      };
      const preq = http.request({
        hostname: target.hostname, port: target.port || 80,
        path: req.url, method: req.method,
        headers: { ...req.headers, host: target.host },
        timeout: 8000,
      }, presponds);
      preq.on('timeout', () => preq.destroy(new Error('upstream timeout')));
      preq.on('error', (e) => {
        fail(502, /timeout/i.test(String(e && e.message)) ? `API 超时（${API_TARGET} 8s 无响应）` : `API unreachable at ${API_TARGET}`, 'E_API_UNREACHABLE');
      });
      // 手动转发请求体并计字节：超限在源头掐断，不再向不可信上游灌数据。
      let received = 0;
      let capped = false;
      req.on('data', (chunk) => {
        if (capped) return;
        received += chunk.length;
        if (received > 1024 * 1024) {
          capped = true;
          preq.destroy();
          fail(413, 'proxy request body exceeds 1MB limit', 'E_PAYLOAD_TOO_LARGE');
          return;
        }
        preq.write(chunk);
      });
      req.on('end', () => { if (!capped) preq.end(); });
      req.on('close', () => { if (!req.complete) preq.destroy(); });   // 浏览器断开即收工
      return;
    }
    staticHandler(req, res);
  });
  return server;
}

export function startReviewServer({ root = DEFAULT_ROOT, port = DEFAULT_PORT, host = '127.0.0.1', apiTarget = null } = {}) {
  const server = createReviewServer(root, { apiTarget });
  return new Promise((resolve, reject) => {
    const onError = (e) => reject(e);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      const actual = server.address().port;
      resolve({ server, port: actual, url: `http://${host}:${actual}` });
    });
  });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--root') out.root = argv[++i];
  }
  return out;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const a = path.resolve(process.argv[1]);
  const b = path.resolve(fileURLToPath(import.meta.url));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
})();

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node app/review/serve.mjs [--port 5185] [--root <dir>]');
    process.exit(0);
  }
  const port = Number.isFinite(args.port) ? args.port : DEFAULT_PORT;
  const root = path.resolve(args.root || DEFAULT_ROOT);
  startReviewServer({ root, port })
    .then(({ server, url }) => {
      console.log(`[review] root: ${root}`);
      console.log(`[review] ${url}/app/review/`);
      const stop = () => server.close(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((e) => {
      if (e && e.code === 'EADDRINUSE') {
        console.error(`[review] failed: 端口 ${port} 被占（可能已开着另一个 cvs 界面或统一入口）。换一个：node app/review/serve.mjs --port 5187`);
      } else {
        console.error('[review] failed:', (e && e.message) || e);
      }
      process.exit(1);
    });
}
