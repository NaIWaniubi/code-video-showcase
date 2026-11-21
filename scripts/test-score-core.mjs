#!/usr/bin/env node
/**
 * test-score-core.mjs — R24-W 主观质量评分的纯函数回归。
 */
import assert from 'node:assert/strict';
import { motionDensity, chromaSpread, pacingScore, cueSyncScore, overallScore } from './lib/score-core.mjs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}

const gray = (vals) => {
  const fb = 96 * 96;
  const out = [];
  for (let f = 0; f < vals.length; f++) for (let i = 0; i < fb; i++) out.push(vals[f]);
  return Buffer.from(out);
};

test('motionDensity：无位移→0，两帧黑白反转→满灰度差，太少帧→null', () => {
  assert.equal(motionDensity(gray([10, 10])).value, 0, '静止片应 0');
  const fb = 96 * 96;
  const a = Buffer.from(Array(fb).fill(30));
  const b = Buffer.from(Array(fb).fill(200));
  const v = motionDensity(Buffer.concat([a, b])).value;
  assert.ok(Math.abs(v - 170/255) < 0.01, `归一化后应≈0.667，得 ${v}`);
  assert.equal(motionDensity(Buffer.alloc(96)).value, null);
});

test('chromaSpread：色板丰富（c 大）→分高；单色板→低', () => {
  const rich = chromaSpread([
    { l: 0.9, c: 0.3, h: 200 }, { l: 0.5, c: 0.25, h: 30 }, { l: 0.2, c: 0.2, h: 300 },
  ]);
  assert.ok(rich.value > 0.55, `rich=${rich.value}`);
  const flat = chromaSpread([{ l: 0.5, c: 0.01, h: 100 }, { l: 0.51, c: 0.012, h: 101 }]);
  assert.ok(flat.value < 0.4, `flat=${flat.value}`);
});

test('pacingScore：切点间隔均匀→高分；无证据→0.25 降级', () => {
  assert.ok(pacingScore([1, 2, 3, 4], 10).value >= 0.99, '均匀间隔应≈1');
  assert.ok(pacingScore([1, 2, 3, 4], 10).value <= 1);
  assert.equal(pacingScore([], 10).value, 0.25, '无切点无闪白→0.25');
});

test('cueSyncScore：对齐率从 qa-audio JSON 取，不读数→null 如实报', () => {
  const j = { cues: [{ pass: true }, { pass: true }, { pass: false }] };
  assert.ok(Math.abs(cueSyncScore(j).value - (2 / 3)) < 1e-6, "cue ratio");
  assert.equal(cueSyncScore(null).value, null);
});

test('overallScore：全维满分→A；缺维按 0.5 中性代入', () => {
  const top = overallScore({ motion: { value: 1 }, chroma: { value: 1 }, pacing: { value: 1 }, sync: { value: 1 }, title: { value: 1 } });
  assert.equal(top.total, 1);
  assert.equal(top.grade, 'A');
  const half = overallScore({ motion: { value: 1 }, chroma: null, pacing: { value: 0.3 }, sync: null, title: null });
  // 0.2·1 + 0.15·0.5 + 0.3·0.3 + 0.25·0.5 + 0.1·0.5
  assert.ok(Math.abs(half.total - (0.2 + 0.075 + 0.09 + 0.125 + 0.05)) < 1e-9, `got ${half.total}`);
});

console.log(`\n${passed} checks passed`);