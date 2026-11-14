#!/usr/bin/env node
/**
 * serve.mjs — 逐帧实时预览工作台的服务端（零依赖）。
 *
 *   node app/frames/serve.mjs                                   # 打开工作台，页内选源
 *   node app/frames/serve.mjs --video out/final.mp4             # 直接看成片每一帧
 *   node app/frames/serve.mjs --plan out/plan.json              # 按帧号实时渲染
 *   node app/frames/serve.mjs --spec project.spec.json          # 从 spec 现场构建
 *   node app/frames/serve.mjs --dir out/images                  # 图片序列翻页
 *
 * 静态资源仍以仓库根为根（与 app/canvas、app/review 一致），
 * /frames/api/* 是本工作台自己的接口。默认只绑 127.0.0.1。
 *
 * API
 *   GET /frames/api/health
 *   GET /frames/api/candidates                         最近可预览的产物
 *   GET /frames/api/open?video=|plan=|spec=|dir=…       打开帧源 → { id, meta }
 *   GET /frames/api/meta?id=                           帧源状态（视频解码进度在这里）
 *   GET /frames/api/frame?id=&n=&fmt=jpeg|png&q=       第 n 帧图片字节
 *   GET /frames/api/close?id=
 *
 * 帧号从 0 开始；第 n 帧时刻 = n / fps，与渲染器 round(duration*fps) 的量化一致。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from '../canvas/serve.mjs';
import { openSource, defaultCacheRoot, timecodeOf } from './source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, '..', '..');
export const DEFAULT_PORT = 5186;
const MAX_SOURCES = 6;

function httpError(status, message, code = null) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

function sendError(res, e) {
  const status = Number(e && e.status) || 500;
  sendJson(res, status, {
    error: String((e && e.message) || e),
    code: (e && e.code) || (status === 400 ? 'E_BAD_REQUEST' : status === 404 ? 'E_NOT_FOUND' : 'E_INTERNAL'),
  });
}

/** 把用户给的路径限制在 root 内，且不允许点目录（.git/.env/…）。 */
export function resolveUnderRoot(root, input, label = 'path') {
  const raw = String(input || '').trim();
  if (!raw) throw httpError(400, `${label} is required`, 'E_PATH');
  if (/^[a-z]+:\/\//i.test(raw)) throw httpError(400, `${label} must be a local path, not a URL`, 'E_PATH');
  const abs = path.resolve(root, raw);
  const rel = path.relative(root, abs);
  if (rel === '') return abs;
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw httpError(403, `${label} escapes project root`, 'E_PATH');
  if (rel.split(path.sep).some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..')) {
    throw httpError(403, `${label} points at a hidden path`, 'E_PATH');
  }
  return abs;
}

function listByMtime(dir, root, exts, limit) {
  const found = [];
  const walk = (d, depth) => {
    if (depth > 4 || found.length > 400) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) { walk(p, depth + 1); continue; }
      if (!ent.isFile()) continue;
      if (!exts.some((x) => ent.name === x || ent.name.endsWith(x))) continue;
      try {
        const st = fs.statSync(p);
        found.push({ path: path.relative(root, p).split(path.sep).join('/'), mtime: st.mtimeMs, bytes: st.size });
      } catch { /* ignore */ }
    }
  };
  walk(dir, 0);
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

/** 最近产物：成片 / plan / spec / 图片目录。只读扫描，深度 4。 */
export function candidates(root) {
  const out = path.join(root, 'out');
  const videos = listByMtime(out, root, ['.mp4', '.webm', '.mov'], 24);
  const plans = listByMtime(out, root, ['plan.json'], 24);
  const specs = listByMtime(out, root, ['.spec.json'], 24);
  const images = [];
  const walkDirs = (d, depth) => {
    if (depth > 3 || images.length > 24) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const p = path.join(d, ent.name);
      const hasManifest = fs.existsSync(path.join(p, 'image-manifest.json'));
      let imgCount = 0;
      if (hasManifest) imgCount = 1;
      else {
        try {
          imgCount = fs.readdirSync(p).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).length;
        } catch { imgCount = 0; }
      }
      if (hasManifest || imgCount >= 3) {
        images.push({ path: path.relative(root, p).split(path.sep).join('/'), manifest: hasManifest, images: imgCount });
      }
      walkDirs(p, depth + 1);
    }
  };
  walkDirs(path.join(out, 'images'), 0);
  walkDirs(out, 0);
  return { videos, plans, specs, images: images.slice(0, 24) };
}

export function createFrameServer(root = DEFAULT_ROOT, opts = {}) {
  const ROOT = path.resolve(root);
  const cacheRoot = opts.cacheRoot ? path.resolve(String(opts.cacheRoot)) : defaultCacheRoot(ROOT);
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const sources = new Map();
  let nextId = 1;

  const staticServer = createStaticServer(ROOT);
  const staticHandler = staticServer.listeners('request')[0];

  function putSource(source) {
    const id = `f-${nextId++}`;
    sources.set(id, { source, id, openedAt: Date.now() });
    while (sources.size > MAX_SOURCES) {
      const oldest = sources.keys().next().value;
      const rec = sources.get(oldest);
      sources.delete(oldest);
      Promise.resolve(rec.source.close()).catch(() => {});
    }
    return id;
  }

  function getSource(id) {
    const rec = sources.get(String(id || ''));
    if (!rec) throw httpError(404, `source ${id} not found (open one first)`, 'E_SOURCE');
    return rec.source;
  }

  async function handleApi(req, res, url) {
    const route = url.pathname.replace(/^\/frames\/api\/?/, '');
    const q = url.searchParams;

    if (route === 'health') {
      sendJson(res, 200, { ok: true, sources: sources.size, version: 1 });
      return;
    }

    if (route === 'candidates') {
      sendJson(res, 200, candidates(ROOT));
      return;
    }

    if (route === 'open') {
      const kind = q.get('kind') || (q.get('video') ? 'video' : q.get('dir') ? 'images' : (q.get('plan') || q.get('spec')) ? 'spec' : null);
      if (!kind) throw httpError(400, 'pass one of: video, plan, spec, dir', 'E_SOURCE');
      const common = { kind, root: ROOT, log };
      if (kind === 'video') {
        common.video = resolveUnderRoot(ROOT, q.get('video'), 'video');
        common.maxWidth = Number(q.get('maxWidth')) || 1280;
        common.quality = q.get('quality') === null ? undefined : Number(q.get('quality'));
        common.fps = q.get('fps') ? Number(q.get('fps')) : null;
        common.refresh = q.get('refresh') === '1';
        common.cacheRoot = q.get('cache') ? resolveUnderRoot(ROOT, q.get('cache'), 'cache') : cacheRoot;
      } else if (kind === 'images') {
        common.dir = resolveUnderRoot(ROOT, q.get('dir'), 'dir');
        common.fps = Number(q.get('fps')) || 1;
      } else {
        if (q.get('plan')) common.plan = resolveUnderRoot(ROOT, q.get('plan'), 'plan');
        else common.spec = resolveUnderRoot(ROOT, q.get('spec'), 'spec');
        common.width = Number(q.get('width')) || null;
        common.height = Number(q.get('height')) || null;
        common.quality = q.get('quality') ? Number(q.get('quality')) : 88;
      }
      delete common.log;                       // openSource 不吃 log
      const source = await openSource({ ...common, log });
      const id = putSource(source);
      sendJson(res, 200, { id, meta: source.meta() });
      return;
    }

    if (route === 'meta') {
      sendJson(res, 200, { id: q.get('id'), meta: getSource(q.get('id')).meta() });
      return;
    }

    if (route === 'close') {
      const id = String(q.get('id') || '');
      const rec = sources.get(id);
      if (rec) {
        sources.delete(id);
        await rec.source.close();
      }
      sendJson(res, 200, { closed: !!rec });
      return;
    }

    if (route === 'frame') {
      const source = getSource(q.get('id'));
      const raw = q.get('n');
      if (raw === null || raw === '') throw httpError(400, 'n (frame index) is required', 'E_FRAME');
      const n = Number(raw);
      if (!Number.isInteger(n)) throw httpError(400, 'n must be an integer frame index', 'E_FRAME');
      const fmt = q.get('fmt') === 'png' ? 'png' : 'jpeg';
      const quality = q.get('q') ? Number(q.get('q')) : null;

      const started = Date.now();
      let frame;
      try {
        frame = await source.getFrame(n, { fmt, q: quality });
      } catch (e) {
        if (Number(e && e.status)) throw e;
        throw httpError(502, String((e && e.message) || e), 'E_FRAME');
      }
      const meta = source.meta();
      const headers = {
        'Content-Type': frame.type,
        'Content-Length': frame.buf.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Index': String(n),
        'X-Frames-Total': String(meta.frames),
        'X-Frames-Ready': String(meta.ready),
        'X-Frame-Time': frame.t !== undefined ? Number(frame.t).toFixed(6) : (n / meta.fps).toFixed(6),
        'X-Frame-Timecode': String(frame.timecode || timecodeOf(n, meta.fps)),
        'X-Render-Ms': String(frame.renderMs !== undefined ? frame.renderMs : Date.now() - started),
      };
      if (frame.seg) headers['X-Frame-Segment'] = encodeURIComponent(String(frame.seg));
      if (frame.file) headers['X-Frame-File'] = encodeURIComponent(frame.file);
      res.writeHead(200, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      res.end(frame.buf);
      return;
    }

    throw httpError(404, 'unknown api route: /frames/api/' + route, 'E_ROUTE');
  }

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); } catch { res.writeHead(400).end('bad request'); return; }
    if (url.pathname === '/frames/api' || url.pathname.startsWith('/frames/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed', code: 'E_METHOD' });
        return;
      }
      handleApi(req, res, url).catch((e) => {
        if (!res.headersSent) sendError(res, e);
        else { try { res.destroy(); } catch { /* ignore */ } }
      });
      return;
    }
    staticHandler(req, res);
  });

  server.on('close', () => {
    for (const [, rec] of sources) Promise.resolve(rec.source.close()).catch(() => {});
    sources.clear();
  });

  return server;
}

export function startFrameServer({ root = DEFAULT_ROOT, port = DEFAULT_PORT, host = '127.0.0.1', cacheRoot = null } = {}) {
  const server = createFrameServer(root, { cacheRoot });
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
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    if (k === 'help' || k === 'refresh') { out[k] = true; continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) { out[k] = true; continue; }
    out[k] = v; i++;
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
    console.log(`Usage: node app/frames/serve.mjs [--video f | --plan f | --spec f | --dir d]
       [--fps n] [--max-width 1280] [--width n] [--height n] [--port 5186] [--root dir]

  Then open http://127.0.0.1:5186/app/frames/
  Source can also be chosen in the page (recent renders are listed).

  Frame n is shown at t = n / fps — the same quantisation the encoder uses,
  so a still exported from this page is the frame in master.mp4 (pre-encode).`);
    process.exit(0);
  }
  const root = path.resolve(args.root || process.cwd());
  const port = Number.isFinite(Number(args.port)) ? Number(args.port) : DEFAULT_PORT;
  startFrameServer({ root, port })
    .then(async ({ server, url }) => {
      console.log(`[frames] root: ${root}`);
      console.log(`[frames] ${url}/app/frames/`);
      // 预打开帧源：命令行给了就省一次点击
      if (args.video || args.plan || args.spec || args.dir) {
        const qs = new URLSearchParams();
        if (args.video) qs.set('video', String(args.video));
        if (args.plan) qs.set('plan', String(args.plan));
        if (args.spec) qs.set('spec', String(args.spec));
        if (args.dir) qs.set('dir', String(args.dir));
        if (args.fps) qs.set('fps', String(args.fps));
        if (args['max-width']) qs.set('maxWidth', String(args['max-width']));
        if (args.width) qs.set('width', String(args.width));
        if (args.height) qs.set('height', String(args.height));
        if (args.refresh) qs.set('refresh', '1');
        try {
          const res = await fetch(`${url}/frames/api/open?${qs}`);
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || res.statusText);
          console.log(`[frames] source ${body.id}: ${body.meta.kind} · ${body.meta.frames} frames @ ${body.meta.fps}fps · ${body.meta.width}×${body.meta.height}`);
          console.log(`[frames] open ${url}/app/frames/?id=${body.id}`);
        } catch (e) {
          console.error('[frames] source failed: ' + (e && e.message || e));
        }
      }
      const stop = () => server.close(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((e) => { console.error('[frames] failed:', e && e.message || e); process.exit(1); });
}
