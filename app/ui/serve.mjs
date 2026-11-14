#!/usr/bin/env node
/**
 * serve.mjs — 统一工作台：一个端口跑齐六个界面 + 帧 API + 评审反代。
 *
 *   node app/ui/serve.mjs                 # http://127.0.0.1:5180/app/
 *   node app/ui/serve.mjs --port 5199
 *   cvs ui
 *
 * 为什么要有它：六个 surface 原本各起一个端口（5181–5186），彼此没有入口也没有
 * 返回路径；用户从 README 里一个个抄 URL。统一服务器把静态页、/frames/api/*、
 * /jobs/*（反代到 API）挂在同一 origin，/app/ 首页就是导航。
 *
 * 仍然可以单独起某个 surface（`cvs canvas` / `cvs frames` / `cvs review`），
 * 行为不变。默认只绑 127.0.0.1。
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFrameServer, DEFAULT_ROOT } from '../frames/serve.mjs';
import { createReviewServer } from '../review/serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT = 5180;
export { DEFAULT_ROOT };

/** 把各 surface 的 request listener 按路径前缀挂到同一个 server。 */
export function createUiServer(root = DEFAULT_ROOT, opts = {}) {
  const frames = createFrameServer(root);
  const review = createReviewServer(root, { apiTarget: opts.apiTarget });
  const frameHandler = frames.listeners('request')[0];
  const reviewHandler = review.listeners('request')[0];

  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch { res.writeHead(400).end('bad request'); return; }
    if (pathname === '/frames/api' || pathname.startsWith('/frames/api/')) { frameHandler(req, res); return; }
    if (pathname === '/health' || pathname === '/jobs' || pathname.startsWith('/jobs/')) { reviewHandler(req, res); return; }
    frameHandler(req, res);   // 静态资源 + 404，与单独起 frames 时一致
  });

  server.cvsDispose = () => frames.cvsDispose?.();
  server.on('close', () => server.cvsDispose());
  return server;
}

export function startUiServer({ root = DEFAULT_ROOT, port = DEFAULT_PORT, host = '127.0.0.1', apiTarget = null } = {}) {
  const server = createUiServer(root, { apiTarget });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const actual = server.address().port;
      resolve({ server, port: actual, url: `http://${host}:${actual}` });
    });
  });
}

// ── CLI ────────────────────────────────────────────────────────────────────

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
    console.log(`Usage: node app/ui/serve.mjs [--port 5180] [--root <dir>]

  http://127.0.0.1:5180/app/          工作台首页（六个界面的入口）
  /app/wizard/   生成 spec            /app/canvas/    画布微调
  /app/script/   剧本表格            /app/versions/  版本树
  /app/review/   评审（需 cvs api）    /app/frames/    逐帧实时预览
  /frames/api/*  帧 API              /jobs/*         反代到 5190 的编译 API`);
    process.exit(0);
  }
  const root = path.resolve(args.root || process.cwd());
  const port = Number.isFinite(args.port) ? args.port : DEFAULT_PORT;
  startUiServer({ root, port })
    .then(({ server, url }) => {
      console.log(`[ui] root: ${root}`);
      console.log(`[ui] ${url}/app/`);
      console.log('[ui] 向导 / 画布 / 剧本 / 版本 / 评审 / 帧预览 都在这里；Ctrl+C 停止');
      const stop = () => server.close(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((e) => { console.error('[ui] failed:', e && e.message || e); process.exit(1); });
}
