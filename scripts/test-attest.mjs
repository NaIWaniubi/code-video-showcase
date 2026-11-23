#!/usr/bin/env node
/**
 * test-attest.mjs — G9 产物哈希证书 + 跨机重放验证器回归。
 *
 *   node scripts/test-attest.mjs
 *
 * 三层，诚实分级：
 *   A. 纯结构断言（零外部依赖）：canonicalJson 键序纪律、digestOf 对 meta 时间戳
 *      不敏感、compareLayers 的分层 verdict（含 mux 抖动 pass-with-note 与真漂移 FAIL）。
 *   B. 真哈希闭环（需 ffmpeg，不需 Chrome）：ffmpeg lavfi 合成 1s mp4 → attest 两次
 *      digest 相等 → verify 全 match → remux 后容器不同帧同 → 篡改帧摘要 verify 必红。
 *   C. 真渲闭环（需 Chrome/Edge）：render-segment 渲 1s 小片再 attest+verify。
 * B/C 缺环境时打印明确 SKIP 行，不计数、不假绿（与 test-ref-video/test-image 先例一致）。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let passed = 0, failed = 0, skipped = 0;
const skips = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { failed++; console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}
function skipTest(name, why) {
  skipped++; skips.push(`${name} — ${why}`);
  console.log(`- SKIP ${name}（${why}，不假绿）`);
}
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const FFMPEG = process.env.FFMPEG_EXE || 'ffmpeg';
function ffmpegOk() { return spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status === 0; }
const { browserCandidates } = await load('templates/cdp.mjs');
const CHROME = process.env.CHROME_EXE || browserCandidates()[0] || '';

const A = await load('scripts/attest.mjs');

// ── 合成四层结构（不依赖任何二进制） ────────────────────────────────────────
function synthLayers(over = {}) {
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
  const perFrame = ['aaa', 'bbb', 'ccc'].map(md5);
  return {
    container: { sha256: 'c'.repeat(64), bytes: 1234 },
    frames: {
      algorithm: 'framemd5-md5column-v1',
      count: perFrame.length,
      digest: crypto.createHash('sha256').update(perFrame.join('\n')).digest('hex'),
      perFrame,
    },
    toolchain: { fingerprint: 'node18|ffmpeg7.0.2|chrome@1', node: '18', ffmpeg: '7.0.2', browser: 'chrome@1' },
    plan: {
      planVersion: 2, engineVersion: 5, toolEngineVersion: 5,
      segments: [{ id: 's1', hash: 'h1', frames: 3 }],
      statuses: [{ id: 's1', status: 'done' }],
    },
    ...over,
  };
}

// ── A. 纯结构断言 ───────────────────────────────────────────────────────────
test('canonicalJson：对象键序无关、数组顺序保留（R2-17 键序纪律）', () => {
  const a = A.canonicalJson({ b: 1, a: { d: [1, 2, { z: 1, y: 2 }] }, c: 3 });
  const b = A.canonicalJson({ c: 3, a: { d: [1, 2, { y: 2, z: 1 }] }, b: 1 });
  assert.equal(a, b, '键序不同必须序列化相等');
  assert.notEqual(A.canonicalJson({ k: [1, 2] }), A.canonicalJson({ k: [2, 1] }), '数组顺序必须保留（时间轴语义）');
});

test('digestOf/buildCertificate：meta 时间戳变化不进 digest（可跨机比）', () => {
  const layers = synthLayers();
  const certA = A.buildCertificate({ layers, meta: { generatedAt: '2026-01-01T00:00:00Z', source: { mp4: '/a/x.mp4' } } });
  const certB = A.buildCertificate({ layers: structuredClone(layers), meta: { generatedAt: '2026-11-23T09:00:00Z', source: { mp4: 'C:\\other\\path\\x.mp4' } } });
  assert.equal(certA.digest, certB.digest, 'meta（生成时间/路径）不得进入被哈希核心');
  assert.equal(certA.digest, A.digestOf(layers), 'digest 必须等于 digestOf(layers)');
  assert.equal(certA.schema, 'cvs-attestation/v1');
});

test('compareLayers：全同 → pass，四层 status 齐', () => {
  const r = A.compareLayers(synthLayers(), synthLayers());
  assert.equal(r.verdict, 'pass');
  assert.equal(r.exitCode, 0);
  assert.equal(r.layers.container.status, 'match');
  assert.equal(r.layers.frames.status, 'match');
  assert.equal(r.layers.toolchain.status, 'equal');
  assert.equal(r.layers.plan.status, 'match');
});

test('compareLayers：帧同容器不同 = mux 抖动 → pass-with-note（exit 0，指认到层）', () => {
  const cert = synthLayers();
  const fresh = synthLayers();
  fresh.container = { sha256: 'f'.repeat(64), bytes: 1300 };
  const r = A.compareLayers(cert, fresh);
  assert.equal(r.verdict, 'pass-with-note');
  assert.equal(r.exitCode, 0, '像素仍复现不是失败');
  assert.equal(r.layers.container.status, 'differ');
  assert.equal(r.layers.frames.status, 'match');
  assert.ok(r.notes.some((n) => /mux|容器/i.test(n)), `notes 必须解释 mux 抖动：${JSON.stringify(r.notes)}`);
});

test('compareLayers：帧摘要不同 = 真像素漂移 → FAIL，指认 frames 层 + 首个漂移帧号', () => {
  const cert = synthLayers();
  const fresh = synthLayers();
  fresh.frames.perFrame = [...fresh.frames.perFrame];
  fresh.frames.perFrame[1] = 'x'.repeat(32);
  fresh.frames.digest = crypto.createHash('sha256').update(fresh.frames.perFrame.join('\n')).digest('hex');
  const r = A.compareLayers(cert, fresh);
  assert.equal(r.verdict, 'fail');
  assert.notEqual(r.exitCode, 0);
  assert.equal(r.layers.frames.status, 'differ');
  assert.equal(r.layers.frames.firstDivergentFrame, 1, '必须指认首个漂移帧（0-based）');
});

test('compareLayers：帧数不同 → count-mismatch FAIL；仅篡改摘要 → 也 FAIL', () => {
  const cert = synthLayers();
  const short = synthLayers();
  short.frames.perFrame = short.frames.perFrame.slice(0, 2);
  short.frames.count = 2;
  short.frames.digest = crypto.createHash('sha256').update(short.frames.perFrame.join('\n')).digest('hex');
  assert.equal(A.compareLayers(cert, short).layers.frames.status, 'count-mismatch');
  const tampered = synthLayers();
  tampered.frames.digest = 'd'.repeat(64);   // 只改摘要不改帧列表 → 自相矛盾 → 必须红
  const r = A.compareLayers(cert, tampered);
  assert.equal(r.verdict, 'fail');
  assert.equal(r.layers.frames.status, 'differ');
});

test('compareLayers：toolchain 差异是信息不是失败（帧同前提）；plan 缺证 → unavailable 不判红', () => {
  const cert = synthLayers();
  const fresh = synthLayers();
  fresh.toolchain = { fingerprint: 'node20|ffmpeg6|edge@2', node: '20', ffmpeg: '6', browser: 'edge@2' };
  let r = A.compareLayers(cert, fresh);
  assert.equal(r.layers.toolchain.status, 'differ');
  assert.equal(r.layers.toolchain.parts.node, 'differ');
  assert.notEqual(r.verdict, 'fail', '跨机工具链不同 + 像素同 → 不得 FAIL');
  assert.ok(r.verdict === 'pass-with-note', `工具链差异必须进 notes：${r.verdict}`);
  const noPlan = synthLayers({ plan: null });
  r = A.compareLayers(cert, noPlan);
  assert.equal(r.layers.plan.status, 'unavailable');
  assert.equal(r.exitCode, 0, '缺 plan 绑定证据是未检，不是漂移');
});

test('compareLayers：plan 段哈希不同 → FAIL（绑定不一致）', () => {
  const cert = synthLayers();
  const fresh = synthLayers();
  fresh.plan.segments = [{ id: 's1', hash: 'h1', frames: 3 }, { id: 's2', hash: 'h2', frames: 4 }];
  const r = A.compareLayers(cert, fresh);
  assert.equal(r.verdict, 'fail');
  assert.equal(r.layers.plan.status, 'differ');
});

// ── B. 真哈希闭环（ffmpeg，无需 Chrome） ────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvshow-attest-'));
const H = { dir: tmp };
const mp4Path = () => path.join(tmp, 'film.mp4');

if (!ffmpegOk()) {
  skipTest('B1 ffmpeg 合成 1s mp4 + attest 两次 digest 稳定', '本机无 ffmpeg（FFMPEG_EXE 未设且 PATH 无 ffmpeg）');
  skipTest('B2 verify 同产物 → 全 match', '本机无 ffmpeg');
  skipTest('B3 remux 容器变帧不变 → pass-with-note', '本机无 ffmpeg');
  skipTest('B4 篡改 attestation 帧摘要 → CLI verify 红（exit≠0 且指认 frames）', '本机无 ffmpeg');
  skipTest('B5 attestation meta 时间戳变化 → digest 不变且 verify 仍绿', '本机无 ffmpeg');
} else {
  const mk = (outFile, extra = []) => {
    const r = spawnSync(FFMPEG, [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=128x96:rate=10',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...extra, outFile,
    ], { cwd: ROOT });
    assert.equal(r.status, 0, `ffmpeg 合成失败: ${r.stderr}`);
  };
  const attestCli = (args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/attest.mjs'), ...args], {
    cwd: ROOT, encoding: 'utf8',
  });
  // B 块用一份最小假 manifest + 假 plan（构造成本，不是被测对象）：
  // 让 B2 成为真正「四层全 match」的绿，而不是靠 plan unavailable 混过去。
  const bManifest = path.join(tmp, 'mini-manifest.json');
  const bPlan = path.join(tmp, 'mini-plan.json');
  fs.writeFileSync(bManifest, JSON.stringify({
    version: 1,
    segments: { s1: { status: 'done', frames: 10, expected: 10, hash: 'a'.repeat(16), out: 'out/s1.mp4', knobs: 'default' } },
    updated: 'x',
  }));
  fs.writeFileSync(bPlan, JSON.stringify({
    version: 2, meta: {}, spec: { engine: 5 },
    segments: [{ id: 's1', kind: 'card', frames: 10, hash: 'a'.repeat(16) }],
  }));
  const bind = ['--manifest', bManifest, '--plan', bPlan];

  test('B1 attest 产证书：四层字段齐 + 同输入两次 digest 相等', () => {
    mk(mp4Path());
    const r1 = attestCli([mp4Path(), ...bind, '--out', path.join(tmp, 'cert1.json'), '--json']);
    assert.equal(r1.status, 0, `attest 退出码应为 0：${r1.stderr}`);
    const j1 = JSON.parse(r1.stdout);
    const cert = JSON.parse(fs.readFileSync(path.join(tmp, 'cert1.json'), 'utf8'));
    assert.ok(cert.layers.container.sha256 && cert.layers.frames.digest && cert.layers.toolchain.fingerprint, '容器/帧/工具链三层必须齐');
    assert.ok(cert.layers.plan && cert.layers.plan.segments.length === 1, 'plan 层必须绑定假 manifest 的段哈希');
    assert.ok(cert.meta.generatedAt, 'meta 段必须存在（且不被 digest 覆盖）');
    assert.equal(cert.digest, j1.digest, '--json 回报 digest 必须与文件一致');
    const r2 = attestCli([mp4Path(), ...bind, '--out', path.join(tmp, 'cert2.json'), '--json']);
    const j2 = JSON.parse(r2.stdout);
    assert.equal(j1.digest, j2.digest, '同一 mp4 两次 attest digest 必须相等');
  });

  test('B2 verify 对同一产物 → 全 match（exit 0）', () => {
    const r = attestCli([mp4Path(), ...bind, '--verify', path.join(tmp, 'cert1.json'), '--json']);
    assert.equal(r.status, 0, `verify 同产物应绿：${r.stdout}${r.stderr}`);
    const j = JSON.parse(r.stdout);
    assert.equal(j.verdict, 'pass');
    assert.equal(j.layers.frames.status, 'match');
    assert.equal(j.layers.container.status, 'match');
    assert.equal(j.layers.plan.status, 'match');
  });

  test('B3 remux（容器字节变、解码帧同）→ verify pass-with-note 且指认 container 层', () => {
    const remux = path.join(tmp, 'remux.mp4');
    // 本机实测：纯 -c copy remux 可能逐字节相同（ffmpeg 7 muxer 确定性）——
    // 用 -metadata 强制容器层差异（不动视频流），确保 mux 抖动分支真被执行而非条件跳过。
    const r0 = spawnSync(FFMPEG, ['-v', 'error', '-y', '-i', mp4Path(), '-c', 'copy', '-metadata', 'comment=cvshow-mux-jitter', remux], { cwd: ROOT });
    assert.equal(r0.status, 0, `remux 失败: ${r0.stderr}`);
    const r = attestCli([remux, ...bind, '--verify', path.join(tmp, 'cert1.json'), '--json']);
    assert.equal(r.status, 0, `mux 抖动不得 FAIL：${r.stdout}${r.stderr}`);
    const j = JSON.parse(r.stdout);
    assert.equal(j.layers.frames.status, 'match', '帧层必须 match（像素复现成立）');
    assert.equal(j.layers.container.status, 'differ', '前置条件：容器字节必须真的不同（-metadata 注入）');
    assert.equal(j.verdict, 'pass-with-note', `容器不同帧同应判 pass-with-note，实际 ${j.verdict}`);
    assert.ok(j.notes.some((n) => /mux/i.test(n)), `notes 必须解释 mux 抖动：${JSON.stringify(j.notes)}`);
  });

  test('B4 篡改 attestation 帧摘要 → CLI verify exit≠0 且指认 frames 层', () => {
    const certPath = path.join(tmp, 'evil.json');
    const cert = JSON.parse(fs.readFileSync(path.join(tmp, 'cert1.json'), 'utf8'));
    cert.layers.frames.digest = '0'.repeat(64);
    fs.writeFileSync(certPath, JSON.stringify(cert, null, 2));
    const r = attestCli([mp4Path(), ...bind, '--verify', certPath, '--json']);
    assert.notEqual(r.status, 0, '篡改帧摘要必须红');
    const j = JSON.parse(r.stdout);
    assert.equal(j.verdict, 'fail');
    assert.equal(j.layers.frames.status, 'differ', '必须指认到 frames 层');
  });

  test('B5 meta 时间戳/路径改写 → digest 不变且 verify 仍绿（跨机可比）', () => {
    const certPath = path.join(tmp, 'crossmachine.json');
    const cert = JSON.parse(fs.readFileSync(path.join(tmp, 'cert1.json'), 'utf8'));
    const before = cert.digest;
    cert.meta.generatedAt = '2020-01-01T00:00:00.000Z';
    cert.meta.source = { mp4: 'D:\\somewhere\\else\\film.mp4' };
    fs.writeFileSync(certPath, JSON.stringify(cert, null, 2));
    assert.equal(cert.digest, before, '只动 meta 不得影响 digest（digest 未重算即证其独立）');
    const r = attestCli([mp4Path(), ...bind, '--verify', certPath, '--json']);
    assert.equal(r.status, 0, `改 meta 后 verify 必须仍绿：${r.stdout}${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).verdict, 'pass');
  });

  test('B6 假 manifest 绑定：段顺序按 manifest 键序（时间轴）；verify 缺 manifest → plan unavailable（如实不红）', () => {
    const manPath = path.join(tmp, 'two-seg-manifest.json');
    fs.writeFileSync(manPath, JSON.stringify({
      version: 1,
      segments: {
        '01-a': { status: 'done', frames: 10, expected: 10, hash: 'aaaaaaaaaaaaaaaa', out: 'out/01-a.mp4', knobs: 'default' },
        '02-b': { status: 'cached', frames: 10, expected: 10, hash: 'bbbbbbbbbbbbbbbb', out: 'out/02-b.mp4', knobs: 'default' },
      },
    }));
    const certPath = path.join(tmp, 'bound.json');
    const a = spawnSync(process.execPath, [path.join(ROOT, 'scripts/attest.mjs'), mp4Path(), '--manifest', manPath, '--out', certPath, '--json'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(a.status, 0, `带 manifest attest 应绿：${a.stderr}`);
    const cert = JSON.parse(fs.readFileSync(certPath, 'utf8'));
    assert.ok(cert.layers.plan, 'plan 层必须存在');
    assert.deepEqual(cert.layers.plan.segments.map((s) => s.id), ['01-a', '02-b'], '段顺序必须按 manifest 键序（时间轴）');
    assert.equal(cert.layers.plan.segments[0].hash, 'aaaaaaaaaaaaaaaa');
    const v = spawnSync(process.execPath, [path.join(ROOT, 'scripts/attest.mjs'), mp4Path(), '--verify', certPath, '--json'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(v.status, 0, `verify 端缺 manifest 不得红：${v.stdout}${v.stderr}`);
    assert.equal(JSON.parse(v.stdout).layers.plan.status, 'unavailable');
    const v2 = spawnSync(process.execPath, [path.join(ROOT, 'scripts/attest.mjs'), mp4Path(), '--verify', certPath, '--manifest', manPath, '--json'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(v2.status, 0);
    assert.equal(JSON.parse(v2.stdout).layers.plan.status, 'match');
  });
}

// ── C. 真渲闭环（Chrome，可选） ─────────────────────────────────────────────
if (!CHROME) {
  skipTest('C1 render-segment 渲 1s 真片 → attest+verify 全 match', '本机无 Chrome/Edge（CHROME_EXE 未设）');
} else {
  test('C1 render-segment 渲 1s 小片 → attest + verify（帧层必须 match；plan 未绑定时允许 pass-with-note）', () => {
    const out = path.join(tmp, 'real.mp4');
    const r0 = spawnSync(process.execPath, [
      path.join(ROOT, 'templates/render-segment.mjs'),
      '--page', 'templates/segment.html?theme=cyber-neon',
      '--out', out, '--root', ROOT,
      '--width', '320', '--height', '180', '--fps', '10', '--duration', '1',
    ], { cwd: ROOT, encoding: 'utf8', timeout: 240000, env: { ...process.env, CHROME_EXE: CHROME } });
    assert.equal(r0.status, 0, `render-segment 失败：${String(r0.stderr || r0.stdout).slice(-600)}`);
    const a = spawnSync(process.execPath, [path.join(ROOT, 'scripts/attest.mjs'), out, '--out', path.join(tmp, 'real-cert.json'), '--json'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(a.status, 0, `attest 真片失败：${a.stderr}`);
    const v = spawnSync(process.execPath, [path.join(ROOT, 'scripts/attest.mjs'), out, '--verify', path.join(tmp, 'real-cert.json'), '--json'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(v.status, 0, `verify 真片应绿：${v.stdout}${v.stderr}`);
    const rep = JSON.parse(v.stdout);
    assert.equal(rep.layers.frames.status, 'match', '真片帧层必须 match');
    assert.ok(rep.verdict === 'pass' || rep.verdict === 'pass-with-note', `verdict 非法：${rep.verdict}`);
  });
}

// ── CLI 表面断言（不依赖环境） ───────────────────────────────────────────────
test('--help 打印用法且 exit 0', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/attest.mjs'), '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `--help 应 exit 0，实际 ${r.status}`);
  assert.ok(/attest/i.test(r.stdout) && /--verify/.test(r.stdout), 'help 必须覆盖 attest/--verify');
});

test('缺 mp4 / 缺 --verify 文件 → E_ATTEST_INPUT exit 2（不假绿）', () => {
  const r1 = spawnSync(process.execPath, [path.join(ROOT, 'scripts/attest.mjs')], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r1.status, 2, `无参应 exit 2，实际 ${r1.status}`);
  assert.ok(/E_ATTEST_INPUT/.test(r1.stderr + r1.stdout), '必须报 E_ATTEST_INPUT');
  const r2 = spawnSync(process.execPath, [path.join(ROOT, 'scripts/attest.mjs'), mp4Path(), '--verify', path.join(tmp, 'nope.json')], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r2.status, 2, `verify 缺证书文件应 exit 2，实际 ${r2.status}`);
  assert.ok(/E_ATTEST_INPUT/.test(r2.stderr + r2.stdout));
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n=== attest: ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
if (skipped) console.log(`skipped because: ${skips.map((s) => s.split(' — ')[1]).filter((v, i, a) => a.indexOf(v) === i).join('; ')}`);
if (failed) process.exitCode = 1;
if (process.exitCode) console.error('[attest] FAIL');
