// common.js — shared drawing/runtime helpers for the code-rendered video pipeline.
// Plain ES module, no dependencies. Copy next to your segment HTML (or serve /tools/common.js).
//
// Contract:
//   const seg = createSegment({ duration: 3 });
//   window.DURATION = seg.duration;
//   window.renderFrame = (u) => { const { t, fx } = seg.sample(u); ... };
//
// Segment mode URL params (set by the renderer):
//   ?seg=1&t0=0.35&speed=1.4&dur=3
//   -> local clip time u in [0,dur] maps to scene time t = t0 + u*speed
//
// Deterministic only: never call Date.now(), performance.now(), Math.random().

export const TAU = Math.PI * 2;

export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (v - a) / (b - a);
export const smoothstep = (a, b, v) => {
  const t = clamp(invLerp(a, b, v));
  return t * t * (3 - 2 * t);
};
export const mapRange = (v, a, b, c, d) => lerp(c, d, clamp(invLerp(a, b, v)));

// ---------- easing ----------
// v2.3：唯一缓动来源是 templates/motion.js。
// 之前 common.js 自己抄了一份，motion.js 又抄了一份，recipes/util.js 还是第三份。
// motion.js 的 ease 与本文件原实现逐点数值相同（已用 77 个采样点比对过），
// 所以改成 re-export 是零像素变化，但从此只有一处真值。
import { ease as motionEase } from './motion.js';
import { MOTION_PROFILES, motionParams, motionLevelFromQuery } from './motion-profile.mjs';

export const ease = motionEase;

// 内部快捷引用（行为与原来完全一致）
const _outQuad = motionEase.outQuad;
const _outCubic = motionEase.outCubic;

/**
 * 当前生效的动效档位参数（v2.3）。
 *
 * 优先级：显式传入 > URL 的 ?mp= > 'standard'。
 * 未指定时返回 standard 档，其所有乘数都是 1 → 与 v2.2 逐像素一致。
 */
export function motionProfile(level) {
  if (level != null && MOTION_PROFILES[level]) return motionParams(level);
  const fromUrl = typeof location !== 'undefined' ? motionLevelFromQuery(location.search) : 'standard';
  return motionParams(fromUrl);
}

// ---------- seeded randomness (replaces Math.random everywhere) ----------
export function mulberry32(seed = 1) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rng(seed = 1) {
  const next = mulberry32(seed);
  return {
    next,
    range: (a, b) => a + (b - a) * next(),
    int: (a, b) => Math.floor(a + (b - a + 1) * next()),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    sign: () => (next() < 0.5 ? -1 : 1),
    gauss: () => {
      const u = Math.max(1e-9, next()), v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
    },
  };
}

export function hash01(n, seed = 0) {
  let h = Math.imul((n | 0) ^ 0x9E3779B9, 0x85EBCA6B) ^ Math.imul(seed | 0, 0xC2B2AE35);
  h ^= h >>> 13; h = Math.imul(h, 0x27D4EB2F); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ---------- value noise / fbm ----------
const fract = (x) => x - Math.floor(x);

export function noise1(x, seed = 0) {
  const i = Math.floor(x), f = x - i;
  const a = hash01(i, seed), b = hash01(i + 1, seed);
  const s = f * f * (3 - 2 * f);
  return lerp(a, b, s) * 2 - 1;
}

export function noise2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const h = (i, j) => hash01(i * 73856093 ^ j * 19349663, seed);
  const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
  const n00 = h(xi, yi), n10 = h(xi + 1, yi), n01 = h(xi, yi + 1), n11 = h(xi + 1, yi + 1);
  return (lerp(lerp(n00, n10, sx), lerp(n01, n11, sx), sy)) * 2 - 1;
}

export function fbm1(x, octaves = 4, seed = 0, lac = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise1(x * freq, seed + o * 17);
    norm += amp; amp *= gain; freq *= lac;
  }
  return sum / norm;
}

export function fbm2(x, y, octaves = 4, seed = 0, lac = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise2(x * freq, y * freq, seed + o * 17);
    norm += amp; amp *= gain; freq *= lac;
  }
  return sum / norm;
}

// ---------- beat helpers ----------
export const beat = (t, bpm = 120) => t * (bpm / 60);            // absolute beat position
export const beatPhase = (t, bpm = 120) => fract(beat(t, bpm));   // 0..1 within beat
export const beatIndex = (t, bpm = 120) => Math.floor(beat(t, bpm));
export function pulse(t, bpm = 120, decay = 6) {
  const ph = beatPhase(t, bpm);
  return Math.exp(-ph * decay);
}

// ---------- segment mode ----------
export function parseSegment(search = (typeof location !== 'undefined' ? location.search : '')) {
  const p = new URLSearchParams(search);
  const enabled = p.get('seg') === '1';
  const num = (k, d) => {
    const v = parseFloat(p.get(k));
    return Number.isFinite(v) ? v : d;
  };
  return {
    enabled,
    t0: num('t0', 0),
    speed: num('speed', 1),
    duration: num('dur', 3),
  };
}

/**
 * createSegment({duration=3, bpm=120, motion})
 *  - reads ?seg&t0&speed&dur and ?mp=<motion level>（v2.3）
 *  - sample(u) -> { u, t, fx }
 *  - fx: { flash, scale, shakeX, shakeY, push } (multiply scale*push for drawing)
 * Impact overlay (u in [0,0.4]):
 *    white flash 0.85 -> 0 over 0.12 s
 *    scale 1.13 -> 1 over 0.32 s (outCubic)
 *    shake 14 px decaying over 0.16 s
 *    then slow push 1 -> 1.05 across the clip
 *
 * v2.3：档位（motion profile）只作为**乘数**作用。standard 档的所有乘数是 1，
 * 所以不传 ?mp= 时输出与 v2.2 逐像素一致（D11）。
 */
export function createSegment(options = {}) {
  const params = parseSegment();
  const duration = params.enabled ? params.duration : (options.duration ?? 3);
  const t0 = params.enabled ? params.t0 : (options.t0 ?? 0);
  const speed = params.enabled ? params.speed : (options.speed ?? 1);
  const profile = motionProfile(options.motion ?? options.mp);

  function sample(u) {
    u = clamp(u, 0, duration);
    const impactDur = 0.4;
    const flash = u < 0.12 ? 0.85 * profile.flash * (1 - _outQuad(clamp(u / 0.12))) : 0;
    // 写成与 v2.2 原式同构的形式（1.13 - 0.13 * k * impact），
    // 而不是 (1 + 0.13*impact) - ... —— 后者会产生最后一位的浮点差，
    // 在 1× 缩放下也可能落到不同的亚像素上（D11：standard 必须逐位一致）。
    const scale = 1.13 - 0.13 * profile.impact * _outCubic(clamp(u / 0.32));
    const amp = u < 0.16 ? 14 * profile.shake * (1 - u / 0.16) : 0;
    const shakeX = amp * Math.sin(u * 220 + 1.7);
    const shakeY = amp * Math.cos(u * 170 + 0.4);
    const after = Math.max(0.0001, duration - impactDur);
    const push = 1 + 0.05 * profile.push * clamp((u - impactDur) / after);
    // __ev 打点（S1-3）：段采样激活。数值路径与 v4.12 完全一致，仅旁路记一笔。
    if (__REC) fxEvent('sample', { u, flash: flash > 0.001, shake: amp > 0 });
    return { u, t: t0 + u * speed, fx: { flash, scale, shakeX, shakeY, push } };
  }
  return { duration, t0, speed, enabled: params.enabled, profile, sample };
}

// ── v4.13 S1-3（G7-1）：页面契约 __textsAt / __ev —— 纯旁路记录器 ─────────────
// 契约（QA/可读性闸/未来 taste 帧级规则消费）：
//   window.__textsAt(t) → [{id,text,x0,y0,x1,y1,size,userY,fill,alpha,font,kind,t}]
//     在 t（= window.renderFrame 的入参口径）重跑一帧，记录该帧每一次
//     fillText/strokeText 的**变换后包围盒**（device 像素，含 impact/applyImpact2D
//     的全局变换）。两次同 t 调用结果必须一致——renderFrame 本就是 f(t)。
//   window.__ev → [{t, ev:[{fx,detail}]}] 效果事件流（impact/flash/采样激活点），
//     本刀只产数据不进判决（taste 帧级 6 条未来消费）。
//   window.__evAt(t) → 该帧事件数组。
// 零像素影响纪律：CanvasRenderingContext2D 原型钩子**只在 __textsAt/__evAt 调用
// 栈内挂载/摘除**；正常渲染路径（渲染器只调 renderFrame）根本不换原型。
// 记录器全程 try/catch——它坏了只丢数据，绝不能带崩一帧。
let __REC = null;

/**
 * G7 校准层标记：HUD/顶栏/倒计时/角章这类**版面 chrome**（品牌名、计数器、时间码、
 * STYLE NN/16 标签）不是「要读的正文」。qa-text 的 dwell/overlap/band 只量正文层，
 * coverage/placeholder 仍全量看。零像素影响：不换任何绘制逻辑，只在录制栈里贴标签。
 */
export function withLayer(name, fn) {
  if (!__REC) return fn();
  const prev = __REC.layer;
  __REC.layer = name;
  try { return fn(); } finally { __REC.layer = prev; }
}

function __fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

function __fontSizeOf(fontStr) {
  const m = /([0-9]*\.?[0-9]+)\s*(px|pt|em|rem|%)/.exec(String(fontStr || ''));
  if (!m) return 16;
  const v = parseFloat(m[1]);
  const unit = m[2];
  const px = unit === 'pt' ? v * (96 / 72) : (unit === 'em' || unit === 'rem') ? v * 16 : unit === '%' ? v * 0.16 : v;
  return Number.isFinite(px) && px > 0 ? px : 16;
}

function __pushRecord(rec, ctx, text, kind, box) {
  // box = {left, top, right, bottom} 在 ctx 当前用户空间；变换到 device 空间。
  let { left, top, right, bottom } = box;
  if (typeof ctx.getTransform === 'function') {
    const tr = ctx.getTransform();
    const corners = [[left, top], [right, top], [left, bottom], [right, bottom]]
      .map(([px, py]) => ({ x: tr.a * px + tr.c * py + tr.e, y: tr.b * px + tr.d * py + tr.f }));
    left = Math.min(...corners.map((c) => c.x)); right = Math.max(...corners.map((c) => c.x));
    top = Math.min(...corners.map((c) => c.y)); bottom = Math.max(...corners.map((c) => c.y));
  }
  const size = Number(box.size) || __fontSizeOf(ctx.font);
  const uy = Number.isFinite(box.userY) ? box.userY : (top + bottom) / 2;
  rec.texts.push({
    id: `${__fnv1a(text)}@r${Math.round(uy / 48)}`,
    text, kind, t: rec.t, layer: rec.layer || 'content',
    x0: +left.toFixed(1), y0: +top.toFixed(1), x1: +right.toFixed(1), y1: +bottom.toFixed(1),
    size: +size.toFixed(1), userY: uy,
    fill: typeof ctx.fillStyle === 'string' ? ctx.fillStyle : (box.color || ''),
    alpha: +Number(ctx.globalAlpha == null ? 1 : ctx.globalAlpha).toFixed(3),
    font: String(ctx.font || (size ? `${size}px` : '')),
  });
}

function __recordText(ctx, kind, rawText, x, y) {
  const rec = __REC;
  if (!rec) return;
  try {
    const text = String(rawText);
    if (!text) return;
    const m = ctx.measureText(text);
    const size = __fontSizeOf(ctx.font);
    const ascent = Number.isFinite(m.fontBoundingBoxAscent) && m.fontBoundingBoxAscent > 0 ? m.fontBoundingBoxAscent : size * 0.92;
    const descent = Number.isFinite(m.fontBoundingBoxDescent) ? Math.max(m.fontBoundingBoxDescent, size * 0.05) : size * 0.2;
    const h = ascent + descent;
    const w = m.width;
    const align = ctx.textAlign || 'start';
    let left = x;
    if (align === 'center') left = x - w / 2;
    else if (align === 'right' || align === 'end') left = x - w;
    let top;
    switch (ctx.textBaseline || 'alphabetic') {
      case 'top': case 'hanging': top = y; break;
      case 'middle': top = y - h / 2; break;
      case 'bottom': case 'ideographic': top = y - h; break;
      default: top = y - ascent;
    }
    __pushRecord(rec, ctx, text, kind, { left, top, right: left + w, bottom: top + h, size, userY: y });
  } catch { /* 记录器永不打断绘制 */ }
}

/**
 * 缓存文字层的 drawImage 补记（S1-3，big-card 预渲染文字层专用，任何按约定挂
 * `canvas.__textInfo = {text,x,y,align,size}` 的页面通用）：录制帧内
 * drawImage(层, dx, dy[, dw, dh]) 时，把层内文字框按缩放搬到目标空间再过当前
 * 变换记入 texts——离屏缓存文案不再对像素文本层失明。
 */
function __recordImageText(ctx, img, args) {
  const rec = __REC;
  if (!rec) return;
  try {
    // 兼容两种约定：单条 `canvas.__textInfo` 与多条 `canvas.__textInfos = []`
    // （glitch 的 BASE 同时缓存标题+副题，单槽不够）。
    const list = img && (Array.isArray(img.__textInfos) ? img.__textInfos
      : (img.__textInfo ? [img.__textInfo] : null));
    if (!list) return;
    const iw = Number(img.width) || 1;
    const ih = Number(img.height) || 1;
    let dx = 0, dy = 0, dw = iw, dh = ih;
    if (args.length >= 6) { dx = Number(args[1]) || 0; dy = Number(args[2]) || 0; dw = Number(args[3]) || iw; dh = Number(args[4]) || ih; }
    else if (args.length >= 3) { dx = Number(args[1]) || 0; dy = Number(args[2]) || 0; }
    const sx = dw / iw, sy = dh / ih;
    for (const ti of list) {
      if (!ti || !ti.text) continue;
      const size = Number(ti.size) || 16;
      const h = size * 1.12;
      const w = Number(ti.w) || size * String(ti.text).length;
      const align = ti.align || 'center';
      let left = Number(ti.x) || 0;
      if (align === 'center') left -= w / 2; else if (align === 'right') left -= w;
      const top = (Number(ti.y) || 0) - h / 2;
      __pushRecord(rec, ctx, String(ti.text), 'layer', {
        left: dx + left * sx, top: dy + top * sy, right: dx + (left + w) * sx, bottom: dy + (top + h) * sy,
        size, userY: dy + ti.y * sy, color: ti.color || '',
      });
    }
  } catch { /* 同上：永不打断绘制 */ }
}

/**
 * 安装页面契约（幂等；非浏览器环境 no-op）。common.js 被 import 即装——
 * 用 createSegment/renderFrame 的页面无需改代码。big-card.html 自绘循环同理：
 * 契约只包裹 window.renderFrame 的一次调用，与预览 RAF 无交集。
 */
export function installPageContract(win = typeof window !== 'undefined' ? window : null) {
  if (!win || typeof win.CanvasRenderingContext2D !== 'function') return false;
  if (typeof win.__textsAt === 'function') return true;
  if (!Array.isArray(win.__ev)) win.__ev = [];
  const run = (t) => {
    const proto = win.CanvasRenderingContext2D.prototype;
    const origFill = proto.fillText;
    const origStroke = proto.strokeText;
    const origDraw = proto.drawImage;
    const rec = { t: Number(t) || 0, texts: [], events: [] };
    proto.fillText = function (text, x, y) { __recordText(this, 'fill', text, x, y); return origFill.apply(this, arguments); };
    proto.strokeText = function (text, x, y) { __recordText(this, 'stroke', text, x, y); return origStroke.apply(this, arguments); };
    proto.drawImage = function (img, ...rest) {
      __recordImageText(this, img, [img, ...rest]);
      return origDraw.apply(this, arguments);
    };
    __REC = rec;
    try {
      if (typeof win.renderFrame === 'function') win.renderFrame(t);
    } finally {
      proto.fillText = origFill;
      proto.strokeText = origStroke;
      proto.drawImage = origDraw;
      __REC = null;
      win.__ev.push({ t: rec.t, ev: rec.events.slice() });
    }
    return rec;
  };
  win.__textsAt = (t) => run(t).texts.slice();
  win.__evAt = (t) => run(t).events.slice();
  return true;
}

/** 效果打点（__ev 数据源）。非记录帧 = 单次 null 判断，零开销零行为变化。 */
export function fxEvent(name, detail) {
  if (!__REC) return;
  __REC.events.push({ fx: name, t: __REC.t, ...(detail === undefined ? {} : { detail }) });
}

installPageContract();

// Apply impact transform to a 2D context (assumes W/H = design size).
export function applyImpact2D(ctx, fx, W = 1920, H = 1080) {
  const s = fx.scale * fx.push;
  ctx.translate(W / 2 + fx.shakeX, H / 2 + fx.shakeY);
  ctx.scale(s, s);
  ctx.translate(-W / 2, -H / 2);
  if (__REC) fxEvent('impact', { s: +s.toFixed(4), shakeX: fx.shakeX, shakeY: fx.shakeY });
}

// White flash overlay; call after restore.
export function drawFlash(ctx, alpha, W = 1920, H = 1080, color = '#ffffff') {
  if (alpha <= 0.001) return;
  if (__REC) fxEvent('flash', { alpha: +alpha.toFixed(3) });
  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

// ---------- standard segment chrome ----------
function _drawCapsuleLabel(ctx, index, name, category = '', opts = {}) {
  const {
    x = 96, y = 72, h = 58, padX = 26, font = '600 26px "Noto Sans SC", sans-serif',
    numberColor = '#d97757', textColor = '#f5f0e8',
    bg = 'rgba(12,12,12,0.72)', border = 'rgba(255,255,255,0.18)',
  } = opts;
  ctx.save();
  ctx.font = font;
  // R2-06（N02-F1）：显式左对齐。本函数按左原点坐标 fillText（x+padX），
  // 但从不设 textAlign——场景代码（segment.html 的居中大标题）把 ctx.textAlign
  // 留成 'center'/'right'，胶囊文字就继承它向左侧溢出药丸框，浅色主题下整条
  // 不可读。全主题全帧中招。save/restore 已有，只缺这一行。
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const num = String(index).padStart(2, '0');
  const label = category ? `${name} · ${category}` : name;
  const wNum = ctx.measureText(num).width;
  const wLabel = ctx.measureText(label).width;
  const w = padX * 2 + wNum + 14 + wLabel;
  const r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = bg; ctx.fill();
  ctx.lineWidth = 1.5; ctx.strokeStyle = border; ctx.stroke();
  ctx.fillStyle = numberColor; ctx.fillText(num, x + padX, y + h / 2 + 1);
  ctx.fillStyle = textColor; ctx.fillText(label, x + padX + wNum + 14, y + h / 2 + 1);
  ctx.restore();
}

/** G7 校准：胶囊 eyebrow（品牌·分类 + 计数器）属版面 chrome。 */
export function drawCapsuleLabel(...args) { return withLayer('chrome', () => _drawCapsuleLabel(...args)); }

export function drawCountdown(ctx, u, duration, opts = {}) {
  return withLayer('chrome', () => {
  const { x = 1824, y = 1016, size = 34, color = 'rgba(245,240,232,0.72)', font = 'JetBrains Mono, monospace' } = opts;
  const remain = Math.max(0, Math.ceil(duration - u - 0.001));
  const text = `00:0${Math.min(9, remain)}`;
  ctx.save();
  ctx.font = `${size}px ${font}`;
  ctx.fillStyle = color;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, x, y);
  ctx.restore();
  });
}

export function drawStamp(ctx, text, opts = {}) {
  return withLayer('chrome', () => {
  const { x = 1824, y = 72, size = 20, align = 'right', color = 'rgba(245,240,232,0.42)', font = 'JetBrains Mono, monospace' } = opts;
  ctx.save();
  ctx.font = `${size}px ${font}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
  ctx.restore();
  });
}

// Cached vertical/radial gradient helper (avoid rebuilding gradients every frame).
const _gradCache = new WeakMap();
export function cachedGradient(ctx, key, build) {
  const canvas = ctx.canvas;
  let map = _gradCache.get(canvas);
  if (!map) { map = new Map(); _gradCache.set(canvas, map); }
  let g = map.get(key);
  if (!g) { g = build(ctx); map.set(key, g); }
  return g;
}

// Typical safe-area helpers
export const SAFE = { left: 96, right: 96, top: 72, bottom: 72 };
export const DESIGN = { W: 1920, H: 1080 };

// Wait for fonts; returns when all requested families are ready.
export async function loadFonts(families, sample = 'ABCDEFG abcdefg 0123456789 中文测试') {
  if (typeof document === 'undefined' || !document.fonts) return;
  for (const family of families) {
    for (const weight of ['400', '500', '600', '700', '900']) {
      try { await document.fonts.load(`${weight} 64px "${family}"`, sample); } catch (e) { /* variable fonts may reject */ }
    }
  }
  await document.fonts.ready;
}

// ── v2: re-export the motion/colour toolkit so pages need one import ───────
// motion.js and color.js are side-effect-free; re-exporting keeps existing
// segment pages unchanged while new ones can use spring(), layoutCJK(), etc.
export {
  spring, springs, springSettle, rateFunc, stagger, track, transitionParams,
  activeItem, quantize, splitGraphemes, layoutCJK, fitText, drawKineticText,
  drawGrain, drawPaperTexture, drawScanlines, drawRGBSplit, drawBloom, drawHalation,
  accentRamp,
} from './motion.js';
export {
  parseColor, toOklch, toHex, toRgba, formatOklch, gamut, clampChroma,
  withLightness, mixOklch, shade, ramp, readableInk, relativeLuminance,
  contrastRatio, apcaLc, apcaAbs, apcaLevel, derivePalette, themeTokensToOklch,
  oklchCssVars, auditApca,
} from './color.js';

/**
 * Read renderer-provided variables. render-segment.mjs injects window.__vars
 * (and a base64url ?vars= fallback for pages opened manually).
 *   window.__vars = { brand: 'ACME', title: '...' }
 */
export function vars() {
  if (typeof window === 'undefined') return {};
  if (window.__vars && typeof window.__vars === 'object') return window.__vars;
  try {
    const p = new URLSearchParams(location.search).get('vars');
    if (!p) return {};
    const b64 = p.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(escape(atob(b64)));
    window.__vars = JSON.parse(json);
    return window.__vars;
  } catch { return {}; }
}
