#!/usr/bin/env node
/**
 * test-taste.mjs — S1 审美裁判机回归（G3 切片重写版）。
 *
 * 原则（来自 notes/G3.md 的防主观化铁律）：
 *   ① 每条被断言的规则必须能构造出确定无疑的正/反例（数值断言非印象）；
 *   ② 豁免只作用于 warning/advisory，error 不可被静默；豁免有生命周期（G3-7）；
 *   ③ 同 spec 同版本两次运行必须同分（进位级精神：这里是同 JSON）；
 *   ④ 判决口径唯一真值在 schema/taste-rules.json 的 assert（G3-6）：本文件用
 *      「改表即改判」实验证明之，并禁止非法 assert 静默回退（启动错）。
 * 退出码（G3-9）：0 通过 · 1 判决阻断 · 2 用法/目录非法。帧级规则显式 skip 计数。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TASTE = path.join(ROOT, 'scripts', 'taste.mjs');
const CASES = path.join(ROOT, 'fixtures', 'taste-cases');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-taste-'));
let fails = 0;
const ok = (name, cond, note = '') => {
  if (cond) console.log(`  ok  ${name}${note ? ` — ${note}` : ''}`);
  else { fails++; console.error(`  FAIL ${name}${note ? ` — ${note}` : ''}`); }
};
const runTaste = (specPath, extra = []) => {
  const outDir = path.join(tmp, 'qa-out');
  const r = spawnSync(process.execPath, [TASTE, specPath, '--root', ROOT, '--json', '--out', outDir, ...extra],
    { encoding: 'utf8', timeout: 90000 });
  let rep = null;
  try { rep = JSON.parse(String(r.stdout || '').split('\n').filter(Boolean).pop()); } catch { /* below */ }
  return { code: r.status, rep, err: String(r.stderr || ''), out: String(r.stdout || ''), outDir };
};
const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/mini-41s/spec.json'), 'utf8'));
const writeSpec = (name, mut) => { const s = structuredClone(base); mut(s); const p = path.join(tmp, `${name}.spec.json`); fs.writeFileSync(p, JSON.stringify(s)); return p; };
const resOf = (rep, id) => rep?.results?.find((r) => r.rule === id);

// ── 1) fixture 现状：无 error，分数带内，非阻断；帧级 6 条显式 skip ──
{
  const { code, rep } = runTaste(path.join(ROOT, 'fixtures/mini-41s/spec.json'));
  ok('fixture passes non-strict', code === 0 && rep && rep.counts.error === 0, `exit=${code} score=${rep?.score}`);
  ok('fixture scores in 80..100 band', rep && rep.score >= 80 && rep.score <= 100, String(rep?.score));
  ok('frame-level rules explicitly skipped (G3-9)', rep?.counts?.frameSkipped === 6 &&
    rep.results.filter((r) => r.status === 'skipped-frames').length === 6, `skip=${rep?.counts?.frameSkipped}`);
}

// ── 2) placeholder-copy 是 error：非 strict 也拦，退出码 1（G3-9 0/1/2） ──
{
  const p = writeSpec('placeholder', (s) => { s.meta.brand = 'ACME 示例品牌'; });
  const { code, rep } = runTaste(p);
  const hit = resOf(rep, 'placeholder-copy');
  ok('placeholder-copy fires as error (exit 1)', code === 1 && hit?.status === 'fail' && hit.severity === 'error', `exit=${code}`);
}

// ── 3) style-duplicate-page 触发 warning 并扣分；--strict 拦（退出码 1） ──
{
  const p = writeSpec('dup', (s) => { s.rounds[1].style.page = s.rounds[0].style.page; });
  const { rep, code } = runTaste(p);
  const hit = resOf(rep, 'style-duplicate-page');
  ok('duplicate style page flagged', hit?.status === 'fail' && code === 0, `status=${hit?.status}`);
  const strict = runTaste(p, ['--strict']);
  ok('duplicate blocks under --strict (exit 1)', strict.code === 1, `exit=${strict.code}`);
}

// ── 4) beat-grid 反例（4.3s 轮 @120bpm = 8.6 拍）仍拦 ──
{
  const p = writeSpec('beat', (s) => {
    s.structure.round = 4.3;
    s.format.duration = Math.round((s.structure.opening + s.rounds.length * 4.3 + (s.structure.moreCard || 0) + (s.structure.flash?.count || 0) * (s.structure.flash?.each || 0) + s.structure.ending) * 10) / 10;
  });
  const { rep } = runTaste(p);
  const hit = resOf(rep, 'beat-grid');
  ok('off-grid round flagged', hit && hit.status !== 'pass', `value=${hit?.evidence}`);
}

// ── 4b) G3-8 正反例：段索引 vs 秒数撞车（fixtures/taste-cases） ──
{
  // 反例：round=8s 且 opening=8s @118.5bpm——round 离拍 0.2 拍。
  // 旧实现用 Number(sec)===st.opening 判「首尾段」，round 撞上 opening 秒数被放宽容差假绿。
  const bad = runTaste(path.join(CASES, 'beat-edge-collision.spec.json'));
  const badHit = resOf(bad.rep, 'beat-grid');
  ok('G3-8 collision round flagged (index-based edge)', badHit?.status === 'fail' && /round=/.test(badHit?.evidence || ''), `value=${badHit?.evidence}`);
  // 正例：同结构 @120bpm 全落拍。
  const good = runTaste(path.join(CASES, 'beat-grid-ok.spec.json'));
  ok('G3-8 on-grid beats pass', resOf(good.rep, 'beat-grid')?.status === 'pass', `value=${resOf(good.rep, 'beat-grid')?.evidence}`);
  // 首尾段宽限仍生效：opening 离拍 0.2 拍（≤±0.25）不拦。
  const edge = writeSpec('beat-edge-ok', (s) => { s.audio.bpm = 118.5; s.structure.opening = 8; s.structure.round = 8; s.structure.ending = 6; s.format.duration = 65; s.structure.card = 1; });
  const er = runTaste(edge);
  const eh = resOf(er.rep, 'beat-grid');
  ok('G3-8 edge segments keep ±0.25 tolerance (opening not flagged)', eh?.status === 'fail' && !/opening=/.test(eh?.evidence || '') && /round=/.test(eh?.evidence || ''), `value=${eh?.evidence}`);
}

// ── 4c) G3-3 正反例：transition-variety 读真实 render.transition ──
{
  const fade = runTaste(path.join(CASES, 'transition-fade.spec.json'));
  ok('G3-3 real transition passes (not always-fail)', resOf(fade.rep, 'transition-variety')?.status === 'pass', `value=${resOf(fade.rep, 'transition-variety')?.evidence}`);
  ok('G3-3 fade fixture non-strict exit 0', fade.code === 0, `exit=${fade.code}`);
  const cut = runTaste(path.join(CASES, 'transition-cut.spec.json'));
  ok('G3-3 all-hard-cut ≥3 rounds fails', resOf(cut.rep, 'transition-variety')?.status === 'fail', `value=${resOf(cut.rep, 'transition-variety')?.evidence}`);
  const cutStrict = runTaste(path.join(CASES, 'transition-cut.spec.json'), ['--strict']);
  ok('G3-3 hard-cut blocks under --strict', cutStrict.code === 1, `exit=${cutStrict.code}`);
}

// ── 4d) G3-4 对比度套 accentOverride：#0a0a0a 必须 FAIL，#00a3a3 必须过 ──
{
  const blk = runTaste(path.join(CASES, 'accent-override-black.spec.json'));
  const cl = resOf(blk.rep, 'contrast-large');
  ok('G3-4 accentOverride=#0a0a0a fails contrast-large', cl?.status === 'fail' && /accent=0/.test(cl?.evidence || ''), `value=${cl?.evidence}`);
  const blkStrict = runTaste(path.join(CASES, 'accent-override-black.spec.json'), ['--strict']);
  ok('G3-4 black override blocks under --strict', blkStrict.code === 1, `exit=${blkStrict.code}`);
  const teal = runTaste(path.join(CASES, 'accent-override-teal.spec.json'));
  ok('G3-4 readable override passes', resOf(teal.rep, 'contrast-large')?.status === 'pass', `value=${resOf(teal.rep, 'contrast-large')?.evidence}`);
  // override-silent 仍比未覆盖原值：accentOverride == 主题 accent 原色 → fail；不同 → pass。
  const sil = writeSpec('ov-silent', (s) => { s.look.accentOverride = '#d97757'; });
  ok('override-silent fires vs RAW theme accent', resOf(runTaste(sil).rep, 'override-silent')?.status === 'fail');
  ok('override-silent N/A under effective theme', resOf(blk.rep, 'override-silent')?.status === 'pass');
}

// ── 5) G3-7 豁免生命周期真闸 ──
{
  // 基座用 transition-fade 正例改 dup：transition-variety 合法通过，不再需要
  // 「fixture 基线噪音」豁免来隔离断言（G3-3 拆豁免的落点）。
  const fadeBase = JSON.parse(fs.readFileSync(path.join(CASES, 'transition-fade.spec.json'), 'utf8'));
  const dupFade = structuredClone(fadeBase); dupFade.rounds[1].style.page = dupFade.rounds[0].style.page;
  const dupPath = path.join(tmp, 'dup-fade.spec.json'); fs.writeFileSync(dupPath, JSON.stringify(dupFade));
  const wv = path.join(tmp, 'wv'); fs.mkdirSync(wv, { recursive: true });
  const waif = (name, arr) => { const p = path.join(wv, `${name}.json`); fs.writeFileSync(p, JSON.stringify({ waivers: arr })); return p; };

  const good = waif('good', [{ rule: 'style-duplicate-page', reason: 'AB 两轮同页是刻意的对照实验', date: '2026-12-31' }]);
  const r1 = runTaste(dupPath, ['--waivers', good, '--strict', '--today', '2026-11-23']);
  ok('warning waivable with valid reason/date (strict exit 0)', r1.code === 0 && resOf(r1.rep, 'style-duplicate-page')?.status === 'waived', `exit=${r1.code}`);

  const noReason = waif('no-reason', [{ rule: 'style-duplicate-page', date: '2026-11-21' }]);
  const r2 = runTaste(dupPath, ['--waivers', noReason]);
  ok('waiver without reason → startup error', r2.code === 2 && r2.err.includes('E_TASTE_WAIVER_REASON'), `exit=${r2.code}`);
  const emptyReason = waif('empty-reason', [{ rule: 'style-duplicate-page', reason: '   ', date: '2026-11-21' }]);
  const r2b = runTaste(dupPath, ['--waivers', emptyReason]);
  ok('waiver with blank reason → startup error', r2b.code === 2 && r2b.err.includes('E_TASTE_WAIVER_REASON'), `exit=${r2b.code}`);

  const ghost = waif('ghost', [{ rule: 'not-a-rule', reason: '拼错的规则名', date: '2026-12-31' }]);
  const r3 = runTaste(dupPath, ['--waivers', ghost]);
  ok('waiver rule not in catalog → startup error', r3.code === 2 && r3.err.includes('E_TASTE_WAIVER_RULE'), `exit=${r3.code}`);

  // 过期：date < --today → 不豁免 + 计入 blocking。同一文件换个 --today 即恢复有效 → 时钟可注入。
  const exp = waif('expired', [{ rule: 'style-duplicate-page', reason: '上季度的评审同意', date: '2026-11-22' }]); // date=豁免有效期止
  const r4 = runTaste(dupPath, ['--waivers', exp, '--today', '2026-11-23']);
  ok('expired waiver NOT waiving (rule back to fail)', r4.code === 1 && resOf(r4.rep, 'style-duplicate-page')?.status === 'fail', `exit=${r4.code}`);
  ok('expired waiver listed + counted blocking', (r4.rep?.expiredWaivers || []).some((x) => x.startsWith('style-duplicate-page')) && r4.rep.counts.expiredWaivers === 1);
  const r5 = runTaste(dupPath, ['--waivers', exp, '--today', '2026-11-22']);
  ok('--today injection restores validity (same day not expired)', r5.code === 0 && resOf(r5.rep, 'style-duplicate-page')?.status === 'waived', `exit=${r5.code}`);

  // 未命中豁免：--report-unused-waivers 时参与退出码；不带时只列示。
  const unused = waif('unused', [{ rule: 'copy-density', reason: '副题齐了就该撤', date: '2026-12-31' }]);
  const r6 = runTaste(dupPath, ['--waivers', unused, '--today', '2026-11-23']);
  ok('unused waiver harmless without flag', r6.code === 0 && Array.isArray(r6.rep?.unusedWaivers) === false);
  const r7 = runTaste(dupPath, ['--waivers', unused, '--report-unused-waivers', '--today', '2026-11-23']);
  ok('unused waiver blocks with --report-unused-waivers', r7.code === 1 && (r7.rep?.unusedWaivers || []).some((x) => x.startsWith('copy-density')) && r7.err.includes('E_TASTE_WAIVER_UNUSED'), `exit=${r7.code}`);

  // error 级不许被静默：合法豁免也照拦。
  const ph = writeSpec('ph2', (s) => { s.meta.brand = 'TBD 品牌'; });
  const phW = waif('ph', [{ rule: 'placeholder-copy', reason: '坚持认为不是占位词', date: '2026-12-31' }]);
  const r8 = runTaste(ph, ['--waivers', phW, '--today', '2026-11-23']);
  ok('error NOT waivable (exit 1)', r8.code === 1 && resOf(r8.rep, 'placeholder-copy')?.status === 'fail');
}

// ── 6) 确定性：同 spec 两次运行同分同判决 ──
{
  const p = path.join(ROOT, 'fixtures/mini-41s/spec.json');
  const a = runTaste(p, ['--today', '2026-11-23']), b = runTaste(p, ['--today', '2026-11-23']);
  ok('deterministic: identical score', a.rep && b.rep && a.rep.score === b.rep.score, `${a.rep?.score} vs ${b.rep?.score}`);
  ok('deterministic: identical verdicts', a.rep && b.rep && JSON.stringify(a.rep.results.map((r) => [r.rule, r.status])) === JSON.stringify(b.rep.results.map((r) => [r.rule, r.status])));
}

// ── 7) 目录↔实现全覆盖：spec 级都有实现，帧级都显式 skip（闸不许 unimplemented 静默） ──
{
  const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'taste-rules.json'), 'utf8'));
  const { rep } = runTaste(path.join(ROOT, 'fixtures/mini-41s/spec.json'));
  const byId = new Map((rep?.results || []).map((r) => [r.rule, r]));
  const missing = cat.rules.filter((r) => r.input !== 'frames' && (!byId.has(r.id) || byId.get(r.id).status === 'unimplemented')).map((r) => r.id);
  ok('all spec-level catalog rules implemented', missing.length === 0, missing.join(','));
  const frameBad = cat.rules.filter((r) => r.input === 'frames' && byId.get(r.id)?.status !== 'skipped-frames').map((r) => r.id);
  ok('all frame-level rules skipped with count', frameBad.length === 0, frameBad.join(','));
}

// ── 8) 主题表全 17 套过 contrast-body（error 级） ──
{
  const { THEME_IDS } = await import('../templates/themes.js');
  let bad = [];
  for (const id of THEME_IDS) {
    const p = writeSpec(`theme-${id}`, (s) => { s.look.theme = id; });
    const { rep } = runTaste(p);
    const hit = resOf(rep, 'contrast-body');
    if (hit?.status !== 'pass') bad.push(`${id}(${hit?.evidence})`);
  }
  ok('all 17 themes pass body contrast', bad.length === 0, bad.join(','));
}

// ── 9) G3-6 单一真值：改表即改判 + 非法 assert 启动错 ──
{
  const catPath = path.join(ROOT, 'schema', 'taste-rules.json');
  const cat = JSON.parse(fs.readFileSync(catPath, 'utf8'));
  const rulesFile = (name, mutate) => { const c2 = structuredClone(cat); mutate(c2); const p = path.join(tmp, `${name}.rules.json`); fs.writeFileSync(p, JSON.stringify(c2)); return p; };
  // duration-band：41s 默认过；表改成 50–60 必须 fail。
  const band = rulesFile('band', (c2) => { const r = c2.rules.find((x) => x.id === 'duration-band'); r.assert.min = 50; r.assert.max = 60; });
  const rb = runTaste(path.join(ROOT, 'fixtures/mini-41s/spec.json'), ['--rules', band]);
  ok('table change flips duration-band', resOf(rb.rep, 'duration-band')?.status === 'fail' && /阈值 50–60|50–60/.test(resOf(rb.rep, 'duration-band')?.evidence + String(resOf(rb.rep, 'duration-band')?.threshold)), `threshold=${resOf(rb.rep, 'duration-band')?.threshold}`);
  // flash-overload：15% 默认过；表改 1% 必须 fail。
  const fl = rulesFile('flash', (c2) => { c2.rules.find((x) => x.id === 'flash-overload').assert.max = 0.01; });
  ok('table change flips flash-overload', resOf(runTaste(path.join(ROOT, 'fixtures/mini-41s/spec.json'), ['--rules', fl]).rep, 'flash-overload')?.status === 'fail');
  // beat-grid：tolerance 改 0.5 全收；4.3s 反例转绿 → 阈值真从表来。
  const bt = rulesFile('beat', (c2) => { c2.rules.find((x) => x.id === 'beat-grid').assert.tolerance = 0.5; c2.rules.find((x) => x.id === 'beat-grid').assert.edgeTolerance = 0.5; });
  const p43 = writeSpec('beat43', (s) => { s.structure.round = 4.3; });
  ok('table change relaxes beat-grid', resOf(runTaste(p43, ['--rules', bt]).rep, 'beat-grid')?.status === 'pass');
  // placeholder regex 表驱动：删 nexus 分支后含 nexus 的 spec 不再被判占位。
  const nx = writeSpec('nexus', (s) => { s.meta.brand = 'Nexus Studio'; });
  ok('nexus flagged by catalog regex', resOf(runTaste(nx).rep, 'placeholder-copy')?.status === 'fail');
  const noNexus = rulesFile('nexus-off', (c2) => { c2.rules.find((x) => x.id === 'placeholder-copy').assert.regex = 'lorem|tbd|todo'; });
  ok('regex table change unflag nexus', resOf(runTaste(nx, ['--rules', noNexus]).rep, 'placeholder-copy')?.status === 'pass');
  // 缺 assert → 启动错 exit 2，不静默。
  const noAs = rulesFile('noassert', (c2) => { delete c2.rules.find((x) => x.id === 'duration-band').assert; });
  const rn = runTaste(path.join(ROOT, 'fixtures/mini-41s/spec.json'), ['--rules', noAs]);
  ok('missing assert → startup error', rn.code === 2 && rn.err.includes('E_TASTE_ASSERT'), `exit=${rn.code}`);
  // 非法 assert（min 是字符串）→ 启动错。
  const badAs = rulesFile('badassert', (c2) => { c2.rules.find((x) => x.id === 'duration-band').assert.min = 'twenty'; });
  const rba = runTaste(path.join(ROOT, 'fixtures/mini-41s/spec.json'), ['--rules', badAs]);
  ok('invalid assert → startup error', rba.code === 2 && rba.err.includes('E_TASTE_ASSERT'), `exit=${rba.code}`);
  // 不可编译 regex → 启动错。
  const badRe = rulesFile('badre', (c2) => { c2.rules.find((x) => x.id === 'fabricated-metric').assert.regex = '(unclosed'; });
  ok('uncompilable regex → startup error', runTaste(path.join(ROOT, 'fixtures/mini-41s/spec.json'), ['--rules', badRe]).code === 2);
}

// ── 10) G3-9 --sarif：SARIF 2.1.0 最小实现 + 退出码 ──
{
  const r = runTaste(path.join(CASES, 'accent-override-black.spec.json'), ['--sarif']);
  const sarifPath = path.join(r.outDir, 'taste.sarif');
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(sarifPath, 'utf8')); } catch { /* below */ }
  const nFail = (r.rep?.results || []).filter((x) => x.status === 'fail').length;
  ok('sarif written (2.1.0)', doc?.version === '2.1.0' && Array.isArray(doc?.runs?.[0]?.results), doc ? `v=${doc.version}` : 'missing');
  ok('sarif results match fail verdicts', doc && doc.runs[0].results.length === nFail && nFail > 0, `results=${doc?.runs?.[0]?.results?.length} fail=${nFail}`);
  ok('sarif levels legal + ruleId known', doc && doc.runs[0].results.every((x) => ['error', 'warning', 'note'].includes(x.level) && /^[a-z-]+$/.test(x.ruleId)));
}

// ── 11) 用法类退出码：非法 --today / 未知 flag → 2 ──
{
  const p = path.join(ROOT, 'fixtures/mini-41s/spec.json');
  ok('--today bad format → exit 2', runTaste(p, ['--today', 'yesterday']).code === 2);
  const r = spawnSync(process.execPath, [TASTE, p, '--tod', 'x'], { encoding: 'utf8', timeout: 60000 });
  ok('unknown flag → exit 2', r.status === 2);
}

fs.rmSync(tmp, { recursive: true, force: true });
if (fails) { console.error(`[test-taste] ${fails} FAIL`); process.exit(1); }
console.log('[test-taste] all green');
