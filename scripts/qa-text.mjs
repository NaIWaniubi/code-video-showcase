#!/usr/bin/env node
/**
 * qa-text.mjs — QA 像素文本闸 + 可读性闸（S1-3/S1-4/余项③，ROADMAP-GAPS G7-2/G7-3）。
 *
 *   node scripts/qa-text.mjs --plan out/<name>/plan.json [--json qa/qa-text.json] [--strict]
 *
 * 为什么存在（病根）：v2.9.0 / v4.10.1 两次「全绿但画面是内建标题」——QA 验的是
 * plan/URL 字符串层，页面把参数丢了照样绿。本闸把断言下沉到**像素文本层**：
 * 按 plan 逐段打开页面（与渲染器同 URL 参数面），在每个抽样帧调页面契约
 * `window.__textsAt(t)`，拿真实 fillText/strokeText 的变换后包围盒来判决。
 *
 * 检查项（name → 语义）：
 *   text contract        页面是否暴露 __textsAt（缺 = 该段无法验证，WARN/FAIL）
 *   pixel text coverage  spec.copy.title/sub/cta + 每段 URL 的 title/sub/first/
 *                        keyword 全量必须至少上屏一次（缺 → FAIL）
 *   placeholder text     内建兜底占位词（'想做'/'结构图示'/'播放量竞速'…）不得
 *                        出现在画面上——除非 spec 文案本来就这么写（FAIL）
 *   text dwell           长文案（>8 码点、正文级字号）停留 ≥ max(1.8s, 语速估计
 *                        +0.6s)；同 id 文本按行聚合相邻帧成区间；flash 段豁免
 *                        （G4-1 ≤8 码点短词同理豁免）——WARN（--strict 拦）
 *   text overlap         同帧两条正文级文本包围盒大面积相交（>30% 小盒面积且
 *                        >400px²；同 id 描边+填充豁免）——FAIL
 *   subtitle band        正文级文本不得越入 safe() 字幕带（platform 字幕的领地，
 *                        交付链的 SRT/VTT 都落这里）；flash 不豁免——FAIL
 *
 * 判决数据之外的纪律：本闸只读页面契约输出，不改任何绘制路径；契约的像素零影响
 * 由 scripts/golden.mjs 单帧 sha 前后对比自证（见 test-readability 与 CHANGELOG）。
 *
 * 退出码：0 无 FAIL（非 strict 下 WARN 放行）；1 FAIL 或 strict+WARN；
 *         3 浏览器不可用——环境降级，绝不装成绿。
 * 零 npm 依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { safe as safeArea, typeSize } from '../templates/tokens.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ── 常量口径（进 errors.json 需求清单时同名，见报告）───────────────────────────
export const MIN_DWELL_SEC = 1.8;         // S1-4：绝对下限
export const SPEECH_MARGIN = 0.6;         // S1-4：语速余量
export const SHORT_TEXT_CODEPOINTS = 8;   // ≤8 码点 = 冲击短词，G4-1 口径，豁免停留
export const OVERLAP_RATIO = 0.30;        // 相交面积 / 小盒面积
export const OVERLAP_MIN_PX2 = 400;       // 交叠绝对下限（小字微碰不拦）
export const BAND_TOLERANCE = 12;         // 压带容差 px（抗 measureText 舍入）

// 内建兜底占位词表。来源=页面兜底常量与 fixture 兜底（逐条标注；新增兜底必须进表，
// 否则「页不吃参数」类缺陷在该页免疫）。
export const PLACEHOLDER_WORDS = [
  { word: '想做', source: 'templates/spec.mjs CARD_COPY_DEFAULT.first；big-card.html CARD.first；timeline-core card.first' },
  { word: '科普视频？', source: 'templates/big-card.html CARD.keyword' },
  { word: '结构图示', source: 'templates/recipe-blueprint.html ?title 兜底' },
  { word: '播放量竞速', source: 'templates/recipe-datarace.html ?title 兜底' },
];

// 段 URL 里承载「文案」的参数名——与 timeline-core 下发面一致（G4-5 双向对账的像素侧）。
export const COPY_PARAMS = ['title', 'sub', 'first', 'keyword', 'cta'];

// ── 纯文本度量 ────────────────────────────────────────────────────────────────
export const normText = (s) => String(s == null ? '' : s).replace(/[\s\u00a0\u3000]+/g, '');
const codePoints = (s) => [...String(s)].length;

/** 语速估计（秒）：CJK ≈4.5 字/秒，拉丁数字 ≈12 字符/秒，整段 +0.25s 起落。 */
export function estSpeechSeconds(text) {
  let cjk = 0, other = 0;
  for (const ch of String(text)) {
    if (/[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/.test(ch)) cjk++;
    else if (/[A-Za-z0-9]/.test(ch)) other++;
  }
  return cjk / 4.5 + other / 12 + (cjk || other ? 0.25 : 0);
}

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

export function intersectArea(a, b) {
  const w = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const hgt = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  return w * hgt;
}
const area = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);

/**
 * 同 (segId, id) 的相邻采样帧聚合成区间。
 * 两帧间隔 > step*gapFactor 视为断档；每段独立（跨段同 id 不相连）。
 * 区间 dwell = last - first + step（采样近似：至少盖住一步），末帧不越段尾。
 */
export function aggregateSpans(samples, { step, gapFactor = 1.5, segEnds = null } = {}) {
  const groups = new Map();
  for (const s of samples) {
    const key = `${s.segId}\u0000${s.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const spans = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => a.t - b.t);
    const [segId, id] = key.split('\u0000');
    let run = [list[0]];
    const flush = () => {
      const first = run[0].t, last = run[run.length - 1].t;
      let end = last + step;
      const cap = segEnds ? segEnds.get(segId) : null;
      if (Number.isFinite(cap)) end = Math.min(end, cap);
      spans.push({ segId, id, start: first, end, frames: run.length, dwell: Math.max(0, end - first) });
      run = [];
    };
    for (let i = 1; i < list.length; i++) {
      if (list[i].t - list[i - 1].t > step * gapFactor) flush();
      run.push(list[i]);
    }
    flush();
  }
  spans.sort((a, b) => a.start - b.start || a.segId.localeCompare(b.segId));
  return spans;
}

/** 从 plan 收集「必须上屏」的文案全集（spec.copy + 每段 URL 文案参数；去重）。 */
export function collectExpectedFromPlan(plan) {
  const out = [];
  const seen = new Set();
  const push = (value, origin) => {
    const v = String(value || '').trim();
    if (!v) return;
    const k = normText(v);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({ value: v, origin });
  };
  const copy = plan?.spec?.copy || {};
  push(copy.title, 'spec.copy.title');
  push(copy.sub, 'spec.copy.sub');
  push(copy.cta, 'spec.copy.cta');
  for (const s of plan?.segments || []) {
    const qs = String(s.page || '').split('?')[1] || '';
    let sp; try { sp = new URLSearchParams(qs); } catch { continue; }
    for (const key of COPY_PARAMS) push(sp.get(key), `${s.id} ?${key}`);
  }
  return out;
}

/**
 * 一帧记录 → 行级单位：同 userY 行桶内的文本按 x 排序串接。
 * 为什么：drawKineticText 逐码点 fillText（motion.js:310），只按单条 text 匹配
 * 会把「可读文案」判成四个 1 码点碎片——像素级覆盖率会瞎。行桶 + 串接把逐字
 * 文本还原回人眼读到的行。
 */
export function buildFrameUnits(texts, { rowH }) {
  const byRow = new Map();
  const seenId = new Set();
  for (const r of texts || []) {
    // 同 id = 同一文本的重复绘制（blur+sharp 缓存层、描边+填充对）——行内只计一次。
    if (r.id != null) { if (seenId.has(r.id)) continue; seenId.add(r.id); }
    const uy = Number.isFinite(r.userY) ? r.userY : (r.y0 + r.y1) / 2;
    const row = Math.round(uy / rowH);
    if (!byRow.has(row)) byRow.set(row, []);
    byRow.get(row).push(r);
  }
  const units = [];
  for (const [row, list] of byRow) {
    list.sort((a, b) => a.x0 - b.x0);
    const joined = list.map((r) => String(r.text || '')).join('');
    units.push({
      row,
      text: joined,
      norm: normText(joined),
      x0: Math.min(...list.map((r) => r.x0)),
      x1: Math.max(...list.map((r) => r.x1)),
      y0: Math.min(...list.map((r) => r.y0)),
      y1: Math.max(...list.map((r) => r.y1)),
      size: Math.max(...list.map((r) => Number(r.size) || 0)),
    });
  }
  return units;
}

// ── 判决（纯函数；浏览器只负责把 frames 采上来）────────────────────────────────
/**
 * @param plan    plan.json 对象（读 meta/spec/segments）
 * @param frames  [{segId, kind, t, texts:[{id,text,x0,y0,x1,y1,size,userY?}]}]
 * @param contract {pagesWithContract:number, pagesNaked:[string]}
 * @param opts    {step}
 */
export function analyzeFrames({ plan, frames, contract = { pagesWithContract: 0, pagesNaked: [] }, opts = {} }) {
  const checks = [];
  const W = Number(plan?.meta?.width) || 1920;
  const H = Number(plan?.meta?.height) || 1080;
  const step = Number(opts.step) || 0.25;
  const segById = new Map((plan?.segments || []).map((s) => [s.id, s]));
  const segEnds = new Map((plan?.segments || []).map((s) => [s.id, Number(s.end ?? ((s.start || 0) + (s.duration || 0)))]));
  const kindBySeg = new Map((plan?.segments || []).map((s) => [s.id, String(s.kind || 'style')]));
  // G7 校准（ship-demo 360p 实战）：HUD/顶栏/倒计时是版面 chrome，不量停留/重叠/字幕带；
  // coverage 与 placeholder 仍全量（chrome 也必须有据可查）。band 烧录感知：
  // 只有字幕真被烧进画面（--burn）时越带才是 FAIL，软字幕交付降 WARN 供人审。
  const isContent = (r) => r.layer !== 'chrome';
  const burn = !!opts.burn;

  const contentMinPx = typeSize('body', W, H);           // 正文级下限（HUD/caption 级不进闸）
  const rowH = Math.max(24, Math.round(Math.min(W, H) * 0.045));

  // 1) 契约在场性。顺序即语义：全裸（闸失明）> 部分裸（覆盖缺口）> 无段可采。
  const naked = contract.pagesNaked || [];
  if (naked.length && !contract.pagesWithContract) {
    checks.push({
      name: 'text contract',
      status: 'FAIL',
      detail: `全部采样页均未暴露 window.__textsAt（${[...new Set(naked)].join(', ')}）——像素文本层完全失明，本闸降级不可用`,
    });
  } else if (naked.length) {
    const total = naked.length + contract.pagesWithContract;
    checks.push({
      name: 'text contract',
      code: 'W_TEXTS_NO_CONTRACT',
      status: 'WARN',
      detail: `${naked.length}/${total} 个页面未暴露 window.__textsAt（无契约页：${[...new Set(naked)].join(', ')}）——像素文本层对其失明`,
    });
  } else if (!frames.length) {
    checks.push({ name: 'text contract', status: 'ADVISORY', detail: 'plan 无可采样段或页面全部不可达——像素文本闸空转' });
  } else {
    checks.push({ name: 'text contract', status: 'PASS', detail: `抽样页面 ${contract.pagesWithContract} 个全部暴露 __textsAt` });
  }

  // 2) 像素文本覆盖率（copy 全量上屏）
  const expected = collectExpectedFromPlan(plan);
  if (!expected.length) {
    checks.push({ name: 'pixel text coverage', status: 'ADVISORY', detail: 'plan 无 copy/title/sub 等期望文案——覆盖率无从断言（非缺陷）' });
  } else {
    // 候选串：单条 text + 行串接 + 整帧行串接（大小写/空白归一后子串判）
    const hay = [];
    for (const f of frames) {
      for (const r of f.texts || []) hay.push(normText(r.text));
      for (const u of buildFrameUnits(f.texts, { rowH })) hay.push(u.norm, normText(u.text));
      hay.push(normText((f.texts || []).map((r) => r.text).join('')));
    }
    const joinedHay = hay.join('\u0001');
    const missing = expected.filter((e) => !joinedHay.includes(normText(e.value)));
    checks.push({
      name: 'pixel text coverage',
      code: 'E_TEXTS_COPY_NOT_RENDERED',
      status: missing.length ? 'FAIL' : 'PASS',
      detail: missing.length
        ? `${missing.length}/${expected.length} 条 plan 文案从未上屏：${missing.map((m) => `"${m.value}"(${m.origin})`).join('；')}` +
          ` —— 「全绿但画面是内建标题」类（v2.9.0/v4.10.1 病根）`
        : `${expected.length} 条 spec/round 文案全部在抽样帧像素文本中出现`,
    });

    // 3) 占位兜底词（仅在期望文案存在时有意义；期望文案本就写了该词 → 视为作者意图）
    const covered = new Set(expected.map((e) => normText(e.value)));
    const hits = [];
    for (const f of frames) {
      for (const u of buildFrameUnits(f.texts, { rowH })) {
        for (const p of PLACEHOLDER_WORDS) {
          const nw = normText(p.word);
          if (!nw || covered.has(nw)) continue;
          if (u.norm === nw || u.norm.includes(nw)) hits.push({ word: p.word, seg: f.segId, t: f.t });
        }
      }
    }
    checks.push({
      name: 'placeholder text',
      code: 'E_TEXTS_PLACEHOLDER',
      status: hits.length ? 'FAIL' : 'PASS',
      detail: hits.length
        ? `画面出现内建兜底词：${hits.slice(0, 5).map((h) => `"${h.word}"@${h.seg}/${Number(h.t).toFixed(2)}s`).join('；')}` +
          ` —— 页面忽略了 plan 下发文案（sentinel 硬编码类，G7-2 FAIL 名单）`
        : `无占位兜底词上屏（表载 ${PLACEHOLDER_WORDS.length} 词，期望文案自带者豁免）`,
    });
  }

  // 4) 停留时长（行单位聚合；flash + 短词豁免）
  const dwellSamples = [];
  const rowTextById = new Map();
  for (const f of frames) {
    const units = buildFrameUnits((f.texts || []).filter(isContent), { rowH });   // chrome 不量停留
    for (const u of units) {
      if (!u.norm) continue;
      const id = `${fnv1a(u.norm)}@${f.segId}:r${u.row}`;
      dwellSamples.push({ segId: f.segId, id, t: f.t });
      if (!rowTextById.has(id)) rowTextById.set(id, { text: u.text, size: u.size });
    }
  }
  const spans = aggregateSpans(dwellSamples, { step, segEnds });
  const dwellViol = [];
  for (const sp of spans) {
    const meta = rowTextById.get(sp.id) || { text: sp.id, size: 0 };
    if (codePoints(meta.text) <= SHORT_TEXT_CODEPOINTS) continue;       // 冲击短词豁免
    if (Number(meta.size) < contentMinPx) continue;                     // HUD/caption 级不进停留口径
    if (kindBySeg.get(sp.segId) === 'flash') continue;                  // flash 段豁免（G4-1）
    const need = Math.max(MIN_DWELL_SEC, estSpeechSeconds(meta.text) + SPEECH_MARGIN);
    if (sp.dwell + 1e-6 < need) {
      dwellViol.push({ seg: sp.segId, text: [...meta.text].slice(0, 16).join(''), dwell: +sp.dwell.toFixed(2), need: +need.toFixed(2) });
    }
  }
  checks.push({
    name: 'text dwell',
    code: 'W_TEXTS_DWELL',
    status: dwellViol.length ? 'WARN' : 'PASS',
    detail: dwellViol.length
      ? `${dwellViol.length} 处长文案读不完（< max(${MIN_DWELL_SEC}s, 语速+${SPEECH_MARGIN}s)）：` +
        `${dwellViol.slice(0, 5).map((v) => `"${v.text}…" ${v.dwell}s<${v.need}s@${v.seg}`).join('；')}（flash/≤${SHORT_TEXT_CODEPOINTS}码点豁免）`
      : `正文级长文案停留全部 ≥ max(${MIN_DWELL_SEC}s, 语速+${SPEECH_MARGIN}s)（同 id 行聚合成区间；flash 豁免）`,
  });

  // 5) 同屏重叠（正文级**填充**两两相交；描边=轮廓/echo 不遮字，同 id 豁免）
  const overlapViol = [];
  for (const f of frames) {
    const content = (f.texts || []).filter((r) => r.layer !== 'chrome' && Number(r.size) >= contentMinPx && r.kind !== 'stroke');
    for (let i = 0; i < content.length; i++) {
      for (let j = i + 1; j < content.length; j++) {
        const a = content[i], b = content[j];
        if (a.id === b.id) continue;
        const inter = intersectArea(a, b);
        const minA = Math.min(area(a), area(b));
        if (minA > 0 && inter > OVERLAP_MIN_PX2 && inter > OVERLAP_RATIO * minA) {
          overlapViol.push({ seg: f.segId, t: +Number(f.t).toFixed(2), a: String(a.text).slice(0, 10), b: String(b.text).slice(0, 10), pct: Math.round((inter / minA) * 100) });
        }
      }
    }
  }
  checks.push({
    name: 'text overlap',
    code: 'E_TEXTS_OVERLAP',
    status: overlapViol.length ? 'FAIL' : 'PASS',
    detail: overlapViol.length
      ? `${overlapViol.length} 处正文文本硬重叠（>${Math.round(OVERLAP_RATIO * 100)}% 小盒面积且>${OVERLAP_MIN_PX2}px²）：` +
        `${overlapViol.slice(0, 5).map((v) => `${v.seg}@${v.t}s "${v.a}"×"${v.b}" ${v.pct}%`).join('；')}`
      : `抽样帧内正文级文本两两包围盒相交面积均 <${Math.round(OVERLAP_RATIO * 100)}% 小盒（同 id 描边/填充豁免）`,
  });

  // 6) 字幕带越界（safe().subtitle；flash 不豁免——带是平台字幕/交付 SRT 的领地）。
  // 判据取「入带深度」：bbox 底边超过带顶 ≥ BAND_TOLERANCE **且** ≥ 字高 1/4——
  // 巨型 echo 轮廓/描边底缘擦过带顶不算压带（存量 golden 实测 600px echo 入带 40px
  // = 字高 4.6%，属构图而非压字幕）。
  const band = safeArea(W, H).subtitle;
  const bandViol = [];
  for (const f of frames) {
    for (const r of (f.texts || []).filter(isContent)) {
      if (Number(r.size) < contentMinPx) continue;
      const y1 = Number(r.y1);
      const inside = y1 - band.y0;
      if (Number.isFinite(y1) && inside > BAND_TOLERANCE && inside >= 0.25 * (y1 - Number(r.y0))) {
        bandViol.push({ seg: f.segId, t: +Number(f.t).toFixed(2), text: String(r.text).slice(0, 12), y1: Math.round(y1), bandTop: band.y0 });
      }
    }
  }
  checks.push({
    name: 'subtitle band',
    code: 'E_TEXTS_BAND_INVASION',
    status: bandViol.length ? (burn ? 'FAIL' : 'WARN') : 'PASS',
    detail: bandViol.length
      ? `${bandViol.length} 处正文文本越入 safe() 字幕带（带顶 y=${band.y0}，交付 SRT/VTT 落位区）：` +
        `${bandViol.slice(0, 5).map((v) => `${v.seg}@${v.t}s "${v.text}" y1=${v.y1}`).join('；')}（flash 不豁免）`
      : `正文级文本均未越入字幕带（y≤${band.y0}+${BAND_TOLERANCE}；含 flash）`,
  });

  // 让未使用的 lint 目标安静（同时是防御：plan 段可能缺 start/end）
  void segById;
  return checks;
}

// ── 浏览器采样 ───────────────────────────────────────────────────────────────
export async function collectFrames({ root, width, height, plan, step = 0.25, maxSamples = 24, minSamples = 2, timeout = 60000, log = () => {} }) {
  const { withRenderer } = await import('../templates/render-segment.mjs');
  const frames = [];
  const samples = [];
  let pagesWithContract = 0;
  const pagesNaked = [];
  let evRecords = 0;

  const groups = new Map();
  for (const s of plan.segments || []) {
    const key = `${s.page}|${s.duration}|${s.t0 ?? 0}|${s.speed ?? 1}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  await withRenderer(
    { root, width, height, timeout, warmup: false, log, warn: log },
    async (ctx) => {
      for (const [, segs] of groups) {
        const s0 = segs[0];
        let page = null;
        try {
          page = await ctx.openPage({ page: s0.page, duration: s0.duration ?? 3, t0: s0.t0 ?? 0, speed: s0.speed ?? 1, vars: null, log });
          const has = await page.ev(() => typeof window.__textsAt === 'function');
          if (!has) {
            for (const s of segs) pagesNaked.push(String(s.page).split('?')[0]);
            continue;
          }
          pagesWithContract++;
          evRecords += await page.ev(() => (window.__ev && window.__ev.length) || 0);
          // 坐标空间归一（ship-demo 360p 实战抓出）：__textsAt 记录的是 **canvas 内部
          // 坐标**——segment.html 系画布==视口（因子 1，零影响），big-card.html 固定
          // 1920×1080 设计面由 ffmpeg 缩放到输出画幅。不折算就把 1080 系坐标拿去判
          // 640×360 的 safe() 字幕带/重叠 → 满屏假阳性（y1=1038 > 画高即铁证）。
          const csize = await page.ev(() => { const c = document.querySelector('canvas'); return c && c.width && c.height ? [c.width, c.height] : null; });
          const fx = csize ? width / csize[0] : 1;
          const fy = csize ? height / csize[1] : 1;
          const fs = Math.min(fx, fy);
          for (const s of segs) {
            const dur = Number(s.duration) || 3;
            const n = Math.max(minSamples, Math.min(maxSamples, Math.ceil(dur / step)));
            const eff = dur / n;
            for (let i = 0; i < n; i++) {
              const u = eff * (i + 0.5);
              try {
                const texts = await page.ev((tt) => {
                  try { return window.__textsAt(tt) || []; } catch (e) { return { __err: String(e && e.message || e) }; }
                }, u);
                if (texts && texts.__err) {
                  samples.push({ segId: s.id, kind: s.kind, t: u, ok: false, error: texts.__err });
                  continue;
                }
                // 一帧一条记录：texts 已是该次 renderFrame(u) 的完整文本清单；
                // 坐标/字号折算到视口空间（fx/fy 见上；同尺寸页恒 1，逐字节语义不变）。
                const slim = (texts || []).map((r) => ({
                  id: r.id, text: r.text, kind: r.kind || 'fill',
                  x0: Number(r.x0) * fx, y0: Number(r.y0) * fy, x1: Number(r.x1) * fx, y1: Number(r.y1) * fy,
                  size: Number(r.size) * fs, userY: r.userY != null ? Number(r.userY) * fy : undefined,
                }));
                if (slim.length) frames.push({ segId: s.id, kind: String(s.kind || 'style'), t: u, texts: slim });
                samples.push({ segId: s.id, kind: s.kind, t: u, ok: true, texts: slim });
              } catch (e) {
                samples.push({ segId: s.id, kind: s.kind, t: u, ok: false, error: String(e && e.message || e) });
              }
            }
          }
        } catch (e) {
          for (const s of segs) samples.push({ segId: s.id, kind: s.kind, t: null, ok: false, error: `open: ${String(e && e.message || e).slice(0, 160)}` });
        } finally {
          if (page) await page.close().catch(() => {});
        }
      }
    },
  );
  return { frames, samples, contract: { pagesWithContract, pagesNaked }, evRecords };
}

/** 契约单页探针（test-readability 的 B 组用；不判决，验契约形状与零污染）。 */
export async function probeContract({ root, width = 1920, height = 1080, page, t = 1.0, timeout = 60000 }) {
  const { withRenderer } = await import('../templates/render-segment.mjs');
  let out = null;
  await withRenderer({ root, width, height, timeout, warmup: false, log: () => {}, warn: () => {} }, async (ctx) => {
    const p = await ctx.openPage({ page, log: () => {} });
    try {
      out = await p.ev((tt) => {
        const has = typeof window.__textsAt === 'function';
        if (!has) return { hasTextsAt: false };
        const first = window.__textsAt(tt);
        const second = window.__textsAt(tt);
        const other = window.__textsAt(tt + 0.4);
        const proto = CanvasRenderingContext2D.prototype;
        const clean = /native code/.test(Function.prototype.toString.call(proto.fillText)) &&
          /native code/.test(Function.prototype.toString.call(proto.strokeText));
        const idsA = first.map((x) => x.id).sort().join('|');
        const idsB = other.map((x) => x.id).sort().join('|');
        const evAtShape = window.__evAt ? window.__evAt(tt) : null;
        return {
          hasTextsAt: true,
          first, second,
          stableId: idsA === idsB,
          prototypeClean: clean,
          ev: Array.isArray(window.__ev) ? window.__ev : [],
          evFrame: Array.isArray(evAtShape) && evAtShape.length > 0,
        };
      }, t);
    } finally {
      await p.close().catch(() => {});
    }
  });
  return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) a[k.slice(2)] = true;
    else { a[k.slice(2)] = next; i++; }
  }
  return a;
}

export async function runTextQa(planPath, opts = {}) {
  const args = { step: 0.25, maxSamples: 24, ...opts };
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const W = Number(plan.meta?.width) || 1920;
  const H = Number(plan.meta?.height) || 1080;
  const root = path.resolve(String(plan.meta?.root || ROOT));
  const { browserCandidates } = await import('../templates/cdp.mjs');
  // opts.noBrowser=true：环境降级路径的可测入口（等价于「本机无 Chrome」；测试与
  // CI 假环境用它断言 exit=3 语义，闸本体不许靠它绕过真实缺失）。
  const exe = args.noBrowser ? null : (process.env.CHROME_EXE || browserCandidates()[0]);
  if (!exe) {
    const report = {
      plan: planPath, checkedAt: new Date().toISOString(),
      checks: [{ name: 'browser', status: 'ADVISORY', detail: 'no Chrome/Edge found — 像素文本闸未运行（环境降级，不装绿）' }],
      summary: { pass: 0, warn: 0, advisory: 1, fail: 0 },
    };
    return { exit: 3, report };
  }
  const log = args.quiet ? () => {} : (l) => console.log(l);
  const burnOn = !!args.burn || String(args.burn || '').toLowerCase() === 'true';
  const collected = await collectFrames({ root, width: W, height: H, plan, step: args.step, maxSamples: args.maxSamples, log });
  const checks = analyzeFrames({ plan, frames: collected.frames, contract: collected.contract, opts: { step: args.step, burn: burnOn } });
  const fail = checks.filter((c) => c.status === 'FAIL').length;
  const warn = checks.filter((c) => c.status === 'WARN').length;
  const advisory = checks.filter((c) => c.status === 'ADVISORY').length;
  const report = {
    plan: path.resolve(planPath),
    checkedAt: new Date().toISOString(),
    viewport: { width: W, height: H },
    sampling: { step: args.step, maxSamples: args.maxSamples },
    metrics: {
      framesSampled: collected.samples.length,
      framesFailed: collected.samples.filter((s) => !s.ok).length,
      textsRecorded: collected.frames.reduce((n, f) => n + f.texts.length, 0),
      evRecords: collected.evRecords,
      pagesWithContract: collected.contract.pagesWithContract,
      pagesNaked: [...new Set(collected.contract.pagesNaked)],
      samples: collected.samples,
    },
    checks,
    summary: { pass: checks.length - fail - warn - advisory, warn, advisory, fail },
  };
  const exit = fail > 0 || (args.strict && warn > 0) ? 1 : 0;
  return { exit, report };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || !a.plan) {
    console.log(`Usage: node scripts/qa-text.mjs --plan <plan.json> [options]
  --json <file>       report path, default qa/qa-text.json (next to plan)
  --strict            warnings (text dwell) fail too
  --step <sec>        sampling step, default 0.25
  --max-samples <n>   per-segment cap, default 24
  --quiet             JSON only`);
    process.exit(a.help ? 0 : 1);
  }
  const planPath = path.resolve(String(a.plan));
  const outJson = path.resolve(String(a.json || path.join(path.dirname(planPath), 'qa-text.json')));
  const { exit, report } = await runTextQa(planPath, {
    strict: !!a.strict, step: Number(a.step) || 0.25, maxSamples: Number(a['max-samples']) || 24, quiet: !!a.quiet,
  });
  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, JSON.stringify(report, null, 2));
  for (const c of report.checks) if (!a.quiet) console.log(`[${c.status}] ${c.name}  ${c.detail}`);
  if (!a.quiet) console.log(`\n${report.summary.pass} pass · ${report.summary.warn} warn · ${report.summary.advisory} advisory · ${report.summary.fail} fail  ->  ${outJson}`);
  else console.log(JSON.stringify({ exit, summary: report.summary, file: outJson }));
  process.exit(exit);
}
