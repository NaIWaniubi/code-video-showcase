/**
 * generative.mjs — 程序化生成画面引擎（R4「断层领先」· 生成式视觉）。
 *
 * 与 effects.mjs 同构：命名目录 + 纯函数核 + 浏览器画布包装。
 * 与「生成模型」的区别（README「No generative models」铁律）：这里一切画面都是
 * (t, seed, 显式参数) 的确定性纯函数——种子化流场、粒子闭式解、环形动力学、
 * 动力学排版。没有扩散/神经网络，没有逐帧积分，同一 t 必出同一像素。
 *
 * 设计参考（取向，非引入依赖）：
 *   - Remotion @remotion/noise（噪声采样器）与 overlay 系统——噪声+合成层分层；
 *   - procedural 社区惯例：curl noise 流场（Open Shadertoy 风格）做确定性 swarm；
 *   - Paper.js / D3-force 的动力学排版被改成**周期解**（弹道/简谐），可重放；
 *   - Tympanic/Steve Rhodes 的色彩科学由 color.js 的 OKLCH 桥承担。
 *
 * 铁律（照抄 effects.mjs）：
 *   - 禁 Math.random / Date.now / performance.now / rAF；
 *   - 粒子用种子哈希闭式求解（flow field 每粒子一条位级轨迹）；
 *   - 纯核不碰 DOM，Node 单测可直接验证确定性；画布包装仅在浏览器里跑。
 */
import { clamp, lerp } from './motion.js';
import { TAU, smoothstep, mapRange } from './common.js';

/* ────────────────────────── 确定性哈希 / 噪声 ─────────────────────────────── */
// 32 位整数哈希（与 recipes/util.js、effects.mjs 逐位一致，独立一份防循环依赖）。

export function hash01(n, seed = 0) {
  let h = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(seed | 0, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** curl-ish 二维流场速度（伪 Curl Noise，闭式，不积分）。 */
function flowAt(x, y, t, seed) {
  const s = t * 0.15;
  const px = Math.sin(x * 0.0035 + y * 0.0025 + s) + 0.6 * Math.sin(y * 0.0041 - x * 0.0033 + s * 1.7);
  const py = Math.cos(x * 0.0043 - y * 0.0027 + s * 1.31) + 0.6 * Math.cos(y * 0.0031 + x * 0.0049 - s * 0.93);
  const m = Math.hypot(px, py) || 1;
  return [px / m, py / m];
}

/**
 * 流场 swarm（纯核）：N 个粒子在第 t 帧的位置与相位。
 * 位级闭式：先随机播种 (r0,θ0,speed)，再沿流场做**有限积分步数**（k 步、步长 dt），
 * k 由 t 驱动但固定上限 → 同一 t 永远同一位置（O(N) 且可并行）。
 */
export function swarmField({ count = 120, t = 0, seed = 7, W = 1920, H = 1080,
                            steps = 8, dt = 0.22, size = 6 } = {}) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    const r0 = hash01(i, seed ^ 0x51ed);
    const th0 = hash01(i, seed ^ 0x7a21);
    const sp = 0.55 + hash01(i, seed ^ 0x3c4d) * 1.6;              // 个体速度方差
    let x = 0.08 * W + r0 * 0.84 * W;
    let y = 0.12 * H + th0 * 0.76 * H;
    const rot = 0.4 + 0.9 * hash01(i, seed ^ 0x11);               // 初始角度
    let px = Math.cos(rot), py = Math.sin(rot);
    const nSteps = steps;                                          // 固定步数：确定性
    for (let s2 = 0; s2 < nSteps; s2++) {
      const [fx, fy] = flowAt(x, y, t, seed);
      px = px * 0.72 + fx * 0.28;
      py = py * 0.72 + fy * 0.28;
      x += px * sp * dt * (30 + size);
      y += py * sp * dt * (30 + size);
    }
    const alpha = 0.25 + 0.75 * hash01(i, seed ^ 0x99);
    pts.push({ x, y, size: size * (0.6 + 0.8 * hash01(i, seed ^ 0x33)),
               alpha, hue: 0.45 + 0.5 * hash01(i, seed ^ 0x77) });
  }
  return pts;
}

/* ───────────────────────── 环形动力学系统 ─────────────────────────────────── */

/** 轨道环系：多个同心环，每环 phase 独立的角速度（纯核）。 */
export function orbitSystem({ t = 0, seed = 3, rings = 5, cx = 0.5, cy = 0.5,
                              speedScale = 1.4, radiusJitter = 0.22 } = {}) {
  return Array.from({ length: rings }, (_, i) => {
    const base = 0.08 + 0.07 * i;
    const om = (0.22 + 0.17 * hash01(i, seed)) * speedScale;
    const rr = base * (1 + radiusJitter * (hash01(i, seed ^ 1) - 0.5));
    const n = 3 + Math.floor(4 * hash01(i, seed ^ 2));
    return {
      phase: hash01(i, seed ^ 3) * TAU,
      radius: rr,
      omega: om,
      dots: Array.from({ length: n }, (_, d) => ({
        phi: (i * 137.508 + d * (360 / n) * (0.85 + 0.3 * hash01(d, seed ^ 4))) * Math.PI / 180,
        size: 0.55 + 0.75 * hash01(d, seed ^ 5),
        blink: hash01(d, seed ^ 6),
      })),
    };
  }).map((ring) => ({ ...ring, x0: cx, y0: cy }));
}

/** 脉冲波：从中心向外传播的半径相位（同心冲击波，判圈感）。 */
export function pulseRings({ t = 0, speed = 320, rings = 6, width = 260 } = {}) {
  return Array.from({ length: rings }, (_, i) => {
    const r = ((t * speed + i * width) % (rings * width));
    const k = r / (rings * width);                                // 0..1 传播进度
    return { radius: r, life: k, alpha: Math.pow(1 - k, 1.5) * 0.85 };
  }).filter((r) => r.life > 0.02);
}

/* ──────────────────── 动力学排版（Paper/D3 的周期化解） ─────────────────── */

/**
 * 弹跳字（Wes Dooley 风格）：每个字符一条简谐弹道，落拍反弹。
 * 返回 char 布局，纯函数；落盘字号由调用方算。
 */
export function bounceChars({ text = '', t = 0, bpm = 120, fontSize = 96, W = 1920 } = {}) {
  const out = [];
  const beatDur = 60 / bpm;
  const idx = Math.floor(t / beatDur);
  const frac = (t / beatDur) - idx;                                // 本拍内相位 0..1
  for (let i = 0; i < text.length; i++) {
    const w = Math.max(0.06, (fontSize * 0.62) / W + 0.02);       // 每字占宽比
    const startX = 0.04 + i * (0.92 / Math.max(1, text.length));
    const offset = 1.4 * Math.abs(Math.sin(Math.PI * (0.5 + 0.5 * frac + 0.5 * hash01(i, 3))));
    const rot = Math.sin(TAU * frac + hash01(i, 9)) * 0.14;
    out.push({ ch: text[i], x: startX, y: 0.66 + offset * 0.0002, dy: offset, rot, i, beat: idx });
  }
  void beatDur;
  return out;
}

/**
 * 标签云式流动行（字幕/卡片标题）：整行在正弦航迹上漂浮 + 字距呼吸。
 */
export function flowLineChars({ text = '', t = 0, seed = 11 } = {}) {
  return Array.from({ length: text.length }, (_, i) => {
    const u = i / Math.max(1, text.length - 1);
    const sway = Math.sin(TAU * (u * 1.5 - t * 0.18) + seed) * 0.03;
    return { ch: text[i], u, sway, gap: 1 + 0.16 * Math.sin(TAU * (u * 2 - t * 0.3) + seed + i) };
  });
}

/* ───────────────────── 流场 swarming canvas 包装 ─────────────────────────── */

export function drawSwarm(ctx, opts = {}) {
  if (typeof document === 'undefined') return;
  const { W = ctx.canvas.width, H = ctx.canvas.height, t = 0, seed = 7, color = '#ffffff' } = opts;
  const pts = swarmField({ t, seed, W, H, steps: opts.steps ?? 8 });
  ctx.save();
  for (const p of pts) {
    ctx.globalAlpha = p.alpha * 0.9;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

export function drawOrbits(ctx, opts = {}) {
  if (typeof document === 'undefined') return;
  const { W = ctx.canvas.width, H = ctx.canvas.height, t = 0, seed = 3,
          accent = '#ffcf5c', dim = '#666666' } = opts;
  const rings = orbitSystem({ t, seed, cx: W * 0.5, cy: H * 0.5, radiusJitter: 0.24 });
  ctx.save();
  for (const ring of rings) {
    ctx.strokeStyle = dim;
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = 0.28;
    ctx.beginPath();
    ctx.ellipse(ring.x0 * W, ring.y0 * H, ring.radius * Math.min(W, H),
                ring.radius * Math.min(W, H) * 0.42, ring.phase * 0.35, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.92;
    for (const d of ring.dots) {
      const a = d.phi + ring.phase + t * ring.omega;
      const ex = ring.x0 * W + Math.cos(a) * ring.radius * Math.min(W, H);
      const ey = ring.y0 * H + Math.sin(a) * ring.radius * Math.min(W, H) * 0.42;
      ctx.beginPath();
      ctx.arc(ex, ey, Math.max(2.4, 5.5 * d.size), 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}

export function drawPulseRings(ctx, opts = {}) {
  if (typeof document === 'undefined') return;
  const { W = ctx.canvas.width, H = ctx.canvas.height, t = 0, color = '#ffcf5c' } = opts;
  const cx = W * 0.5, cy = H * 0.5;
  ctx.save();
  for (const r of pulseRings({ t })) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = r.alpha;
    ctx.lineWidth = 3 * (1 - r.life * 0.6);
    ctx.beginPath();
    ctx.arc(cx, cy, r.radius * Math.min(W, H) * 0.001, 0, TAU);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawBounceText(ctx, opts = {}) {
  if (typeof document === 'undefined') return;
  const { text = 'TITRE', t = 0, bpm = 120, fontSize = 96, W = ctx.canvas.width,
          color = '#ffffff', originY = 0.66 } = opts;
  const chars = bounceChars({ text, t, bpm, fontSize, W });
  ctx.save();
  ctx.font = `${fontSize}px "Noto Sans SC", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  for (const c of chars) {
    const x = c.x * W;
    const y = originY * ctx.canvas.height - c.dy * fontSize * 0.9;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(c.rot);
    ctx.fillText(c.ch, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

/* ──────────────────────── 目录 + 自检 ───────────────────────────────────── */

export const GENERATIVE = [
  { id: 'swarm', label: '流场群游', desc: 'curl-noise 流场上的确定性粒子群',
    params: ['count', 'steps', 'seed'] },
  { id: 'orbits', label: '轨道环系', desc: '多层椭圆轨道 + 相位独立',
    params: ['rings', 'radiusJitter'] },
  { id: 'pulse-rings', label: '脉冲波', desc: '向外传播的同心冲击环',
    params: ['speed', 'width'] },
  { id: 'bounce-text', label: '弹跳字', desc: '逐字简谐弹道，落拍反弹',
    params: ['bpm', 'fontSize'] },
];

/** Node 自检：纯核对同 t 双跑恒等（确定性契约的机器证明）。 */
export function generativeProbe() {
  const assert = (a, b, l) => { if (a !== b) throw new Error(`${l}: ${a} != ${b}`); };
  assert(swarmField({ t: 1.7, seed: 5, count: 40 })[7].x, swarmField({ t: 1.7, seed: 5, count: 40 })[7].x, 'swarm');
  assert(orbitSystem({ t: 2.2, seed: 4 })[2].dots[0].size, orbitSystem({ t: 2.2, seed: 4 })[2].dots[0].size, 'orbits');
  assert(pulseRings({ t: 0.5 }).length, pulseRings({ t: 0.5 }).length, 'pulse');
  assert(bounceChars({ text: 'abcdefg', t: 1.25, bpm: 120 })[3].dy,
         bounceChars({ text: 'abcdefg', t: 1.25, bpm: 120 })[3].dy, 'bounce');
  return { ok: true, modules: GENERATIVE.length };
}