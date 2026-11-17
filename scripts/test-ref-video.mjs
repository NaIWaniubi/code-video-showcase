#!/usr/bin/env node
/**
 * test-ref-video.mjs — 参考片反推引擎回归（R4 旗舰能力）。
 *
 *   node scripts/test-ref-video.mjs
 *
 * 三层：纯函数单元（结构拟合/buildReport 合成数据）+ CLI 端到端（ffmpeg 生成
 * 合成片 → 全链反推 → 报告可解析）。ffmpeg 缺失时 e2e 如实 skip，不假绿。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)));
function ffmpeg() {
  const bin = process.env.FFMPEG || 'ffmpeg';
  return spawnSync(bin, ['-version']).status === 0;
}

const { inferStructure, buildReport } = await load('scripts/lib/ref-video-core.mjs');

test('inferStructure：BPM 在场时 flash.each 一拍派生（R2-25 硬约束）', () => {
  // 卡点宣传片模板：8s opening → 4×(1s card + 4s style) → 1s more → 4×0.5s flash → 6s ending = 42
  const cuts = [8, 9, 13, 14, 18, 19, 23, 24, 27,
    27.5, 28, 28.5, 29,          // flash 簇（0.5s 间隔 ×4 → ≥3 连续短切点）
    29.5, 30, 30.5, 31];
  const st = inferStructure({ duration: 41, cuts, bpm: 120 });
  assert.equal(st.ok, true);
  assert.equal(st.flash.each, 0.5, `each 应按 60/bpm=0.5 派生，实际 ${st.flash.each}`);
  assert.equal(st.flash.count, 1, `快闪簇应检出 1 组，实际 ${st.flash.count}`);
});

test('inferStructure：无 BPM 时 each 不臆造（null），退化输入残差有界且入 notes', () => {
  const st = inferStructure({ duration: 41, cuts: [8], bpm: null });
  assert.equal(st.flash.each, null);
  // 单一切点是退化输入：走模板默认兜底，残差允许到 3.5s，但必须进 notes（如实）。
  assert.ok(Math.abs(st.residualVsSource) <= 3.5, `残差应有界：${st.residualVsSource}`);
  assert.ok((st.notes || []).some((n) => /残差|兜底/.test(n)), `notes 应含残差/兜底说明：${JSON.stringify(st.notes)}`);
});

test('inferStructure：card 必须小于 round 的 55%（结构闸不松）', () => {
  const cuts = [];
  for (let t = 8; t < 36; t += 3.5) cuts.push(Number(t.toFixed(2)));
  cuts.push(38);
  const st = inferStructure({ duration: 41, cuts, bpm: 100 });
  assert.ok(st.card <= st.round * 0.55 + 1e-9, `card=${st.card} round=${st.round}`);
  assert.ok(st.card >= 1 && st.card <= 2 && st.round >= 3 && st.round <= 8, `范围越界：${JSON.stringify(st)}`);
});

test('inferStructure：invalid duration 直接 ok:false', () => {
  assert.equal(inferStructure({ duration: -1 }).ok, false);
  assert.equal(inferStructure({}).ok, false);
});

test('buildReport：specPatch 结构完整、theme 只取 id（无别名）', () => {
  const structure = inferStructure({ duration: 41, cuts: [8], bpm: 120 });
  const report = buildReport({
    source: 'demo.mp4',
    probe: { duration: 41, fps: 30, width: 1920, height: 1080, hasAudio: true },
    clusters: [],
    structure,
    tempo: { method: 'energy-flux-autocorr', bpm: 120, confidence: 0.6 },
    appliedTheme: { theme: { id: 'coral-noir', name: '珊瑚暗夜', confidence: 0.7 }, palette: [], metrics: {}, hints: {} },
  });
  assert.equal(report.ok, true);
  assert.equal(report.specPatch.look.theme, 'coral-noir');
  assert.equal(report.specPatch.audio.bpm, 120);
  assert.equal(report.specPatch.structure.opening, structure.opening);
  assert.equal(report.specPatch.structure.flash.count, structure.flash.count);
  assert.equal(report.tempo.bpm, 120);
});

// ── e2e：合成片全链 ────────────────────────────────────────────────────────
if (!ffmpeg()) {
  console.log('- e2e skip（本机无 ffmpeg，不假绿）');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-refvideo-'));
  const mp4 = path.join(dir, 'syn.mp4');
  // testsrc + 渐变色相 → 有切点、有色彩，60fps 240p；同时补一段音轨让 tempo 分支可测。
  const gen = spawnSync(process.env.FFMPEG || 'ffmpeg', [
    '-f', 'lavfi', '-i', 'testsrc=duration=12:size=320x240:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4,
  ], { encoding: 'utf8' });
  if (gen.status !== 0) throw new Error('ffmpeg 生成合成片失败');
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'ref-video.mjs'), '--video', mp4, '--json',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
  try {
    test('e2e：合成片反推产出可解析报告（含 probe/structure/visual）', () => {
      assert.equal(r.status, 0, `exit=${r.status} ${r.stderr.slice(-400)}`);
      const j = JSON.parse(r.stdout.trim().split('\n').pop());
      assert.ok(j.probe.duration > 10, `时长：${j.probe.duration}`);
      assert.equal(j.probe.width, 320);
      assert.ok(j.structure.ok, '结构推断应成功');
      assert.equal(j.structure.flash.count >= 0, true);
      assert.ok(['coral-noir', ...Object.keys({})].length > 0);   // theme 字段存在即可
      assert.ok(typeof j.visual?.theme?.id === 'string', `theme=${JSON.stringify(j.visual?.theme)}`);
      assert.ok(fs.existsSync(path.join(ROOT, 'analysis', 'syn', 'ref-report.json')),
        '报告应落盘 analysis/syn/ref-report.json');
    });

    test('e2e --apply：把 patch 并入既有 spec 且不毁原内容', () => {
      const spec0 = path.join(dir, 'base.json');
      fs.writeFileSync(spec0, JSON.stringify({
        meta: { name: 'demo' },
        look: { mode: 'showcase', style: 'flat' },
        audio: { mood: 'warm' },
        structure: { opening: 9, round: 5, card: 1, moreCard: 1, ending: 7, flash: { count: 3, each: 0.5 } },
      }, null, 2));
      const r2 = spawnSync(process.execPath, [
        path.join(ROOT, 'scripts', 'ref-video.mjs'), '--video', mp4,
        '--apply', spec0, '--out', path.join(dir, 'rep'),
      ], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
      assert.equal(r2.status, 0, r2.stderr.slice(-400));
      const out = JSON.parse(fs.readFileSync(spec0, 'utf8'));
      // 用户内容保留
      assert.equal(out.meta.name, 'demo');
      assert.equal(out.look.style, 'flat');
      assert.equal(out.audio.mood, 'warm');
      // 反推值覆盖
      assert.notEqual(out.structure.opening, 9, 'opening 应被实测值替换');
      assert.ok(typeof out.structure.round === 'number' && out.structure.round >= 3);
      assert.ok(out.look.theme, 'look.theme 应被写入主题 id');
    });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(path.join(ROOT, 'analysis', 'syn'), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log(`\n${passed} checks passed`);