#!/usr/bin/env node
/**
 * test-motionmd.mjs — G10/S3-4 spec⇄Motion.md 互转的回归闸（builder 第三棒）。
 *
 *   cvs motionmd <spec.json> [--out f.md]     spec → 五维（hook/shot/pacing/type/sound）markdown
 *   cvs motionmd --parse <f.md> [--json]      markdown → spec patch **建议**（绝不回写 spec）
 *
 * 约定：模板文本自写（借 OpenMotion 五维 rubric 的名目，不引入其实现）；派生数据
 * 只读现有 spec/plan.json 字段。断言面：五段齐、关键值来自 fixture、解析映射正确、
 * 非法值只出 warnings 不出坏建议、纯函数确定性、CLI 与 bin/cvs.mjs 动词接通、
 * --parse 不改 spec 文件字节。
 *
 * 汇总格式对齐 summary-parse：末行 "N passed, M failed"，退出码 0/1。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let passed = 0;
let failed = 0;
async function ok(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e && e.message || e}`); failed++; }
}

const { specToMotionMarkdown, parseMotionMarkdown } = await import('../scripts/motionmd.mjs');
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'mini-41s', 'spec.json'), 'utf8'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-motionmd-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

// ── 1. spec → markdown ──────────────────────────────────────────────────────
const md = specToMotionMarkdown(spec);

await ok('M1 five-dimension sections all present', () => {
  for (const sec of ['hook', 'shot', 'pacing', 'type', 'sound']) {
    assert.match(md, new RegExp(`^## ${sec}`, 'm'), `missing ## ${sec} section`);
  }
});

await ok('M2 derived values come from spec fields, not invented', () => {
  assert.match(md, /- bpm: 120/);                 // audio.bpm
  assert.match(md, /- theme: coral-noir/);        // look.theme
  assert.match(md, /- total: 41/);                // format.duration / specDuration
  assert.match(md, /- opening: 8/);               // structure.opening
  assert.match(md, /- mood: electronic/);         // audio.mood
  assert.match(md, /- rounds: 6/);                // rounds.length
});

await ok('M3 parse maps back to spec paths (patch suggestions)', () => {
  const { suggestions } = parseMotionMarkdown(md);
  const byPath = new Map(suggestions.map((s) => [s.path, s]));
  assert.equal(byPath.get('audio.bpm').value, 120);
  assert.equal(byPath.get('look.theme').value, 'coral-noir');
  assert.equal(byPath.get('structure.opening').value, 8);
  assert.equal(byPath.get('format.duration').value, 41);
  assert.equal(byPath.get('audio.mood').value, 'electronic');
  for (const s of suggestions) {
    assert.ok(s.reason, '每条建议必须带出处理由');
    assert.ok('source' in s, '每条建议必须标明来源维度');
    assert.ok(typeof s.path === 'string' && s.path.includes('.'), '建议必须给 spec 字段路径');
  }
});

await ok('M4 invalid enum/color values degrade to warnings, never bad suggestions', () => {
  const broken = md
    .replace(/- motion: (\S+)/, '- motion: turbo-max')
    .replace(/- accent: (\S+)/, '- accent: not-a-color');
  const { suggestions, warnings } = parseMotionMarkdown(broken);
  const paths = suggestions.map((s) => s.path);
  assert.ok(!paths.includes('look.motion') || suggestions.find((s) => s.path === 'look.motion') == null, '非法 motion 不该成建议');
  assert.ok(!paths.includes('look.accentOverride'), '非法 accent 不该成建议');
  assert.ok(warnings.length >= 2, `expect ≥2 warnings, got ${warnings.length}: ${JSON.stringify(warnings)}`);
});

await ok('M5 pure & deterministic: same spec → byte-identical markdown', () => {
  assert.equal(specToMotionMarkdown(JSON.parse(JSON.stringify(spec))), md);
});

await ok('M6 parse tolerates free prose: unknown sections listed as ignored', () => {
  const { suggestions, ignored } = parseMotionMarkdown(md + '\n## vibes\n- hue: chartreuse\n- vibe: 松弛\n');
  assert.ok(ignored.some((i) => String(i).includes('vibes')), `ignored=${JSON.stringify(ignored)}`);
  // 未映射 bullet 不能变成建议
  assert.ok(!suggestions.some((s) => String(s.value) === 'chartreuse'));
});

// ── 2. CLI ──────────────────────────────────────────────────────────────────
const mdOut = path.join(tmp, 'mini.Motion.md');
await ok('M7 CLI: cvs motionmd <spec> --out <f> writes the five-dim doc', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'cvs.mjs'), 'motionmd', path.join(ROOT, 'fixtures', 'mini-41s', 'spec.json'), '--out', mdOut], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 0, `exit=${r.status} err=${r.stderr}`);
  const txt = fs.readFileSync(mdOut, 'utf8');
  assert.match(txt, /^## hook/m);
  assert.match(txt, /^## sound/m);
});

await ok('M8 CLI: --parse --json prints suggestions and leaves the source spec untouched', () => {
  const specCopy = path.join(tmp, 'spec-copy.json');
  fs.copyFileSync(path.join(ROOT, 'fixtures', 'mini-41s', 'spec.json'), specCopy);
  const before = fs.readFileSync(specCopy, 'utf8');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'cvs.mjs'), 'motionmd', '--parse', mdOut, '--json'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 0, `exit=${r.status} err=${r.stderr}`);
  const j = JSON.parse(String(r.stdout).trim().split('\n').pop());
  assert.ok(Array.isArray(j.suggestions) && j.suggestions.length >= 5);
  assert.equal(fs.readFileSync(specCopy, 'utf8'), before, 'parse 模式绝不写 spec');
});

await ok('M9 CLI: missing spec / unknown flag exit 2 (usage), raw script not the bin sugar', () => {
  // bin/cvs.mjs 的 `a.length ? a : ['--help']` 与其它动词同约定（裸命令=打帮助退 0）；
  // 用法错误断言打在真实入口 scripts/motionmd.mjs 上。
  const r1 = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'motionmd.mjs')], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r1.status, 2, `no-arg should exit 2, got ${r1.status}`);
  const r2 = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'motionmd.mjs'), '--wat'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r2.status, 2, `unknown flag should exit 2, got ${r2.status}: ${r2.stderr}`);
});

await ok('M10 bin help lists motionmd verb', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'cvs.mjs'), 'help'], { encoding: 'utf8', cwd: ROOT });
  assert.match(r.stdout, /motionmd/);
});

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
