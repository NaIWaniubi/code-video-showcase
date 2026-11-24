#!/usr/bin/env node
/**
 * serve.mjs — 编辑画布的零依赖静态服务器（服务仓库根目录）。
 *
 *   node app/canvas/serve.mjs                 # http://127.0.0.1:5182/app/canvas/
 *   node app/canvas/serve.mjs --port 5190
 *   node app/canvas/serve.mjs --root .
 *
 * 只读 GET/HEAD，不写文件、不联网、不依赖任何 npm 包。
 * 以 `import` 方式使用时不会自动监听（供 scripts/test-inspect.mjs 复用 createStaticServer）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseByteRange } from '../shared/range.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, '..', '..');
export const DEFAULT_PORT = 5182;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
};

/**
 * @param {string} [root] 静态根目录，默认仓库根
 * @returns {http.Server}
 */
/**
 * @param {string} [root] 静态根目录，默认仓库根
 * @param {{cacheControl?: (file: string, pathname: string) => string}} [opts]
 *   cacheControl 决定 Cache-Control；默认 no-store（编辑页/测试的既有行为）。
 *   app/frames 用它给模板/字体加短缓存 —— 工作台的 iframe 池会反复载同一批模块。
 * @returns {http.Server}
 */
export function createStaticServer(root = DEFAULT_ROOT, opts = {}) {
  const ROOT = path.resolve(root);
  const cacheFor = typeof opts.cacheControl === 'function' ? opts.cacheControl : () => 'no-store';

  return http.createServer((req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' }).end('method not allowed');
        return;
      }
      const url = new URL(req.url, 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '/favicon.ico') { res.writeHead(204).end(); return; }

      const hadSlash = pathname.endsWith('/');
      if (hadSlash) pathname += 'index.html';

      // 点文件（.git/、.env、.zcode/…）一律不提供。
      // 之前这里能直接 GET /.git/config 拿到仓库配置。
      if (pathname.split('/').some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..')) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
        return;
      }

      let file = path.resolve(ROOT, '.' + pathname);
      if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }

      fs.stat(file, (err, st) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404'); return; }
        if (st.isDirectory()) {
          if (!hadSlash) {
            res.writeHead(301, { Location: pathname + '/' }).end();
            return;
          }
          res.writeHead(404).end('404');
          return;
        }
        if (!st.isFile()) { res.writeHead(404).end('404'); return; }
        const mime = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
        const cache = cacheFor(file, pathname);
        // R3-审计（RT-03 #2）：静态服务以前没有 Range 支持，评审页/帧预览的 <video>
        // 拖到未缓冲区只能卡住等全量顺序读。成片动辄上百 MB，206 分段是拖动定位的前提。
        const head = (status, extra, len) => res.writeHead(status, {
          'Content-Type': mime,
          'Content-Length': String(len),
          'Cache-Control': cache,
          'X-Content-Type-Options': 'nosniff',
          ...extra,
        });
        const range = parseByteRange(req.headers.range, st.size);
        if (range && range !== 'unsat') {
          head(206, { 'Content-Range': `bytes ${range.start}-${range.end}/${st.size}`, 'Accept-Ranges': 'bytes' }, range.end - range.start + 1);
          if (req.method === 'HEAD') { res.end(); return; }
          fs.createReadStream(file, { start: range.start, end: range.end }).on('error', () => res.destroy()).pipe(res);
          return;
        }
        if (range === 'unsat') {
          head(416, { 'Content-Range': `bytes */${st.size}` }, 23);
          res.end('416 Range Not Satisfiable');
          return;
        }
        head(200, { 'Accept-Ranges': 'bytes' }, st.size);
        if (req.method === 'HEAD') { res.end(); return; }
        fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
      });
    } catch {
      res.writeHead(400).end('bad request');
    }
  });
}

/**
 * 监听并返回 { server, port, url }。port=0 时用系统分配的端口（测试用）。
 */
export function startServer({ root = DEFAULT_ROOT, port = DEFAULT_PORT, host = '127.0.0.1' } = {}) {
  const server = createStaticServer(root);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve({ server, port: server.address().port, url: `http://${host}:${server.address().port}` });
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
    console.log('Usage: node app/canvas/serve.mjs [--port 5182] [--root <dir>]');
    process.exit(0);
  }
  const port = Number.isFinite(args.port) ? args.port : DEFAULT_PORT;
  startServer({ root: args.root || DEFAULT_ROOT, port })
    .then(({ server, port: p, url }) => {
      console.log(`[canvas] root: ${path.resolve(args.root || DEFAULT_ROOT)}`);
      console.log(`[canvas] ${url}/app/canvas/`);
      const stop = () => server.close(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((e) => {
      if (e && e.code === 'EADDRINUSE') {
        console.error(`[canvas] failed: 端口 ${p} 被占（可能已开着另一个 cvs 界面或统一入口）。换一个：node app/canvas/serve.mjs --port 5183`);
      } else {
        console.error('[canvas] failed:', e && e.message || e);
      }
      process.exit(1);
    });
}
