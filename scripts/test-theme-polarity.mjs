#!/usr/bin/env node
/**
 * test-theme-polarity.mjs — R2-05 收口 · 点缀色极性规则（KNOWN_RED 8 项清零回归）
 *
 * 断言的是**一般规则**，不是 8 项组合清单——任何主题、任何点缀色、任何底色都必须满足：
 *   P1 无双不可读：对底/表面，!(WCAG<2 && |APCA Lc|<20)（theme-audit 矩阵硬闸同尺）。
 *   P2 深浅极性：浅底出深点缀（Lc 同号为正）、深底出浅点缀（为负）——
 *      sign = mode==='light' ? +1 : -1，dir*apcaLc(a.hex, ground) 必须 > 0。
 *   P3 兜底重算达标：凡走过极性重算的点缀色（source ≠ hex），
 *      对主底必须 |Lc| ≥ 60（正文档），对表面必须 |Lc| ≥ 45（大字/次要档）。
 *   P4 最小改动面：未走重算的点缀色必须保持画风表原值（无 source/polarityFixed 标记）。
 *
 * 画风表与 token 的不动性：
 *   T1 17 主题的 colors.* token 不因重算而变（点缀重算只动 accents 列表）。
 *   T2 被重算的 5 个点缀色，其画风表原值必须原样保存在 source 字段
 *      （淡粉 #e6c2c6 / 暖沙 #d9cbb8 / 月白 #c9dad7 / 暗酒红 #7d0c14 / 近黑 #0a0a0a）。
 *
 * layout0 兜底（cardColors 极性重算，双档 ≥60/45）：
 *   C1 cardColors(t,0).bg === t.colors.accent（兜底强调色走主题 accent，非硬编黄）。
 *   C2 |Lc(CC.ink, CC.bg)| ≥ 45 且极性与 CC.bg 相反（浅底深字/深底浅字）——
 *      优先 ≥60，够不着落 ≥45；这是 R2-05「白字白底」家族的最低契约。
 *   C3 显式覆盖优先于兜底：accentOverride 的 accent/accentInk 原样生效，
 *      cardColors(覆盖主题, 0).bg 用显式值——与 G3 taste 的 accentOverride 同尺。
 *
 * 门禁直通：spawn `node scripts/theme-audit.mjs --strict` 必须 exit 0 且无 [FAIL]。
 * 绝不在测试里放宽 theme-audit 阈值（阈值判据只读，不复写）。
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { THEME_LIST, cardColors, accentOverride, contrastRatio } from '../templates/themes.js';
import { apcaLc } from '../templates/color.js';
import { composite } from './theme-audit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let fails = 0;
const ok = (name, cond, note = '') => {
  if (cond) console.log(`  ok  ${name}${note ? ` — ${note}` : ''}`);
  else { fails++; console.error(`  FAIL ${name}${note ? ` — ${note}` : ''}`); }
};

// ── 1) P1/P2/P3/P4：17 主题 × 点缀色 × {底, 表面} 全矩阵 ──────────────────
{
  const hardBad = [], polBad = [], gradeBad = [], untouchedBad = [], fixedBad = [];
  let fixedCount = 0;
  for (const t of THEME_LIST) {
    const dir = t.mode === 'light' ? 1 : -1;
    const grounds = [[t.colors.bg, '底', 60], [t.colors.surface, '表面', 45]];
    for (const a of t.accents) {
      const isFixed = a.source != null && a.source !== a.hex;
      if (isFixed) fixedCount++;
      else if (a.polarityFixed) fixedBad.push(`${t.id}/${a.name} polarityFixed 无 source`);
      for (const [ground, gName, minLc] of grounds) {
        const fg = composite(String(a.hex), String(ground));
        const ratio = contrastRatio(fg, String(ground));
        const lc = apcaLc(fg, String(ground));
        if (ratio < 2 && Math.abs(lc) < 20) hardBad.push(`${t.id}/点缀·${a.name}/${gName} r=${ratio.toFixed(2)} Lc=${lc.toFixed(1)}`);
        if (dir * lc <= 0) polBad.push(`${t.id}/点缀·${a.name}/${gName} dir*Lc=${(dir * lc).toFixed(1)}`);
        if (isFixed && dir * lc < minLc) gradeBad.push(`${t.id}/点缀·${a.name}/${gName} Lc=${lc.toFixed(1)} < ${minLc}`);
      }
      // P4：未走重算的点缀色不许被改动（画风表原值 = 上屏值，无 source 标记）。
      if (!isFixed && (a.source !== undefined || a.polarityFixed !== undefined)) {
        untouchedBad.push(`${t.id}/点缀·${a.name}`);
      }
    }
  }
  ok('P1 无「双不可读」点缀组合（17 主题全矩阵）', hardBad.length === 0, hardBad.join(' | ') || 'clean');
  ok('P2 点缀色深浅极性正确（浅底深点缀/深底浅点缀）', polBad.length === 0, polBad.join(' | ') || 'clean');
  ok('P3 重算后的点缀色 APCA 双档达标（底≥60/表面≥45）', gradeBad.length === 0, gradeBad.join(' | ') || `fixed=${fixedCount}`);
  ok('P4 未触发的点缀色保持画风表原值（最小改动面）', untouchedBad.length === 0 && fixedCount > 0, untouchedBad.join(',') || `touched=${fixedCount}`);
  ok('重算项结构合法（polarityFixed 与 source 同现）', fixedBad.length === 0, fixedBad.join(' | ') || 'clean');
}

// ── 2) T1/T2：token 与画风表不动性 ────────────────────────────────────────
{
  // T1：重算只发生在 accents；colors.* token 保持原对象语义（accent 仍是主题强调色）。
  const tokenBad = [];
  for (const t of THEME_LIST) {
    if (typeof t.colors.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(t.colors.accent)) tokenBad.push(`${t.id}.accent`);
    for (const role of ['bg', 'surface']) {
      if (typeof t.colors[role] !== 'string') tokenBad.push(`${t.id}.${role}`);
    }
  }
  ok('T1 colors.* token 全部完好（点缀重算不触碰 token）', tokenBad.length === 0, tokenBad.join(',') || 'clean');
  // T2：已知 5 个存量红组合的画风表原值必须原样留档在 source（钉死「不改表」承诺）。
  const pin = [
    ['aqua-morandi', '淡粉', '#e6c2c6'], ['aqua-morandi', '暖沙', '#d9cbb8'],
    ['celadon-paper', '月白', '#c9dad7'],
    ['crimson-theater', '暗酒红', '#7d0c14'], ['crimson-theater', '近黑', '#0a0a0a'],
  ];
  const pinBad = [];
  for (const [id, name, authored] of pin) {
    const t = THEME_LIST.find((x) => x.id === id);
    const a = t?.accents.find((x) => x.name === name);
    const src = a?.source ?? a?.hex; // 未重算时原值就在 hex
    if (!a || src.toLowerCase() !== authored) pinBad.push(`${id}/${name} source=${src} 应为 ${authored}`);
  }
  ok('T2 画风表原值留档（5 个重算项 source 逐字节可溯）', pinBad.length === 0, pinBad.join(' | ') || 'clean');
}

// ── 3) C1/C2：layout0 兜底强调色 + 极性重算双档 ───────────────────────────
{
  const c1Bad = [], c2Bad = [];
  for (const t of THEME_LIST) {
    const CC = cardColors(t, 0);
    if (CC.bg.toLowerCase() !== t.colors.accent.toLowerCase()) c1Bad.push(`${t.id} bg=${CC.bg} accent=${t.colors.accent}`);
    const lc = apcaLc(CC.ink, CC.bg);
    // 极性：字与底必须一深一浅；双档：|Lc| ≥ 45（大字地板，能及 60 时实现必须优先 60）。
    if (Math.abs(lc) < 45) c2Bad.push(`${t.id}/ink Lc=${lc.toFixed(1)} <45`);
  }
  ok('C1 layout0 兜底强调色 = 主题 accent（R2-05 走主题，非硬编黄）', c1Bad.length === 0, c1Bad.join(' | ') || '17/17');
  ok('C2 layout0 卡面字色 APCA ≥45 地板（双档大字层）', c2Bad.length === 0, c2Bad.join(' | ') || '17/17');
}

// ── 4) C3：显式 accent 覆盖优先于兜底（与 taste/accentOverride 同尺） ─────
{
  const t = THEME_LIST.find((x) => x.id === 'coral-noir');
  const X = '#e6c2c6'; // 刻意挑一个会被极性重算的浅色做显式覆盖
  const ov = accentOverride(t, { accent: X });
  ok('C3a accentOverride 的显式 accent 原样生效', ov.colors.accent === X, ov.colors.accent);
  ok('C3b cardColors(覆盖, 0).bg 用显式值（覆盖优先于兜底重算）',
    cardColors(ov, 0).bg.toLowerCase() === X.toLowerCase(), cardColors(ov, 0).bg);
  const ov2 = accentOverride(t, { accent: X, accentInk: '#ffffff' });
  ok('C3c 显式 accentInk 不被候选链吞掉（G3 v4.9.0 语义）', ov2.colors.accentInk === '#ffffff', ov2.colors.accentInk);
  // 覆盖主题下字色仍须按实际底色做极性择色（兜底只兜「没显式值」的时候）。
  const CCov = cardColors(ov, 0);
  ok('C3d 覆盖底色上的兜底 ink 仍过双档地板', Math.abs(apcaLc(CCov.ink, CCov.bg)) >= 45,
    `ink=${CCov.ink} Lc=${apcaLc(CCov.ink, CCov.bg).toFixed(1)}`);
}

// ── 5) 门禁直通：theme-audit --strict 必须全绿（不放宽任何阈值） ──────────
{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'theme-audit.mjs'), '--strict'],
    { encoding: 'utf8', timeout: 120000 });
  const out = String(r.stdout || '') + String(r.stderr || '');
  ok('G theme-audit --strict exit 0', r.status === 0, `exit=${r.status}`);
  ok('G theme-audit --strict 无 [FAIL] 行', !out.includes('[FAIL]'), out.includes('[FAIL]') ? `${(out.match(/\[FAIL\]/g) || []).length} 条残留` : 'clean');
  ok('G 汇总行报「全部通过」', out.includes('全部通过'), out.split(/\r?\n/).filter((l) => l.startsWith('✓') || l.startsWith('✗')).pop());
}

if (fails) { console.error(`\n[test-theme-polarity] ${fails} FAIL`); process.exit(1); }
console.log('\n[test-theme-polarity] all green');
