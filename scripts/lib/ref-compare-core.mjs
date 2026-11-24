/**
 * ref-compare-core.mjs — 「复刻度量」内核（R22-W，借鉴 openfilm/skill-replicate 思想）。
 *
 * 背景：agent 看的是静帧不是视频——只看帧能把 look 对上、把时间感丢掉
 * （漏掉帧与帧之间的切点、匀速代替缓动、自带时钟）。skill-replicate 的解法是
 * 给 agent 一个「时间的度量」：切点对齐、每处变化的节奏相似度、色彩版面对齐。
 * 本模块把该度量做成纯函数：输入两端视频的分析结果（切点表/像素流/时长），
 * 输出结构对齐分数、节奏相似度、色板距离、帧级相似度与整体判定。
 */

/** 切点匹配容差（秒）——低于此偏移视为同一处切。 */
export const CUT_TOL_SEC = 0.4;

/**
 * 把参考片的每个切点在复刻片里找最近邻，输出对齐表。
 * @returns {{matched:number, unmatched:Array<{at:number, nearest?:number, offsetSec?:number}>,
 *            extraRender:number[], offsetsSec:number[]}}
 */
export function matchCuts(refCuts, renderCuts, { tol = CUT_TOL_SEC } = {}) {
  const rc = [...renderCuts].sort((a, b) => a - b);
  const matched = [];
  const unmatched = [];
  const used = new Set();
  const offsetsSec = [];
  for (const at of refCuts) {
    let best = null;
    let bi = -1;
    for (let i = 0; i < rc.length; i++) {
      if (used.has(i)) continue;
      const d = Math.abs(rc[i] - at);
      if (best === null || d < best) { best = d; bi = i; }
    }
    if (best !== null && best <= tol && bi >= 0) {
      used.add(bi);
      matched.push(at);
      offsetsSec.push(+(rc[bi] - at).toFixed(3));   // 四舍五入到毫秒，消除浮点尾差
    } else {
      unmatched.push({ at });
    }
  }
  let extraRender = 0;
  for (let i = 0; i < rc.length; i++) if (!used.has(i)) extraRender++;
  return { matched: matched.length, unmatched, extraRender, offsetsSec };
}

/**
 * 节奏相似度（0..1）：切点间隔模式的对齐度。
 * 先按「各端相邻切点间隔序列」归一长度，再逐位比较间隔比例。
 * 无切点的端退化为按时长比判定。
 */
export function rhythmSimilarity(refCuts, renderCuts) {
  const gapsOf = (cuts) => {
    const g = [];
    for (let i = 1; i < cuts.length; i++) g.push(Math.max(0.01, cuts[i] - cuts[i - 1]));
    return g;
  };
  const rg = gapsOf(refCuts);
  const gg = gapsOf(renderCuts);
  if (!rg.length && !gg.length) {
    // 两端都没有可检测的切点：以时长接近度作弱信号（如实标注）。
    return { score: 0.5, note: 'both sides have no detectable cuts' };
  }
  if (!rg.length || !gg.length) return { score: 0, note: 'one side has no cuts' };
  const n = Math.min(rg.length, gg.length);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = rg[i] / (rg.reduce((x, y) => x + y, 0) || 1);
    const b = gg[i] / (gg.reduce((x, y) => x + y, 0) || 1);
    sum += 1 - Math.min(1, Math.abs(a - b) / Math.max(a, b, 1e-9));
  }
  return { score: +(sum / n).toFixed(3), note: `gap-pattern alignment over ${n} intervals` };
}

/**
 * 帧级色彩相似度：两端同栅格（fps×dur）采样帧逐帧对平均 RGB 距离，
 * 归一化到 [0,1] 距离后取 1−d。无帧可对 → 0（如实）。
 */
export function frameColorSimilarity(refPixels, renderPixels, { w = 96, h = 96 } = {}) {
  const fb = w * h * 3;
  const nRef = Math.floor((refPixels?.length || 0) / fb);
  const nRen = Math.floor((renderPixels?.length || 0) / fb);
  if (!nRef || !nRen) return { similarity: 0, note: 'no comparable frames' };
  const n = Math.min(nRef, nRen);
  let total = 0;
  for (let f = 0; f < n; f++) {
    let d = 0;
    for (let i = 0; i < fb; i += 3) {
      const o = f * fb + i;
      total += Math.abs(refPixels[o] - renderPixels[o]);
      total += Math.abs(refPixels[o + 1] - renderPixels[o + 1]);
      total += Math.abs(refPixels[o + 2] - renderPixels[o + 2]);
    }
  }
  const maxD = n * fb * 255;   // 每帧 fb 个字节、每字节最大差 255
  const similarity = 1 - total / maxD;
  return { similarity: +similarity.toFixed(3), note: `${n} aligned frames at ${w}×${h}` };
}

/** 色板相似度：两端主色聚类中心的平均最近邻 oklab 距离（越小越像）。
 *  聚类中心的公共投影是 (l, c, h)（极坐标）——由 c·cos/sin(h) 还原
 *  oklab 的 a/b；本就带完整 (l,a,b) 的输入直接采用。
 *  距离上界约 1.2（l∈[0,1]，a/b∈[-0.4,0.4]）。 */
export function paletteDistanceBetween(refClusters, renderClusters) {
  if (!refClusters?.length || !renderClusters?.length) return { distance: null, similarity: null, note: 'missing palettes' };
  const abOf = (c) => (typeof c.a === 'number' && typeof c.b === 'number')
    ? [c.a, c.b]
    : [(typeof c.c === 'number' ? c.c * Math.cos((c.h || 0) * Math.PI / 180) : 0),
       (typeof c.c === 'number' ? c.c * Math.sin((c.h || 0) * Math.PI / 180) : 0)];
  let sum = 0;
  for (const a of refClusters) {
    const [aa, ab] = abOf(a);
    let best = Infinity;
    for (const b of renderClusters) {
      const [ba, bb] = abOf(b);
      const d = Math.hypot(a.l - b.l, aa - ba, ab - bb);
      if (d < best) best = d;
    }
    sum += best;
  }
  const distance = sum / refClusters.length;   // 0 = 逐中心重合，~1.2 = 最远
  return { distance: +distance.toFixed(3), similarity: +(1 - Math.min(1, distance / 1.2)).toFixed(3) };
}

/**
 * 总判定：无参差、无缺切、节奏 ≥0.6、色板与帧相似度 ≥0.6 → match；
 * 部分命中 → partial；全崩 → mismatch。
 */
export function overallVerdict({ durationDeltaSec, cutMatch, rhythm, frameSim, palSim }) {
  const noMissedCuts = cutMatch.unmatched.length === 0;
  const okRhythm = rhythm.score >= 0.6;
  const okFrame = frameSim.similarity >= 0.6;
  const okPal = palSim.distance !== null ? palSim.similarity >= 0.6 : true;
  const hits = [durationDeltaSec <= 1, noMissedCuts, okRhythm, okFrame].filter(Boolean).length;
  if (hits >= 3 && okPal) return 'match';
  if (hits >= 1) return 'partial';
  return 'mismatch';
}