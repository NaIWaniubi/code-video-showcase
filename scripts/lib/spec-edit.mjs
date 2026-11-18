/**
 * spec-edit.mjs — agent 向的结构剪辑操作核（R15，纯函数，可单测）。
 *
 * 设计取舍（对齐行业共识而非本地实现）：
 *   - OpenTimelineIO：时间线是数据，任何工具都能读写——本核的每次输出仍是
 *     **闭合结构的 spec**，下游 compile/lint 照旧可用；
 *   - auto-editor / Kdenlive 的「裁剪 / 拆分 / 丢弃 / 换序」四件套语义；
 *   - 段序与 timeline-core 严格同构（opening → 轮×N → more → flash → ending）；
 *   - D 公式不变式：D = opening + N×round + moreCard + flash.count×each + ending，
 *     所有操作走 reflow() 重分配；预算做两位小数运算，余数吸收进 opening，
 *     短片骨架（几秒的 fixture/参考反推片）不因整数秒地板而散架。
 */
import { resolveFlashEach } from '../../templates/timeline-core.mjs';

const r2 = (x) => Math.round(x * 100) / 100;

/** 结构费的精确求和（与 specDuration 同口径，含拍派生 each）。 */
export function structureSum(spec) {
  const st = spec.structure || {};
  const n = Array.isArray(spec.rounds) ? spec.rounds.length : Number(st.rounds || 0);
  const flash = Number(st.flash?.count ?? 0) * resolveFlashEach(spec);
  return Number(st.opening ?? 0) + n * Number(st.round ?? 0) +
    Number(st.moreCard ?? 0) + flash + Number(st.ending ?? 0);
}

/** 每轮卡时长：短轮按 40% 保底且留足风格段（正长），长轮沿用 floor(r/3) 上限 1s。
 *  旧公式 min(1, max(1, floor(r/3))) 对 r<3 全塌成 1，卡片比轮还长。 */
function cardOf(round) {
  if (!(round > 0)) return 0;
  if (round >= 3) return Math.min(1, Math.floor(round / 3));
  return Math.min(round * 0.4, round - 0.05);
}

/** 把 N 轮、总长 durSec 的结构重分配（flash/moreCard 从 spec 取真值）。
 *  durSec 可选，缺省用 structureSum(spec)。全程两位小数，终值精确闭合：
 *  opening + rounds×round + moreCard = budget，budget + flashes = durSec。 */
export function reflow(spec, nTarget, durSec) {
  const st = spec.structure || {};
  const dur = Number.isFinite(durSec) ? Math.max(0.6, r2(durSec)) : structureSum(spec);
  let n = Math.max(1, Math.min(12, Math.round(Number(nTarget) || 1)));
  const flashTotal = r2(Number(st.flash?.count ?? 0) * resolveFlashEach(spec));
  const more = r2(Number(st.moreCard ?? 0));
  const budget = r2(Math.max(0.3, dur - flashTotal - more));

  // 连每轮 0.3s + 起止各 0.2s 都装不下时才收缩轮数（短片骨架保住轮数优先挤比例）。
  while (n > 1 && budget < 0.3 * n + 0.4) n--;

  let opening = Math.max(0.2, r2(budget * 2 / 9));
  let ending = Math.max(0.2, r2(budget * 2 / 9));
  let round = Math.max(0.3, r2((budget * 5 / 9) / n));
  // 从最可压缩项逐格找平，直至三项之和恰好 ≤ budget。
  while (opening + ending + round * n > budget) {
    if (round > 0.3 + 1e-9) round = r2(round - 0.01);
    else if (opening > 0.2 + 1e-9) opening = r2(opening - 0.01);
    else ending = r2(ending - 0.01);
  }
  // 余数吸收进 opening——D 恒等于目标总长（lint 的 E_DURATION 由此闭死）。
  opening = r2(opening + (budget - (opening + ending + round * n)));
  return { opening, ending, rounds: n, round, card: cardOf(round), moreCard: more };
}

/** 在 t 秒处把所在轮一分为二（a/b 复制语义——同页渲染两次，无冲突）。 */
export function splitAtSeconds(spec, t) {
  const st = spec.structure || {};
  const rounds = spec.rounds || [];
  const n = rounds.length;
  if (!n) throw new Error('split: spec 没有任何轮');
  const opening = Number(st.opening ?? 0);
  const perRound = Number(st.round ?? 0);
  if (!(perRound > 0)) throw new Error('split: structure.round 未定义');
  if (!(t >= opening && t < opening + n * perRound)) {
    throw new Error(`split: 时刻 ${t}s 不在轮区间（${opening}s–${opening + n * perRound}s）内`);
  }
  const idx = Math.min(n - 1, Math.max(0, Math.floor((t - opening) / perRound)));
  const base = rounds[idx];
  const clone = (r, suffix) => JSON.parse(JSON.stringify(r));
  const a = clone(base); a.id = `${base.id}a`;
  const b = clone(base); b.id = `${base.id}b`;
  if (a.copy?.title != null) a.copy.title += '·A';
  if (b.copy?.title != null) b.copy.title += '·B';
  const next = [...rounds.slice(0, idx), a, b, ...rounds.slice(idx + 1)];
  return applyStructure({ ...spec, rounds: next }, reflow(spec, n + 1));
}

/** 丢弃指定轮（按 id）。 */
export function dropRound(spec, roundId) {
  const rounds = (spec.rounds || []).filter((r) => String(r.id) !== String(roundId));
  if (rounds.length === (spec.rounds || []).length) {
    throw new Error(`drop: 找不到轮 ${roundId}`);
  }
  if (rounds.length < 1) throw new Error('drop: 不能把轮删光（至少保留一轮）');
  return applyStructure({ ...spec, rounds }, reflow(spec, rounds.length));
}

/** 把某轮移到目标位置（1-based）。 */
export function moveRound(spec, fromId, toPos) {
  const rounds = [...(spec.rounds || [])];
  const fromIdx = rounds.findIndex((r) => String(r.id) === String(fromId));
  if (fromIdx < 0) throw new Error(`move: 找不到轮 ${fromId}`);
  const [item] = rounds.splice(fromIdx, 1);
  const pos = Math.max(0, Math.min(rounds.length, Math.round(toPos) - 1));
  rounds.splice(pos, 0, item);
  return { ...spec, rounds };   // 换序不改 D，无需 reflow
}

/** 全片重拟合到目标时长（auto-editor 风格 trim-to-fit；轮数不变，只重排占比）。 */
export function trimToSeconds(spec, totalSec) {
  const n = (spec.rounds || []).length;
  if (!Number.isFinite(totalSec) || totalSec < 0.6) throw new Error(`trim: 目标时长 ${totalSec}s 过短（≥0.6s）`);
  return applyStructure(spec, reflow(spec, n, totalSec));
}

/** 把 spec 展开为时间线布局 [{start,end,id,kind,note}]（与 timeline-core 同构）。 */
export function layoutSeconds(spec) {
  const st = spec.structure || {};
  const fps = Number(spec.format?.fps || 30);
  const bpm = Number(spec.audio?.bpm) || 120;
  const flashEach = resolveFlashEach(spec);
  const card = Number(st.card ?? 0);
  const round = Number(st.round ?? 0);
  const styleDur = Math.max(0.01, round - card);
  const rows = [];
  let t = 0;
  const push = (id, kind, dur, note) => {
    if (!(dur > 0)) return;
    rows.push({ id, kind, start: t, end: t + dur, note });
    t += dur;
  };
  push('00-opening', 'opening', Number(st.opening ?? 0));
  for (let i = 0; i < (spec.rounds || []).length; i++) {
    const r = spec.rounds[i];
    push(`${r.id}-card`, 'card', card);
    push(`${r.id}-style`, 'style', styleDur);
    void r;
  }
  push('99-more', 'more', Number(st.moreCard ?? 0));
  const nFlash = Number(st.flash?.count ?? 0);
  for (let k = 0; k < nFlash; k++) push(`99-flash-${k + 1}`, 'flash', flashEach);
  push('99-ending', 'ending', Number(st.ending ?? 0));
  void fps; void bpm;
  return { rows, total: t };
}

/** 把结构字典写回 spec（format.duration 同步——编译链唯一真相）。 */
export function applyStructure(spec, r) {
  const flashTotal = r2(Number(spec.structure?.flash?.count ?? 0) *
    resolveFlashEach(spec));
  const duration = r2(r.opening + r.rounds * r.round + r.moreCard + flashTotal + r.ending);
  return {
    ...spec,
    format: {
      ...(spec.format || {}),
      duration,
    },
    structure: {
      ...(spec.structure || {}),
      opening: r.opening, rounds: r.rounds, round: r.round,
      card: r.card, moreCard: r.moreCard, ending: r.ending,
    },
  };
}