#!/usr/bin/env node
/**
 * test-ref-compare.mjs — R22-W 复刻度量的纯函数回归。
 */
import assert from 'node:assert/strict';
import {
  matchCuts, rhythmSimilarity, frameColorSimilarity,
  paletteDistanceBetween, overallVerdict, CUT_TOL_SEC,
} from './lib/ref-compare-core.mjs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}

test('matchCuts：容差内对齐带帧偏移，越界判未命中、复刻多余切点计数', () => {
  const r = matchCuts([1, 2, 3], [1.1, 2.5, 5]);
  assert.equal(r.matched, 1, `只应命中 1（1→1.1）`);
  assert.equal(r.unmatched.length, 2, 'ref 的 2、3 未命中');
  assert.equal(r.extraRender, 2, '复刻片 2.5、5 是多余切点');
  assert.deepEqual(r.offsetsSec, [0.1]);
});

test('matchCuts：容差边界恰在 tol（半开区间语义，<=tol 算命中）', () => {
  const r = matchCuts([0], [CUT_TOL_SEC], { tol: CUT_TOL_SEC });
  assert.equal(r.matched, 1, '偏移恰等于容差应算命中');
});

test('rhythmSimilarity：同一间隔序列得满分', () => {
  const r = rhythmSimilarity([1, 2, 3], [1, 2, 3]);
  assert.ok(r.score >= 0.99, `同序列应≈1，得 ${r.score}`);
});

test('frameColorSimilarity：同缓冲=1，纯黑vs纯白=0，无帧可对=0+note', () => {
  const fb = 96 * 96 * 3;
  const buf = Buffer.from(Array.from({ length: fb }, (_, i) => (i * 7) % 256));
  assert.equal(frameColorSimilarity(buf, buf).similarity, 1);
  const black = Buffer.alloc(fb), white = Buffer.from(Array(fb).fill(255));
  assert.equal(frameColorSimilarity(black, white).similarity, 0);
  const empty = frameColorSimilarity(Buffer.alloc(0), buf);
  assert.equal(empty.similarity, 0);
  assert.match(empty.note, /no comparable frames/);
});

test('paletteDistanceBetween：同色板 distance=0 sim=1，缺一侧返回 null 如实报', () => {
  const a = [{ l: 0.5, a: 0.1, b: -0.1 }];
  assert.equal(paletteDistanceBetween(a, a).distance, 0);
  const miss = paletteDistanceBetween(a, []);
  assert.equal(miss.distance, null);
});

test('overallVerdict：无缺切+节奏高+帧像 → match；全崩 → mismatch', () => {
  const good = overallVerdict({
    durationDeltaSec: 0.05, cutMatch: { unmatched: [] },
    rhythm: { score: 0.9 }, frameSim: { similarity: 0.8 },
    palSim: { distance: 0.2, similarity: 0.9 },
  });
  assert.equal(good, 'match');
  const bad = overallVerdict({
    durationDeltaSec: 12, cutMatch: { unmatched: [{}, {}, {}] },
    rhythm: { score: 0.1 }, frameSim: { similarity: 0.05 },
    palSim: { distance: 1.19, similarity: 0.01 },
  });
  assert.equal(bad, 'mismatch');
});

console.log(`\n${passed} checks passed`);