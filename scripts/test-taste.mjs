#!/usr/bin/env node
/**
 * test-taste.mjs — S1 审美裁判机回归：判决正确性、豁免生命周期、确定性同分。
 *
 * 原则（来自 notes/G3.md 的防主观化铁律）：
 *   ① 每条被断言的规则必须能构造出确定无疑的正/反例（数值断言非印象）；
 *   ② 豁免只作用于 warning/advisory，error 不可被静默；
 *   ③ 同 spec 同版本两次运行必须同分（进位级精神：这里是同 JSON）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TASTE = path.join(ROOT, 'scripts', 'taste.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-taste-'));
let fails = 0;
const ok = (name, cond, note = '') => {
  if (cond) console.log(`  ok  ${name}${note ? ` — ${note}` : ''}`);
  else { fails++; console.error(`  FAIL ${name}${note ? ` — ${note}` : ''}`); }
};
const runTaste = (specPath, extra = []) => {
  const r = spawnSync(process.execPath, [TASTE, specPath, '--root', ROOT, '--json', ...extra],
    { encoding: 'utf8', timeout: 90000 });
  let rep = null;
  try { rep = JSON.parse(String(r.stdout || '').split('\n').filter(Boolean).pop()); } catch { /* below */ }
  return { code: r.status, rep, err: String(r.stderr || '') };
};
const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/mini-41s/spec.json'), 'utf8'));
const writeSpec = (name, mut) => { const s = structuredClone(base); mut(s); const p = path.join(tmp, `${name}.spec.json`); fs.writeFileSync(p, JSON.stringify(s)); return p; };

// ── 1) fixture 现状：无 error，分数带内，非阻断 ──
{
  const { code, rep } = runTaste(path.join(ROOT, 'fixtures/mini-41s/spec.json'));
  ok('fixture passes non-strict', code === 0 && rep && rep.counts.error === 0, `exit=${code} score=${rep?.score}`);
  ok('fixture scores in 80..100 band', rep && rep.score >= 80 && rep.score <= 100, String(rep?.score));
}

// ── 2) placeholder-copy 是 error 且 --strict 与否都拦 ──
{
  const p = writeSpec('placeholder', (s) => { s.meta.brand = 'ACME 示例品牌'; });
  const { code, rep } = runTaste(p);
  const hit = rep?.results?.find((r) => r.rule === 'placeholder-copy');
  ok('placeholder-copy fires as error', code === 13 && hit?.status === 'fail' && hit.severity === 'error', `exit=${code}`);
}

// ── 3) style-duplicate-page 触发 warning 并扣分 ──
{
  const p = writeSpec('dup', (s) => { s.rounds[1].style.page = s.rounds[0].style.page; });
  const { rep, code } = runTaste(p);
  const hit = rep?.results?.find((r) => r.rule === 'style-duplicate-page');
  ok('duplicate style page flagged', hit?.status === 'fail' && code === 0, `status=${hit?.status}`);
  const strict = runTaste(p, ['--strict']);
  ok('duplicate blocks under --strict', strict.code === 13);
}

// ── 4) beat-grid 触发（4.3s 轮 @120bpm = 8.6 拍） ──
{
  const p = writeSpec('beat', (s) => {
    s.structure.round = 4.3;
    s.format.duration = Math.round((s.structure.opening + s.rounds.length * 4.3 + (s.structure.moreCard || 0) + (s.structure.flash?.count || 0) * (s.structure.flash?.each || 0) + s.structure.ending) * 10) / 10;
  });
  const { rep } = runTaste(p);
  const hit = rep?.results?.find((r) => r.rule === 'beat-grid');
  ok('off-grid round flagged', hit && hit.status !== 'pass', `value=${hit?.evidence}`);
}

// ── 5) 豁免生命周期：waived 生效 → error 不可豁免 → 过期豁免被点名 ──
{
  const dup = writeSpec('dup2', (s) => { s.rounds[1].style.page = s.rounds[0].style.page; });
  const waivDir = path.join(tmp, 'wv'); fs.mkdirSync(waivDir, { recursive: true });
  const waivPath = path.join(waivDir, 'waivers.json');
  fs.writeFileSync(waivPath, JSON.stringify({ waivers: [
    { rule: 'style-duplicate-page', reason: 'AB 两轮同页是刻意的对照实验', date: '2026-11-21' },
    { rule: 'transition-variety', reason: '41s 教学片全硬切是风格选择（fixture 基线噪音，为隔离断言而豁免）', date: '2026-11-21' },
    { rule: 'placeholder-copy', reason: '误判？', date: '2026-11-21' },
    { rule: 'flash-overload', reason: '早已修掉，豁免过期', date: '2026-01-01' },
  ] }));
  const { code, rep } = runTaste(dup, ['--waivers', waivPath, '--strict', '--report-unused-waivers']);
  const dupR = rep?.results?.find((r) => r.rule === 'style-duplicate-page');
  ok('warning is waivable (strict passes)', code === 0 && dupR?.status === 'waived', `exit=${code} status=${dupR?.status}`);
  ok('unused waiver reported', Array.isArray(rep?.unusedWaivers) && rep.unusedWaivers.some((x) => x.startsWith('flash-overload')));
  const ph = writeSpec('ph2', (s) => { s.meta.brand = 'TBD 品牌'; });
  const r2 = runTaste(ph, ['--waivers', waivPath]);
  ok('error NOT waivable', r2.code === 13 && r2.rep?.results?.find((x) => x.rule === 'placeholder-copy')?.status === 'fail');
}

// ── 6) 确定性：同 spec 两次运行同分同判决 ──
{
  const p = path.join(ROOT, 'fixtures/mini-41s/spec.json');
  const a = runTaste(p), b = runTaste(p);
  ok('deterministic: identical score', a.rep && b.rep && a.rep.score === b.rep.score, `${a.rep?.score} vs ${b.rep?.score}`);
  ok('deterministic: identical verdicts', a.rep && b.rep && JSON.stringify(a.rep.results.map((r) => [r.rule, r.status])) === JSON.stringify(b.rep.results.map((r) => [r.rule, r.status])));
}

// ── 7) 全规则都有实现（闸不许 unimplemented 静默） ──
{
  const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'taste-rules.json'), 'utf8'));
  const { rep } = runTaste(path.join(ROOT, 'fixtures/mini-41s/spec.json'));
  const byId = new Map((rep?.results || []).map((r) => [r.rule, r]));
  const missing = cat.rules.filter((r) => !byId.has(r.id) || byId.get(r.id).status === 'unimplemented').map((r) => r.id);
  ok('all catalog rules implemented', missing.length === 0, missing.join(','));
}

// ── 8) 主题表全 17 套过 contrast-body（error 级） ──
{
  const { THEME_IDS } = await import('../templates/themes.js');
  let bad = [];
  for (const id of THEME_IDS) {
    const p = writeSpec(`theme-${id}`, (s) => { s.look.theme = id; });
    const { rep } = runTaste(p);
    const hit = rep?.results?.find((r) => r.rule === 'contrast-body');
    if (hit?.status !== 'pass') bad.push(`${id}(${hit?.evidence})`);
  }
  ok('all 17 themes pass body contrast', bad.length === 0, bad.join(','));
}

fs.rmSync(tmp, { recursive: true, force: true });
if (fails) { console.error(`[test-taste] ${fails} FAIL`); process.exit(1); }
console.log('[test-taste] all green');
