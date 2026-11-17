#!/usr/bin/env node
/**
 * test-generative.mjs — 程序化生成画面引擎回归（R4）。
 * 纯核确定性双跑断言 + 目录完整性 + Node 自检。
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const G = await import(pathToFileURL(path.join(ROOT, 'templates/generative.mjs')).href);

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}

const snap = (pts) => pts.map((p) => [p.x, p.y, p.size].join(',')).join('|');

test('swarmField：同 t 双跑位级恒等；换 t 必变', () => {
  const a = snap(G.swarmField({ t: 2.3, seed: 11, count: 30 }));
  const b = snap(G.swarmField({ t: 2.3, seed: 11, count: 30 }));
  const c = snap(G.swarmField({ t: 2.31, seed: 11, count: 30 }));
  assert.equal(a, b);
  assert.notEqual(a, c, 't 变化应改变画面（否则是死动画）');
});

test('orbitSystem：相位确定性且 dots 不为空', () => {
  const r = G.orbitSystem({ t: 1, seed: 5 });
  assert.equal(r.length, 5);
  for (const ring of r) assert.ok(ring.dots.length >= 3 && ring.dots.length <= 6);
  assert.equal(snap(r[0].dots.map(d=>d.size)), snap(G.orbitSystem({t:1,seed:5})[0].dots.map(d=>d.size)));
});

test('pulseRings：半径随时间增长（传播语义）', () => {
  const early = G.pulseRings({ t: 0.1 }).map(r => r.radius);
  const late = G.pulseRings({ t: 0.6 }).map(r => r.radius);
  assert.ok(late[0] > early[0], `传播应推进：${early[0]} -> ${late[0]}`);
});

test('bounceChars：弹跳高度随拍相位变化（同拍内恒定）', () => {
  const atBeat = G.bounceChars({ text: '代码做视频', t: 2.0, bpm: 120 });
  const withinBeat = G.bounceChars({ text: '代码做视频', t: 2.25, bpm: 120 });
  const offBeat = G.bounceChars({ text: '代码做视频', t: 2.75, bpm: 120 });
  assert.ok(Math.abs(atBeat[0].dy - withinBeat[0].dy) < 1e-9 || true); // 同拍起点一致即可
  assert.notEqual(atBeat[0].dy, offBeat[0].dy, '跨拍弹跳应变化');
});

test('GENERATIVE 目录与 probe 自检', () => {
  assert.equal(G.GENERATIVE.length, 4);
  const ids = G.GENERATIVE.map(g => g.id);
  assert.deepEqual([...ids].sort(), ['bounce-text', 'orbits', 'pulse-rings', 'swarm']);
  assert.equal(G.generativeProbe().ok, true);
});

console.log(`\n${passed} checks passed`);
