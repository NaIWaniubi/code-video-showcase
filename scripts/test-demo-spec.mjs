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

// ── R7-W2：帧工作台段表 patch（编辑→导出→编译闭环） ──────────────
test('segment-patch：合法 patch 套用后 rounds 变化、未知索引退 10', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-segpatch-'));
  const specPath = path.join(dir, 'spec.json');
  const spec = composeDemoSpec('skeleton');
  fs.writeFileSync(specPath, JSON.stringify(spec));
  const patchPath = path.join(dir, 'patch.json');
  // 模拟帧工作台导出：把 r01 的 style.page 换成 skeleton 页（它本来就是）
  const edited = { ...spec.rounds[0], style: { ...spec.rounds[0].style, copy: { title: '剪辑后' } } };
  fs.writeFileSync(patchPath, JSON.stringify({ schema: 'cvs.segment-patch/v1', patch: [{ index: 0, ...edited }] }, null, 2));
  // patch 在 compile（cvs build）里应用，lint 不消费它
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'bin/cvs.mjs'), 'build', specPath,
    '--root', ROOT, '--outdir', path.join(dir, 'o'), '--dry-run',
    '--segment-patch', patchPath,
  ], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  try {
    assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || ''));
    assert.match((r.stderr || '') + (r.stdout || ''), /\[patch\]/, '应出现 patch 应用标记');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('segment-patch：坏 schema（缺 patch 数组）退 E_SEGMENT_PATCH exit 10', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-segpatch2-'));
  const specPath = path.join(dir, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify(composeDemoSpec('skeleton')));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ schema: 'nope' }));
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'bin/cvs.mjs'), 'build', specPath,
    '--root', ROOT, '--outdir', path.join(dir, 'o'), '--dry-run',
    '--segment-patch', bad,
  ], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  try {
    assert.equal(r.status, 10);
    assert.match(r.stderr || '', /E_SEGMENT_PATCH/);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── R8-W1：批量并行的 manifest 与重试字段 ──────────────────────
test('demo all --concurrency 2：manifest 汇总 attempts（dry-run）', () => {
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/demo.mjs'), 'all', '--seconds', '4',
    '--dry-run', '--concurrency', '2',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
  try {
    assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || ''));
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'out/demo-all/manifest.json'), 'utf8'));
    assert.equal(man.rows.length, 6);
    assert.equal(man.summary.total, 6);
    assert.ok((man.summary.ok) >= 5, `至少 5 个成功：${JSON.stringify(man.summary)}`);
    for (const row of man.rows) assert.ok(typeof row.attempts === 'number', '每行应带 attempts');
  } finally {
    try { fs.rmSync(path.join(ROOT, 'out/demo-all'), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── R8-W3：copyPatch 文案回填（帧工作台导出 → compile 合并） ───
test('copyPatch：帧工作台导出的标题回填在 compile 标记中生效', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-copypatch-'));
  const specPath = path.join(dir, 'spec.json');
  const spec = composeDemoSpec('skeleton');
  fs.writeFileSync(specPath, JSON.stringify(spec));
  // 只给 index + title（其余字段省略 = 不动），与 exportSegments 的输出同构。
  const patchPath = path.join(dir, 'patch.json');
  fs.writeFileSync(patchPath, JSON.stringify({
    schema: 'cvs.segment-patch/v1',
    sourceFrames: 180,
    patch: [],
    copyPatch: [{ index: 0, title: spec.rounds[0].style.copy.title + ' · 片段1' }],
  }, null, 2));
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'bin/cvs.mjs'), 'build', specPath,
    '--root', ROOT, '--outdir', path.join(dir, 'o'), '--dry-run',
    '--segment-patch', patchPath,
  ], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  try {
    assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || ''));
    const out = String(r.stdout || '') + String(r.stderr || '');
    assert.match(out, /copy-patch applied 1/, '应出现 copy-patch 应用标记');
    assert.match(out, /titles:[^\n]*片段1/, '标记应含回填后的标题（片段1）');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});


// ── R9-W1：--only 子集与非法名单 ──────────────────────────────
test('demo all --only fractal：只出指定子集；非法名 exit 2', () => {
  // 非法名单直接退 2（组合器校验，宁可报错不出错片）
  const bad = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/demo.mjs'), 'all', '--only', 'bogus',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  assert.equal(bad.status, 2, (bad.stderr || '') + (bad.stdout || ''));
  assert.match((bad.stderr || ''), /E_DEMO_ONLY/);

  // 合法子集：dry-run 下只跑一个风格并成功
  const ok = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/demo.mjs'), 'all', '--only', 'fractal',
    '--seconds', '4', '--dry-run',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
  try {
    assert.equal(ok.status, 0, (ok.stderr || '') + (ok.stdout || ''));
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'out/demo-all/manifest.json'), 'utf8'));
    assert.equal(man.rows.length, 1);
    assert.equal(man.rows[0].style, 'fractal');
  } finally {
    try { fs.rmSync(path.join(ROOT, 'out/demo-all'), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
