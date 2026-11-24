/**
 * lib/score-core.mjs — 主观质量评分核（R24-W，evals 思想）。
 *
 * OpenFilm 用「evals」记录真实请求在有/无 skill 下的实测对比。我们的对应物：
 * 把成片的**可复核信号**聚合成一个主观分——不替人判断，但让「这条片好不好」
 * 从感觉变成证据清单。每维 0..1，加权合成 total；各维附证据数字。
 */
/** 运动密度：每帧平均像素位移（灰度差均值）。过低=死片，过高=噪点片。 */
export function motionDensity(pixels, w = 96, h = 96) {
  const fb = w * h;
  const n = Math.floor((pixels?.length || 0) / fb);
  if (n < 2) return { value: null, note: 'too few frames' };
  let sum = 0, cnt = 0;
  for (let f = 1; f < n; f++) {
    for (let i = 0; i < fb; i++) {
      sum += Math.abs(pixels[f * fb + i] - pixels[(f - 1) * fb + i]);
      cnt++;
    }
  }
  return { value: +((sum / cnt) / 255).toFixed(3), note: `${n} frames @ ${w}×${h}` };
}

/** 色彩活力：逐帧主色方差均值——色板单调=低分，色域丰富=高分。 */
export function chromaSpread(clusters) {
  if (!clusters?.length) return { value: null, note: 'no palette' };
  // 以 c（彩度极径）+ l 跨度近似感知丰富度
  const cs = clusters.map((c) => Number(c.c || 0));
  const ls = clusters.map((c) => Number(c.l ?? 0.5));
  const meanC = cs.reduce((a, b) => a + b, 0) / cs.length;
  const varL = ls.reduce((a, x) => a + (x - ls.reduce((y, z) => y + z, 0) / ls.length) ** 2, 0) / ls.length;
  return { value: +Math.min(1, (meanC * 2 + Math.sqrt(varL)) / 1.4).toFixed(3), note: `${clusters.length} clusters` };
}

/** 节奏感：有切点的片按切点间隔均匀度计分；单段长片按闪白节律计。 */
export function pacingScore(cuts, durationSec, flashCount = 0) {
  if (cuts && cuts.length >= 3) {
    const gaps = [];
    for (let i = 1; i < cuts.length; i++) gaps.push(Math.max(0.01, cuts[i] - cuts[i - 1]));
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const cv = Math.sqrt(gaps.reduce((a, g) => a + ((g - mean) ** 2), 0) / gaps.length) / mean;
    // 变异系数 ≤0.35 视为卡点稳定（实测量纲：高卡点片约 0.2–0.35）
    return { value: +Math.max(0, Math.min(1, 1 - cv / 0.7)).toFixed(3), note: `cv=${cv.toFixed(2)} over ${gaps.length} intervals` };
  }
  if (flashCount >= 6 && durationSec >= 8) {
    return { value: 0.8, note: `${flashCount} flashes, no scene cuts detectable` };
  }
  return { value: 0.25, note: 'no rhythm evidence (single segment, no cuts)' };
}

/** 音画同步：cue 对齐率（qa-audio 同口径，直接吃它的 JSON）。 */
export function cueSyncScore(qaAudioJson) {
  try {
    const j = typeof qaAudioJson === 'string' ? (qaAudioJson.trim() || 'null') ? JSON.parse(qaAudioJson) : null : qaAudioJson;
    const cues = j.cues || [];
    if (!cues.length) return { value: null, note: 'no cues' };
    const ok = cues.filter((c) => c.pass !== false).length;
    return { value: ok / cues.length, note: `${ok}/${cues.length} within tolerance` };
  } catch { return { value: null, note: 'qa-audio json unreadable' }; }
}

/** 总分：五维加权（节奏与同步权重最高——主观观感的决定项）。缺维按 0.5 中性代入。 */
export function overallScore({ motion, chroma, pacing, sync, title }) {
  const v = (x) => (x == null || x.value == null ? 0.5 : x.value);
  const total = 0.2 * v(motion) + 0.15 * v(chroma) + 0.3 * v(pacing) + 0.25 * v(sync) + 0.1 * v(title);
  const grade = total >= 0.75 ? 'A' : total >= 0.55 ? 'B' : total >= 0.4 ? 'C' : 'D';
  return { total: +total.toFixed(3), grade, parts: { motion: v(motion), chroma: v(chroma), pacing: v(pacing), sync: v(sync), title: v(title) } };
}