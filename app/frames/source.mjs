/**
 * source.mjs — 逐帧预览的三种帧源，统一成 `getFrame(n)`。
 *
 *   spec   从 spec / plan 实时渲染第 n 帧：与 render-segment.mjs **同一条路径**
 *          （同一页面 URL、同样 t = 段内帧号 / fps、同样 renderFrame），
 *          所以预览帧就是成片里的那一帧，不是近似画面。
 *   video  从已渲染的 mp4 逐帧解码：ffmpeg `-fps_mode passthrough` 一次性
 *          顺序落盘 JPEG，边解码边可看（ready 计数递增），按帧号索引。
 *   images 图片序列（`cvs image` 产物 / 任意帧目录 / image-manifest.json），
 *          一张图 = 一帧，按文件名自然排序翻页。
 *
 * 纯逻辑（帧号/时间/时间码/段定位/读尺寸）都导出，方便 scripts/test-frames.mjs
 * 在 Node 里直接断言，不需要浏览器。
 *
 * 帧号约定（与 templates/render-segment.mjs 完全一致）：
 *   frames = round(duration * fps)
 *   段内第 i 帧 → 段内时间 t = i / fps
 *   全片第 n 帧 → 所在段 seg，i = n - seg.startFrame，t = i / fps
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { withRenderer } from '../../templates/render-segment.mjs';
import { buildPlanFromSpec } from '../../templates/plan.mjs';

// ── 纯函数 ──────────────────────────────────────────────────────────────────

/** "30000/1001" → 29.97002997；"30" → 30；无法解析 → fallback。 */
export function parseRate(value, fallback = 30) {
  if (value === null || value === undefined) return fallback;
  const s = String(value).trim();
  if (!s) return fallback;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (m) {
    const num = Number(m[1]);
    const den = Number(m[2]);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0 && num > 0) return num / den;
    return fallback;
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 帧号 → 秒（0 基，帧 n 的时刻是 n/fps）。 */
export function frameToTime(n, fps) {
  return Number(n) / (Number(fps) || 30);
}

/** 秒 → 最近帧号（四舍五入；用于把用户输入的时间对齐到帧）。 */
export function timeToFrame(t, fps) {
  return Math.max(0, Math.round((Number(t) || 0) * (Number(fps) || 30)));
}

/** 帧号 → 时间码 HH:MM:SS:FF（FF 为秒内帧序号；29.97 下按 NDF 近似）。 */
export function timecodeOf(n, fps) {
  const f = Number(fps) || 30;
  const frame = Math.max(0, Math.round(Number(n) || 0));
  const secTotal = Math.floor(frame / f);
  const ff = Math.min(Math.max(1, Math.round(f)) - 1, Math.round(frame - secTotal * f));
  const hh = Math.floor(secTotal / 3600);
  const mm = Math.floor((secTotal % 3600) / 60);
  const ss = secTotal % 60;
  const p = (v, w = 2) => String(v).padStart(w, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

/** 全片帧数（与渲染器同一量化：round(duration*fps)）。 */
export function frameCountOf(duration, fps) {
  const d = Number(duration);
  const f = Number(fps);
  if (!Number.isFinite(d) || d <= 0) return 0;
  return Math.max(0, Math.round(d * (Number.isFinite(f) && f > 0 ? f : 30)));
}

/** 找到包含第 n 帧的段（startFrame 含，endFrame 不含）。 */
export function findSegment(segments, n) {
  if (!Array.isArray(segments) || !segments.length) return null;
  const frame = Number(n) || 0;
  for (const seg of segments) {
    if (frame >= seg.startFrame && frame < seg.endFrame) return seg;
  }
  return null;
}

/** 全片第 n 帧 → { seg, localFrame, t, time, timecode }。 */
export function frameInfo(plan, n) {
  const fps = Number(plan?.stats?.fps) || Number(plan?.spec?.format?.fps) || 30;
  const frame = Math.max(0, Math.round(Number(n) || 0));
  const seg = findSegment(plan?.segments || [], frame);
  const localFrame = seg ? frame - seg.startFrame : frame;
  return {
    n: frame,
    fps,
    seg: seg || null,
    segmentId: seg ? seg.id : null,
    localFrame,
    t: localFrame / fps,
    time: frame / fps,
    timecode: timecodeOf(frame, fps),
  };
}

/** 自然排序（frame_2 排在 frame_10 前）。 */
export function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif']);

/** 读 PNG / JPEG / WebP / GIF / BMP 的像素尺寸；不认识返回 null。 */
export function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG: 8 字节签名 + IHDR
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF
  if (buf.length >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // BMP
  if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
  }
  // JPEG: 逐段扫 SOF0/1/2/3/5/6/7/9/10/11/13/14/15
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      const len = buf.readUInt16BE(off + 2);
      if (len < 2) return null;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      off += 2 + len;
    }
  }
  // WebP: RIFF....WEBP + VP8/VP8L/VP8X
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    }
    if (chunk === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
  }
  return null;
}

// ── ffprobe ────────────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: opts.timeout || 20000 });
  } catch (e) {
    const msg = e && e.stderr ? String(e.stderr).trim() : String(e && e.message || e);
    throw new Error(`${cmd} failed: ${msg.slice(0, 400)}`);
  }
}

/** 探测视频：{ width, height, fps, frames, duration, codec }。 */
export function probeVideo(file) {
  const out = run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,avg_frame_rate,nb_frames,duration,codec_name',
    '-show_entries', 'format=duration',
    '-of', 'json', file,
  ]);
  let j;
  try { j = JSON.parse(out); } catch { throw new Error('ffprobe returned invalid JSON'); }
  const st = (j.streams || [])[0];
  if (!st) throw new Error('no video stream in ' + file);
  const fps = parseRate(st.avg_frame_rate && st.avg_frame_rate !== '0/0' ? st.avg_frame_rate : st.r_frame_rate, 30);
  const duration = Number(st.duration) || Number((j.format || {}).duration) || 0;
  let frames = Number.parseInt(st.nb_frames, 10);
  if (!Number.isFinite(frames) || frames <= 0) frames = frameCountOf(duration, fps);
  if (!frames) throw new Error('cannot determine frame count of ' + file);
  return {
    width: Number(st.width) || 0,
    height: Number(st.height) || 0,
    fps,
    frames,
    duration: duration || frames / fps,
    codec: st.codec_name || null,
  };
}

// ── 工具 ────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function exists(p) {
  try { fs.statSync(p); return true; } catch { return false; }
}

async function waitFor(predicate, { timeout = 20000, interval = 60, label = 'condition' } = {}) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeout) {
    try {
      const v = await predicate();
      if (v) return v;
    } catch (e) { lastErr = e; }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label} (${timeout}ms)${lastErr ? ': ' + lastErr.message : ''}`);
}

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

// ── 视频源：渐进解码 ────────────────────────────────────────────────────────

/**
 * 视频帧源。首次打开时把 mp4 逐帧解码到缓存目录（JPEG），
 * 解码过程中 `ready` 递增，已解码的帧随即可看。
 */
export class VideoSource {
  constructor({ file, root, cacheRoot = null, maxWidth = 1280, quality = 3, refresh = false, fps = null }) {
    this.kind = 'video';
    this.file = path.resolve(String(file));
    this.root = path.resolve(String(root));
    this.maxWidth = Number(maxWidth) > 0 ? Number(maxWidth) : 1280;
    this.quality = Math.min(10, Math.max(1, Number(quality) || 3));
    this.refresh = !!refresh;
    this.fpsOverride = fps ? Number(fps) : null;
    this.cacheRoot = cacheRoot ? path.resolve(String(cacheRoot)) : path.join(this.root, 'out', 'frames-cache');
    this.proc = null;
    this.poller = null;
    this.error = null;
    this.done = false;
    this.ready = 0;
  }

  async open() {
    if (!exists(this.file)) throw new Error('video not found: ' + this.file);
    const info = probeVideo(this.file);
    this.info = info;
    this.fps = this.fpsOverride && this.fpsOverride > 0 ? this.fpsOverride : info.fps;
    this.frames = info.frames;
    this.duration = info.duration;
    this.width = info.width;
    this.height = info.height;

    const st = fs.statSync(this.file);
    const scale = this.width > this.maxWidth ? this.maxWidth / this.width : 1;
    this.outWidth = Math.max(2, Math.round((this.width * scale) / 2) * 2);
    this.outHeight = Math.max(2, Math.round((this.height * scale) / 2) * 2);

    const key = sha1([this.file, st.size, st.mtimeMs, this.outWidth, this.quality].join('|')).slice(0, 16);
    this.dir = path.join(this.cacheRoot, `v-${key}`);
    const doneMark = path.join(this.dir, '.done');
    if (this.refresh) { try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* ignore */ } }
    fs.mkdirSync(this.dir, { recursive: true });

    if (exists(doneMark)) {
      this.done = true;
      this.ready = this.countFrames();
      return this;
    }
    this.spawnDecoder();
    return this;
  }

  countFrames() {
    try {
      return fs.readdirSync(this.dir).filter((f) => /^f_\d+\.jpg$/.test(f)).length;
    } catch { return 0; }
  }

  spawnDecoder() {
    const pattern = path.join(this.dir, 'f_%06d.jpg');
    const args = ['-hide_banner', '-v', 'error', '-i', this.file, '-fps_mode', 'passthrough'];
    if (this.outWidth !== this.width || this.outHeight !== this.height) {
      args.push('-vf', `scale=${this.outWidth}:${this.outHeight}:flags=lanczos`);
    }
    args.push('-start_number', '0', '-q:v', String(this.quality), pattern);
    const proc = spawn('ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = proc;
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
    proc.on('error', (e) => { this.error = 'ffmpeg spawn failed: ' + e.message; this.done = true; });
    proc.on('exit', (code) => {
      this.proc = null;
      this.ready = this.countFrames();
      if (code === 0) {
        this.done = true;
        try { fs.writeFileSync(path.join(this.dir, '.done'), String(this.ready)); } catch { /* ignore */ }
      } else {
        this.error = `ffmpeg exit ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`;
        this.done = true;
      }
    });
    this.poller = setInterval(() => {
      const n = this.countFrames();
      if (n !== this.ready) this.ready = n;
    }, 200);
    if (this.poller.unref) this.poller.unref();
  }

  framePath(n) {
    return path.join(this.dir, `f_${String(n).padStart(6, '0')}.jpg`);
  }

  async getFrame(n) {
    const idx = Math.round(Number(n));
    if (!Number.isFinite(idx) || idx < 0 || idx >= this.frames) {
      const e = new Error(`frame ${n} out of range 0..${this.frames - 1}`);
      e.status = 400;
      throw e;
    }
    if (this.error && idx >= this.ready) throw new Error(this.error);
    const file = this.framePath(idx);
    if (!exists(file)) {
      await waitFor(() => exists(this.framePath(idx)) || this.error || this.done, {
        timeout: 30000, label: `frame ${idx} decode`,
      });
      if (!exists(file)) {
        const e = new Error(this.error || `frame ${idx} was not decoded (decoder stopped at ${this.ready}/${this.frames})`);
        e.status = 502;
        throw e;
      }
    }
    return { buf: fs.readFileSync(file), type: 'image/jpeg' };
  }

  async close() {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    if (this.proc) {
      try { this.proc.kill(); } catch { /* ignore */ }
      this.proc = null;
    }
  }

  meta() {
    return {
      kind: 'video', file: this.file,
      width: this.outWidth, height: this.outHeight,
      sourceWidth: this.width, sourceHeight: this.height,
      fps: this.fps, frames: this.frames, duration: this.duration,
      ready: this.done ? this.frames : this.ready, decoded: this.ready, done: this.done,
      error: this.error, cacheDir: this.dir, codec: this.info?.codec || null,
      segments: [], previewScale: this.outWidth / (this.width || this.outWidth),
    };
  }
}

// ── spec 源：按帧号精确渲染 ─────────────────────────────────────────────────

/**
 * spec / plan 帧源。浏览器常驻；每个段一个页面（LRU 3 个）。
 * getFrame(n) → 与 render-segment 完全相同的画面（同 URL / 同 t / 同 renderFrame）。
 */
export class SpecSource {
  constructor({ root, planPath = null, specPath = null, width = null, height = null, quality = 88, cacheSize = 240, pageLimit = 1, log = null }) {
    this.kind = 'spec';
    this.root = path.resolve(String(root));
    this.planPath = planPath ? path.resolve(String(planPath)) : null;
    this.specPath = specPath ? path.resolve(String(specPath)) : null;
    this.widthOpt = Number(width) || 0;
    this.heightOpt = Number(height) || 0;
    this.quality = Math.min(100, Math.max(30, Number(quality) || 88));
    this.cacheSize = Math.max(0, Number(cacheSize) || 0);
    this.pageLimit = Math.max(1, Number(pageLimit) || 3);
    this.log = typeof log === 'function' ? log : () => {};
    this.pages = new Map();       // seg.id → { page, mode, used }
    this._pagePromises = new Map();
    this._cache = new Map();      // key → { buf, type }
    this._chain = Promise.resolve();
    this.renders = 0;
    this.error = null;
    this._release = null;
    this._runner = null;
  }

  async open() {
    let plan;
    if (this.planPath) {
      if (!exists(this.planPath)) throw new Error('plan not found: ' + this.planPath);
      plan = JSON.parse(fs.readFileSync(this.planPath, 'utf8'));
    } else if (this.specPath) {
      if (!exists(this.specPath)) throw new Error('spec not found: ' + this.specPath);
      const spec = JSON.parse(fs.readFileSync(this.specPath, 'utf8'));
      const built = buildPlanFromSpec(spec, { root: this.root });
      plan = built.plan;
    } else {
      throw new Error('SpecSource needs planPath or specPath');
    }
    this.plan = plan;
    const fmt = plan?.spec?.format || {};
    this.fps = Number(plan?.stats?.fps) || Number(fmt.fps) || 30;
    this.frames = Number(plan?.stats?.frames) || frameCountOf(Number(fmt.duration) || 0, this.fps);
    this.width = this.widthOpt || Number(fmt.width) || 1920;
    this.height = this.heightOpt || Number(fmt.height) || 1080;
    if (!this.frames) throw new Error('plan has no frames');
    this.duration = this.frames / this.fps;
    this.segments = (plan.segments || []).map((s) => ({
      id: s.id, kind: s.kind, label: s.label || s.kind || s.id,
      startFrame: s.startFrame, endFrame: s.endFrame, frames: s.frames,
      start: s.start, end: s.end, page: s.page, duration: s.duration,
      t0: s.t0 ?? 0, speed: s.speed ?? 1,
    }));
    // 渲染器懒启动：打开 spec 源本身只读 plan（<50ms）。
    // 工作台里的 spec 预览走 iframe 实时 renderFrame，不需要服务端浏览器；
    // 只有缩略图 / 无头取帧 / 下载才在后台起 Chrome。
    this._rendererReady = null;
    return this;
  }

  /** 首次取帧时启动常驻浏览器；失败缓存错误，后续请求直接抛。 */
  async ensureRenderer() {
    if (this._runner) {
      if (this.error) throw this.error;
      await this._rendererReady;
      return;
    }
    const self = this;
    let readyResolve;
    let readyReject;
    this._rendererReady = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
    this._releaseP = new Promise((res) => { self._release = res; });
    this._runner = withRenderer({
      root: this.root,
      width: this.width,
      height: this.height,
      format: 'jpeg',
      quality: this.quality,
      capture: 'auto',
      warmup: false,
      browser: process.env.CHROME_EXE || null,
      log: (line) => self.log(line),
      warn: (line) => self.log('[warn] ' + line),
    }, async (ctx) => {
      self.ctx = ctx;
      readyResolve();
      await self._releaseP;
    });
    this._runner.catch((e) => {
      self.error = e;
      readyReject(e);
    });
    await this._rendererReady;
  }

  /** 串行化所有渲染请求（单页一次只能 renderFrame 一个 t）。 */
  _enqueue(fn) {
    const run = () => fn();
    const next = this._chain.then(run, run);
    this._chain = next.catch(() => {});
    return next;
  }

  _mode(page) {
    return page.ev(({ w, h }) => {
      if (window.__capture === 'canvas' || window.__capture === 'cdp') return window.__capture;
      const cs = [...document.querySelectorAll('canvas')];
      if (cs.length !== 1) return 'cdp';
      if (document.querySelector('[data-dom-overlay]')) return 'cdp';
      const c = cs[0];
      return c.width >= w * 0.99 && c.height >= h * 0.99 ? 'canvas' : 'cdp';
    }, { w: this.width, h: this.height });
  }

  async _pageFor(seg) {
    const hit = this.pages.get(seg.id);
    if (hit) { hit.used = Date.now(); return hit; }
    const pending = this._pagePromises.get(seg.id);
    if (pending) return pending;
    const p = (async () => {
      const page = await this.ctx.openPage({
        page: seg.page,
        duration: Number(seg.duration) || Number(seg.frames) / this.fps,
        t0: Number(seg.t0) || 0,
        speed: Number(seg.speed) || 1,
        width: this.width,
        height: this.height,
      });
      const mode = await this._mode(page);
      if (process.env.CVS_FRAMES_DEBUG) this.log(`[page] ${seg.id} mode=${mode}`);
      const entry = { page, mode, used: Date.now() };
      this.pages.set(seg.id, entry);
      this._evictPages();
      return entry;
    })();
    this._pagePromises.set(seg.id, p);
    try {
      return await p;
    } finally {
      this._pagePromises.delete(seg.id);
    }
  }

  _evictPages() {
    if (this.pages.size <= this.pageLimit) return;
    const entries = [...this.pages.entries()].sort((a, b) => a[1].used - b[1].used);
    while (this.pages.size > this.pageLimit) {
      const [id, entry] = entries.shift();
      this.pages.delete(id);
      if (process.env.CVS_FRAMES_DEBUG) this.log(`[page] evict ${id}`);
      Promise.resolve(entry.page.close()).catch(() => {});
    }
  }

  /**
   * 单帧抓取。带 30s 看门狗：页面若卡死（evaluate 永不返回），
   * 抛 504 并把该页从缓存里摘掉，下一次请求重开，不会永久堵住串行队列。
   */
  async _capture(entry, t, fmt, q) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error('frame render timed out after 30s; page recycled');
        e.status = 504;
        e.recyclePage = true;
        reject(e);
      }, 30000);
    });
    try {
      return await Promise.race([this._captureNow(entry, t, fmt, q), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async _captureNow(entry, t, fmt, q) {
    if (entry.mode === 'canvas') {
      const dataUrl = await entry.page.ev(({ tt, f, qq }) => {
        window.renderFrame(tt);
        const c = document.querySelector('canvas');
        return c.toDataURL(f === 'png' ? 'image/png' : 'image/jpeg', qq);
      }, { tt: t, f: fmt, qq: q });
      const comma = String(dataUrl).indexOf(',');
      if (comma < 0) throw new Error('canvas.toDataURL returned no data');
      return {
        buf: Buffer.from(String(dataUrl).slice(comma + 1), 'base64'),
        type: fmt === 'png' ? 'image/png' : 'image/jpeg',
      };
    }
    await entry.page.ev((tt) => window.renderFrame(tt), t);
    return { buf: await entry.page.shot(), type: 'image/jpeg' };
  }

  async getFrame(n, { fmt = 'jpeg', q = null } = {}) {
    const idx = Math.round(Number(n));
    if (!Number.isFinite(idx) || idx < 0 || idx >= this.frames) {
      const e = new Error(`frame ${n} out of range 0..${this.frames - 1}`);
      e.status = 400;
      throw e;
    }
    if (this.error) throw this.error;
    const variant = fmt === 'png' ? 'png' : 'jpeg';
    const quality = Math.min(1, Math.max(0.3, (Number(q) || this.quality) / 100));
    return this._enqueue(async () => {
      await this.ensureRenderer();
      const info = frameInfo(this.plan, idx);
      if (!info.seg) {
        const e = new Error(`frame ${idx} is not covered by any segment`);
        e.status = 404;
        throw e;
      }
      const key = `${info.seg.id}:${info.localFrame}:${variant}:${quality}`;
      const hit = this._cache.get(key);
      if (hit) {
        this._cache.delete(key);
        this._cache.set(key, hit);          // LRU touch
        return { ...hit, t: info.t, seg: info.seg.id, timecode: info.timecode };
      }
      const entry = await this._pageFor(info.seg);
      const started = Date.now();
      if (process.env.CVS_FRAMES_DEBUG) this.log(`[render] n=${idx} seg=${info.seg.id} local=${info.localFrame} t=${info.t.toFixed(4)} start`);
      let res;
      try {
        res = await this._capture(entry, info.t, variant, quality);
      } catch (e) {
        if (e && e.recyclePage) {
          for (const [id, e2] of [...this.pages.entries()]) {
            if (e2 === entry) {
              this.pages.delete(id);
              Promise.resolve(entry.page.close()).catch(() => {});
              break;
            }
          }
        }
        throw e;
      }
      this.renders++;
      if (process.env.CVS_FRAMES_DEBUG) this.log(`[render] n=${idx} done ${Date.now() - started}ms ${res.buf.length}B`);
      if (this.cacheSize > 0) {
        this._cache.set(key, res);
        while (this._cache.size > this.cacheSize) {
          const oldest = this._cache.keys().next().value;
          this._cache.delete(oldest);
        }
      }
      return { ...res, t: info.t, seg: info.seg.id, timecode: info.timecode, renderMs: Date.now() - started };
    });
  }

  async close() {
    for (const [, entry] of this.pages) {
      try { await entry.page.close(); } catch { /* ignore */ }
    }
    this.pages.clear();
    if (this._release) this._release();
    if (this._runner) { try { await this._runner; } catch { /* ignore */ } }
  }

  meta() {
    const segs = this.segments.map((s) => ({
      id: s.id, kind: s.kind, label: s.label,
      startFrame: s.startFrame, endFrame: s.endFrame, frames: s.frames,
      start: s.start, end: s.end,
      // 直播式预览（iframe 实时渲染）需要自己拼页面 URL：
      // 与 render-segment.mjs 的 withSegmentParams 同参数。
      page: s.page, duration: s.duration, t0: s.t0, speed: s.speed,
    }));
    return {
      kind: 'spec', plan: this.planPath, spec: this.specPath,
      width: this.width, height: this.height,
      fps: this.fps, frames: this.frames, duration: this.duration,
      ready: this.frames, decoded: this.frames, done: true,
      error: this.error ? String(this.error.message || this.error) : null,
      segments: segs, rendered: this.renders, cachedFrames: this._cache.size,
      theme: this.plan?.meta?.theme || null,
      name: this.plan?.meta?.name || null,
    };
  }
}

// ── 图片序列源 ──────────────────────────────────────────────────────────────

/**
 * 图片帧源：目录里的图片一张一帧。若目录里有 image-manifest.json，
 * 按清单顺序；否则按文件名自然排序。
 */
export class ImageSource {
  constructor({ dir, root, fps = 1 }) {
    this.kind = 'images';
    this.dir = path.resolve(String(dir));
    this.root = path.resolve(String(root));
    this.fps = Number(fps) > 0 ? Number(fps) : 1;
    this.files = [];
  }

  async open() {
    if (!exists(this.dir)) throw new Error('images dir not found: ' + this.dir);
    const st = fs.statSync(this.dir);
    if (!st.isDirectory()) {
      this.files = [this.dir];
    } else {
      let listed = null;
      const manifestPath = path.join(this.dir, 'image-manifest.json');
      if (exists(manifestPath)) {
        try {
          const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          listed = (man.images || [])
            .map((img) => (img && img.file ? path.resolve(this.root, img.file) : null))
            .filter((p) => p && exists(p));
        } catch { listed = null; }
      }
      if (listed && listed.length) {
        this.files = listed;
      } else {
        this.files = fs.readdirSync(this.dir)
          .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
          .sort(naturalCompare)
          .map((f) => path.join(this.dir, f));
      }
    }
    if (!this.files.length) throw new Error('no image frames in ' + this.dir);
    this.frames = this.files.length;
    this.duration = this.frames / this.fps;
    const first = imageSize(fs.readFileSync(this.files[0]));
    this.width = first ? first.width : 0;
    this.height = first ? first.height : 0;
    return this;
  }

  async getFrame(n) {
    const idx = Math.round(Number(n));
    if (!Number.isFinite(idx) || idx < 0 || idx >= this.frames) {
      const e = new Error(`frame ${n} out of range 0..${this.frames - 1}`);
      e.status = 400;
      throw e;
    }
    const file = this.files[idx];
    const ext = path.extname(file).toLowerCase();
    const type = ext === '.png' ? 'image/png'
      : ext === '.webp' ? 'image/webp'
        : ext === '.gif' ? 'image/gif'
          : ext === '.bmp' ? 'image/bmp'
            : ext === '.avif' ? 'image/avif' : 'image/jpeg';
    return { buf: fs.readFileSync(file), type, file: path.relative(this.root, file).split(path.sep).join('/') };
  }

  async close() { /* 无资源 */ }

  meta() {
    return {
      kind: 'images', dir: this.dir,
      width: this.width, height: this.height,
      fps: this.fps, frames: this.frames, duration: this.duration,
      ready: this.frames, decoded: this.frames, done: true,
      error: null, segments: [],
      names: this.files.map((f) => path.basename(f)),
    };
  }
}

// ── 构造入口 ────────────────────────────────────────────────────────────────

export async function openSource({ kind = null, root = process.cwd(), plan = null, spec = null, video = null, dir = null, fps = null, maxWidth = 1280, quality = null, refresh = false, cacheRoot = null, width = null, height = null, log = null } = {}) {
  const type = kind || (video ? 'video' : dir ? 'images' : (plan || spec) ? 'spec' : null);
  if (type === 'video') return new VideoSource({ file: video, root, maxWidth, quality: quality == null ? 3 : quality, refresh, fps, cacheRoot }).open();
  if (type === 'images') return new ImageSource({ dir, root, fps: fps || 1 }).open();
  if (type === 'spec') return new SpecSource({ root, planPath: plan, specPath: spec, width, height, quality: quality == null ? 88 : quality, log }).open();
  throw new Error('no frame source: pass --video, --plan/--spec, or --dir');
}

/** 默认缓存目录（视频解码帧）。 */
export function defaultCacheRoot(root) {
  return path.join(path.resolve(root), 'out', 'frames-cache');
}

/** 供测试用：临时目录。 */
export function tmpCacheRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-frames-'));
}
