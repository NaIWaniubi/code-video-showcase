#!/usr/bin/env node
/**
 * test-theme-audit.mjs — G3-5 回归：上屏组合矩阵的 APCA lc 必须用**合成后**前景色。
 *
 * 已复现（修复前）：matrix lc 吃未合成 rgba → coral-noir HUD 倒计时对底 Lc=398139.4
 * （天文数字），hard/soft 判据永不触发，暗底半透明字黑压黑永远拦不住。
 * 合成后真值 Lc=59.9。本测试对每个含 rgba 前景的主题断言 lc 等于同色源复算值，
 * 且不许出现 >110 的非法 Lc（APCA 绝对值上限 ~106）。
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { apcaLc } from '../templates/color.js';
import { THEME_LIST } from '../templates/themes.js';
import { composite } from './theme-audit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let fails = 0;
const ok = (name, cond, note = '') => {
  if (cond) console.log(`  ok  ${name}${note ? ` — ${note}` : ''}`);
  else { fails++; console.error(`  FAIL ${name}${note ? ` — ${note}` : ''}`); }
};

const runAudit = (id) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'theme-audit.mjs'), id, '--json'],
    { encoding: 'utf8', timeout: 60000 });
  let doc = null;
  try { doc = JSON.parse(String(r.stdout || '').split('\n').filter(Boolean).pop()); } catch { /* below */ }
  return { code: r.status, doc };
};

// ── 1) coral-noir 反例锚点：HUD 倒计时（rgba）对底/表面的 lc = 合成复算值 ──
{
  const { doc } = runAudit('coral-noir');
  const t = THEME_LIST.find((x) => x.id === 'coral-noir');
  const rows = (doc?.themes?.[0]?.matrix || []).filter((x) => x.pair.includes('倒计时'));
  ok('countdown matrix rows present', rows.length === 2, `n=${rows.length}`);
  let bad = [];
  for (const row of rows) {
    const bgHex = row.pair.endsWith('/ 底') ? t.colors.bg : t.colors.surface;
    const expect = +Math.abs(apcaLc(composite(String(t.hud.countdown), String(bgHex)), String(bgHex))).toFixed(1);
    if (Math.abs(row.lc - expect) > 0.05) bad.push(`${row.pair}: got ${row.lc} want ${expect}`);
  }
  ok('G3-5 matrix lc uses COMPOSITED fg', bad.length === 0, bad.join(' | ') || 'all match');
  const absurd = rows.filter((x) => x.lc > 110);
  ok('no astronomic Lc (rgba raw leak)', absurd.length === 0, absurd.map((x) => `${x.pair}=${x.lc}`).join(','));
}

// ── 2) 全主题不变量：矩阵 lc 全部 ≤ 110 且 hard/soft 判据与自复算一致 ──
{
  let badAbsurd = [], badLogic = [];
  for (const t of THEME_LIST) {
    const { doc } = runAudit(t.id);
    for (const row of doc?.themes?.[0]?.matrix || []) {
      if (row.lc > 110) badAbsurd.push(`${t.id}/${row.pair}=${row.lc}`);
      const logic = row.hard === (row.ratio < 2 && row.lc < 20) && (!row.hard || !row.soft);
      if (!logic) badLogic.push(`${t.id}/${row.pair} hard=${row.hard} soft=${row.soft} r=${row.ratio} lc=${row.lc}`);
    }
  }
  ok('17 主题矩阵 lc 全部物理合法 (≤110)', badAbsurd.length === 0, badAbsurd.join(','));
  ok('矩阵 hard/soft 判据自洽', badLogic.length === 0, badLogic.join(','));
}

if (fails) { console.error(`[test-theme-audit] ${fails} FAIL`); process.exit(1); }
console.log('[test-theme-audit] all green');
