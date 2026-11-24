#!/usr/bin/env node
/**
 * test-flash-words.mjs — G4：flash 真快闪 / S9 words 闭环 / bpm 进 URL+哈希 /
 * big-card 时钟 / logo 进哈希面 的回归契约（纯 Node，零依赖）。
 *
 * 背景（引擎审计 FINDING-4/5/6/7/8/9，docs/ROADMAP-GAPS-2026-11.md G4）：
 *   - FINDING-4：flash 段只下发 item/count，而没有任何页面读 item/count
 *     （全仓 get('item') 零命中）→ 一支片子里 4 个快闪段是同一画面放 4 遍。
 *   - FINDING-7（S9 病根）：spec.flash.words 不被 schema/校验/plan 任何一环
 *     承认；deriveFromScript 的 flash 分支丢掉 b.copy；空串词经 query() 的
 *     v!=='' 闸门后回落到内建「想做」。
 *   - FINDING-6：改 audio.bpm 后所有段 segmentHash 不变（90BPM 的片子逐字
 *     仍按 120 跳，且缓存全命中）；recipe-generative 读 ?bpm 但 plan 从不下发。
 *   - FINDING-5：big-card.html 硬编 window.DURATION=1.0 且 renderFrame 直接
 *     clamp(u,0,1)——0.5s 的 flash 烧进半截入场动画，1.5s 的卡后 0.5s 冻结。
 *   - FINDING-9：logo 只进 meta.brandKit 不进 spec.assets/段哈希面——同路径
 *     换 logo 字节，段缓存不失效；card/more/flash URL 还没有 brandParams。
 *
 * 断言（对应任务书的 ①–⑤ + A–F 扩展）：
 *   ① flash 段 URL 必带 first 且 first ∈ words（words 取词，count 循环复用）。
 *   ② count=4 且给 ≥4 词时，4 段的 first / layout 互不相同，段哈希 4 个不同
 *      （同一支片子放 4 遍的病根从 URL 与像素两面堵死）。
 *   ③ words 含空串/纯空白/超 8 码点/非数组/超上限 → E_FLASH_WORDS；
 *      flash 块未知键 → E_UNKNOWN_FIELD（FLASH_KEYS 白名单）。
 *   ④ audio.bpm 120→90（flash.each 固定、帧数不变）→ 段哈希必须变，
 *      且 style 段 URL 带 ?bpm=。
 *   ⑤ deriveFromScript 的 flash 分支必须消费 b.copy → spec.flash.words。
 *   ⑥ words<count → W_FLASH_WORDS_REUSE；words>count → W_FLASH_WORDS_UNUSEED；
 *      count=0 但给了 words → W_FLASH_DEAD（validateSpec 层，plan 不哑吞）。
 *   ⑦ flash 段 URL 带 seconds（plan 把段时长下发给页面时钟）；
 *      big-card 源码必须读 ?seconds/?dur 并以它驱动 renderFrame（无浏览器下
 *      做源码级契约断言：不再出现 `window.DURATION = 1.0` 硬编）。
 *   ⑧ flash 段与 card/more 段一样携带 brand/logo/brandFont（big-card 支持 ?logo=）。
 *   ⑨ 同一 logo 路径、字节不同 → 段哈希必须不同（缓存假绿面）。
 *   ⑩ templates/segment.html（new-project 的 flash.html 母本）必须读 ?first，
 *      否则 S9 只修了 big-card 一半，新工程照样踩（任务书 B.5 选的修法）。
 *
 * 退出码 0/1。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

import { normalizeSpec, validateSpec, deriveFromScript, MAX_FLASH_COUNT } from '../templates/spec.mjs';
import { buildPlanFromSpec } from '../templates/plan.mjs';
import { buildPlan } from '../templates/timeline.mjs';
import { query, resolveFlashEach } from '../templates/timeline-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { failed++; console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}

const q = (page) => new URLSearchParams(String(page).split('?')[1] || '');

function spec(mutate = () => {}) {
  const s = {
    specVersion: 1,
    meta: { name: 'flash-test', brand: 'ACME', title: '测试片', locale: 'zh-CN' },
    format: { width: 1920, height: 1080, fps: 30, aspect: '16:9', duration: null },
    look: { mode: 'showcase', style: null, theme: 'coral-noir', accentOverride: null, motion: null },
    audio: { mood: 'electronic', bpm: 120, vo: null },
    structure: { opening: 1, round: 2, card: 1, ending: 1, moreCard: 1, flash: { count: 4, each: 0.5 } },
    opening: { page: 'templates/segment.html' },
    rounds: [{
      id: 'r01', name: '快闪测试轮',
      card: { page: 'templates/big-card.html', first: '想要', keyword: '快闪？' },
      style: { page: 'templates/recipe-generative.html', recipe: 'generative' },
    }],
    moreCard: { page: 'templates/big-card.html', first: '还有', keyword: '更多？' },
    flash: { page: 'templates/big-card.html', words: ['甲', '乙', '丙', '丁'] },
    ending: { page: 'templates/segment.html' },
    assets: [],
    patches: [],
    render: { quality: 'master', preset: 'bilibili', concurrency: 2, outDir: 'out' },
  };
  mutate(s);
  return s;
}

const codesOf = (iss) => iss.filter((i) => i.level === 'error').map((i) => i.code);
const issue = (iss, code, at = null) =>
  iss.find((i) => i.code === code && (at === null || i.path === at));

// 临时目录（⑨ finally 清理用）。root 仍是仓库（页面路径要能解析）。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-g4-'));

// ── ① flash 段 URL 带 first 且 first ∈ words ────────────────────────────────

test('① flash 段 URL 带 ?first= 且逐段取自 words（模循环）', () => {
  const { plan } = buildPlanFromSpec(spec(), { root: ROOT });
  const words = ['甲', '乙', '丙', '丁'];
  const flash = plan.segments.filter((s) => s.kind === 'flash');
  assert.equal(flash.length, 4, 'flash 段数应等于 structure.flash.count');
  flash.forEach((s, i) => {
    const p = q(s.page);
    assert.equal(p.get('first'), words[i % words.length], `${s.id}: first 应为 words[${i}]，实际 ${p.get('first')}`);
    assert.equal(p.get('keyword'), words[i % words.length], `${s.id}: keyword 应与 first 同源`);
  });
});

test('①b 词两端空白被裁掉后才下发（S9 病根：query() 丢空串 → 回落内建「想做」）', () => {
  const { plan } = buildPlanFromSpec(spec((v) => { v.flash.words = [' 快 ', ' 闪 ', '文', '案']; }), { root: ROOT });
  for (const s of plan.segments.filter((x) => x.kind === 'flash')) {
    assert.ok(String(s.page).includes('first='), `${s.id}: flash URL 缺 first 参数`);
    assert.notEqual(q(s.page).get('first'), '', `${s.id}: first 不得为空串`);
  }
  assert.deepEqual(
    plan.segments.filter((x) => x.kind === 'flash').map((x) => q(x.page).get('first')),
    ['快', '闪', '文', '案'],
  );
});

// ── ② 四段各异：first/layout 互不相同，段哈希 4 个不同 ──────────────────────

test('② count=4：四段的 first、layout、URL、段哈希全部互不相同（不再是同一支片子放4遍）', () => {
  const { plan } = buildPlanFromSpec(spec(), { root: ROOT });
  const flash = plan.segments.filter((s) => s.kind === 'flash');
  assert.equal(new Set(flash.map((s) => q(s.page).get('first'))).size, 4, 'first 未逐段取词');
  assert.equal(new Set(flash.map((s) => q(s.page).get('layout'))).size, 4, 'layout 未轮转（i%4）');
  assert.equal(new Set(flash.map((s) => s.page)).size, 4, 'flash URL 未逐段各异');
  assert.equal(new Set(flash.map((s) => s.hash)).size, 4, 'flash 段哈希未逐段各异（缓存层仍会混拼）');
});

test('②b words 少于 count 时取模循环（甲乙甲乙），URL 仍 4 个不同', () => {
  const { plan } = buildPlanFromSpec(spec((v) => { v.flash.words = ['甲', '乙']; }), { root: ROOT });
  const flash = plan.segments.filter((s) => s.kind === 'flash');
  assert.deepEqual(flash.map((s) => q(s.page).get('first')), ['甲', '乙', '甲', '乙']);
  assert.equal(new Set(flash.map((s) => s.page)).size, 4, '取模循环后 layout/index 必须继续区分四段');
});

// ── ③ E_FLASH_WORDS / FLASH_KEYS 白名单 ─────────────────────────────────────

test('③ words 必须是字符串数组：非数组 → E_FLASH_WORDS', () => {
  const iss = validateSpec(normalizeSpec(spec((v) => { v.flash.words = '快闪'; })));
  assert.ok(codesOf(iss).includes('E_FLASH_WORDS'), JSON.stringify(iss.filter((i) => i.level === 'error')));
});

test('③ 空串 / 纯空白词 → E_FLASH_WORDS（否则 query() 丢值回落内建「想做」）', () => {
  for (const bad of [['', '好词'], ['   ', '好词'], ['好词', ' ']]) {
    const iss = validateSpec(normalizeSpec(spec((v) => { v.flash.words = bad; })));
    assert.ok(codesOf(iss).includes('E_FLASH_WORDS'), `words=${JSON.stringify(bad)} 未被拒`);
  }
});

test('③ 单词超过 8 个码点 → E_FLASH_WORDS；8 码点边界与代理对必须放行', () => {
  const iss = validateSpec(normalizeSpec(spec((v) => { v.flash.words = ['一二三四五六七八九']; })));
  assert.ok(codesOf(iss).includes('E_FLASH_WORDS'), '9 码点词未被拒');
  const ok = validateSpec(normalizeSpec(spec((v) => { v.flash.words = ['一二三四五六七八']; })));
  assert.ok(!codesOf(ok).includes('E_FLASH_WORDS'), '8 码点合法词被误拒');
  // 代理对：8 个 emoji = 16 个 UTF-16 单元、8 码点——必须放行（防劈代理对）
  const emoji = validateSpec(normalizeSpec(spec((v) => { v.flash.words = ['😀😀😀😀😀😀😀😀']; })));
  assert.ok(!codesOf(emoji).includes('E_FLASH_WORDS'), '8 码点 emoji 被误拒');
  const emoji9 = validateSpec(normalizeSpec(spec((v) => { v.flash.words = ['😀😀😀😀😀😀😀😀😀']; })));
  assert.ok(codesOf(emoji9).includes('E_FLASH_WORDS'), '9 码点 emoji 未被拒');
});

test('③ words 数量超过 MAX_FLASH_COUNT → E_FLASH_WORDS', () => {
  const iss = validateSpec(normalizeSpec(spec((v) => { v.flash.words = Array(MAX_FLASH_COUNT + 1).fill('词'); })));
  assert.ok(codesOf(iss).includes('E_FLASH_WORDS'));
});

test('③ flash 块未知字段 → E_UNKNOWN_FIELD（FLASH_KEYS 白名单）', () => {
  const iss = validateSpec(normalizeSpec(spec((v) => { v.flash.wordz = ['typo']; })));
  assert.ok(codesOf(iss).includes('E_UNKNOWN_FIELD'), JSON.stringify(iss.filter((i) => i.level === 'error')));
  // 白名单内键必须放行
  const ok = validateSpec(normalizeSpec(spec((v) => {
    v.flash.words = ['词']; v.flash.layout = 2; v.flash.first = '首'; v.flash.keyword = '键';
    v.flash.color = '#ffcf5c'; v.flash.name = '快闪'; v.flash.params = { x: '1' };
  })));
  assert.ok(!codesOf(ok).includes('E_UNKNOWN_FIELD'), JSON.stringify(ok.filter((i) => i.code === 'E_UNKNOWN_FIELD')));
});

// ── ④ bpm 进 URL + 进哈希 ───────────────────────────────────────────────────

test('④ bpm 120→90（帧数不变）→ 全部段哈希变化，style URL 带 ?bpm=90', () => {
  const a = buildPlanFromSpec(spec(), { root: ROOT }).plan;
  const b = buildPlanFromSpec(spec((v) => { v.audio.bpm = 90; }), { root: ROOT }).plan;
  // 帧边界一致（flash.each 显式给出，结构总时长不随 bpm 变）——证明哈希差异
  // 来自 bpm 本身而非帧数变化的巧合。
  assert.deepEqual(a.segments.map((s) => s.frames), b.segments.map((s) => s.frames));
  for (const s of a.segments) {
    const t = b.segments.find((x) => x.id === s.id);
    assert.notEqual(t.hash, s.hash, `${s.id}: bpm 变更未进段哈希`);
  }
  const style = b.segments.find((s) => s.kind === 'style');
  assert.equal(q(style.page).get('bpm'), '90', 'style 段 URL 未下发 ?bpm=');
});

test('④b 不传 bpm 的旧 timeline v1 URL 逐字节不变（bpm 下发只在 specMode）', () => {
  const v1 = {
    version: 1,
    meta: { title: 'legacy', fps: 30, bpm: 120 },
    structure: { opening: 1, round: 2, card: 1, ending: 1, moreCard: 1, flash: { count: 2, each: 0.5 } },
    rounds: [{ id: 'r01', name: 'a', card: { page: 'templates/big-card.html' }, style: { page: 'templates/segment.html' } }],
    flash: { page: 'templates/big-card.html' },
  };
  const plan = buildPlan(v1, { root: ROOT });
  const style = plan.segments.find((s) => s.kind === 'style');
  assert.equal(q(style.page).get('bpm'), null, 'v1 style URL 混入了 ?bpm（golden 兼容破坏）');
  const flash = plan.segments.find((s) => s.kind === 'flash');
  assert.equal(q(flash.page).get('first'), null, 'v1 flash URL 混入了 ?first（golden 兼容破坏）');
});

// ── ⑤ deriveFromScript 消费 flash copy ──────────────────────────────────────

test('⑤ 剧本 flash 块的 copy 累积进 flash.words（S9 闭环起点）', () => {
  const script = [
    { role: 'flash', t: [0, 0.5], copy: ['快', '闪'] },
    { role: 'flash', t: [0.5, 1.0], copy: ['文', '案'] },
  ];
  // count 从显式 0 起算钉住「每块 +1」的既有语义（空 base 会从
  // DEFAULT_STRUCTURE.flash.count=8 起步——那是历史行为，不在本切片改动面）。
  const derived = deriveFromScript(script, { structure: { flash: { count: 0, each: 0.5 } } });
  assert.deepEqual(derived.flash.words, ['快', '闪', '文', '案']);
  assert.equal(derived.structure.flash.count, 2);
  // 空 base：words 累积仍要成立（count 起点是历史语义，只查单调增长）
  const d2 = deriveFromScript(script, {});
  assert.deepEqual(d2.flash.words, ['快', '闪', '文', '案']);
  assert.ok(d2.structure.flash.count >= 2);
});

test('⑤b 端到端：script spec → normalizeSpec → words 进 plan URL 且校验通过', () => {
  const s = spec((v) => {
    delete v.rounds;
    v.flash = { page: 'templates/big-card.html' };
    v.script = [
      { role: 'opening', t: [0, 1], page: 'templates/segment.html' },
      { role: 'card', t: [1, 2], copy: ['想要', '快闪？'], page: 'templates/big-card.html' },
      { role: 'scene', t: [2, 4], page: 'templates/recipe-generative.html', recipe: 'generative', name: '轮一' },
      { role: 'more', t: [4, 5], page: 'templates/big-card.html', copy: ['还有', '更多？'] },
      { role: 'flash', t: [5, 5.5], copy: ['快'] },
      { role: 'flash', t: [5.5, 6], copy: ['闪'] },
      { role: 'flash', t: [6, 6.5], copy: ['文'] },
      { role: 'flash', t: [6.5, 7], copy: ['案'] },
      { role: 'ending', t: [7, 8], page: 'templates/segment.html' },
    ];
    v.structure = { opening: 1, round: 2, card: 1, ending: 1, moreCard: 1, flash: { count: 0, each: 0.5 } };
  });
  const norm = normalizeSpec(s);
  const iss = validateSpec(norm);
  assert.deepEqual(codesOf(iss), [], JSON.stringify(iss.filter((i) => i.level === 'error')));
  assert.deepEqual(norm.flash.words, ['快', '闪', '文', '案']);
  const { plan } = buildPlanFromSpec(s, { root: ROOT });
  assert.deepEqual(
    plan.segments.filter((x) => x.kind === 'flash').map((x) => q(x.page).get('first')),
    ['快', '闪', '文', '案'],
  );
});

// ── ⑥ W_FLASH_* 三态警告 ────────────────────────────────────────────────────

test('⑥ words<count → W_FLASH_WORDS_REUSE；words>count → W_FLASH_WORDS_UNUSED；count=0 给 words → W_FLASH_DEAD', () => {
  const reuse = validateSpec(normalizeSpec(spec((v) => { v.flash.words = ['甲']; })));
  assert.ok(reuse.some((i) => i.code === 'W_FLASH_WORDS_REUSE'), '取模循环没有留痕警告');
  const unused = validateSpec(normalizeSpec(spec((v) => { v.flash.words = ['甲', '乙', '丙', '丁', '戊', '己']; })));
  assert.ok(unused.some((i) => i.code === 'W_FLASH_WORDS_UNUSED'), '多余词没有留痕警告');
  const dead = validateSpec(normalizeSpec(spec((v) => {
    v.structure.flash.count = 0; v.flash.words = ['甲'];
  })));
  assert.ok(dead.some((i) => i.code === 'W_FLASH_DEAD'), 'count=0 仍给 words 没有留痕警告');
});

// ── ⑦ flash 段下发 seconds；big-card 时钟不再硬编 1.0 ──────────────────────

test('⑦ flash 段 URL 带 ?seconds=（= 段时长），card/more 也带', () => {
  const { plan } = buildPlanFromSpec(spec(), { root: ROOT });
  for (const s of plan.segments.filter((x) => ['flash', 'card', 'more'].includes(x.kind))) {
    const sec = Number(q(s.page).get('seconds'));
    assert.ok(sec > 0, `${s.id} 未带正数 ?seconds=`);
  }
  const flash = plan.segments.find((s) => s.kind === 'flash');
  assert.equal(Number(q(flash.page).get('seconds')), resolveFlashEach(normalizeSpec(spec())));
});

test('⑦b big-card 源码契约：读 ?seconds/?dur 驱动时钟，不再硬编 window.DURATION = 1.0', () => {
  const src = fs.readFileSync(path.join(ROOT, 'templates/big-card.html'), 'utf8');
  assert.ok(/get\(['"]seconds['"]\)/.test(src), 'big-card 未读 ?seconds');
  assert.ok(/get\(['"]dur['"]\)/.test(src), 'big-card 未读 ?dur（createSegment 先例）');
  assert.ok(!/window\.DURATION\s*=\s*1\.0\s*;/.test(src), 'big-card 仍硬编 window.DURATION = 1.0');
  assert.ok(/clamp\(\s*u\s*\/\s*DURATION\s*,\s*0\s*,\s*1\s*\)/.test(src), 'renderFrame 未按 DURATION 归一时钟（0.5s 半截动画 / 1.5s 冻结）');
});

// ── ⑧ brandParams 覆盖 card/more/flash（big-card 支持 ?logo=/?brandFont=） ──

test('⑧ card/more/flash URL 带 brand/logo/brandFont', () => {
  const rel = 'out/g4-test-logo.png';
  const abs = path.join(ROOT, rel);
  fs.writeFileSync(abs, Buffer.from('89504e470d0a1a0a', 'hex'));
  try {
    const { plan } = buildPlanFromSpec(spec((v) => {
      v.meta.brandKit = { logo: { path: rel }, fonts: { heading: 'TestSerif' } };
    }), { root: ROOT });
    for (const s of plan.segments.filter((x) => ['card', 'more', 'flash'].includes(x.kind))) {
      const p = q(s.page);
      assert.equal(p.get('brand'), 'ACME', `${s.id}: 缺 brand`);
      assert.equal(p.get('logo'), rel, `${s.id}: 缺 logo`);
      assert.equal(p.get('brandFont'), 'TestSerif', `${s.id}: 缺 brandFont`);
    }
  } finally {
    fs.rmSync(abs, { force: true });
  }
});

// ── ⑨ logo 字节变更 → 段哈希必须变（缓存失效面） ────────────────────────────

test('⑨ 同路径换 logo 字节：全部段哈希失效（FINDING-9 假绿面）', () => {
  const rel = 'out/g4-test-logo-hash.png';
  const abs = path.join(ROOT, rel);
  const mk = () => spec((x) => { x.meta.brandKit = { logo: { path: rel }, fonts: { heading: 'TestSerif' } }; });
  fs.writeFileSync(abs, Buffer.from('89504e470d0a1a0a0000000d4948445201', 'hex'));
  const p1 = buildPlanFromSpec(mk(), { root: ROOT }).plan;
  fs.writeFileSync(abs, Buffer.from('89504e470d0a1a0a0000000d4948445202', 'hex'));
  const p2 = buildPlanFromSpec(mk(), { root: ROOT }).plan;
  try {
    for (const s of p1.segments) {
      const t = p2.segments.find((x) => x.id === s.id);
      assert.notEqual(t.hash, s.hash, `${s.id}: logo 字节变更未失效段缓存`);
    }
  } finally {
    fs.rmSync(abs, { force: true });
    fs.rmSync(TMP, { recursive: true, force: true });
  }
});

// ── ⑩ segment.html（new-project flash.html 母本）必须读 ?first ──────────────

test('⑩ templates/segment.html 读 ?first（new-project 的 flash 页与 big-card 同步闭环）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'templates/segment.html'), 'utf8');
  assert.ok(/get\(['"]first['"]\)/.test(src), 'segment.html 不读 ?first：new-project 的 flash.html 仍会吃内建默认词');
});

// ── query() 助手语义不回归（first 空串被丢的行为必须留在原处并被闸挡住） ────

test('辅助：query 丢空串（因此 E_FLASH_WORDS 必须在 spec 层拦空词）', () => {
  assert.equal(query('p.html', { first: '' }), 'p.html');
  assert.equal(query('p.html', { first: '词' }), 'p.html?first=%E8%AF%8D');
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
