#!/usr/bin/env node
/**
 * test-catalog.mjs — G11 分发实物的结构回归（不触发渲染）。
 * 钉死：demo 与目录 PNG 存在、体积预算内、被 git 跟踪（.gitignore 豁免真生效）、
 * catalog.html 条目数=教义画风数、README 不再自认「无成片」。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let passed = 0, failed = 0;
const test = (n, fn) => { try { fn(); passed++; console.log('✓ ' + n); } catch (e) { failed++; console.error('✗ ' + n + '\n  ' + (e.message || e)); process.exitCode = 1; } };

const doctrine = JSON.parse(fs.readFileSync(path.join(ROOT, 'content/style-doctrine.json'), 'utf8'));
const styleIds = Object.keys(doctrine.styles).filter((k) => !k.startsWith('$'));

test('旗舰 demo 存在、≤8MB、非空壳', () => {
  const f = path.join(ROOT, 'assets/demos/showcase-360.mp4');
  assert.ok(fs.existsSync(f), '先跑 node scripts/ship-demo.mjs');
  const b = fs.statSync(f).size;
  assert.ok(b > 200_000 && b <= 8 * 1024 * 1024, `size ${b} not in (200KB, 8MB]`);
});
test('demo 的 attestation 在且 digest 字段齐', () => {
  const f = path.join(ROOT, 'assets/demos/showcase-360.attestation.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(j.digest && j.layers && j.layers.frames && j.layers.container, 'attestation layers/digest present');
});
test('.gitignore 豁免生效：demo 与 catalog PNG 被 git 跟踪（不是被 *.mp4 吞掉的幽灵）', () => {
  const probe = (p) => {
    // 语义：不带 -v 的 check-ignore，exit 0=被忽略、1=不被忽略；
    // 带 -v 时对「被 !反向规则 豁免」的路径同样打印匹配行且可能返回 0——不可用于豁免断言。
    const r = spawnSync('git', ['check-ignore', '-q', p], { cwd: ROOT, encoding: 'utf8' });
    return r.status === 0; // 0 = 被忽略
  };
  assert.ok(!probe('assets/demos/showcase-360.mp4'), 'demo 不应被 ignore');
  assert.ok(!probe('assets/catalog/cyber-pixel.png'), 'catalog png 不应被 ignore');
  // git ls-files 断言留给发版后（git add 由主线程在合并提交时执行）；此处只验豁免语义。
});
test('catalog.html 条目数与教义画风数一致', () => {
  const html = fs.readFileSync(path.join(ROOT, 'assets/catalog.html'), 'utf8');
  for (const id of styleIds) {
    assert.ok(html.includes(`catalog/${encodeURIComponent(id)}.png`) || html.includes(`catalog/${id}.png`), `catalog 缺 ${id}`);
  }
  const figures = (html.match(/<figure/g) || []).length;
  assert.equal(figures, styleIds.length, `figure 数 ${figures} ≠ 画风数 ${styleIds.length}`);
});
test('README 不再自认无成片，且指向 demo/catalog', () => {
  const rm = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(!/There is no finished demo video/i.test(rm), 'README 仍写「无成片」');
  assert.ok(/assets\/demos\//.test(rm) && /assets\/catalog\.html/.test(rm), 'README 应指向 demo 与目录页');
  assert.ok(/attest/i.test(rm), 'README 应有 attest 线索');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
