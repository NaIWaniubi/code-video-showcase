#!/usr/bin/env node
/**
 * app/wizard/serve.mjs — 5181 端口静态服务，根目录 = 仓库根。
 *
 *   node app/wizard/serve.mjs
 *   → http://127.0.0.1:5181/app/wizard/
 *
 * 只做三件事：
 *   1. 安全地服务仓库文件（禁目录穿越、禁点文件、GET/HEAD）；
 *   2. 给浏览器提供 /templates/spec.mjs 依赖的 timeline.mjs 浏览器版：
 *      该文件顶部 import 了 node:fs / node:path 且底部有 CLI 自启动判断，
 *      浏览器无法解析。这里只在「响应」中剥离两个 node 导入并注入 process/fs/path
 *      只读桩，磁盘上的 templates/timeline.mjs 一个字节都不改。
 *   3. 根路径 / 与 /app/wizard 都跳到 /app/wizard/。
 *
 * 零依赖：只用 node 内置模块。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.map': 'application/json; charset=utf-8',
};

/** 浏览器版 timeline.mjs 的桩：只影响被改写的那次响应。 */
const TIMELINE_SHIM = `/* [wizard] browser shim injected by app/wizard/serve.mjs — node:fs/node:path are Node-only. */
const process = {
  argv: [],
  env: {},
  cwd: () => '/',
  exit(code) {
    throw new Error('process.exit(' + code + ') is not available in the browser');
  },
};
const fs = new Proxy({}, {
  get() {
    return () => {
      throw new Error('node:fs is not available in the browser');
    };
  },
});
const path = new Proxy({}, {
  get() {
    return () => {
      throw new Error('node:path is not available in the browser');
    };
  },
});
`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Usage: node app/wizard/serve.mjs [--port 5181] [--host 127.0.0.1]
Serves the repository root. Open http://127.0.0.1:5181/app/wizard/`);
  process.exit(0);
}

const PORT = Number(args.port || process.env.PORT || 5181);
const HOST = args.host || process.env.HOST || '127.0.0.1';

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function redirect(res, location) {
  send(res, 302, '', { Location: location });
}

function isDenied(pathname) {
  // R3-审计（RT-03 #9）：以前显式放过 .well-known，与其余四个服务口径不齐；
  // 仓库若放入密钥类 well-known 文件就是单点暴露面。统一按点段一律拒绝。
  return pathname
    .split('/')
    .filter(Boolean)
    .some((seg) => seg.startsWith('.'));
}

function safeResolve(pathname) {
  const rel = pathname.replace(/^\/+/, '');
  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

function readBrowserTimeline(filePath) {
  let src = fs.readFileSync(filePath, 'utf8');
  src = src.replace(/^#!.*\r?\n/, '');
  const before = src;
  src = src
    .replace(/^import\s+fs\s+from\s+['"]node:fs['"];?\s*$/m, '')
    .replace(/^import\s+path\s+from\s+['"]node:path['"];?\s*$/m, '');
  if (src === before) {
    throw new Error('timeline.mjs 的 node 导入行没有匹配到；serve.mjs 的浏览器改写已失效，请检查模板是否被改动');
  }
  return TIMELINE_SHIM + src;
}

// R8-W2：参考片反推端点（multipart 上传 → CLI 全链分析 → 报告 JSON）。
// 为什么要有：反推引擎要 Node+ffmpeg，浏览器跑不动；向导把这层当服务端助手。
const ALLOWED_VIDEO_EXT = new Set(".mp4 .webm .mov .mkv".split(" "));
function analyzeRefVideo(req, res, bodyBuf) {
  const ct = String(req.headers["content-type"] || "");
  // 两种写法都要认：浏览器发边界带引号，curl 可能不带。
  const bm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  if (!bm) { send(res, 400, JSON.stringify({ ok: false, error: "E_NO_BOUNDARY" })); return; }
  const boundary = (bm[1] || bm[2]).trim();
  const sep = Buffer.from("--" + boundary);
  const HEND = Buffer.from("\r\n\r\n");
  // 从 0 开始找：首段分隔符就贴在请求体开头（curl/浏览器的边界都带前导 --）。
  let idx = bodyBuf.indexOf(sep);
  while (idx >= 0) {
    const headerEnd = bodyBuf.indexOf(HEND, idx + sep.length);
    if (headerEnd < 0) break;
    const headText = bodyBuf.slice(idx + sep.length + 2, headerEnd).toString("utf8");
    if (/name=/.test(headText)) {
      const fnMatch = headText.match(/filename="([^"]*)"/);
      const raw = fnMatch ? fnMatch[1] : "";
      const bs = String.fromCharCode(92);
      let base = raw.split("/").pop() || raw;
      if (base.includes(bs)) base = base.split(bs).pop() || base;
      const ext = base.includes(".") ? base.slice(base.lastIndexOf(".")).toLowerCase() : "";
      if (!base || !ALLOWED_VIDEO_EXT.has(ext)) {
        send(res, 415, JSON.stringify({ ok: false, error: "E_REF_VIDEO_TYPE",
          message: "不支持的参考片格式 " + (ext || "(无扩展名)") + "; 接受 mp4|webm|mov|mkv" }));
        return;
      }
      const dataStart = headerEnd + 4;
      const nextIdx = bodyBuf.indexOf(sep, dataStart);
      const dataEnd = nextIdx >= 0 ? nextIdx - 2 : bodyBuf.length;
      if (dataEnd <= dataStart) { send(res, 400, JSON.stringify({ ok: false, error: "E_EMPTY_UPLOAD" })); return; }
      const tmpPath = path.join(os.tmpdir(), "cvs-ref-" + process.pid + "-" + Date.now() + ext);
      fs.writeFileSync(tmpPath, bodyBuf.slice(dataStart, dataEnd));
      const r = spawnSync(process.execPath, [
        path.join(ROOT, "scripts/ref-video.mjs"), "--video", tmpPath, "--json",
      ], { encoding: "utf8", timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* 尽力清理 */ }
      if (r.status !== 0 || !r.stdout || !r.stdout.trim()) {
        const line = String(r.stderr || r.stdout || "").trim().split("/\r?\n/").pop() || "";
        send(res, 500, JSON.stringify({ ok: false, error: "E_REF_VIDEO_FAILED", message: line.slice(0, 200) }));
        return;
      }
      try {
        const report = JSON.parse(r.stdout.trim().split("/\r?\n/").filter((l) => l.trim()).pop());
        send(res, 200, JSON.stringify(report), { "Content-Type": "application/json; charset=utf-8" });
      } catch (e) {
        send(res, 500, JSON.stringify({ ok: false, error: "E_REF_VIDEO_UNPARSEABLE", message: String(e.message).slice(0, 120) }));
      }
      return;
    }
    idx = bodyBuf.indexOf(sep, idx + sep.length);
  }
  send(res, 400, JSON.stringify({ ok: false, error: "E_NO_FILE_PART" }));
}

const server = http.createServer((req, res) => {
  // R8-W2：POST /api/analyze-ref —— 参考片反推（multipart 上传）。
  if (req.method === 'POST' && new URL(req.url, 'http://localhost').pathname === '/api/analyze-ref') {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 400 * 1024 * 1024) { send(res, 413, JSON.stringify({ ok: false, error: 'E_BODY_TOO_LARGE', message: '参考片最大 400MB' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { analyzeRefVideo(req, res, Buffer.concat(chunks)); });
    req.on('error', () => { try { send(res, 400, JSON.stringify({ ok: false, error: 'E_READ_ERROR' })); } catch { /* 已销毁 */ } });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method Not Allowed\n', { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    send(res, 400, 'Bad Request\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  if (pathname === '/' || pathname === '/app/wizard') {
    redirect(res, '/app/wizard/');
    return;
  }

  if (isDenied(pathname)) {
    send(res, 403, 'Forbidden\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  const filePath = safeResolve(pathname);
  if (!filePath) {
    send(res, 403, 'Forbidden\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    send(res, 404, `Not Found: ${pathname}\n`, { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  if (stat.isDirectory()) {
    if (!pathname.endsWith('/')) {
      redirect(res, `${pathname}/`);
      return;
    }
    const index = path.join(filePath, 'index.html');
    if (!fs.existsSync(index)) {
      send(res, 403, 'Directory listing is disabled\n', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    const body = fs.readFileSync(index);
    send(res, 200, req.method === 'HEAD' ? '' : body, { 'Content-Type': MIME['.html'], 'Content-Length': body.length });
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  let body;
  let note = '';

  try {
    if (pathname === '/templates/timeline.mjs') {
      body = Buffer.from(readBrowserTimeline(filePath), 'utf8');
      note = 'x-wizard-rewrite';
    } else {
      body = fs.readFileSync(filePath);
    }
  } catch (e) {
    send(res, 500, `Read error: ${e.message}\n`, { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  send(res, 200, req.method === 'HEAD' ? '' : body, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    ...(note ? { 'X-Wizard-Rewrite': 'timeline-browser' } : {}),
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[wizard] port ${PORT} is already in use. Try: node app/wizard/serve.mjs --port 5182`);
  } else {
    console.error('[wizard] server error:', e.message || e);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  // --port 0 时 OS 分配临时端口；打印实际绑定端口，测试据此连接（避免固定端口冲突）。
  const actual = server.address().port;
  console.log(`[wizard] root   ${ROOT}`);
  console.log(`[wizard] open   http://${HOST}:${actual}/app/wizard/`);
  console.log('[wizard] note   /templates/timeline.mjs is served browser-safe (node: imports stripped, disk file untouched)');
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
