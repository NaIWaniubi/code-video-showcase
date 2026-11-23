#!/usr/bin/env node
/**
 * theme-audit.mjs v2 — WCAG 2 + APCA audit for every theme.
 *
 *   node scripts/theme-audit.mjs
 *   node scripts/theme-audit.mjs aqua-morandi cyber-neon
 *   node scripts/theme-audit.mjs --strict          # CI gate (WCAG failures exit 1)
 *   node scripts/theme-audit.mjs --json qa/themes.json
 *
 * APCA (Lc) is reported alongside WCAG because dark backgrounds and thin CJK
 * strokes are where the WCAG 2 ratio flatters a design. Guidance: body ≥ 60,
 * small text ≥ 75, large display ≥ 45.
 *
 * composite() 也被 test-theme-audit.mjs import（G3-5 lc 单一色源）；CLI 判决逻辑
 * 收进 main()，被 import 时不执行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEME_LIST, getTheme, auditTheme, contrastRatio } from '../templates/themes.js';
import { auditApca, apcaLc } from '../templates/color.js';

// 导出给 test-theme-audit.mjs 复用：lc 回归必须用同一合成函数（单一真值，测试不复写）。
export function composite(fg, bg) {
  const m = String(fg).match(/rgba?\(([^)]+)\)/);
  if (!m) return fg;
  const [r, g, b, a = 1] = m[1].split(',').map(Number);
  const h = String(bg).replace('#', '');
  const br = parseInt(h.slice(0, 2), 16), bgc = parseInt(h.slice(2, 4), 16), bb = parseInt(h.slice(4, 6), 16);
  const to = (v) => Math.round(v).toString(16).padStart(2, '0');
  return `#${to(r * a + br * (1 - a))}${to(g * a + bgc * (1 - a))}${to(b * a + bb * (1 - a))}`;
}

function main() {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const jsonIdx = args.indexOf('--json');
  const jsonPath = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
  const only = args.filter((a, i) => !a.startsWith('--') && (jsonIdx < 0 || i !== jsonIdx + 1));

  const themes = only.length ? only.map((id) => getTheme(id)) : THEME_LIST;
  let failures = 0, apcaWarnings = 0;
  const report = { generatedAt: new Date().toISOString(), themes: [] };
  // 机器模式（--json）：人类可读块走 stderr，stdout 只留一行 JSON。
  const JSON_MODE = args.includes('--json');
  const say = (...a) => (JSON_MODE ? console.error(...a) : console.log(...a));

  for (const theme of themes) {
    say(`\n■ ${theme.id}  ${theme.name} / ${theme.nameEn}  [${theme.mode}]  ${theme.material.kind}`);
    say(`  底色 ${theme.colors.bg}  强调 ${theme.colors.accent}  ${theme.tagline}`);
    const wcag = auditTheme(theme);
    const apca = auditApca(theme);
    const entry = { id: theme.id, name: theme.name, mode: theme.mode, wcag: [], apca: [] };
    for (const row of wcag) {
      const mark = row.pass ? 'PASS' : 'FAIL';
      if (!row.pass) failures++;
      entry.wcag.push(row);
      say(`  [${mark}] ${row.label.padEnd(18, ' ')} ${row.pair.padEnd(22, ' ')} ${String(row.ratio).padStart(6)} : 1   (min ${row.min})`);
    }
    for (const row of apca) {
      const mark = row.pass ? 'PASS' : 'WARN';
      if (!row.pass) apcaWarnings++;
      entry.apca.push(row);
      say(`  [${mark}] APCA ${row.label.padEnd(16, ' ')} ${row.pair.padEnd(22, ' ')} ${String(row.lc).padStart(6)} Lc  (min ${row.need})`);
    }
    // R3-审计（RT-06 F1 / R2-28 落地）：token 对之外补「上屏组合」矩阵——点缀色、
    // 倒计时直接印在 bg/surface 上的真实组合。以前 accents×bg 最低 1.00:1 时
    // theme-audit 仍可全绿，等于无障碍门禁只审了没人看的 token 对。
    // 分两档：WCAG<2 且 APCA<20 → 双指标都不可读，硬失败；其余低对比 → 提示级，
    // 可见但不拦交付（浅色主题的粉彩点缀是设计取舍，需人工复核而非自动改色）。
    const matrix = [];
    let matrixWarns = 0;
    for (const [fgHex, fgLabel] of [
      ...theme.accents.map((a) => [a.hex, `点缀·${a.name}`]),
      [theme.hud.countdown, 'HUD 倒计时'],
    ]) {
      for (const [bgLabel, bgHex] of [['底', theme.colors.bg], ['表面', theme.colors.surface]]) {
        if (!fgHex || !bgHex) continue;
        // countdown 是半透明 token，按该底色合成后再比（与 HUD 胶囊同一口径）。
        const fg = composite(String(fgHex), String(bgHex));
        const ratio = contrastRatio(fg, String(bgHex));
        // G3-5（已复现）：lc 此前吃**未合成**的 fgHex——rgba(...) 直接进 apcaLc 被
        // parseColor 按 alpha 当亮度分量算出 398139 之类的天文 Lc，hard/soft 永不触发，
        // 暗底半透明字（黑压黑）永远拦不住。与 ratio 同色源：一律用合成后 fg。
        const lc = Math.abs(apcaLc(fg, String(bgHex)));
        const hard = ratio < 2 && lc < 20;                    // 双指标都不可读
        const soft = !hard && !(ratio >= 3 || lc >= 30);       // 大字口径不达标
        const row = { pair: `${fgLabel} / ${bgLabel}`, ratio: +ratio.toFixed(2), lc: +lc.toFixed(1), hard, soft };
        matrix.push(row);
        say(`  [${hard ? 'FAIL' : soft ? 'WARN' : 'PASS'}] 矩阵 ${row.pair.padEnd(24, ' ')} ${String(ratio).padStart(6)} : 1 · Lc ${String(lc).padStart(5)}`);
        if (hard) failures++;
        else if (soft) matrixWarns++;
      }
    }
    apcaWarnings += matrixWarns;
    entry.matrix = matrix;
    // HUD capsule: composite the rgba capsule over the theme background.
    const capsule = composite(theme.hud.capsuleBg, theme.colors.bg);
    const numRatio = contrastRatio(theme.hud.capsuleNumber, capsule);
    const textRatio = contrastRatio(theme.hud.capsuleText, capsule);
    const numPass = numRatio >= 3, textPass = textRatio >= 4.5;
    if (!numPass || !textPass) failures++;
    say(`  [${numPass ? 'PASS' : 'FAIL'}] HUD 编号 / 胶囊        ${numRatio.toFixed(2)} : 1   (min 3)`);
    say(`  [${textPass ? 'PASS' : 'FAIL'}] HUD 文字 / 胶囊        ${textRatio.toFixed(2)} : 1   (min 4.5)`);
    entry.hud = { numberRatio: +numRatio.toFixed(2), textRatio: +textRatio.toFixed(2), pass: numPass && textPass };
    say(`  点缀色 ${theme.accents.map((a) => `${a.name} ${a.hex}`).join(' · ')}`);
    report.themes.push(entry);
  }

  report.summary = { themes: themes.length, failures, apcaWarnings };
  if (jsonPath) {
    fs.mkdirSync(path.dirname(path.resolve(jsonPath)), { recursive: true });
    fs.writeFileSync(path.resolve(jsonPath), JSON.stringify(report, null, 2));
    console.log(`\n[report] ${path.resolve(jsonPath)}`);
  }
  // --json 不带路径 = 机器模式：stdout 只有一行可 parse 的 JSON，
  // 人类文本块全部退到 stderr（CI 管道 `theme-audit --json | jq` 之前会 parse 失败）。
  if (args.includes('--json') && !jsonPath) {
    process.stdout.write(JSON.stringify(report) + '\n');
    if (strict && failures > 0) process.exit(1);
    process.exit(0);
  }
  console.log(`\n${failures === 0 ? '✓ WCAG + 上屏组合矩阵全部通过' : `✗ ${failures} 项不合格（含上屏组合矩阵）`}${apcaWarnings ? `  ·  ${apcaWarnings} 项 APCA 提醒（仅提示，--strict 不拦）` : ''}`);
  if (strict && failures > 0) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
