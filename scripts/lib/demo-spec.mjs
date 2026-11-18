/**
 * demo-spec.mjs — `cvs demo` 的演示片组合器（纯函数，可单测）。
 *
 * 把「导演演示集」的一个风格排成一段最短可播的 spec：
 *   单轮 card+style（或双轮，长片时），时长正好闭合（D 公式）。
 */
import { stylePageFor } from '../../templates/style-pages.mjs';
import { STYLE_IDS } from '../../scripts/nl2spec.mjs';

/** 中文展示名（与 nl2spec STYLE_LABEL 同口径；缺失回落 id）。 */
const LABEL_FALLBACK = {
  wireframe: '白模线框', skeleton: '骨骼动画', fractal: '分形生长',
  firework: '粒子喷泉', terrain: '地形测绘', network: '网络脉冲',
  generative: '生成式画面',
};

/** 默认主题：按风格选暗底主视觉（与 nl2spec 的默认主题一致）。 */
const DEFAULT_THEME = {
  wireframe: 'cyber-neon', skeleton: 'coral-noir', fractal: 'celadon-paper',
  firework: 'cyber-neon', terrain: 'blueprint-stone', network: 'blueprint-stone',
  generative: 'cyber-neon',
};

/**
 * @param {string} styleId 风格 id（必须命中 STYLE_IDS）
 * @param {{seconds?:number, theme?:string|null, brand?:string}} opts
 */
export function composeDemoSpec(styleId, { seconds = 6, theme = null, brand = 'DEMO' } = {}) {
  if (!STYLE_IDS.includes(String(styleId))) {
    throw Object.assign(new Error(`unknown style "${styleId}"`), { code: 'E_UNKNOWN_STYLE' });
  }
  const T = Math.max(4, Math.min(30, Number(seconds) || 6));
  const page = stylePageFor(styleId);
  const label = LABEL_FALLBACK[styleId] || String(styleId);
  const rounds = T >= 9 ? 2 : 1;
  // 组件：开场占 16%、卡占 15%（夹在 1–2）、余量给 style
  const open = Math.max(1, Math.min(3, Math.round(T * 0.16)));
  const card = Math.max(1, Math.min(2, Math.round(T * 0.15)));
  const more = 1;
  const ending = Math.max(1, Math.min(3, Math.round(T * 0.14)));
  const styleSec = Math.max(2, Number(((T - open - ending - more - rounds * card) / rounds).toFixed(2)));
  // 总时长由组件实算（闭合，不匹配不硬凑）
  const total = Number((open + rounds * (card + styleSec) + more + ending).toFixed(2));
  const roundsList = Array.from({ length: rounds }, (_, i) => ({
    id: `r${String(i + 1).padStart(2, '0')}`,
    name: label,
    card: { page: 'templates/big-card.html', layout: 0, first: '想', keyword: '看片？' },
    style: { page, t0: 0.35, speed: 1, copy: { title: label, subtitle: `${styleId} · ${T}s` } },
  }));
  return {
    specVersion: 1,
    meta: { name: `demo-${styleId}`, brand, cta: '开始', locale: 'zh-CN' },
    format: { width: 1920, height: 1080, fps: 30, aspect: '16:9', duration: total },
    look: { mode: 'showcase', style: String(styleId), theme: theme || DEFAULT_THEME[styleId] || 'coral-noir' },
    audio: { mood: 'electronic', bpm: 120 },
    structure: {
      opening: open, rounds, round: Number((card + styleSec).toFixed(2)), card, moreCard: more,
      ending,
      flash: { count: 0, each: 0.5 },
    },
    opening: { page: 'templates/segment.html', name: '开场' },
    rounds: roundsList,
    moreCard: { page: 'templates/big-card.html', first: '更多', keyword: '玩法？' },
    flash: { page: 'templates/segment.html' },
    ending: { page: 'templates/segment.html', name: '收尾' },
    _meta: { engine: 'demo-spec/1', styleId, seconds: T, totalDuration: total },
  };
}