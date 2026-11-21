#!/usr/bin/env node
/**
 * test-film-export.mjs — R24-W spec → OpenFilm IR 导出与 overrides 的回归。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildFilmHtml, overridesToSpecPatch } from './lib/film-export.mjs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}

const miniSpec = () => JSON.parse(fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'mini-41s', 'spec.json'), 'utf8'));

test('buildFilmHtml：每段一条 section，at/#t 与 withSegmentParams 同口径（t=t0+u·speed）', () => {
  const html = buildFilmHtml(miniSpec());
  assert.match(html, /<meta name="viewport" content="width=1920, height=1080">/, 'stage meta');
  // 展开核与编译链同构：opening → 轮×(卡+风格) → more → flash×4 → ending
  const segs = ['00-opening'];
  for (let i = 1; i <= 6; i++) { segs.push(`r${String(i).padStart(2,'0')}-card`, `r${String(i).padStart(2,'0')}-style`); }
  segs.push('99-more');
  for (let i = 1; i <= 4; i++) segs.push(`99-flash-${i}`);
  segs.push('99-ending');
  // opening=0–2s / card 每轮 1s / style 3.5s 等——断言 at 显式出现且数值合理
  assert.ok(html.includes('at="0.000"'), 'opening 起点 0');
  const cardIdx = html.indexOf('r01-card');
  assert.ok(cardIdx > 0, '存在 r01-card');
  // at 属性在 iframe 标签内（id 与 src 之后）——断言整段上下文
  const segCtx = html.slice(cardIdx - 40, cardIdx + 160);
  assert.ok(segCtx.includes('at="8.000"'), 'r01-card 段带 at=8.000（opening 8s 后）');
  assert.ok(segCtx.includes('#t=0.000,1.000"'), '卡段 #t=0→1s（与 withSegmentParams 同口径）');
  for (const id of segs) {
    assert.ok(html.includes(`id="${id}"`), `${id} 在展板`);
    assert.ok(html.includes(`pages/${id}.html?`), `${id} 页面壳引用`);
  }
});

test('轨道语义：opening/card/ending 为 locked（人的），风格轨为 hidden', () => {
  const html = buildFilmHtml(miniSpec());
  assert.ok(/class="track cvs-opening locked"/.test(html), 'opening 应 locked');
  assert.ok(/class="track cvs-style hidden"/.test(html), 'style 应 hidden');
});

test('overrides 非破坏层：clip 级注入 overrides JSON 且可回汇总进 spec patch', () => {
  const ovMap = new Map([['r01-card', { text: '新标题', style: { color: '#ff0' } }]]);
  const html = buildFilmHtml(miniSpec(), { overridesByClip: ovMap });
  assert.ok(html.includes("overrides='"), '应带 overrides 属性');
  assert.ok(html.includes('新标题'), '手改文本进入 IR');
  const patch = overridesToSpecPatch(miniSpec(), ovMap);
  assert.equal(patch.stylePatch.length, 2, 'style.color + text 各一条');
  assert.ok(patch.stylePatch.some((p) => p.field === 'accentOverride' && p.value === '#ff0'));
  assert.ok(patch.stylePatch.some((p) => p.field === 'copy.title' && p.value === '新标题'));
});

console.log(`\n${passed} checks passed`);