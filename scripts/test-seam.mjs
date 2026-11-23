#!/usr/bin/env node
/**
 * test-seam.mjs — G10/S3-3 波次的回归闸（builder 第三棒，2026-11-24）。
 *
 * 覆盖三件事（同属一批静态闸改动，共用一个套件避免 test-all 再膨胀）：
 *   A. seam gate：templates/plan.mjs 导出 seamDirectionIssues + CLI 行为
 *      —— 相邻段「入场运动向量」不一致 → W_SEAM_DIRECTION（默认 warn 不拦，
 *      --strict 拦 exit 10）。向量语义取自仓内既有定义：
 *      motion-profile.mjs MOTION_PROFILES[level].transition（入场转场）
 *      → motion.js transitionParams(name, 0) 的初始位移 {x, y}。
 *   B. E_VIDEO_UNCONSUMED：templates/spec.mjs validateSpec 对 kind=video 资产
 *      显性拒绝（S6 渲染消费者未落地，不留「过 lint 却永不进画面」暗雷）。
 *   C. `cvs ship --emit-motion`：纯打包 .motion rc.1 目录档
 *      （motion/manifest.json + motion/shots.json，从 plan.segments 映射）。
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

const { buildPlanFromSpec, seamDirectionIssues } = await import('../templates/plan.mjs');
const { validateSpec, normalizeSpec } = await import('../templates/spec.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-seam-'));
function cleanup() { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
process.on('exit', cleanup);

function loadFixtureSpec() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'mini-41s', 'spec.json'), 'utf8'));
}

// ── A. seam gate ────────────────────────────────────────────────────────────
console.log('[A] seam gate W_SEAM_DIRECTION');

// A1 纯函数：同档位相邻 → 零告警。
await ok('A1 uniform motion produces no seam issues', () => {
  const fake = { meta: { motion: 'standard' }, segments: [
    { id: '00-opening', kind: 'opening' },
    { id: 'r01-card', kind: 'card' },
    { id: 'r01-style', kind: 'style', motion: 'standard' },
    { id: '99-ending', kind: 'ending' },
  ] };
  assert.deepEqual(seamDirectionIssues(fake), []);
});

// A2 纯函数：whip(dynamic) 与 slam(standard) 相邻 → 每处接缝一个 WARN。
await ok('A2 directional/undirectional adjacency warns once per seam', () => {
  const fake = { meta: { motion: 'standard' }, segments: [
    { id: 'a-card', kind: 'card' },              // standard → (0,0)
    { id: 'a-style', kind: 'style', motion: 'dynamic' }, // whip → (0.18,0)
    { id: 'b-card', kind: 'card' },              // standard → (0,0)
  ] };
  const issues = seamDirectionIssues(fake);
  assert.equal(issues.length, 2, `expect 2 seam issues, got ${issues.length}`);
  for (const i of issues) {
    assert.equal(i.code, 'W_SEAM_DIRECTION');
    assert.equal(i.level, 'warn');
    assert.match(i.path, /a-card→a-style|a-style→b-card/);
    assert.match(i.message, /dynamic/);
  }
});

// A3 纯函数：两档都无方向位移（calm↔standard↔maximal）→ 一致，不告警。
await ok('A3 isotropic entries never mismatch even across levels', () => {
  const fake = { meta: { motion: 'calm' }, segments: [
    { id: 's1', kind: 'style', motion: 'calm' },      // fade → (0,0)
    { id: 's2', kind: 'style', motion: 'standard' },  // slam → (0,0)
    { id: 's3', kind: 'style', motion: 'maximal' },   // glitch → (0,0)
  ] };
  assert.deepEqual(seamDirectionIssues(fake), []);
});

// A4 buildPlanFromSpec 端到端：单段 style.motion='dynamic' → warnings 出现成对 W_SEAM_DIRECTION。
await ok('A4 buildPlanFromSpec surfaces seam warnings from a real fixture spec', () => {
  const spec = loadFixtureSpec();
  spec.rounds[1].style = { ...spec.rounds[1].style, motion: 'dynamic' };
  const { plan } = buildPlanFromSpec(spec, { root: ROOT, checkPages: false });
  const seam = plan.warnings.filter((w) => w.code === 'W_SEAM_DIRECTION');
  assert.equal(seam.length, 2, `expect 2 warnings around r02-style, got ${seam.length}: ${JSON.stringify(seam)}`);
  assert.ok(seam.some((w) => w.path.includes('r02-card→r02-style')));
  assert.ok(seam.some((w) => w.path.includes('r02-style→r03-card')));
});

// A5 默认（非 strict）--check：只 WARN，exit 0。
const seamSpecPath = path.join(tmp, 'seam.spec.json');
{
  const spec = loadFixtureSpec();
  spec.rounds[1].style = { ...spec.rounds[1].style, motion: 'dynamic' };
  fs.writeFileSync(seamSpecPath, JSON.stringify(spec));
}
await ok('A5 plan --check keeps WARN non-blocking (exit 0)', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'templates', 'plan.mjs'), '--spec', seamSpecPath, '--check', '--root', ROOT], { encoding: 'utf8' });
  assert.equal(r.status, 0, `exit=${r.status} out=${r.stdout} err=${r.stderr}`);
  assert.match(r.stderr, /\[warn\] \[W_SEAM_DIRECTION\]/);
});

// A6 --strict --check：W_SEAM_DIRECTION 升级为拦截（exit 10）。
await ok('A6 plan --check --strict blocks seam mismatch (exit 10)', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'templates', 'plan.mjs'), '--spec', seamSpecPath, '--check', '--strict', '--root', ROOT], { encoding: 'utf8' });
  assert.equal(r.status, 10, `exit=${r.status} out=${r.stdout} err=${r.stderr}`);
  assert.match(r.stderr, /W_SEAM_DIRECTION/);
  assert.match(r.stderr, /strict/);
});

// A7 干净 fixture 双档都不许冒烟：默认 --check 无 W_SEAM_DIRECTION、零告警计数。
await ok('A7 clean fixture stays silent (no seam warnings)', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'templates', 'plan.mjs'), '--spec', path.join(ROOT, 'fixtures', 'mini-41s', 'spec.json'), '--check', '--strict', '--root', ROOT], { encoding: 'utf8' });
  assert.equal(r.status, 0, `exit=${r.status} err=${r.stderr}`);
  assert.doesNotMatch(r.stderr, /W_SEAM_DIRECTION/);
});

// ── B. E_VIDEO_UNCONSUMED ───────────────────────────────────────────────────
console.log('[B] E_VIDEO_UNCONSUMED (spec.mjs validateSpec)');

await ok('B1 kind=video asset is a hard error citing S6/G10', () => {
  const spec = normalizeSpec(loadFixtureSpec());
  spec.assets = [{ id: 'bg', path: 'assets/loop.mp4', kind: 'video' }];
  const issues = validateSpec(spec);
  const hit = issues.find((i) => i.code === 'E_VIDEO_UNCONSUMED');
  assert.ok(hit, `expected E_VIDEO_UNCONSUMED, got ${JSON.stringify(issues.map((i) => i.code))}`);
  assert.equal(hit.level, 'error');
  assert.match(hit.path, /assets\[0\]/);
  assert.match(hit.message, /S6|G10/);
});

await ok('B2 kind=image/audio/logo assets untouched by the gate', () => {
  const spec = normalizeSpec(loadFixtureSpec());
  spec.assets = [{ id: 'k', path: 'assets/a.png', kind: 'image' }, { id: 'b', path: 'assets/b.wav', kind: 'audio' }];
  const issues = validateSpec(spec);
  assert.ok(!issues.some((i) => i.code === 'E_VIDEO_UNCONSUMED'));
});

await ok('B3 missing kind is NOT misread as video (only explicit kind rejected)', () => {
  const spec = normalizeSpec(loadFixtureSpec());
  spec.assets = [{ id: 'x', path: 'assets/clip.mp4' }];
  const issues = validateSpec(spec);
  assert.ok(!issues.some((i) => i.code === 'E_VIDEO_UNCONSUMED'), 'kind omitted → gate silent (path-only assets are metadata)');
});

// ── C. ship --emit-motion ───────────────────────────────────────────────────
console.log('[C] cvs ship --emit-motion');

const shipWd = path.join(tmp, 'ship-wd');
function makeShipProject(withPlan = true) {
  fs.rmSync(shipWd, { recursive: true, force: true });
  fs.mkdirSync(path.join(shipWd, 'out'), { recursive: true });
  const spec = {
    meta: { name: 'motion-demo', title: 'T', description: '', tags: [], brand: 'B', cta: '', locale: 'zh-CN' },
    format: { width: 1920, height: 1080, fps: 30, aspect: '16:9', duration: 8 },
    look: { mode: 'showcase', style: null, theme: 'coral-noir', accentOverride: null, motion: 'standard' },
    audio: { mood: 'electronic', bpm: 120, vo: null },
    structure: { opening: 4, round: 4, card: 1, ending: 4, moreCard: 0, flash: { count: 0, each: 0.25 } },
    opening: {}, rounds: [], moreCard: {}, flash: {}, ending: {}, script: null,
    render: { outDir: 'out', motionBlur: false }, assets: [], patches: [],
  };
  fs.writeFileSync(path.join(shipWd, 'motiondemo.json'), JSON.stringify(spec));
  if (withPlan) {
    const plan = {
      version: 2,
      meta: { fps: 30, width: 1920, height: 1080, motion: 'standard', theme: 'coral-noir', outDir: 'out', transition: null },
      stats: { duration: 8, frames: 240, segments: 2 },
      segments: [
        { id: '00-opening', kind: 'opening', label: 'opening', startFrame: 0, frames: 120, page: 'templates/segment.html', hash: 'aaaa1111bbbb2222' },
        { id: '99-ending', kind: 'ending', label: 'ending', startFrame: 120, frames: 120, page: 'templates/segment.html', hash: 'cccc3333dddd4444' },
      ],
    };
    fs.writeFileSync(path.join(shipWd, 'out', 'plan.json'), JSON.stringify(plan));
  }
}

function runShip(extra) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ship.mjs'), 'motiondemo.json', ...extra], { cwd: shipWd, encoding: 'utf8' });
}

await ok('C1 --emit-motion --out dir writes .motion rc.1 manifest+shots from plan.segments', () => {
  makeShipProject(true);
  const r = runShip(['--emit-motion', '--out', 'dir']);
  // 无 master.mp4 → ship 以 13 收尾（留痕不算崩）；文件在退出前已落盘。
  assert.equal(r.status, 13, `expect exit 13 (missing master), got ${r.status}: ${r.stderr}`);
  const dirs = fs.readdirSync(shipWd).filter((d) => d.startsWith('motiondemo-'));
  assert.equal(dirs.length, 1, `ship dir not found: ${JSON.stringify(dirs)}`);
  const motionDir = path.join(shipWd, dirs[0], 'motiondemo', 'motion');
  const manifest = JSON.parse(fs.readFileSync(path.join(motionDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'motion/rc.1');
  assert.equal(manifest.meta.name, 'motion-demo');
  assert.equal(manifest.meta.fps, 30);
  assert.equal(manifest.meta.width, 1920);
  const shots = JSON.parse(fs.readFileSync(path.join(motionDir, 'shots.json'), 'utf8'));
  assert.equal(shots.shots.length, 2);
  assert.deepEqual(shots.shots.map((s) => s.id), ['00-opening', '99-ending']);
  assert.deepEqual(shots.shots.map((s) => s.kind), ['opening', 'ending']);
  // 帧→秒换算按 plan.meta.fps。
  assert.equal(shots.shots[1].startSec, 4);
  assert.equal(shots.shots[1].durationSec, 4);
  assert.equal(shots.shots[0].hash, 'aaaa1111bbbb2222');
});

await ok('C2 --emit-motion without plan.json degrades honestly (no motion dir, warn on stderr)', () => {
  makeShipProject(false);
  const r = runShip(['--emit-motion', '--out', 'dir']);
  assert.match(r.stderr, /emit-motion/);
  const dirs = fs.readdirSync(shipWd).filter((d) => d.startsWith('motiondemo-'));
  assert.equal(dirs.length, 1);
  assert.ok(!fs.existsSync(path.join(shipWd, dirs[0], 'motiondemo', 'motion')), 'must not fabricate motion/ without a plan');
});

await ok('C3 default ship (no flag) writes no motion dir (zero regression)', () => {
  makeShipProject(true);
  const r = runShip(['--out', 'dir']);
  assert.equal(r.status, 13, `exit=${r.status}`);
  const dirs = fs.readdirSync(shipWd).filter((d) => d.startsWith('motiondemo-'));
  assert.ok(!fs.existsSync(path.join(shipWd, dirs[0], 'motiondemo', 'motion')));
});

await ok('C4 --json reports emitMotion flag', () => {
  makeShipProject(true);
  const r = runShip(['--emit-motion', '--out', 'dir', '--json']);
  const line = String(r.stdout).trim().split('\n').pop();
  const j = JSON.parse(line);
  assert.equal(j.ok, true);
  assert.equal(j.emitMotion, true);
});

// ── D. MCP cvs_diff（G10/S3：包装 ref video --compare 现成能力）───────────
console.log('[D] mcp cvs_diff tool');

const { TOOLS } = await import('../mcp/server.mjs');
await ok('D1 cvs_diff registered with ref/mine/out schema', () => {
  const t = TOOLS.find((x) => x.name === 'cvs_diff');
  assert.ok(t, 'cvs_diff missing from TOOLS');
  assert.ok(t.description.includes('compare'), 'description should surface the underlying --compare');
  for (const p of ['ref', 'mine', 'out']) assert.ok(t.inputSchema.properties[p], `inputSchema needs ${p}`);
  assert.deepEqual(t.inputSchema.required, ['ref', 'mine']);
});

await ok('D2 cvs_diff on missing ref → structured isError with E_REF_VIDEO_UNREADABLE', async () => {
  const t = TOOLS.find((x) => x.name === 'cvs_diff');
  const r = await t.run({ ref: 'fixtures/definitely-missing-ref.mp4', mine: 'fixtures/definitely-missing-mine.mp4' });
  assert.equal(r.isError, true, `expect isError, got ${JSON.stringify(r).slice(0, 200)}`);
  assert.match(r.text, /E_REF_VIDEO_UNREADABLE|不存在|not found/i);
});

await ok('D3 cvs_diff maps outPath to --out and json mode (spawn probe, no ffmpeg needed to fail fast)', async () => {
  // 参数映射断言：ref/mine/out 必须变成 `ref video <ref> --compare <mine> --out <out> --json`。
  // 用不存在的 ref 让 ref-video 早退（exit 15），断言命令本身成形（E_REF_VIDEO_UNREADABLE
  // 而非 E_USAGE——未知旗标会是 exit 2/用法文本）。
  const t = TOOLS.find((x) => x.name === 'cvs_diff');
  const r = await t.run({ ref: 'fixtures/nope.mp4', mine: 'fixtures/nope2.mp4', out: path.join(tmp, 'diffout') });
  assert.equal(r.isError, true);
  assert.doesNotMatch(r.text, /E_USAGE|unknown flag/, `flag mapping broken: ${r.text.slice(0, 200)}`);
});

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
