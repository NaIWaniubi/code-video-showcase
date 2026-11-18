#!/usr/bin/env node
/**
 * test-demo-spec.mjs — `cvs demo` 组合器回归（纯函数 + --dry-run 透传冒烟）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const { composeDemoSpec } = await import(pathToFileURL(path.join(ROOT, 'scripts/lib/demo-spec.mjs')).href);

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}

test('闭合结构：D 公式与 format.duration 一致（不硬凑）', () => {
  for (const [style, secs] of [['skeleton', 6], ['firework', 8], ['wireframe', 12], ['terrain', 30]]) {
    const s = composeDemoSpec(style, { seconds: secs });
    const st = s.structure;
    const formula = st.opening + st.rounds * st.round + st.moreCard +
      st.flash.count * st.flash.each + st.ending;
    assert.ok(Math.abs(formula - s.format.duration) < 0.01,
      `${style}: formula ${formula} != duration ${s.format.duration}`);
  }
});

test('结构闸：card 明显小于 round；rounds 随时长双轮', () => {
  const short = composeDemoSpec('network', { seconds: 5 });
  assert.ok(short.structure.card < short.structure.round * 0.6);
  assert.equal(short.structure.rounds, 1);
  const long = composeDemoSpec('fractal', { seconds: 10 });
  assert.equal(long.structure.rounds, 2);
});

test('风格页指向真实模板文件', () => {
  for (const id of ['wireframe', 'skeleton', 'fractal', 'firework', 'terrain', 'network']) {
    const s = composeDemoSpec(id);
    assert.equal(s.rounds[0].style.page, `templates/recipe-${id}.html`,
      `${id}: page 不匹配`);
  }
});

test('未知风格 → E_UNKNOWN_STYLE（调用方路由到 usage exit 2）', () => {
  try { composeDemoSpec('nope'); assert.fail('应抛错'); }
  catch (e) { assert.equal(e.code, 'E_UNKNOWN_STYLE'); }
});

test('e2e：demo --dry-run 链（validate+plan 不过渲染）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-demo-'));
  const specPath = path.join(dir, 'project.spec.json');
  const spec = composeDemoSpec('skeleton');
  fs.writeFileSync(specPath, JSON.stringify(spec));
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/demo.mjs'), 'skeleton',
    '--outdir', path.join(dir, 'o'), '--dry-run',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  try {
    assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || ''));
    // compile 的 dry-run 标记走它的 stdout（demo 用 stdio inherit 透传）
    assert.match((r.stdout || '') + (r.stderr || ''), /\[dry-run\]/, '应出现 dry-run 停止标记');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

console.log(`\n${passed} checks passed`);
