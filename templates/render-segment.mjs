#!/usr/bin/env node
/**
 * render-segment.mjs v3 — render one HTML segment to MP4, frame by frame.
 *
 *   node render-segment.mjs --page segments/01.html --out out/01.mp4 --duration 3
 *   node render-segment.mjs --page segments/09.html --out out/09.mp4 --duration 3 --t0 0.35 --speed 1.4
 *   node render-segment.mjs --page segments/01.html --still 0.2,0.8,1.4 --outdir out/stills
 *
 * v3 keeps the CLI and the pixel pipeline byte-for-byte identical, and adds a
 * reusable module surface so one process can render many segments with a single
 * static server and a single browser (the SwiftShader startup is the dominant
 * cost of a 23-segment film):
 *
 *   import { withRenderer, renderSegment } from './render-segment.mjs';
 *
 *   await withRenderer({ root, width, height, browser }, async (ctx) => {
 *     for (const seg of plan.segments) {
 *       await ctx.render(segOptions);        // one page, one ffmpeg, same frames
 *     }
 *   });
 *
 * `renderSegment(options)` still does the whole single-segment job (server +
 * browser + ffmpeg) and is what the CLI calls. `withRenderer(options, fn)` owns
 * the server + browser and hands `fn` a context whose `render()` / `stills()`
 * methods take the same option names as the CLI.
 *
 * What changed in v2 (see CHANGELOG):
 *   • Zero-dependency fallback: uses system Chrome/Edge over raw CDP when
 *     Playwright is not installed (templates/cdp.mjs).
 *   • Fast canvas capture: for single full-viewport <canvas> pages, frames are
 *     encoded in-page with canvas.toDataURL() and piped to ffmpeg — typically
 *     30–50% faster than a CDP screenshot per frame. DOM-heavy pages fall back
 *     to Page.captureScreenshot automatically.
 *   • Correct colour: JPEG/PNG (full range) is explicitly converted to limited
 *     range bt709 with colour tags, so players do not guess bt601.
 *   • Intermediates encode with CRF 12 / veryfast; the final pass re-encodes once.
 *
 * Design: page.evaluate(renderFrame(t)) → capture → ffmpeg image2pipe → libx264.
 * Relative --page paths are served by an embedded static server with
 * ?seg=1&t0=&speed=&dur= appended, so common.js createSegment() maps clip time u
 * to scene time t = t0 + u*speed.
 *
 * Requires: ffmpeg on PATH (or FFMPEG_EXE), and either Playwright or Chrome/Edge.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch as launchCdp, connect, evaluate as cdpEvaluate, waitFor as cdpWaitFor } from './cdp.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.mp4': 'video/mp4',
};

// ---------- tiny arg parser ----------

/** Parse an argv slice (`--key value`, `--flag`) into a plain object. */
export function parseArgv(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

const bool = (v, d) => (v === undefined ? d : !(v === false || v === 'false' || v === '0'));

function parseStills(v) {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.map(Number).filter(Number.isFinite);
  return String(v).split(',').map(Number).filter(Number.isFinite);
}

function loadVars(v, root) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  const s = String(v);
  if (s.trim().startsWith('{')) return JSON.parse(s);
  return JSON.parse(fs.readFileSync(path.resolve(root, s), 'utf8'));
}

/** Map parsed CLI args to the plain options object renderSegment() accepts. */
export function optionsFromArgs(args) {
  const num = (k, d) => (args[k] === undefined ? d : Number(args[k]));
  const str = (k, d) => (args[k] === undefined ? d : String(args[k]));
  const root = path.resolve(str('root', process.cwd()));
  return {
    page: args.page === undefined ? null : String(args.page),
    out: args.out === undefined ? null : String(args.out),
    duration: num('duration', 3),
    t0: num('t0', 0),
    speed: num('speed', 1),
    fps: num('fps', 30),
    width: num('width', 1920),
    height: num('height', 1080),
    root,
    port: num('port', 0),
    crf: num('crf', 12),
    preset: str('preset', 'veryfast'),
    tune: str('tune', ''),
    quality: num('quality', 92),
    // R2-11c：默认 raw 捕获。早期默认 JPEG（Chrome JPEG 编码器非确定，幂等破功），
    // 改 PNG 后确定但 zlib 编码吃掉 378ms/帧（renderFrame 本身只要 0.7ms）。
    // raw 直接把 getImageData 的 RGBA 经本地 POST 送进 ffmpeg rawvideo：无编码器
    // = 无损且确定性天然成立，实测 3s 段 91s→23s（3.9fps vs 0.7fps），两次渲染
    // sha256 逐字节相同。画布不是 2D/尺寸不符时自动回退 png（仍确定，只是慢）。
    format: str('format', 'raw'),
    capture: str('capture', 'auto'),
    // S5a 运动模糊（v4.10.0）：tmix 权重串（如 '1 2 1'）= 子帧采样倍率 N=词数。
    // 空 = 关。开启时以 fps*N 渲染子帧，编码后 tmix+fps 回原帧率——页面是纯
    // f(t)，子帧 t 天然合法；输出帧数/帧率与关时逐帧同构，下游（probe/concat/qa）零改动。
    motionBlur: str('motion-blur', '') || str('motionBlur', ''),
    headed: !!args.headed,
    // R16-W→v4.9.1 遗留：--keep-page-params 现为**兼容 no-op**（v4.9.1 起生产链
    // 本来就保留 plan 全部 query，剥离行为已删——见 withSegmentParams 注释）。
    keepPageParams: !!args['keep-page-params'] || !!args.keepPageParams,
    timeout: num('timeout', 120000),
    launchTimeout: num('launch-timeout', 30000),
    warmup: args['no-warmup'] ? false : bool(args.warmup, true),
    optimize: args['no-optimize'] ? false : bool(args.optimize, true),
    still: args.still === undefined ? null : String(args.still),
    outdir: args.outdir === undefined ? null : String(args.outdir),
    vars: args.vars === undefined ? null : String(args.vars),
    browser: args.browser === undefined ? null : String(args.browser),
    cdp: !!args.cdp,
    noPlaywright: !!args['no-playwright'],
    profileDir: args['profile-dir'] === undefined ? null : String(args['profile-dir']),
    removeProfile: !!args['remove-profile'],
  };
}

/**
 * Normalise any supported option spelling into the canonical object used by
 * the renderer. Paths are resolved once here so callers may pass relative paths.
 */
export function normalizeOptions(raw = {}) {
  const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));
  const str = (v, d) => (v === undefined || v === null ? d : String(v));
  const root = path.resolve(str(raw.root, process.cwd()));
  const width = num(raw.width, 1920);
  const height = num(raw.height, 1080);
  const stills = parseStills(raw.stills !== undefined ? raw.stills : raw.still);
  const outdir = path.resolve(str(raw.outdir, path.join(root, 'out', 'stills')));
  const browser = raw.browser ? path.resolve(String(raw.browser)) : (process.env.CHROME_EXE || null);
  const log = typeof raw.log === 'function' ? raw.log : (line) => console.log(line);
  const warn = typeof raw.warn === 'function' ? raw.warn : (line) => console.warn(line);
  return {
    page: raw.page === undefined || raw.page === null ? null : String(raw.page),
    out: raw.out ? path.resolve(String(raw.out)) : null,
    duration: num(raw.duration, 3),
    t0: num(raw.t0, 0),
    speed: num(raw.speed, 1),
    fps: num(raw.fps, 30),
    width,
    height,
    root,
    port: num(raw.port, 0),
    crf: num(raw.crf, 12),
    preset: str(raw.preset, 'veryfast'),
    tune: str(raw.tune, ''),
    // R2-11c：raw = getImageData 原始像素经本地 POST 直送 ffmpeg rawvideo。
    // 无编码器 = 无损 + 确定性天然成立，且删掉 PNG zlib（实测 378ms/帧）与
    // ffmpeg PNG 解码两次开销。jpeg/png 仅在 raw 不可用（非 2D 画布/尺寸不符/
    // CDP 回退/静帧）时使用。
    format: (() => { const f = String(str(raw.format, 'png')).toLowerCase(); return f === 'jpeg' ? 'jpeg' : f === 'raw' ? 'raw' : 'png'; })(),
    motionBlur: String(raw.motionBlur ?? raw['motion-blur'] ?? '').trim(),
    quality: num(raw.quality, 92),
    capture: str(raw.capture, 'auto'),
    headed: !!raw.headed,
    timeout: num(raw.timeout, 120000),
    // 浏览器**启动**超时与页面 ready 超时必须分开：页面可以慢（SwiftShader 首帧），
    // 但一个起不来的浏览器不该继承 120s 的页面预算，把失败路径拖成两分钟空等。
    launchTimeout: num(raw.launchTimeout, 30000),
    warmup: raw.warmup !== undefined ? bool(raw.warmup, true) : true,
    optimize: raw.optimize !== undefined ? bool(raw.optimize, true) : true,
    stills,
    outdir,
    vars: loadVars(raw.vars, root),
    ffmpeg: process.env.FFMPEG_EXE || 'ffmpeg',
    browser,
    cdp: !!raw.cdp,
    noPlaywright: !!raw.noPlaywright,
    profileDir: raw.profileDir ? path.resolve(String(raw.profileDir)) : null,
    removeProfile: !!raw.removeProfile,
    // R16-W：共享浏览器端点（ws://…/devtools/browser/…）；连入既有进程不拥有它。
    endpoint: raw.endpoint ? String(raw.endpoint) : null,
    // R16-W：预览取帧保留页面自带查询参数（theme/layout 等）——与 live iframe 同 URL 语义。
    keepPageParams: !!raw.keepPageParams,
    log,
    warn,
  };
}

/** Turn a plan segment's `renderArgs` array into canonical options. */
export function optionsFromRenderArgs(renderArgs, extra = {}) {
  const args = parseArgv(renderArgs || []);
  return normalizeOptions({ ...optionsFromArgs(args), ...extra });
}

/**
 * S8/G2-4：改字节但不进 segmentHash 的渲染旋钮（capture/format/crf/preset/tune/
 * quality/browser…——机器级参数）的缓存隔离后缀。
 * segmentHash 是内容口径、刻意不含这些；但 render-batch/farm 可被直接带非默认旋钮
 * 启动——此前新字节会写进同一个 `<hash>.mp4` 槽，正常构建命中「异内容同缓存键」的
 * 混拼（审计 F2）。现在非默认旋钮折进缓存文件名后缀；全默认 → 空串，旧缓存条目
 * 原样有效（warm 缓存不砸）。--format jpeg 额外告警：Chrome JPEG 编码非逐字节
 * 确定（R2-11 根因），其产物不得进位级复现叙事。
 */
export function knobsCacheSuffix(raw = {}, warn) {
  const o = normalizeOptions({ ...raw });
  const d = normalizeOptions({});
  const keys = ['capture', 'format', 'quality', 'crf', 'preset', 'tune', 'warmup', 'optimize', 'motionBlur', 'browser'];
  const diff = {};
  for (const k of keys) if (String(o[k]) !== String(d[k])) diff[k] = o[k];
  if (diff.format === 'jpeg' && typeof warn === 'function') {
    warn('[warn] --format jpeg: Chrome JPEG encode is not byte-deterministic (R2-11); its products do not qualify for the bit-exact reproducibility claim');
  }
  if (!Object.keys(diff).length) return '';
  return '.' + crypto.createHash('sha256').update(JSON.stringify(diff)).digest('hex').slice(0, 10);
}

// ---------- static server ----------

export function startStaticServer(root, port = 0) {
  return new Promise((resolve, reject) => {
    const ROOT = path.resolve(root);
    // R2-11c：raw 捕获的帧接收槽。页面把 getImageData 的原始 RGBA 用 fetch POST
    // 到这里（不经 base64、不经任何编码器），handler 收齐 body 后存 last 并回 200。
    // fetch 只有在响应到达后才 resolve，而响应只在 'end' 后发出，所以页面侧 await
    // 返回时 last 必然已就绪——顺序捕获无需额外同步。
    const frameSink = {
      last: null,
      take() { const b = this.last; this.last = null; return b; },
      stats: { posts: 0, bytes: 0 },
    };
    const server = http.createServer((req, res) => {
      try {
        let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (urlPath === '/favicon.ico') { res.writeHead(204).end(); return; }
        if (req.method === 'POST' && urlPath === '/__frame') {
          const chunks = []; let size = 0; let dead = false;
          req.on('data', (d) => {
            if (dead) return;
            size += d.length;
            if (size > 64 * 1024 * 1024) { dead = true; req.destroy(); return; } // 单帧上限 64MB
            chunks.push(d);
          });
          req.on('end', () => {
            if (dead) return;
            frameSink.last = Buffer.concat(chunks, size);
            frameSink.stats.posts += 1;
            frameSink.stats.bytes += size;
            // 短连接：本地每帧一个 POST，复用 keep-alive 会踩中 Node 默认 5s
            // keepAliveTimeout —— 服务端在空闲后单方面断连，页面侧下一次
            // fetch 直接 'Failed to fetch'（实测第 63 帧必挂）。关连接最省心。
            res.writeHead(200, {
              'Content-Type': 'text/plain', 'Content-Length': 2,
              'Cache-Control': 'no-store', 'Connection': 'close',
            }).end('ok');
            req.socket.setTimeout(0);
          });
          req.on('error', (e) => {
            frameSink.stats.errors = (frameSink.stats.errors || 0) + 1;
            frameSink.stats.lastError = String(e && e.message || e);
            try { if (!res.headersSent) res.writeHead(400).end('bad'); } catch { /* ignore */ }
          });
          return;
        }
        if (urlPath.endsWith('/')) urlPath += 'index.html';
        // 点文件（.git/、.env…）不提供——渲染服务器也会被外部请求碰到。
        if (urlPath.split('/').some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..')) {
          res.writeHead(404).end('404'); return;
        }
        const file = path.resolve(ROOT, '.' + urlPath);
        if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403).end('forbidden'); return; }
        fs.stat(file, (err, st) => {
          if (err || !st.isFile()) { res.writeHead(404).end('404'); return; }
          res.writeHead(200, {
            'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Content-Length': st.size, 'Cache-Control': 'no-store',
          });
          fs.createReadStream(file).pipe(res);
        });
      } catch { res.writeHead(400).end('bad request'); }
    });
    server.frameSink = frameSink;
    // 每帧 POST 是 8 MB 级别的连续上传，不能被默认 5s keepAlive/请求超时截断。
    server.keepAliveTimeout = 60000;
    server.headersTimeout = 65000;
    server.requestTimeout = 0;
    server.timeout = 0;
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// ---------- ffmpeg ----------

function launchFfmpeg(outFile, opts) {
  // R2-11c：raw 直送——页面 POST 的 RGBA 像素原样进编码器。免 PNG zlib 编码
  // （实测 378ms/帧）与 ffmpeg 的 PNG 解码，且无编码器即无损、确定性天然成立。
  // 色彩链与 PNG 路径同一套（pc→tv / bt709），所以画面与旧 PNG 路径一致。
  const raw = opts.format === 'raw';
  // 色彩链对 raw 与 png 完全一致：实测同一份像素喂两种链，输出逐字节相同
  // （chain 级实验见 docs/audit2/FINDINGS-ROUND2.md）。alpha 在 scale 前剥离。
  const input = raw
    ? ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${opts.width}x${opts.height}`,
       '-framerate', String(opts.fps), '-i', 'pipe:0']
    : ['-f', 'image2pipe', '-s', `${opts.width}x${opts.height}`,
       '-framerate', String(opts.fps), '-i', 'pipe:0'];
  // R3-审计（RT-05 F6）：image2pipe（PNG 回退链）以前没有 -s——自写页面画布
  // 与视口不完全相等时，输出尺寸=画布尺寸而非 plan.meta 画幅（下游 qa 会红，
  // 但先在源头钉死，成片尺寸与计划一致）。
  // raw 与 png 必须走**同一条**色彩链才能出同一画面：alpha 在进 scale 之前就先
  // 丢掉（PNG 解码出来的 RGB 没有 alpha，rgba 若带着 alpha 进 scale，矩阵分支
  // 与色度下采样的处理会有微差——实测单帧 PSNR 42dB / 边缘最大差 56）。
  // format=rgb24 把 alpha 剥离，之后 scale/format 与 PNG 路径逐字一致。
  const filters = [
    ...(raw ? ['format=rgb24'] : []),
    'scale=in_range=pc:out_range=tv:out_color_matrix=bt709',
    'format=yuv420p',
  ].join(',');
  const codec = [
    '-c:v', 'libx264', '-preset', opts.preset, '-crf', String(opts.crf),
    ...(opts.tune ? ['-tune', opts.tune] : []),
    // R2-11：段编码钉死单线程 + bitexact——x264 帧线程>1 即使固定数量仍有调度
    // 微差（实测 threads=2 解码帧全同但码流大小差 ~2KB）。单线程保证逐字节确定。
    // 段用 veryfast 且短，单线程开销可接受；这是「确定性」卖点的硬保证。
    '-threads', '1', '-x264-params', 'threads=1:lookahead_threads=1:rc-lookahead=10',
    '-fflags', '+bitexact', '-flags', '+bitexact',
    '-vf', filters,
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-video_track_timescale', '90000',
    '-movflags', '+faststart', outFile,
  ];
  const p = spawn(opts.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...input, ...codec], { windowsHide: true });
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  const done = new Promise((res, rej) => {
    p.on('error', rej);
    p.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exit ' + c + ': ' + err.slice(0, 800)))));
  });
  // 渲染中途抛错（页面 renderFrame 抛异常 / 抓帧失败）时必须能杀掉 ffmpeg：
  // 它一直等 stdin，管道句柄让 Node 事件循环不退出。症状是「batch 打印了
  // done 但进程挂住」，看起来像卡死，实际是一个没被清理的子进程。
  const kill = () => {
    try { p.stdin.destroy(); } catch { /* ignore */ }
    try { p.kill('SIGKILL'); } catch { /* ignore */ }
  };
  return { stdin: p.stdin, done, kill };
}

function writeAsync(stream, buf) {
  return new Promise((resolve) => {
    if (stream.write(buf)) resolve();
    else stream.once('drain', resolve);
  });
}

// ---------- URL ----------

// R3-审计（RT-07 P2-3）：allowRemotePages opt-in 后的残余 SSRF——回环/私网/
// 链路本地段与云元数据地址一律硬拦，导航前失败。
// S8/G5 移交修复：旧版用裸正则匹配 IP 字符串，`[::ffff:127.0.0.1]` 被 Node 归一化为
// `[::ffff:7f00:1]`（十六进制映射）后绕过 `127\.` 前缀判据；且 `[::ffff:a9fe:a9fe]`
// （169.254 元数据）同样逃逸。改为先解包 IPv4-mapped IPv6（点分/十六进制两式）再判段，
// 并把十进制/十六进制打包 IPv4（http://2130706433/ = 127.0.0.1）也还原成点分再判。
const PRIVATE_HOST_RE = /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.)/i;

function ipv4FromPackedInt(s) {
  // 十进制或 0x 十六进制的单段 IPv4（http://2130706433/、http://0x7f000001/）。
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(s)) return null;
  const n = /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10);
  if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return null;
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function isPrivateHost(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return false; }
  if (!host) return false;
  host = host.toLowerCase();
  if (/^localhost(?:$|\.)/.test(host)) return true;
  if (host.startsWith('[') && host.endsWith(']')) {
    const inner = host.slice(1, -1).split('%')[0];
    if (inner === '::1' || inner === '::') return true;               // v6 loopback / unspecified
    if (/^f[cd][0-9a-f]{2}:/.test(inner) || /^f[cd]/.test(inner)) return true; // ULA fc00::/7
    // IPv4-mapped：::ffff:a.b.c.d 或 ::ffff:HHHH:HHHH。解出 v4 再走点分判段。
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(inner)
      || /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(inner);
    if (m) {
      if (m.length === 2) return isPrivateHost(`http://${m[1]}/`);
      const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
      return isPrivateHost(`http://${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}/`);
    }
    return false;
  }
  // 打包整数 IPv4（非点分）先还原，避免 http://2130706433/ 绕过前缀判据。
  if (!host.includes('.')) {
    const packed = ipv4FromPackedInt(host);
    if (packed) return isPrivateHost(`http://${packed}/`);
  }
  return PRIVATE_HOST_RE.test(host);
}

export function withSegmentParams(page, port, t) {
  const u = new URL(`http://127.0.0.1:${port}/${page.replace(/^\/+/, '')}`);
  // R19 修正（校园墙宣传片实测暴露的内容错位 bug）：RT-07 P2-2 曾把页面自带
  // query **全剥**，理由是「?logo=… 能原样进成片 URL」——那是过度矫正：logo 类
  // 危险参数本就有各自的闸门（远程页白名单/SSRF/路径约束），而 plan 合法下发的
  // theme/mp/accent/title/brand/first/keyword/layout/index… 被一起剥掉后，成片
  // 全部渲染成页面内建 demo 文案（qa 查不出：它验 plan 有标题，不验像素里有）。
  // 现在保留原 query，渲染器参数 seg/t0/speed/dur 依旧强制覆盖。
  u.searchParams.set('seg', '1');
  u.searchParams.set('t0', String(t.t0));
  u.searchParams.set('speed', String(t.speed));
  u.searchParams.set('dur', String(t.duration));
  return u.toString();
}

function buildPageUrl(page, port, t) {
  let pageUrl = /^https?:\/\//i.test(String(page)) ? page : withSegmentParams(page, port, t);
  if (/^https?:\/\//i.test(String(page))) {
    if (isPrivateHost(pageUrl)) {
      throw new Error(`remote page blocked: ${page} points at a loopback/private range (SSRF guard)`);
    }
  }
  if (t.vars) {
    const u = new URL(pageUrl);
    u.searchParams.set('vars', Buffer.from(JSON.stringify(t.vars)).toString('base64url'));
    pageUrl = u.toString();
  }
  return pageUrl;
}

// ---------- page adapters ----------

async function openPlaywright(opts) {
  let chromium;
  try { chromium = (await import('playwright')).chromium; }
  catch { chromium = (await import('playwright-core')).chromium; }

  const launchArgs = [
    '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--hide-scrollbars', '--mute-audio', '--no-first-run', '--disable-extensions',
    '--run-all-compositor-stages-before-draw', '--disable-frame-rate-limit', '--force-color-profile=srgb',
    '--disable-lcd-text', '--font-render-hinting=none',
  ];
  if (process.platform !== 'win32') {
    launchArgs.push('--disable-dev-shm-usage');
    // 沙箱默认开启；容器 / root 环境用 CVS_NO_SANDBOX=1 显式关闭（docker/Dockerfile 已设）。
    if (process.env.CVS_NO_SANDBOX === '1') launchArgs.push('--no-sandbox', '--disable-setuid-sandbox');
  }

  const browser = await chromium.launch({
    headless: !opts.headed,
    args: launchArgs,
    ...(opts.browser ? { executablePath: opts.browser } : {}),
  });
  const context = await browser.newContext({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: 1 });
  return {
    kind: 'playwright',
    async newPage({ url, initScript, width = opts.width, height = opts.height }) {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
      try {
        await page.setViewportSize({ width, height });
        if (initScript) await page.addInitScript({ content: initScript });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
        await page.waitForFunction('window.__ready === true || window.__bootError', null, { timeout: opts.timeout });
        const bootError = await page.evaluate(() => window.__bootError || null);
        if (bootError) throw new Error('page boot error: ' + bootError);
        await page.evaluate(() => document.fonts.ready);
        // v4.9.1 CJK 子集竞态（test-recipes 实测暴露：kinetic/datarace/inkwash 静帧
        // 两次不一致，59~数千 px）：unicode-range 子集在**首绘用到字形时**才入队，
        // boot 里 loadFonts(sample) 只覆盖样例子集。首绘 renderFrame(0) 之后必须再
        // 等一轮 fonts.ready + status 收敛，否则冷启动 A/B 两跑分别拍到"字体半路
        // 到场"与"全到场"两种光栅 → 破坏帧=f(t)。
        await page.evaluate(async () => { window.renderFrame && window.renderFrame(0); await document.fonts.ready; });
        await page.waitForFunction('document.fonts.status !== "loading"', null, { timeout: 12000 }).catch(() => {});
        await page.evaluate(() => document.fonts.ready);

        const cdp = await context.newCDPSession(page);
        const ev = (fn, arg) => page.evaluate(fn, arg);
        const shot = async () => {
          const r = await cdp.send('Page.captureScreenshot', {
            format: cdpShotFormat(opts), ...(cdpShotFormat(opts) === 'jpeg' ? { quality: opts.quality } : {}),
            fromSurface: true, captureBeyondViewport: false,
            ...(opts.optimize ? { optimizeForSpeed: true } : {}),
            clip: { x: 0, y: 0, width, height, scale: 1 },
          });
          return Buffer.from(r.data, 'base64');
        };
        const duration = await page.evaluate(() => window.DURATION ?? null);
        return { kind: 'playwright', ev, shot, errors, duration, close: () => page.close() };
      } catch (e) {
        await page.close().catch(() => {});
        throw e;
      }
    },
    close: () => browser.close(),
  };
}

/** R16-W：连入既有浏览器（不拥有 → close 不杀进程，供同进程位级对比用）。 */
function attachCreatePage(b, opts) {
  return async ({ width = opts.width, height = opts.height } = {}) => {
    const { targetId: tid } = await b.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await b.send('Target.attachToTarget', { targetId: tid, flatten: true });
    await b.send('Page.enable', {}, sessionId);
    await b.send('Runtime.enable', {}, sessionId);
    await b.send('Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height }, sessionId);
    return {
      sessionId, targetId: tid,
      close: async () => { try { await b.send('Target.closeTarget', { targetId: tid }); } catch { /* already gone */ } },
    };
  };
}

async function openCdp(opts) {
  // R16-W：opts.endpoint（ws://127.0.0.1:port/devtools/browser/…）连入已启动的浏览器，
  // 与调用方（如 frames 工作台的 live iframe）共享同一个 GPU/SwiftShader 进程——
  // 同参数同进程渲染必然逐像素一致，这是「预览帧 == 成片帧」的位级硬证据。
  let b;
  if (opts.endpoint) {
    // R16-W：连入已启动的浏览器（不拥有）。句柄伪装成 launch() 的形状——内部适配器
    // 通过 b.client / b.createPage 与之交互；__owns=false 让 close() 不杀共享进程。
    const c = await connect(opts.endpoint, opts.launchTimeout);
    b = { client: c, createPage: attachCreatePage(c, opts), __owns: false, close: async () => {} };
  } else {
    b = await launchCdp({
      executablePath: opts.browser || undefined,
      width: opts.width,
      height: opts.height,
      headed: opts.headed,
      timeout: opts.launchTimeout,
      profileDir: opts.profileDir,
      removeProfile: opts.removeProfile,
    });
  }
  return {
    kind: 'cdp',
    async newPage({ url, initScript, width = opts.width, height = opts.height }) {
      const p = await b.createPage({ width, height });
      const errors = [];
      const offs = [
        b.client.on('Runtime.exceptionThrown', (params, sid) => {
          if (sid !== p.sessionId) return;
          errors.push(params?.exceptionDetails?.exception?.description || params?.exceptionDetails?.text || 'page exception');
          // 模块加载失败（404 依赖）时模块体不执行，__ready/__bootError 都不会置位。
          // 立一个旗标让 ready 等待提前退出，而不是烧满 timeout。
          cdpEvaluate(b.client, p.sessionId, () => { if (!window.__ready) window.__pageException = true; }).catch(() => {});
        }),
        b.client.on('Runtime.consoleAPICalled', (params, sid) => {
          if (sid !== p.sessionId) return;
          if (params.type === 'error') errors.push('console: ' + (params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
        }),
      ];
      try {
        if (initScript) {
          await b.client.send('Page.addScriptToEvaluateOnNewDocument', { source: initScript }, p.sessionId);
        }
        await b.client.send('Page.navigate', { url }, p.sessionId);
        await cdpWaitFor(b.client, p.sessionId, 'document.readyState === "complete" || document.readyState === "interactive"', { timeout: opts.timeout, label: 'document load', warn: opts.warn });
        await cdpWaitFor(b.client, p.sessionId, 'window.__ready === true || !!window.__bootError || !!window.__pageException', { timeout: opts.timeout, label: 'window.__ready', warn: opts.warn });
        const bootError = await cdpEvaluate(b.client, p.sessionId, () => window.__bootError || null);
        if (bootError) throw new Error('page boot error: ' + bootError);
        const isReady = await cdpEvaluate(b.client, p.sessionId, () => window.__ready === true);
        if (!isReady && errors.length) throw new Error('page boot error: ' + errors[0]);
        await cdpEvaluate(b.client, p.sessionId, () => document.fonts.ready);
        // v4.9.1 CJK unicode-range 子集首绘后才入队——boot 的 loadFonts(sample) 只覆盖
        // 样例子集。首绘后必须再等一轮 fonts.ready + status 收敛，否则冷启动两跑分别
        // 拍到"字体半路到场/全到场"两种光栅，破坏帧=f(t)（test-recipes 实测暴露）。
        await cdpEvaluate(b.client, p.sessionId, async () => { window.renderFrame && window.renderFrame(0); await document.fonts.ready; return true; });
        await cdpWaitFor(b.client, p.sessionId, 'document.fonts.status !== "loading"', { timeout: 12000, label: 'fonts settled', warn: opts.warn }).catch(() => {});
        await cdpEvaluate(b.client, p.sessionId, () => document.fonts.ready);

        // S8/G2 同族补漏：per-frame 取帧 evaluate（raw: renderFrame+getImageData+
        // 8.3MB base64 POST；canvas: toDataURL）此前吃 cdp.mjs 的 30s 旧默认——
        // 重段首帧冷启动 + farm 并发下会在 frame 0 撞 `CDP timeout: Runtime.evaluate`
        // （mini-41s e2e 实测 99-ending 三连败）。与截图同口径：给页面预算。
        const ev = (fn, arg) => cdpEvaluate(b.client, p.sessionId, fn, arg, opts.timeout || 120000);
        const shot = async () => {
          const r = await b.client.send('Page.captureScreenshot', {
            format: cdpShotFormat(opts), ...(cdpShotFormat(opts) === 'jpeg' ? { quality: opts.quality } : {}),
            fromSurface: true, captureBeyondViewport: false,
            ...(opts.optimize ? { optimizeForSpeed: true } : {}),
            clip: { x: 0, y: 0, width, height, scale: 1 },
          }, p.sessionId, opts.timeout || 120000);
          return Buffer.from(r.data, 'base64');
        };
        const duration = await cdpEvaluate(b.client, p.sessionId, () => window.DURATION ?? null);
        return { kind: 'cdp', ev, shot, errors, duration, close: async () => { for (const off of offs) off(); await p.close(); } };
      } catch (e) {
        for (const off of offs) off();
        await p.close().catch(() => {});
        throw e;
      }
    },
    // R16-W：共享浏览器由调用方拥有，close 必须是空操作（杀了它等于杀掉工作台页面）。
    close: () => (b.__owns === false ? Promise.resolve() : b.close()),
  };
}

/** Open one browser (Playwright when installed, raw CDP otherwise). */
export async function openBrowser(opts) {
  // R16-W：显式 endpoint 必须走 CDP 共享路径——Playwright 分支会自行启动，
  // 端点被静默忽略，位级一致性就无从谈起。
  if (!opts.cdp && opts.endpoint) {
    try { return await openCdp(opts); }
    catch (e) { throw new Error('no renderer available:\n  - cdp(shared): ' + String(e.message).split('\n')[0]); }
  }
  const tried = [];
  if (!opts.cdp && !opts.noPlaywright) {
    try { return await openPlaywright(opts); }
    catch (e) { tried.push(`playwright: ${String(e.message).split('\n')[0]}`); }
  }
  try { return await openCdp(opts); }
  catch (e) { tried.push(`cdp: ${String(e.message).split('\n')[0]}`); }
  throw new Error('no renderer available:\n  - ' + tried.join('\n  - '));
}

// ---------- capture ----------

/** CDP Page.captureScreenshot only knows png/jpeg; a raw request falls back to png. */
function cdpShotFormat(opts) {
  return opts.format === 'jpeg' ? 'jpeg' : 'png';
}

async function resolveCaptureMode(page, opts) {
  let mode = opts.capture;
  const wantRaw = opts.format === 'raw';
  if (mode === 'auto') {
    try {
      mode = await page.ev(({ w, h, raw }) => {
        if (window.__capture === 'canvas' || window.__capture === 'cdp') return window.__capture;
        const cs = [...document.querySelectorAll('canvas')];
        if (cs.length !== 1) return 'cdp';
        if (document.querySelector('[data-dom-overlay]')) return 'cdp';
        // R3-审计（RT-05 F2）：页面里只要存在「可见的」非 canvas DOM（HUD/水印/
        // 角标常见形态）而没标 data-dom-overlay，raw/canvas 只取画布像素 → 这些层
        // 整块丢帧且无告警。宁可慢走 CDP 截图（含 DOM），不出缺像素的片。
        // S8（v4.11）：但 canvas 的**布局父节点**（#stage 这类纯容器）不是绘制层——
        // 把它当覆盖层会把全部内建页踢进 CDP 合成器截图路径，而该路径实测非逐字节
        // 确定（6 次 2 偏，LSB 级漂移）且慢 4×。祖先节点仅在「自己绘制背景」时才算
        // 覆盖层（半透明画布+衬底场景）；真 DOM 覆盖层用 data-dom-overlay 显式声明。
        const c0 = cs[0];
        const visibleOverlay = [...document.querySelectorAll('body *')].some((el) =>
          el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE' && el.tagName !== 'NOSCRIPT' &&
          el.tagName !== 'TEMPLATE' && el.tagName !== 'CANVAS' && el.offsetParent !== null &&
          !(el.contains(c0) && (() => {
            const s = getComputedStyle(el);
            return s.backgroundColor === 'rgba(0, 0, 0, 0)' && s.backgroundImage === 'none';
          })()));
        if (visibleOverlay) return 'cdp';
        const c = cs[0];
        if (raw) {
          // rawvideo 要求画布尺寸与 -s 逐像素一致（否则帧边界错位），且必须是 2D
          // 上下文（WebGL 画布没有 getImageData）。任一不符 → PNG 回退，仍确定。
          if (c.width !== w || c.height !== h) return 'canvas';
          let g = null;
          try { g = c.getContext('2d'); } catch { /* webgl 等 */ }
          return g ? 'raw' : 'canvas';
        }
        return c.width >= w * 0.99 && c.height >= h * 0.99 ? 'canvas' : 'cdp';
      }, { w: opts.width, h: opts.height, raw: wantRaw });
    } catch (e) {
      // R3-审计（RT-05 F14）：以前静默落 cdp，失败原因不留痕。留一条可查的告警。
      mode = 'cdp';
      try { page.log(`[warn] capture-mode probe failed (${String((e && e.message) || e).slice(0, 120)}); using cdp`); } catch { /* ignore */ }
    }
  }
  if (mode === 'canvas') {
    const can = await page.ev(() => document.querySelectorAll('canvas').length === 1);
    if (!can) mode = 'cdp';
  }
  return mode;
}

async function grab(page, t, mode, opts) {
  if (mode === 'raw') {
    // 页面里 renderFrame → getImageData（纯拷贝，无编码）→ fetch POST 原始 RGBA。
    // fetch 的 await 保证字节已全部落到 frameSink.last，Node 侧顺序取走即可。
    // 本地 POST 偶发瞬时断连（实测第 ~60 帧一次），重试成本近零而最稳；
    // 每次都新建连接，坏掉的复用连接不会传染下一帧。
    await page.ev(async (tt) => {
      window.renderFrame(tt);
      const c = document.querySelector('canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let lastErr = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            // R3-审计（RT-05 F3）：退避改指数（25→50→100→200ms），并给每次 POST
            // 加 3s 上限——以前线性且靠 socket 关闭触发 reject，慢挂最坏拖满 125ms×5。
            const r = await fetch('/__frame', {
              method: 'POST', body: d, cache: 'no-store',
              ...((typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? { signal: AbortSignal.timeout(3000) } : {}),
            });
            if (r.ok) return attempt;
            lastErr = 'HTTP ' + r.status;
          } catch (e) {
            lastErr = (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e));
          }
          await new Promise((res) => setTimeout(res, 25 * 2 ** attempt));
        }
      throw new Error('frame post failed after 5 attempts — ' + lastErr);
    }, t);
    const buf = page.frameSink ? page.frameSink.take() : null;
    if (!buf || !buf.length) throw new Error('raw frame missing from frame sink');
    const want = opts.width * opts.height * 4;
    if (buf.length !== want) throw new Error(`raw frame size ${buf.length} != ${want} (${opts.width}x${opts.height} RGBA)`);
    return buf;
  }
  if (mode === 'canvas') {
    const dataUrl = await page.ev(({ tt, fmt, q }) => {
      window.renderFrame(tt);
      const c = document.querySelector('canvas');
      return c.toDataURL(fmt === 'png' ? 'image/png' : 'image/jpeg', q);
    }, { tt: t, fmt: opts.format, q: opts.quality });
    const comma = String(dataUrl).indexOf(',');
    if (comma < 0) throw new Error('canvas.toDataURL returned no data');
    const buf = Buffer.from(String(dataUrl).slice(comma + 1), 'base64');
    if (buf.length < 800) throw new Error(`canvas frame suspiciously small (${buf.length} bytes)`);
    return buf;
  }
  await page.ev((tt) => window.renderFrame(tt), t);
  const buf = await page.shot();
  if (buf.length < 800) throw new Error(`CDP frame suspiciously small (${buf.length} bytes)`);
  return buf;
}

// ---------- renderer context ----------

/**
 * Start one static server and one browser, then run `fn(ctx)`.
 *
 * ctx.openPage(pageOpts) → { url, kind, ev, shot, errors, duration, close }
 * ctx.render(pageOpts)   → render one segment to MP4 (same options as CLI)
 * ctx.stills(pageOpts)   → render stills (same options as CLI)
 * ctx.restart()          → replace the browser (retry path)
 */
export async function withRenderer(rawOptions, fn) {
  const opts = normalizeOptions(rawOptions);
  const server = await startStaticServer(opts.root, opts.port);
  const port = server.address().port;
  let browser = null;
  let restarts = 0;
  const baseProfileDir = opts.profileDir;

  const pageOptions = (pageOpts = {}) => {
    const merged = normalizeOptions({ ...opts, ...pageOpts, root: opts.root, log: opts.log, warn: opts.warn });
    // normalizeOptions would re-read --vars; page-level vars win when given.
    merged.vars = pageOpts.vars !== undefined ? loadVars(pageOpts.vars, opts.root) : opts.vars;
    return merged;
  };

  const ctx = {
    root: opts.root,
    port,
    origin: `http://127.0.0.1:${port}`,
    opts,
    get browser() { return browser; },
    get kind() { return browser ? browser.kind : null; },

    async openPage(pageOpts = {}) {
      const o = pageOptions(pageOpts);
      const page = o.page || opts.page;
      if (!page) throw new Error('--page is required');
      const url = buildPageUrl(page, port, { t0: o.t0, speed: o.speed, duration: o.duration, vars: o.vars, keepPageParams: o.keepPageParams });
      const initScript = o.vars ? `window.__vars = ${JSON.stringify(o.vars)};` : '';
      const log = typeof pageOpts.log === 'function' ? pageOpts.log : opts.log;
      log(`[page] ${url}`);
      if (!browser) throw new Error('renderer is not running');
      const p = await browser.newPage({ url, initScript, width: o.width, height: o.height });
      p.url = url;
      p.log = log;
      p.frameSink = server.frameSink; // raw 捕获：页面 POST 的原始帧从这里取
      return p;
    },

    async render(pageOpts = {}) {
      return renderVideo(ctx, pageOptions(pageOpts), pageOpts);
    },

    async stills(pageOpts = {}) {
      return renderStills(ctx, pageOptions(pageOpts), pageOpts);
    },

    async restart() {
      const old = browser;
      browser = null;
      if (old) await old.close().catch(() => {});
      // 恢复路径换一个全新的 profile 目录。被杀/崩溃的浏览器可能把 singleton 锁、
      // 半写的 Local State 留在旧目录里；复用它等于把「能不能恢复」押在上一次死得
      // 够干净上。profile 只是浏览器状态，帧缓存是 .cache，换目录不损失任何复用。
      restarts += 1;
      const next = baseProfileDir ? { ...opts, profileDir: `${baseProfileDir}-r${restarts}` } : opts;
      browser = await openBrowser(next);
      opts.log(`[browser] ${browser.kind}${restarts > 1 ? ` (restart ${restarts})` : ''}`);
      return browser.kind;
    },
  };

  try {
    browser = await openBrowser(opts);
    opts.log(`[browser] ${browser.kind}`);
    return await fn(ctx);
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
    // Browser keep-alive sockets otherwise hold the process open until the
    // 5 s keepAliveTimeout, which multiplied across 33 segments is real time.
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }
}

async function preparePage(ctx, opts, pageOpts) {
  const page = await ctx.openPage(pageOpts);
  try {
    const mode = await resolveCaptureMode(page, opts);
    page.log(`[capture] ${mode}`);
    page.mode = mode;
    return page;
  } catch (e) {
    await page.close().catch(() => {});
    throw e;
  }
}

async function warmUp(page, opts) {
  if (!opts.warmup) return;
  try {
    // R2-11：swiftshader 渲染器在 ~112 帧后有状态突变（shader 缓存/JIT 预热），
    // 使通用开场段动画 arc 的抗锯齿出现逐次微差（帧 0-111 确定、112+ 漂移）。
    // 捕获前先 discard 渲一段序列（只 renderFrame 不抓帧，开销小）越过突变点，
    // 让捕获帧逐字节确定。recipe 页用简单形状不受影响，此预热对其无害。
    const fps = opts.fps || 30;
    const warmFrames = Math.max(150, Math.round(fps * 5));
    for (let i = 0; i < warmFrames; i++) {
      await page.ev((t) => window.renderFrame(t), i / fps);
    }
    await page.ev(() => new Promise((r) => requestAnimationFrame(() => r(true))));
  } catch { /* warm-up is best effort */ }
}

async function renderVideo(ctx, opts, rawPageOpts = {}) {
  if (!opts.out) throw new Error('--out is required (or use --still)');
  const page = await preparePage(ctx, opts, rawPageOpts);
  try {
    if (page.duration && Math.abs(page.duration - opts.duration) > 1e-6) {
      opts.warn(`[warn] page DURATION=${page.duration} but --duration=${opts.duration}; using --duration`);
    }
    await warmUp(page, opts);

    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    // R2-11c：ffmpeg 的输入格式必须与**实际**捕获模式一致。raw 模式不可用
    // （画布非 2D / 尺寸不符 / 已回退 CDP）时改走 PNG——ffmpeg 侧随之切回
    // image2pipe，否则会把 PNG 字节当 RGBA 像素读成花屏。
    if (opts.format === 'raw' && page.mode !== 'raw') {
      opts.format = 'png';
      page.log('[capture] raw unavailable; falling back to png (still deterministic)');
    }
    // S5a 运动模糊：以 fps*N 渲染 N 倍子帧（页面纯 f(t)，子帧合法），编码后
    // tmix=frames=N:weights=w + fps 回原帧率——每输出帧 = 一小段快门窗口内的
    // 加权和。全程单线程 bitexact，确定性不破（tmix 为逐像素算术）。
    const blurW = String(opts.motionBlur || '').trim();
    const samples = blurW ? blurW.split(/\s+/).filter(Boolean).length : 1;
    if (blurW && samples < 2) throw new Error(`[E_BLUR] motion-blur weights "${blurW}" 需要 ≥2 个权重`);
    const renderFps = opts.fps * samples;
    const framesOut = Math.round(opts.duration * opts.fps);
    const frames = Math.round(opts.duration * renderFps);
    const finalOut = opts.out;
    const encOut = blurW ? finalOut + '.preblur.mp4' : finalOut;
    if (blurW) fs.rmSync(encOut, { force: true });
    const ff = launchFfmpeg(encOut, { ...opts, fps: renderFps });
    const started = performance.now();
    try {
      for (let i = 0; i < frames; i++) {
        const t = i / renderFps;
        let buf;
        try { buf = await grab(page, t, page.mode, opts); }
        catch (e) {
          if (page.mode === 'canvas') {
            page.log(`[warn] canvas capture failed at frame ${i} (${e.message}); switching to cdp`);
            page.mode = 'cdp';
            buf = await grab(page, t, page.mode, opts);
          } else if (page.mode === 'raw') {
            // raw 流不能中途换格式（ffmpeg 已按 rawvideo 启动，混入 PNG 字节会花屏）。
            // 报清楚病根，让人直接 --format png 绕过——那同样是确定的，只是慢些。
            throw new Error(`raw capture failed at frame ${i}: ${e.message} — rerun with --format png to bypass raw`);
          } else throw e;
        }
        await writeAsync(ff.stdin, buf);
        if (i % 30 === 0 || i === frames - 1) {
          const sec = (performance.now() - started) / 1000;
          const fps = (i + 1) / Math.max(0.001, sec);
          page.log(`[frame] ${i + 1}/${frames}  t=${t.toFixed(3)}s  elapsed=${sec.toFixed(1)}s  ~${fps.toFixed(1)}fps`);
        }
      }
      ff.stdin.end();
      await ff.done;
    } catch (e) {
      // 抓帧失败：杀掉 ffmpeg，避免它的 stdin 管道把进程留住。
      // kill 之后 done 必然 reject（exit null），必须消费掉，否则成为未处理拒绝。
      ff.kill();
      try { await ff.done; } catch { /* expected after kill */ }
      fs.rmSync(encOut, { force: true });
      throw e;
    }
    if (blurW) {
      const r = spawnSync(opts.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', encOut,
        '-vf', `tmix=frames=${samples}:weights='${blurW}',fps=${opts.fps}`,
        '-c:v', 'libx264', '-preset', opts.preset, '-crf', String(opts.crf),
        // G6-2：tmix 后置 pass 与主编码同构——以前漏了 -tune，开 blur 的段
        // 编码器参数与关档不同构（用户指定的 tune 被静默丢弃）。
        ...(opts.tune ? ['-tune', opts.tune] : []),
        '-threads', '1', '-x264-params', 'threads=1:lookahead_threads=1:rc-lookahead=10',
        '-fflags', '+bitexact', '-flags', '+bitexact',
        '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
        '-video_track_timescale', '90000', '-movflags', '+faststart', finalOut], { windowsHide: true });
      fs.rmSync(encOut, { force: true });
      if (r.status !== 0) throw new Error(`[E_BLUR] tmix post-pass failed (exit ${r.status}): ${String(r.stderr || '').slice(-300)}`);
      page.log(`[blur] tmix frames=${samples} weights='${blurW}' → ${opts.fps}fps`);
    }
    const size = fs.statSync(finalOut).size;
    const outFrames = blurW ? framesOut : frames;
    page.log(`[done] ${finalOut}  ${outFrames} frames @${opts.fps}fps  ${(size / 1024 / 1024).toFixed(2)} MB  capture=${page.mode}${blurW ? '  blur=' + samples + 'x' : ''}`);
    if (page.errors.length) opts.warn('[page errors] ' + page.errors.slice(0, 5).join(' | '));
    return { out: finalOut, frames: outFrames, seconds: (performance.now() - started) / 1000, capture: page.mode, pageUrl: page.url, errors: page.errors.slice(0, 5) };
  } finally {
    await page.close().catch(() => {});
  }
}

async function renderStills(ctx, opts, rawPageOpts = {}) {
  const stills = opts.stills || [];
  // stills 落盘必须是图片文件（golden 基线是 PNG）；raw 只对视频流有意义。
  if (opts.format === 'raw') opts.format = 'png';
  const page = await preparePage(ctx, opts, rawPageOpts);
  try {
    fs.mkdirSync(opts.outdir, { recursive: true });
    for (const t of stills) {
      let buf;
      try { buf = await grab(page, t, page.mode, opts); }
      catch (e) {
        if (page.mode === 'canvas') {
          page.log(`[warn] canvas capture failed (${e.message}); switching to cdp`);
          page.mode = 'cdp';
          buf = await grab(page, t, page.mode, opts);
        } else throw e;
      }
      const ext = opts.format === 'png' ? 'png' : 'jpg';
      const file = path.join(opts.outdir, `still-${String(t.toFixed(2)).replace('.', '_')}.${ext}`);
      fs.writeFileSync(file, buf);
      page.log(`[still] ${file}`);
    }
    page.log(`[done] ${stills.length} stills -> ${opts.outdir}`);
    if (page.errors.length) opts.warn('[page errors] ' + page.errors.slice(0, 5).join(' | '));
    return { stills: stills.length, outdir: opts.outdir, files: stills.map((t) => path.join(opts.outdir, `still-${String(t.toFixed(2)).replace('.', '_')}.${opts.format === 'png' ? 'png' : 'jpg'}`)) };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Render exactly one segment (or its stills). Starts its own server and
 * browser, so this is the "cold" single-segment entry point. For many
 * segments use withRenderer() to amortise the browser startup.
 */
export async function renderSegment(rawOptions) {
  const opts = normalizeOptions(rawOptions);
  return withRenderer(opts, async (ctx) => {
    if (opts.stills) return ctx.stills({});
    return ctx.render({});
  });
}

// ---------- CLI ----------

const USAGE = `Usage: node render-segment.mjs --page <path-or-url> [options]
  --out <file.mp4>        output video (required unless --still)
  --duration <sec>        clip duration, default 3
  --t0 <sec>              scene offset appended to the page URL, default 0
  --speed <x>             scene playback speed, default 1
  --fps <n>               default 30
  --width/--height <n>    viewport, default 1920x1080
  --root <dir>            static root, default cwd
  --port <n>              static server port, default 0 (ephemeral)
  --crf <n>               libx264 crf for the intermediate, default 12
  --preset <name>         libx264 preset, default veryfast
  --tune <name>           optional x264 tune (e.g. animation)
  --format <raw|png|jpeg>  frame format, default png (raw = lossless RGBA straight to
                          ffmpeg rawvideo, ~3-7x faster than png and equally exact;
                          falls back to png when the canvas is not a 2D same-size one)
  --quality <n>           jpeg quality, default 92
  --capture <auto|canvas|cdp>  frame capture path, default auto
  --vars <file|json>      expose as window.__vars (also ?vars=<base64url>)
  --still <t1,t2,...>     render stills instead of video
  --outdir <dir>          stills directory, default out/stills
  --no-warmup             skip the first-frame warm-up
  --no-optimize           disable CDP optimizeForSpeed
  --headed                show the browser (debug)
  --timeout <ms>          ready timeout, default 120000
  --launch-timeout <ms>   browser start timeout, default 30000 (kept separate from
                          --timeout so a browser that cannot start fails fast)
  --browser <path>        explicit Chrome/Edge executable
  --profile-dir <dir>     persistent Chrome profile (default: temp, removed)
  --remove-profile        delete the persistent profile on exit
  --cdp                   skip Playwright, use raw CDP
  --no-playwright         same as --cdp

Relative --page paths get ?seg=1&t0=&speed=&dur= appended automatically.
A page can force the capture path with window.__capture = 'canvas' | 'cdp'.`;

const isMain = (() => {
  if (!process.argv[1]) return false;
  const a = path.resolve(process.argv[1]);
  const b = path.resolve(fileURLToPath(import.meta.url));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
})();

if (isMain) {
  const args = parseArgv(process.argv.slice(2));
  if (args.help || !args.page) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }
  renderSegment(optionsFromArgs(args))
    .then((r) => {
      if (r && r.frames !== undefined && r.frames === 0) process.exitCode = 1;
    })
    .catch((e) => { console.error('[fatal]', e && e.stack || e); process.exit(1); });
}
