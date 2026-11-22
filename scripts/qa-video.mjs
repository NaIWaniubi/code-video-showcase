#!/usr/bin/env node
/**
 * qa-video.mjs — delivery gate for a rendered film.
 *
 *   node scripts/qa-video.mjs out/final.mp4 --plan out/plan.json
 *   node scripts/qa-video.mjs out/final.mp4 --ref out/master.mp4 --min-vmaf 95
 *
 * Checks: container/codec/colour tags/frame count, black frames, frozen frames
 * (whitelisting cards/flashes from the timeline), silence, EBU R128 loudness,
 * optional VMAF/SSIM against a reference, and a 1 fps contact sheet.
 *
 * Writes qa/qa-video.json and exits 1 on hard failures (warnings only with
 * --strict). Zero npm dependencies: ffprobe/ffmpeg must be on PATH.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = {};
const positional = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) { positional.push(a); continue; }
  const next = process.argv[i + 1];
  if (!next || next.startsWith('--')) args[a.slice(2)] = true;
  else { args[a.slice(2)] = next; i++; }
}
const num = (k, d) => (args[k] === undefined ? d : Number(args[k]));
const FILE = positional[0];

if (args.help || !FILE) {
  console.log(`Usage: node scripts/qa-video.mjs <video.mp4> [options]
  --plan <plan.json>     expected size/fps/frames + card/flash whitelist
  --ref <video.mp4>      reference for VMAF/SSIM (use a CRF12 master, not a platform copy)
  --min-vmaf <n>         default 95
  --width/--height <n>   expected size (default from plan, else 1920x1080)
  --fps <n>              expected fps (default from plan, else 30)
  --duration <sec>       expected duration (default from plan)
  --json <file>          report path, default qa/qa-video.json
  --contact <file>       contact sheet path, default qa/contact.jpg
  --no-contact           skip the contact sheet
  --strict               treat warnings as failures
  --quiet                only print the summary`);
  process.exit(args.help ? 0 : 1);
}

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const VIDEO = path.resolve(String(FILE));
// R2-37（N01-F7/N09-F6）：质检附属产物不再落仓库根——默认跟着被检文件走。
const QA_DIR = path.join(path.dirname(VIDEO), 'qa');
const REPORT = path.resolve(String(args.json || path.join(QA_DIR, 'qa-video.json')));
const CONTACT = path.resolve(String(args.contact || path.join(QA_DIR, 'contact.jpg')));
const STRICT = !!args.strict;
// W6：派生导出格式——QA 预期随之调整（webm=VP9，gif 无 pix/音频概念），
// 不放宽「帧数/时长/内容」等核心项，只改容器级预期。
const FORMAT = args.format ? String(args.format) : null;
const EXPECTED_CODEC = FORMAT === 'webm' ? 'vp9' : FORMAT === 'gif' ? 'gif' : 'h264';

const report = { file: VIDEO, checkedAt: new Date().toISOString(), checks: [], metrics: {} };
const add = (name, status, detail, value) => {
  report.checks.push({ name, status, detail, ...(value !== undefined ? { value } : {}) });
  if (!args.quiet) console.log(`[${status}] ${name}  ${detail}`);
};

function run(cmd, a, opts = {}) {
  return spawnSync(cmd, a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function ffprobeJson(file, extra = []) {
  const r = run(FFPROBE, ['-v', 'error', '-print_format', 'json', ...extra, file]);
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

if (!fs.existsSync(VIDEO)) { console.error(`missing file: ${VIDEO}`); process.exit(1); }

// ── plan expectations ───────────────────────────────────────────────────────
let plan = null;
if (args.plan) {
  plan = JSON.parse(fs.readFileSync(path.resolve(String(args.plan)), 'utf8'));
}
let fps = num('fps', plan?.meta?.fps ?? 30);
const width = num('width', plan?.meta?.width ?? 1920);
const height = num('height', plan?.meta?.height ?? 1080);
const duration = num('duration', plan?.stats?.duration ?? null);
let expectedFrames = plan?.stats?.frames ?? (duration ? Math.round(duration * fps) : null);
report.expect = { width, height, fps, duration, frames: expectedFrames };

// ── 1a. 内容级检查（v2.3.5）────────────────────────────────────────────────
// 容器指标全绿不代表画面是用户要的：旧版 fixture 用同一张占位页填了 78% 时长，
// 仍然拿 10 pass / 0 fail。这里补三类「画面内容」断言。
if (plan) {
  const proot = path.resolve(String(plan.meta?.root || process.cwd()));
  const pages = [...new Set((plan.segments || []).map((s) => String(s.page).split('?')[0]))];
  const missing = pages.filter((p) => !fs.existsSync(path.resolve(proot, p)));
  add('pages exist', missing.length ? 'FAIL' : 'PASS',
    missing.length ? `missing: ${missing.join(', ')}` : `${pages.length} page file(s) resolved`);

  const placeholders = [];
  for (const p of pages) {
    const abs = path.resolve(proot, p);
    if (!fs.existsSync(abs)) continue;
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    if (/PLACEHOLDER_TITLE|PLACEHOLDER_SUB/.test(text)) placeholders.push(p);
  }
  add('placeholder pages', placeholders.length ? 'FAIL' : 'PASS',
    placeholders.length ? `developer placeholder constants in: ${placeholders.join(', ')}` : 'no PLACEHOLDER_* in used pages');

  if (plan.spec) {
    const copy = plan.spec.copy || {};
    add('copy present', copy.title ? 'PASS' : 'FAIL',
      copy.title ? `title="${copy.title}"` : 'plan.spec.copy.title is empty — the film has no title');
  }
}

// ── 1. container / streams ─────────────────────────────────────────────────
// N06-F4/F5（v2.5.2）：`-count_frames` 是整片全解码（41s 1080p 实测 8.5s/遍）。
// 容器里 x264/muxer 已写 nb_frames，先读元数据；只有元数据缺失、
// 或 --count-frames 显式要求逐帧核账时才全解码。
let probe = ffprobeJson(VIDEO, ['-show_streams', '-show_format']);
let v = (probe.streams || []).find((s) => s.codec_type === 'video');
let au = (probe.streams || []).find((s) => s.codec_type === 'audio');
let frames = v && v.nb_frames !== undefined ? Number(v.nb_frames) : NaN;
let framesSource = 'container';
if (!v || !Number.isFinite(frames) || frames <= 0 || args['count-frames']) {
  probe = ffprobeJson(VIDEO, ['-count_frames', '-show_streams', '-show_format']);
  v = (probe.streams || []).find((s) => s.codec_type === 'video');
  au = (probe.streams || []).find((s) => s.codec_type === 'audio');
  frames = Number(v?.nb_read_frames || 0);
  framesSource = 'decoded';
}
if (!v) { add('video stream', 'FAIL', 'no video stream'); }
else {
  report.metrics.framesSource = framesSource;
  report.metrics.frames = frames;
  // W6：派生格式按**实际流帧率**校核（gif 导出降到 15fps，plan 的 30 fps 不适用）；
  // 时长不变，帧数期望 = 时长 × 实际帧率。
  if (FORMAT && v) {
    const [frA, frB] = String(v.r_frame_rate || '').split('/').map(Number);
    const actualFps = frB ? frA / frB : NaN;
    if (Number.isFinite(actualFps)) {
      fps = actualFps;
      if (duration != null) expectedFrames = Math.round(duration * actualFps);
    }
  }
  report.metrics.codec = v.codec_name;
  report.metrics.pix_fmt = v.pix_fmt;
  report.metrics.color = { space: v.color_space, primaries: v.color_primaries, transfer: v.color_transfer, range: v.color_range };
  add('codec', v.codec_name === EXPECTED_CODEC ? 'PASS' : 'WARN', `video=${v.codec_name} (need ${EXPECTED_CODEC})`);
  add('pix_fmt', FORMAT === 'gif' ? 'ADVISORY' : (v.pix_fmt === 'yuv420p' ? 'PASS' : 'FAIL'), FORMAT === 'gif' ? 'GIF 无像素格式概念，跳过' : `${v.pix_fmt} (need yuv420p)`);
  // W6：gif 按设计缩到 480 宽——与 plan 原生画幅不符是有意的，降为 ADVISORY 不拦交付。
  const sizeOk = Number(v.width) === width && Number(v.height) === height;
  add('size', FORMAT === 'gif' ? (sizeOk ? 'PASS' : 'ADVISORY') : (sizeOk ? 'PASS' : 'FAIL'),
    FORMAT === 'gif'
      ? `${v.width}x${v.height}（gif 导出按设计缩宽，plan 为 ${width}x${height}）`
      : `${v.width}x${v.height} (need ${width}x${height})`);
  add('fps', v.r_frame_rate === `${fps}/1` ? 'PASS' : 'WARN', `${v.r_frame_rate} (need ${fps}/1)`);
  if (expectedFrames != null) {
    add('frames', frames === expectedFrames ? 'PASS' : 'FAIL', `${frames} (expected ${expectedFrames})`);
  }
  const colorOk = v.color_space === 'bt709' && v.color_primaries === 'bt709' && v.color_transfer === 'bt709' && v.color_range === 'tv';
  add('colour tags', colorOk ? 'PASS' : 'WARN', `${v.color_space || '?'}/${v.color_primaries || '?'}/${v.color_transfer || '?'}/${v.color_range || '?'} (need bt709/bt709/bt709/tv)`);
  if (duration != null) {
    const d = Number(probe.format?.duration || 0);
    add('duration', Math.abs(d - duration) <= 1 / fps + 0.001 ? 'PASS' : 'WARN', `${d.toFixed(3)}s (expected ${duration.toFixed(3)}s)`);
  }
  const tb = String(v.time_base || '');
  report.metrics.time_base = tb;
}
if (au) {
  report.metrics.audio = { codec: au.codec_name, sample_rate: Number(au.sample_rate), channels: au.channels };
  add('audio codec', au.codec_name === 'aac' ? 'PASS' : 'WARN', `${au.codec_name} ${au.sample_rate}Hz ${au.channels}ch`);
  add('audio rate', Number(au.sample_rate) === 48000 ? 'PASS' : 'WARN', `${au.sample_rate}Hz (need 48000)`);
} else {
  add('audio stream', 'WARN', 'no audio stream');
}

// ── 2. black / frozen / silence ────────────────────────────────────────────
function parseDetect(regex, text) {
  const out = [];
  for (const m of String(text).matchAll(regex)) out.push(m.groups || m);
  return out;
}

// N06-F7 + R2-04：blackdetect/freezedetect/signalstats 合并成**一次**解码
// （旧代码 3 遍全解码；实测单遍合并 1.70s vs 两遍 3.31s）。
const det = run(FFMPEG, ['-hide_banner', '-nostats', '-i', VIDEO,
  '-vf', 'blackdetect=d=0.10:pic_th=0.98:pix_th=0.10,freezedetect=n=0.001:d=1.0,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
  '-an', '-f', 'null', '-']);
const detErr = String(det.stderr || '');
const detOut = String(det.stdout || '');

const blacks = parseDetect(/black_start:(?<start>[\d.]+)\s+black_end:(?<end>[\d.]+)\s+black_duration:(?<dur>[\d.]+)/g, detErr);
// 暗转场（fadeblack/circlecrop/rectcrop，meta.transition.dark）故意在段边界产生黑帧。
// 这些过渡窗内的黑帧不计入预算，否则注册表认可的转场会让 strict/deliver 必红。
// 过渡窗 = 第 k+1 段平移后起点起的 duration 秒（与 xfade offset 同一真值）。
const trMeta = plan?.meta?.transition;
const darkWindows = (trMeta && trMeta.dark)
  ? (plan?.segments || []).slice(1).map((s) => [s.start, s.start + trMeta.duration])
  : [];
const unexpectedBlacks = blacks.filter((b) => {
  const a = Number(b.start), z = Number(b.end);
  return !darkWindows.some(([s, e]) => z >= s - 0.05 && a <= e + 0.05);
});
const blackTotal = unexpectedBlacks.reduce((s, b) => s + Number(b.dur), 0);
report.metrics.black = { count: blacks.length, unexpected: unexpectedBlacks.length, seconds: +blackTotal.toFixed(3), spans: blacks.map((b) => [Number(b.start), Number(b.end)]), darkTransitionWindows: darkWindows.length };
// R2-09 配套：平台件画幅转换（横→竖 letterbox）的黑边是有意 padding，非渲染缺陷。
// --allow-letterbox 时黑帧降为 advisory（报告但不拦 strict），避免误红。
const blackOk = blackTotal <= Math.max(0.5, (duration || 61) * 0.01);
const blackStatus = blackOk ? 'PASS' : (args['allow-letterbox'] ? 'ADVISORY' : 'WARN');
add('black frames', blackStatus, `${unexpectedBlacks.length}/${blacks.length} spans, ${blackTotal.toFixed(2)}s total${darkWindows.length ? ` (${darkWindows.length} dark-transition windows exempt)` : ''}${args['allow-letterbox'] ? ' [letterbox padding allowed]' : ''}`);

const freezes = parseDetect(/freeze_start:\s*(?<start>[\d.]+)[\s\S]*?freeze_duration:\s*(?<dur>[\d.]+)/g, detErr);
const staticWindows = (plan?.segments || []).filter((s) => ['card', 'flash', 'more'].includes(s.kind)).map((s) => [s.start, s.end]);
const unexpectedFreezes = freezes.filter((f) => {
  const a = Number(f.start), b = a + Number(f.dur);
  return !staticWindows.some(([s, e]) => b >= s - 0.05 && a <= e + 0.05);
});
report.metrics.freeze = { count: freezes.length, unexpected: unexpectedFreezes.length, spans: freezes.map((f) => [Number(f.start), +Number(f.dur).toFixed(3)]) };
add('frozen frames', unexpectedFreezes.length === 0 ? 'PASS' : 'WARN', `${freezes.length} spans (${unexpectedFreezes.length} outside card/flash windows)`);

// R2-04（N08-F1）：WCAG 2.3.1 闪烁闸门。八连闪 8×0.25s = 3.75 次/秒，
// 全画面亮度 Δ(相对亮度)=0.32——是判据(0.1)的 3 倍，属光敏风险；
// 旧的 blackdetect 只看黑帧，白闪一路放行。逐帧 YAVG → sRGB EOTF →
// 相对亮度摆动计数 → 任意 1s 滑窗内成对闪烁 >3 即不过。
function flashAnalysis(out) {
  const times = []; const lumas = [];
  let pendingT = null;
  for (const line of out.split(/\r?\n/)) {
    const mt = line.match(/pts_time:([\d.]+)/);
    if (mt) { pendingT = Number(mt[1]); continue; }
    const my = line.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
    if (my && pendingT !== null) { times.push(pendingT); lumas.push(Number(my[1])); pendingT = null; }
  }
  const lin = lumas.map((y) => {
    const s = Math.min(1, Math.max(0, y / 255));
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  // 转折点配对计数（不是贪心累积）：一次平滑的白闪衰减只有「升→降」一个转折，
  // 算 1 次闪烁；旧版贪心 |Δ|≥0.12 累积会把同一次衰减切成 6-7 段假闪烁，
  // 把 2Hz 的 flash 段误报成 3.5/s。这里只在亮度方向反转且幅度≥0.1 时记一次摆动。
  const sm = lin.map((v, i) => {
    const a = lin[Math.max(0, i - 1)], b = lin[Math.min(lin.length - 1, i + 1)];
    return (a + v + b) / 3; // 3 帧平滑去噪
  });
  const swings = [];
  let lastVal = sm[0] ?? 0, dir = 0;
  for (let i = 1; i < sm.length; i++) {
    const d = sm[i] - sm[i - 1];
    const nd = d > 0.003 ? 1 : (d < -0.003 ? -1 : dir);
    if (dir !== 0 && nd !== 0 && nd !== dir && Math.abs(sm[i - 1] - lastVal) >= 0.1) {
      swings.push(times[i - 1]); lastVal = sm[i - 1];
    }
    if (nd !== 0) dir = nd;
  }
  let maxPairsPerSec = 0;
  for (let i = 0; i < swings.length; i++) {
    let j = i;
    while (j < swings.length && swings[j] - swings[i] < 1.0) j++;
    maxPairsPerSec = Math.max(maxPairsPerSec, Math.floor((j - i) / 2));
  }
  return { samples: lin.length, swings: swings.length, maxPairsPerSec };
}
if (detOut.includes('YAVG')) {
  const fa = flashAnalysis(detOut);
  report.metrics.flash = { samples: fa.samples, swings: fa.swings, maxPairPerSec: +fa.maxPairsPerSec.toFixed(2) };
  add('flash rate', fa.maxPairsPerSec <= 3.0 ? 'PASS' : 'WARN',
    `max ${fa.maxPairsPerSec.toFixed(1)} flash pair(s)/s over 1s window (WCAG 2.3.1 limit 3; ΔL≥0.12 swings: ${fa.swings})`);
}

if (au) {
  const sd = run(FFMPEG, ['-hide_banner', '-nostats', '-i', VIDEO, '-af', 'silencedetect=noise=-45dB:d=1.0', '-vn', '-f', 'null', '-']);
  const sils = parseDetect(/silence_start:\s*(?<start>-?[\d.]+)[\s\S]*?silence_end:\s*(?<end>[\d.]+)\s*\|\s*silence_duration:\s*(?<dur>[\d.]+)/g, sd.stderr);
  const midSilence = sils.filter((s) => Number(s.start) > 0.5 && Number(s.end) < (duration || 61) - 0.6);
  report.metrics.silence = { count: sils.length, mid: midSilence.length, spans: sils.map((s) => [Number(s.start), Number(s.end)]) };
  add('silence', midSilence.length === 0 ? 'PASS' : 'WARN', `${sils.length} spans, ${midSilence.length} mid-film`);
}

// ── 3. loudness ────────────────────────────────────────────────────────────
if (au) {
  const ln = run(FFMPEG, ['-hide_banner', '-nostats', '-i', VIDEO, '-af', 'loudnorm=I=-14:TP=-1.0:LRA=11:print_format=json', '-vn', '-f', 'null', '-']);
  const m = String(ln.stderr).match(/\{[^{}]*"input_i"[^{}]*\}/s);
  if (m) {
    const d = JSON.parse(m[0]);
    const I = Number(d.input_i), TP = Number(d.input_tp), LRA = Number(d.input_lra);
    report.metrics.loudness = { lufs: I, truePeak: TP, lra: LRA };
    add('loudness', Math.abs(I + 14) <= 1 ? 'PASS' : 'WARN', `${I} LUFS (target -14 ±1)`);
    add('true peak', TP <= -1.0 ? 'PASS' : 'WARN', `${TP} dBTP (target ≤ -1.0)`);
    add('loudness range', LRA <= 14 ? 'PASS' : 'WARN', `${LRA} LU`);
  } else {
    add('loudness', 'WARN', 'could not parse loudnorm output');
  }
}

// ── 4. GOP / keyint spacing（R3-审计 RT-06 P1-3） ────────────────────────────
// R2-21 宣称「GOP≤2s 全链路受控」，但 QA 从不验证。旧版成片实测最大 GOP
// 242 帧（8s）——平台必判二转。此处按 I 帧时间戳测最大间隔。
{
  const gp = run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'frame=pict_type,pkt_pts_time', '-of', 'csv=p=0', VIDEO]);
  const iTimes = [];
  if (gp.status === 0) {
    for (const line of String(gp.stdout || '').split('\n')) {
      const m = /^I,(\d+(?:\.\d+)?)/.exec(String(line).trim());
      if (m) iTimes.push(Number(m[1]));
    }
  }
  if (iTimes.length >= 2) {
    let maxGap = 0;
    for (let i = 1; i < iTimes.length; i++) maxGap = Math.max(maxGap, iTimes[i] - iTimes[i - 1]);
    const limit = 3 / fps;   // keyint=2×fps + 一帧容差
    report.metrics.gop = { iFrames: iTimes.length, maxGapSec: +maxGap.toFixed(3), limitSec: +limit.toFixed(3) };
    add('gop spacing', maxGap <= limit ? 'PASS' : 'WARN',
      `max I-frame gap ${maxGap.toFixed(2)}s over ${iTimes.length} I-frames (limit ${limit.toFixed(2)}s ≈ keyint 2×fps; platforms re-transcode larger GOPs)`);
  } else {
    add('gop spacing', 'ADVISORY', `could not enumerate I-frame timestamps (ffprobe exit ${gp && gp.status})`);
  }
}

// ── 5. optional VMAF/SSIM against a reference ───────────────────────────────
if (args.ref) {
  const ref = path.resolve(String(args.ref));
  const refProbe = ffprobeJson(ref, ['-count_frames', '-show_streams']);
  const refVideo = (refProbe.streams || []).find((s) => s.codec_type === 'video');
  const refFrames = Number(refVideo?.nb_read_frames || 0);
  if (!refVideo || Math.abs(refFrames - (report.metrics.frames || 0)) > 1) {
    add('VMAF', 'ADVISORY', `reference has ${refFrames || '?'} frames vs ${report.metrics.frames || '?'}; skipped (use a same-length master)`);
  } else {
  const log = path.resolve('qa', 'vmaf.json');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const vm = run(FFMPEG, ['-hide_banner', '-nostats', '-i', VIDEO, '-i', ref, '-lavfi',
    `[0:v]setpts=PTS-STARTPTS[d];[1:v]setpts=PTS-STARTPTS[r];[d][r]libvmaf=model=version=vmaf_v0.6.1:log_path=${log.replace(/\\/g, '/')}:log_fmt=json:feature=name=psnr|name=float_ssim`,
    '-f', 'null', '-'], { timeout: 15 * 60 * 1000 });
  if (vm.status !== 0) {
    add('VMAF', 'ADVISORY', `libvmaf unavailable or reference mismatch: ${String(vm.stderr).split('\n').slice(-2).join(' ')}`);
  } else if (fs.existsSync(log)) {
    const j = JSON.parse(fs.readFileSync(log, 'utf8'));
    const pooled = j.pooled_metrics || j;
    const mean = Number(pooled.vmaf?.mean ?? pooled.vmaf);
    const min = Number(pooled.vmaf?.min ?? mean);
    report.metrics.vmaf = { mean, min, psnr_y: pooled.psnr_y?.mean, ssim: pooled.float_ssim?.mean };
    add('VMAF', mean >= num('min-vmaf', 95) ? 'PASS' : 'FAIL', `mean ${mean?.toFixed(2)} min ${min?.toFixed(2)} (need ≥ ${num('min-vmaf', 95)})`);
  }
  }
}

// ── 5. contact sheet ───────────────────────────────────────────────────────
if (!args['no-contact']) {
  fs.mkdirSync(path.dirname(CONTACT), { recursive: true });
  const cs = run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', VIDEO, '-vf', 'fps=1,scale=320:-2,tile=8x8:padding=4:margin=8', '-frames:v', '1', CONTACT]);
  add('contact sheet', cs.status === 0 ? 'PASS' : 'ADVISORY', cs.status === 0 ? CONTACT : String(cs.stderr).slice(0, 200));
}

// ── 检查齐全性（R3-审计 RT-06 P1-2） ────────────────────────────────────────
// flash / silence / loudness 等检测在 probe 失败时会整项缺席，报告照样全绿。
// 交付级（带 plan）质检把「必备项没跑成」与「跑过了没问题」严格分开。
// S0-1：plan 缺席同样不许沉默——记 WARN（--strict 下拦），把降级摆在报告里。
if (plan) {
  const seen = new Set(report.checks.map((c) => c.name));
  const required = ['pages exist', 'codec', 'pix_fmt', 'size', 'fps', 'frames', 'duration'];
  if (au) required.push('audio codec', 'loudness');
  for (const name of required) {
    if (!seen.has(name)) {
      add(`check "${name}"`, 'FAIL', `expected check did not run — treat as probe failure, not "all green"`);
    }
  }
} else {
  add('plan coverage', 'WARN', 'no plan.json supplied — pages/placeholder/frames/cuts/title checks skipped; this is NOT a delivery-grade QA');
}

// ── URL 溯源闸（v4.9.2，内容错位病根的制度化防线） ──────────────────────────
// v2.9.0 教训：渲染器把 plan 下发的 theme/title/first 等 query 剥光，成片渲染成
// 页面内建 demo 文案，而 QA 只验「plan 里有标题」不验「渲染 URL 里还带着它」——
// 全绿三天。现在 manifest.renderUrl（farm 从渲染器 [page] 行捕获）必须携带 plan
// 段 URL 的全部非渲染器专属参数；丢失即 FAIL。
if (plan) {
  try {
    const mfPath = path.join(path.dirname(path.resolve(String(args.plan))), 'render-manifest.json');
    if (!fs.existsSync(mfPath)) {
      add('url provenance', 'WARN', 'render-manifest.json not found next to plan — provenance not verified');
    } else {
      const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
      const RESERVED = new Set(['seg', 't0', 'speed', 'dur', 'vars']);
      let checked = 0, noUrl = 0, fails = 0;
      for (const s of plan.segments || []) {
        const m = (mf.segments || {})[s.id];
        if (!m || m.status === 'cached') continue;
        if (!m.renderUrl) { noUrl++; continue; }
        checked++;
        const want = new URL(`http://x/${String(s.page).replace(/^\/+/, '')}`).searchParams;
        const got = new URL(String(m.renderUrl)).searchParams;
        for (const [k, v] of want) {
          if (RESERVED.has(k)) continue;
          if (got.get(k) !== v) {
            fails++;
            add('url provenance', 'FAIL', `${s.id}: plan ${k}=${v} lost in rendered URL (${got.get(k) ?? 'ABSENT'}) — 内容错位类缺陷`);
            break;
          }
        }
      }
      if (!fails) {
        // v4.9.3（证伪 F1 配套）：done 段缺 renderUrl 是 WARN 不是 PASS——
        // 「重渲自动补全」自 v4.9.3 起为真（batch 链已回传 pageUrl），
        // 更早 manifest 的缺字段必须显式申报而不是绿给谁看。
        if (noUrl) add('url provenance', 'WARN', `${noUrl} 个 done 段无 renderUrl（manifest 产自 v4.9.3 之前）——本闸对其未生效，重渲后补全；已验 ${checked} 段全带参`);
        else if (checked) add('url provenance', 'PASS', `${checked} 段的实际渲染 URL 携带 plan 全部文案/主题参数`);
        else add('url provenance', 'ADVISORY', 'manifest 段全为 cached——本轮无新渲染可溯源（非缺陷，但本闸空转）');
      }
    }
  } catch (e) { add('url provenance', 'FAIL', `manifest unreadable: ${String(e.message).slice(0, 120)}`); }
}

// ── summary ────────────────────────────────────────────────────────────────
// 三档：FAIL 交付物是错的；WARN 交付物不合格（--strict 下判失败）；
//       ADVISORY 诊断/装饰（VMAF 没装、封面拼图生成失败）——任何情况下都不拦交付。
const failures = report.checks.filter((c) => c.status === 'FAIL');
const warnings = report.checks.filter((c) => c.status === 'WARN');
const advisories = report.checks.filter((c) => c.status === 'ADVISORY');
report.summary = {
  pass: report.checks.length - failures.length - warnings.length - advisories.length,
  warn: warnings.length,
  advisory: advisories.length,
  fail: failures.length,
};
fs.mkdirSync(path.dirname(REPORT), { recursive: true });
fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
console.log(`\n${report.summary.pass} pass · ${report.summary.warn} warn · ${report.summary.advisory} advisory · ${report.summary.fail} fail  ->  ${REPORT}`);
if (failures.length || (STRICT && warnings.length)) process.exit(1);
