#!/usr/bin/env node
/**
 * ship-demo.mjs — G11：一键产出仓库旗舰 demo（360p 小体积成片 + attest 证书）。
 * 审计背景：README 长期自认「仓库无成片」，而 .gitignore 的 *.mp4 会静默吞掉
 * git add——「可验证证据链」叙事缺最后一块实物。本脚本把 mini-41s 夹具降档渲染，
 * 产物与它的 attestation.json 一起放进 assets/demos/（.gitignore 已显式豁免）。
 *
 *   node scripts/ship-demo.mjs            # 渲 + 拷贝 + attest（--render 的语义即真跑）
 *   node scripts/ship-demo.mjs --dry      # 只算派生 spec 与落点，不渲
 *
 * 退出码 0/1（渲染失败/超体积预算时如实报，不产半成品冒充成功）。零依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const dry = process.argv.includes('--dry');
const SRC = 'fixtures/mini-41s/spec.json';
const DERIVED = 'out/demo-360/spec.json';
// 母带直接吃 out/mini-41s 的 1080p 段缓存（同 spec/画幅/fps → 全命中，秒级），
// demo 是「母带 + 确定性下采样 + 证书」的派生物，不新烧一轮渲染。
const OUTDIR = 'out/mini-41s';
const DEST_MP4 = 'assets/demos/showcase-360.mp4';
const DEST_CERT = 'assets/demos/showcase-360.attestation.json';
const MAX_BYTES = 8 * 1024 * 1024; // 预算：GitHub 单文件轻松档，免 LFS（见 docs/PUBLISH.md）

const spec = JSON.parse(fs.readFileSync(path.join(ROOT, SRC), 'utf8'));
// 原生 1080p 渲染（页面设计常量在 1080p 是验证过的正确画幅），产物再确定性
// 下采样到 360p 入库。为什么不在 360 直渲：G11 demo 实战抓出 segment.html 的
// HUD/字号继承 1080 设计常量（drawCountdown 默认 x=1824 在小画幅直接出画、
// 标题字号不随画幅缩放压进胶囊区）——小横屏排版是独立专项 GAPS G12，不在本刀
// 用一半字号常量硬凑。下采样本身由 ffmpeg 完成，证书对**最终入库文件**出。
spec.render = { ...spec.render, outDir: OUTDIR }; // format 原样（1080p30 = 缓存口径）
// 演示文案适配（G7 dwell 闸实战）：夹具卡面 first/keyword 组合 + big-card 回声重绘
// 后按行聚合超 8 码点、1s 拍卡读不完是真判据——demo 是门面片，不放宽闸、改文案。
// 只动派生 spec，fixtures/mini-41s 共享夹具零改动（test-frames 等依赖原文案）。
const cp4 = (t) => [...String(t ?? '').replace(/\s+/g, '')].slice(0, 4).join('');
for (const r of spec.rounds || []) {
  if (r.card) { r.card.first = cp4(r.card.first); r.card.keyword = cp4(r.card.keyword); }
  if (r.style && r.style.copy) {
    r.style.copy.title = [...String(r.style.copy.title || '')].slice(0, 6).join('');
    r.style.copy.subtitle = cp4(r.style.copy.subtitle);
  }
}
if (spec.moreCard) { spec.moreCard.first = cp4(spec.moreCard.first); spec.moreCard.keyword = cp4(spec.moreCard.keyword); }
// flash 段补词（同一像素闸抓到：不给 words 时 big-card 回落内建「想做/科普视频？」
// ——S9 病根被 qa-text 当场点名，正证闸有效）。演示片给四个真词。
if (spec.flash && !(spec.flash.words && spec.flash.words.length)) {
  spec.flash.words = ['纯代码', '逐帧渲', '可复现', '零模型'];
}
fs.mkdirSync(path.join(ROOT, path.dirname(DERIVED)), { recursive: true });
fs.writeFileSync(path.join(ROOT, DERIVED), JSON.stringify(spec, null, 2));
console.log(`[ship-demo] derived spec（复用 1080p 缓存）→ ${DERIVED}（入库前下采样 640×360）`);
if (dry) { console.log('[ship-demo] --dry: stop before render'); process.exit(0); }

function run(args, label) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const out = String(r.stdout || '') + String(r.stderr || '');
  if (r.status !== 0) { console.error(`[ship-demo] ${label} failed exit=${r.status}\n${out.slice(-1200)}`); process.exit(1); }
  return out;
}

console.log('[ship-demo] building (this renders for real)...');
run(['bin/cvs.mjs', 'build', DERIVED, '--root', '.', '--strict', '--concurrency', '2'], 'build');
const master = path.join(ROOT, OUTDIR, 'master.mp4');
if (!fs.existsSync(master)) { console.error('[ship-demo] master.mp4 missing after build'); process.exit(1); }

// 确定性下采样：同一 master 永远得同一 360p 文件（单线程 + bitexact，与渲染器同纪律）。
const ffmpeg = process.env.FFMPEG_EXE || 'ffmpeg';
const small = path.join(ROOT, 'out', 'demo-360', 'showcase-360.mp4');
fs.mkdirSync(path.dirname(small), { recursive: true });
const rs = spawnSync(ffmpeg, ['-y', '-v', 'error', '-i', master, '-vf', 'scale=640:360:flags=bicubic',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '28', '-pix_fmt', 'yuv420p', '-threads', '1',
  '-x264-params', 'threads=1:lookahead_threads=1', '-an', '-movflags', '+faststart', small], { windowsHide: true });
if (rs.status !== 0) { console.error('[ship-demo] downscale failed', String(rs.stderr || '').slice(-300)); process.exit(1); }

const bytes = fs.statSync(small).size;
if (bytes > MAX_BYTES) {
  console.error(`[ship-demo] 360p demo ${(bytes / 1048576).toFixed(1)} MB exceeds budget ${(MAX_BYTES / 1048576)} MB — 提 crf 或裁时长`);
  process.exit(1);
}

fs.mkdirSync(path.join(ROOT, 'assets', 'demos'), { recursive: true });
fs.copyFileSync(small, path.join(ROOT, DEST_MP4));
// 证书对**入库文件**出（clone 后即可 cvs attest --verify 闭环）；plan/manifest 层
// 保留母版血缘（同源 plan、段哈希、ENGINE_VERSION），meta 记派生命令。
run(['bin/cvs.mjs', 'attest', path.relative(ROOT, DEST_MP4).split(path.sep).join('/'),
  '--manifest', path.join(OUTDIR, 'render-manifest.json'),
  '--plan', path.join(OUTDIR, 'plan.json'),
  '--out', path.join(ROOT, OUTDIR, 'attestation-360.json'), '--json'], 'attest');
const cert = JSON.parse(fs.readFileSync(path.join(ROOT, OUTDIR, 'attestation-360.json'), 'utf8'));
cert.mp4 = DEST_MP4;
cert.meta = cert.meta || {};
cert.meta.demoNote = '41s fixture rendered at 1920x1080 then deterministic bicubic downscale (ffmpeg scale=640:360, x264 crf28 threads=1 bitexact-style params); layers.plan preserves master lineage. Rebuild: node scripts/ship-demo.mjs';
fs.writeFileSync(path.join(ROOT, DEST_CERT), JSON.stringify(cert, null, 2));
console.log(`[ship-demo] wrote ${DEST_MP4} (${(bytes / 1048576).toFixed(2)} MB) + ${DEST_CERT} (digest ${(cert.digest || '').slice(0, 12)}…)`);
