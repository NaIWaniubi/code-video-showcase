#!/usr/bin/env node
/**
 * determinism-check.mjs — render the same instant twice in fresh browsers and
 * compare the bytes. Catches Date.now/Math.random/CSS animation leaks and
 * font-loading races before they become a 61 s re-render.
 *
 *   node scripts/determinism-check.mjs
 *   node scripts/determinism-check.mjs --page "templates/segment.html?theme=cyber-neon" --t 0.5
 *   node scripts/determinism-check.mjs --page segments/01.html --t 2.4 --runs 3
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (!next || next.startsWith('--')) args[a.slice(2)] = true;
  else { args[a.slice(2)] = next; i++; }
}
const str = (k, d) => (args[k] === undefined ? d : String(args[k]));
const page = str('page', 'templates/segment.html?theme=coral-noir');
const t = Number(str('t', '0.5'));
const runs = Math.max(2, Number(str('runs', '2')));
// R3-审计（RT-09 F8）：以前只有静帧双跑——容器级不确定（mux 时间戳、
// 音视频同步偏移）逃出全部幂等检查。加 --video：整段 mp4 双跑比对全编码链。
const videoMode = !!args.video;
const durationSec = Number(str('duration', '1'));
// S8/G2-3：探针必须能表达「复现配置」。此前 spawn 只传 --page/--duration，
// 无法锁定 width/height/fps/capture——「640×360+cyber-neon+cdp」那类非确定现象
// 结构上测不到（只能渲默认 1920×1080/coral-noir/30 帧）。现在透传全部渲染旋钮。
const width = Number(str('width', '640'));
const height = Number(str('height', '360'));
const fps = Number(str('fps', '24'));
const capture = args.capture ? str('capture', '') : '';
const format = args.format ? str('format', '') : '';
const renderer = path.join(ROOT, 'templates/render-segment.mjs');
const projectRoot = path.resolve(str('root', ROOT));
// R2-11 三层隔离法的机器化：容器 sha 之外再比解码帧（framemd5）——
// 「整只 mp4 字节同」把「容器/编码/像素」三层混为一谈，红时无法归因。
// 分帧层相同而容器层不同 = mux 抖动（像素仍可复现，软失败）；分帧层不同 = 真漂移（P0）。
const ffmpeg = process.env.FFMPEG_EXE || 'ffmpeg';

function frameDigest(mp4) {
  // -f framemd5：逐帧内容寻址，与容器/时间戳无关。返回聚合 sha256。
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', mp4, '-map', '0:v:0', '-f', 'framemd5', '-'],
    { cwd: projectRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return crypto.createHash('sha256').update(String(r.stdout)).digest('hex');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvshow-determinism-'));
const hashes = [];

try {
  for (let i = 0; i < runs; i++) {
    const outdir = path.join(tmp, `run-${i}`);
    const r = spawnSync(process.execPath, [
      renderer, '--page', page,
      ...(videoMode ? ['--out', path.join(outdir, 'segment.mp4')] : []),
      ...(videoMode ? [] : ['--still', String(t)]),
      '--outdir', outdir,
      '--root', projectRoot,
      '--width', String(width), '--height', String(height), '--fps', String(fps),
      '--duration', videoMode ? String(durationSec) : '1',
      ...(capture ? ['--capture', capture] : []),
      ...(format ? ['--format', format] : []),
    ], { cwd: projectRoot, encoding: 'utf8' });
    if (r.status !== 0) {
      console.error(`[run ${i + 1}] failed:\n${(r.stderr || r.stdout).slice(-1200)}`);
      process.exit(1);
    }
    const files = fs.readdirSync(outdir).filter((f) => videoMode ? /\.mp4$/i.test(f) : /^still-/);
    if (!files.length) { console.error(`[run ${i + 1}] produced no ${videoMode ? 'mp4' : 'still'}`); process.exit(1); }
    const file = path.join(outdir, files[0]);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const frames = videoMode ? frameDigest(file) : null;
    hashes.push({ file, bytes: fs.statSync(file).size, hash, frames });
    console.log(`[run ${i + 1}] ${files[0]}  ${(hashes[i].bytes / 1024).toFixed(1)} KB  ${hash.slice(0, 16)}${frames ? `  frames=${frames.slice(0, 16)}` : ''}`);
  }
} finally {
  // cleanup after the result is printed
  setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }, 0);
}

const containerOk = hashes.every((h) => h.hash === hashes[0].hash);
const frameOk = !videoMode || (hashes[0].frames !== null && hashes.every((h) => h.frames === hashes[0].frames));
let verdict, code = 0;
if (videoMode) {
  if (containerOk && frameOk) verdict = `\n✓ deterministic: ${runs} runs of ${durationSec}s video are byte-identical (container + frame level)`;
  else if (!containerOk && frameOk) verdict = `\n⚠ PIXEL-DETERMINISTIC, container differs (${runs} 解码帧全同、mp4 字节不同 → mux 抖动，像素可复现成立)`;
  else { verdict = `\n✗ NOT deterministic (PIXEL drift):\n${hashes.map((h, i) => `  run ${i + 1}: container=${h.hash.slice(0, 12)} frames=${(h.frames || 'n/a').slice(0, 12)}`).join('\n')}`; code = 1; }
} else {
  if (containerOk) verdict = `\n✓ deterministic: ${runs} runs of t=${t} are byte-identical`;
  else { verdict = `\n✗ NOT deterministic:\n${hashes.map((h, i) => `  run ${i + 1}: ${h.hash}`).join('\n')}`; code = 1; }
}
console.log(verdict);
if (code) process.exit(1);
