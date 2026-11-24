/**
 * ref-video-core.mjs — 参考片反推的纯函数核心（Node 侧，确定性）。
 *
 * 输入：一支参考片 ffprobe 元数据 + 场景切点 + 逐秒采样的 sRGB 像素
 *      （由 CLI 用 ffmpeg 抽取后传入）+ 可选的 tempo 测量（BPM）。
 * 输出：结构模型、节拍、色板/主题匹配、可直接 patch 的 spec 结构草案。
 *
 * 「反推」是启发式的：结构上不追求像素级还原，而是把典型卡点宣传片的模板
 * （opening → [card+style]*N → more → flash 簇 → ending）拟合到实测切点上，
 * 并把残差如实写进 notes/confidence——绝不假装精确。
 */
import { analyzePixels } from '../ref-core.mjs';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 结构推断（纯函数，可单测）。 */
export function inferStructure({ duration, cuts = [], bpm = null } = {}) {
  const notes = [];
  const cutsSorted = [...cuts].filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b);
  const hasAudioTempo = typeof bpm === 'number' && bpm > 0;
  if (!Number.isFinite(duration) || duration <= 0) return { ok: false, notes: ['invalid duration'] };

  // opening：首切点前的一段（宣传片惯例 6–12s 的建立镜头）。
  const firstCut = cutsSorted.length ? cutsSorted[0] : 0;
  let opening = clamp(Math.round(firstCut), 4, 12);

  // ending：末切点之后收束。
  const lastCut = cutsSorted.length ? cutsSorted[cutsSorted.length - 1] : duration;
  let ending = clamp(Math.round(duration - lastCut), 4, 10);

  const middleStart = opening;
  const middleEnd = Math.max(middleStart + 1, duration - ending);
  const middleDur = Math.max(1, middleEnd - middleStart);

  // 中间段的每一切片间隔：短 = 大字卡槽，长 = 风格段槽。
  const gaps = [];
  for (let i = 0; i < cutsSorted.length - 1; i++) {
    if (cutsSorted[i] < middleEnd && cutsSorted[i + 1] > middleStart) {
      gaps.push(clamp(cutsSorted[i + 1] - cutsSorted[i], 0.05, 20));
    }
  }
  const median = (xs) => {
    if (!xs.length) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    const m = s[Math.floor(s.length / 2)];
    return s.length % 2 ? m : (s[s.length - 1] + m) / 2;
  };
  const cardGaps = gaps.filter((g) => g < 1.5);
  const styleGaps = gaps.filter((g) => g >= 1.5);
  let card = clamp(Number(median(cardGaps).toFixed(2)), 1, 2);
  let roundRaw = (cardGaps.length ? Number(median(cardGaps).toFixed(2)) : 1.5) +
                 (styleGaps.length ? Number(median(styleGaps).toFixed(2)) : 3);
  let round = clamp(Number(roundRaw.toFixed(2)), 3, 8);

  // 轮数：按中段时长整除，结果回填 round 保证结构公式闭合。
  const rounds = clamp(Math.max(1, Math.round(middleDur / round)), 1, 12);
  round = Number((middleDur / rounds).toFixed(2));
  if (card > round * 0.55) card = Number((round * 0.35).toFixed(2));   // card 必须明显小于一轮

  // flash 簇：连续 ≥3 个极短切点的组（快闪特征）；无则用模板默认并注明。
  const shortRun = [];
  let flashCount = 0;
  for (let i = 1; i < cutsSorted.length - 1; i++) {
    const gPrev = cutsSorted[i] - cutsSorted[i - 1];
    const gNext = cutsSorted[i + 1] - cutsSorted[i];
    if (gPrev < 0.6 && gNext < 0.6) shortRun.push(i);
    if (shortRun.length && shortRun[shortRun.length - 1] !== i &&
        gNext >= 0.6) {
      if (shortRun.length >= 2) flashCount++;
      shortRun.length = 0;
    }
  }
  if (shortRun.length >= 2) flashCount++;
  if (!flashCount) {
    flashCount = 4;
    notes.push('未检出闪段切点簇；flash 沿用模板默认 4 次（需人工复核）');
  } else {
    notes.push(`检出 ${flashCount} 处快闪簇（连续 <0.6s 切点）`);
  }
  flashCount = clamp(Math.min(flashCount, 16), 0, 16);

  // each：BPM 在场时一拍（60/bpm，与 timeline-core.resolveFlashEach 同口径，
  // 让任意 BPM 下闪段天然落拍，R2-25 的硬约束）。
  const each = hasAudioTempo ? Number((60 / bpm).toFixed(2)) : null;

  // moreCard：中段末尾 1.5s 内的短切点视为「更多」卡（可选）。
  const moreCard = 1;

  // 退化护栏：无卡点信号（单一切点/全是长镜头）时模板默认兜底，绝不产 NaN
  // 结构值落进 spec（NaN 进 JSON 即静默毁片）。
  if (!Number.isFinite(card) || card < 1) { card = 1; notes.push('未检出大字卡切点；card 沿用默认 1s'); }
  if (!Number.isFinite(round) || round < 3 || round > 8) {
    round = Number((card + 3).toFixed(2));
    notes.push('风格段切点不足或过密；round 按 card+3 兜底');
  }
  if (!Number.isFinite(rounds) || rounds < 1) {
    rounds = clamp(Math.max(1, Math.round(middleDur / Math.max(3, round))), 1, 12);
    notes.push('按中段时长反填轮数=' + rounds);
  }

  const model = {
    totalDuration: Number(duration.toFixed(2)),
    opening, rounds, round, card, moreCard,
    ending, flash: { count: flashCount, each },
    cuts: cutsSorted.map((t) => Number(t.toFixed(3))),
  };
  // 结构公式实算 vs 片长残差（如实报，不静默）。
  const flashTotal = flashCount * (each || 0.5);
  const computed = opening + rounds * round + moreCard + flashTotal + ending;
  const residual = Number((duration - computed).toFixed(2));
  model.residualVsSource = residual;
  if (Math.abs(residual) > 1.5) {
    notes.push(`结构拟合残差 ${residual}s（opening=${opening} round=${round}×${rounds} flash=${flashCount}×${each ?? 0.5}）；建议人工校 structure`);
  }
  if (!hasAudioTempo) notes.push('无可信 BPM；flash.each 未按拍派生');

  // 置信度：三分量加权（如实混合，不虚高）。
  const gapCV = (() => {
    if (!styleGaps.length) return 1;
    const mean = styleGaps.reduce((a, b) => a + b, 0) / styleGaps.length;
    const varr = styleGaps.reduce((a, b) => a + (b - mean) ** 2, 0) / styleGaps.length;
    return mean ? clamp(Math.sqrt(varr) / mean, 0, 3) : 3;
  })();
  const regularityScore = clamp(1 - gapCV / 3, 0, 1);            // 切点越规律越高
  const coverage = clamp(rounds / 12, 0, 1);
  const confidence = Number((0.45 * regularityScore + 0.3 * coverage + 0.25 * (hasAudioTempo ? 1 : 0)).toFixed(2));
  model.confidence = confidence;
  model.notes = notes;
  model.ok = true;
  return model;
}

/** 报告组装（纯函数）：视觉分析结果 + 结构 + BPM → 规范 JSON 报告。 */
export function buildReport({ source, probe, clusters, structure, tempo, appliedTheme }) {
  const visual = appliedTheme;
  return {
    ok: true,
    engine: 'ref-video/1',
    source,
    probe: {
      duration: Number((probe?.duration || 0).toFixed(3)),
      fps: probe?.fps ?? null,
      width: probe?.width ?? null,
      height: probe?.height ?? null,
      hasAudio: !!probe?.hasAudio,
    },
    structure,
    tempo,
    visual: {
      theme: visual?.theme ?? null,
      palette: visual?.palette ?? [],
      metrics: visual?.metrics ?? {},
      hints: visual?.hints ?? {},
    },
    specPatch: {
      look: {
        theme: visual?.theme?.id ?? null,
        ...(visual?.theme?.accentOverride ? { accentOverride: visual.theme.accentOverride } : {}),
      },
      audio: tempo?.bpm ? { bpm: tempo.bpm } : {},
      structure: {
        opening: structure.opening,
        round: Number(structure.round.toFixed(2)),
        card: Number(structure.card.toFixed(2)),
        moreCard: structure.moreCard,
        ending: structure.ending,
        ...(structure.flash.each != null ? { flash: { count: structure.flash.count, each: structure.flash.each } } : { flash: { count: structure.flash.count } }),
      },
    },
  };
}