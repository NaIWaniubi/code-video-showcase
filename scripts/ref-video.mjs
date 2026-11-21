#!/usr/bin/env node
/**
 * ref-video.mjs — 参考片反推引擎 CLI（R4「断层领先」旗舰能力）。
 *
 *   cvs ref video demo.mp4
 *   cvs ref video demo.mp4 --apply project.spec.json      # 把结论 patch 进现有 spec
 *   cvs ref video demo.mp4 --json                        # stdout 仅一行 JSON
 *
 * 管线：ffprobe 元数据 → ffmpeg showinfo 场景切点 → ffmpeg 逐秒采样像素 →
 *       ref-core k-means/主题匹配 → （可选）numpy BPM 自相关 → 结构拟合 → 报告。
 *
 * 所有外部进程走 env 覆盖（FVMPEG/FFPROBE/PYTHON，R1 审计坑⑥：from-reference
 * 曾硬编码 ffmpeg）。npm/python 缺失时如实降级并报 E_* 码，不静默假成功。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseStrict, rejectUnknown } from './lib/strict-flags.mjs';
import { analyzePixels, kmeansPixels } from './ref-core.mjs';
import { inferStructure, buildReport } from './lib/ref-video-core.mjs';
import {
  matchCuts, rhythmSimilarity, frameColorSimilarity,
  paletteDistanceBetween, overallVerdict,
} from './lib/ref-compare-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROG = 'node scripts/ref-video.mjs';
const KNOWN = new Set(['video', 'threshold', 'sample-fps', 'out', 'apply', 'json',
  'max-seconds', 'emit-spec', 'compare', 'help']);
const argv = process.argv.slice(2);
const { args, unknown } = parseStrict(argv, KNOWN);
if (unknown.length) rejectUnknown(PROG, unknown, KNOWN);
// 位置参数（parseStrict 按白名单跳过裸 token，这里单独收集供 --video 兜底）。
const positional = argv.filter((a) => !String(a).startsWith('--'));
const videoArg = String(args.video || positional[0] || '');

if (args.help || !videoArg) {
  console.log(`Usage: node scripts/ref-video.mjs --video <file.mp4> [options]
  --video <f>            reference film (positional accepted too)
  --threshold <t>        scene-cut threshold (default 0.18)
  --sample-fps <n>       pixel sampling rate (default 2)
  --out <dir>            report output dir (default analysis/<basename>)
  --apply <spec.json>    merge the structure/theme patch into an existing spec
  --emit-spec <out.json]  expand the structure into a NEW compilable spec
  --compare <render.mp4> measure a remake against the reference (R22-W)
  --json                 one-line JSON on stdout, human text to stderr`);
  process.exit(args.help ? 0 : 2);
}

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const PYTHON = process.env.PYTHON || 'python';
let ffmpegOk = true;
try { ffmpegOk = spawnSync(FFMPEG, ['-version']).status === 0; } catch { ffmpegOk = false; }
if (!ffmpegOk || !fs.existsSync(path.resolve(videoArg))) {
  console.error(`[error] [E_REF_VIDEO_UNREADABLE] 无法读取参考片：${videoArg}（先检查路径；ffmpeg=${FFMPEG} 可用=${ffmpegOk}）`);
  process.exit(15);
}

// ── 1. probe ────────────────────────────────────────────────────────────────
const pr = spawnSync(FFPROBE, [
  '-v', 'error',
  '-show_entries', 'format=duration:stream=codec_type,codec_name,r_frame_rate,width,height',
  '-of', 'json', path.resolve(videoArg),
], { encoding: 'utf8', timeout: 60000 });
if (pr.status !== 0 || !pr.stdout) {
  console.error(`[error] [E_REF_VIDEO_UNREADABLE] ffprobe failed: ${String(pr.stderr || pr.stdout).slice(0, 200)}`);
  process.exit(15);
}
const pjson = JSON.parse(pr.stdout);
const fmt = pjson.format || {};
const vstream = (pjson.streams || []).find((s) => s.codec_type === 'video');
const astream = (pjson.streams || []).find((s) => s.codec_type === 'audio');
let fpsNum = 30;
if (vstream?.r_frame_rate) {
  const [a, b] = String(vstream.r_frame_rate).split('/').map(Number);
  if (a > 0 && b > 0) fpsNum = Math.round(a / b);
}
const probe = {
  duration: Number(fmt.duration || 0),
  fps: fpsNum,
  width: Number(vstream?.width || 0),
  height: Number(vstream?.height || 0),
  hasAudio: !!astream,
};

// ── 2. scene cuts ───────────────────────────────────────────────────────────
const threshold = Number(args.threshold ?? 0.18);
const sr = spawnSync(FFMPEG, [
  '-hide_banner', '-nostats', '-i', path.resolve(videoArg),
  '-an', '-vf', `select='gt(scene,${threshold})',showinfo`,
  '-f', 'null', '-',
], { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
const cuts = [];
if (sr.status !== 0 && sr.status !== null) {
  // 常见于「无切点」或解码尾部小错；0 个 cut 不是致命错，继续。
  console.error(`[warn] scene detection exited ${sr.status}; treating as 0 cuts`);
}
for (const m of String(sr.stdout || '').matchAll(/pts_time:(\d+(?:\.\d+)?)/g)) cuts.push(Number(m[1]));
for (const m of String(sr.stderr || '').matchAll(/pts_time:(\d+(?:\.\d+)?)/g)) cuts.push(Number(m[1]));

// ── 3. 逐秒像素采样 ─────────────────────────────────────────────────────────
const sampleFps = Number(args['sample-fps'] ?? 2);
// R7-W3：--max-seconds 长片分析上限（默认 300s）——超长片逐秒解码会拖死，
// 只取前 N 秒做视觉统计，结构仍按全长拟合（片段开头已代表整体配色）。
const maxSeconds = Number(args['max-seconds'] ?? 300);
if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) {
  console.error(`[error] [E_USAGE] --max-seconds must be a positive number`);
  process.exit(2);
}
const effectiveDur = Math.min(probe.duration || Infinity, maxSeconds);
const srPixels = spawnSync(FFMPEG, [
  '-hide_banner', '-nostats', '-i', path.resolve(videoArg),
  ...(Number.isFinite(effectiveDur) && effectiveDur < probe.duration ? ['-t', String(effectiveDur)] : []),
  '-vf', `fps=${Math.max(1, sampleFps)},scale=96:96:flags=area`, '-f', 'rawvideo',
  '-pix_fmt', 'rgb24', 'pipe:1',
], { encoding: 'buffer', timeout: 180000, maxBuffer: 128 * 1024 * 1024 });
let pixels = [];
const frameBytes = 96 * 96 * 3;
const totalFrames = Math.floor((srPixels.stdout ? srPixels.stdout.length : 0) / frameBytes);
for (let f = 0; f < totalFrames; f++) {
  for (let i = 0; i < frameBytes; i += 3) {
    const o = f * frameBytes + i;
    pixels.push({ r: srPixels.stdout[o] / 255, g: srPixels.stdout[o + 1] / 255, b: srPixels.stdout[o + 2] / 255 });
  }
}
let visual = null;
let pixelWarn = '';
try {
  visual = analyzePixels(pixels.length >= frameBytes ? pixels : [], { k: 6, sample: 96 });
} catch (e) {
  pixelWarn = `pixel analysis skipped: ${String(e.message || e).slice(0, 120)}`;
}

// ── 4. tempo（可选，numpy） ────────────────────────────────────────────────
const TEMPO_PY = String.raw`
import sys, json, math
import numpy as np
raw = sys.stdin.buffer.read()
sr = 22050
n = len(raw) // 4
if n < sr * 2:
    print(json.dumps({"ok": False, "reason": "audio too short"})); sys.exit(0)
x = np.frombuffer(raw, dtype="<f4")[:n].astype(np.float64)
hop = int(sr * 0.02)
nf = n // hop
env = np.array([np.sqrt(np.mean(x[i*hop:(i+1)*hop]**2) + 1e-12) for i in range(nf)])
flux = np.diff(env)
best_lag, best_score = 0, -1.0
lo, hi = max(1, int(sr*0.3/hop)), int(sr*0.9/hop) + 1
for lag in range(lo, min(hi, len(flux))):
    s = float(np.dot(flux[:len(flux)-lag], flux[lag:]))
    if s > best_score:
        best_score, best_lag = s, lag
if best_lag <= 0:
    print(json.dumps({"ok": False, "reason": "no tempo"})); sys.exit(0)
dt = best_lag * 0.02
freq = 1.0 / dt
# 八度折叠到 60..180 BPM 区间（与 qa-audio 同口径）
while freq < 1.0:
    freq *= 2
while freq > 3.0:
    freq /= 2
bpm = round(60.0 * freq, 1)
peak = float(np.max(np.abs(x)))
print(json.dumps({"ok": True, "bpm": bpm, "lagSec": round(dt, 4), "confidence": round(min(1.0, best_score / max(1e-9, float(np.sum(flux*flux)))), 3), "peak": round(peak, 4)})`;

let tempo = { ok: false, reason: 'no audio track' };
if (probe.hasAudio) {
  const pwav = spawnSync(FFMPEG, [
    '-hide_banner', '-nostats', '-i', path.resolve(videoArg),
    '-vn', '-ac', '1', '-ar', '22050', '-f', 'f32le', 'pipe:1',
  ], { encoding: 'buffer', timeout: 180000, maxBuffer: 128 * 1024 * 1024 });
  const py = spawnSync(PYTHON, ['-c', TEMPO_PY], { input: pwav.stdout || Buffer.alloc(0), encoding: 'utf8', timeout: 60000 });
  if (py.status === 0 && py.stdout) {
    try { tempo = JSON.parse(String(py.stdout).trim().split('\n').pop()); } catch { tempo = { ok: false, reason: 'tempo script output unparsable' }; }
  } else {
    tempo = { ok: false, reason: `python unavailable or failed (${PYTHON}) — structure will still be inferred` };
  }
}
if (!tempo.ok && probe.hasAudio) console.error(`[warn] tempo：${tempo.reason}`);

// ── 5. 结构推断 + 报告 ──────────────────────────────────────────────────────
const bpmForStructure = tempo.ok && tempo.bpm ? tempo.bpm : (cuts.length > 2 && probe.duration > 8 ? 120 : null);
const structure = inferStructure({ duration: probe.duration, cuts, bpm: bpmForStructure });
const report = buildReport({ source: path.basename(videoArg), probe, clusters: visual?.palette || [], structure, tempo: tempo.ok ? { method: 'energy-flux-autocorr', bpm: tempo.bpm, confidence: tempo.confidence } : { method: 'none' }, appliedTheme: visual });

report.engine = 'ref-video/1';
report.visualTruncatedTo = Number.isFinite(effectiveDur) && effectiveDur < probe.duration
  ? `${effectiveDur}s / 全片 ${probe.duration.toFixed(1)}s` : null;
report.notes = [...(structure.notes || []), pixelWarn].filter(Boolean);

report.applied = args.apply ? applyPatch(args.apply, report.specPatch) : null;

// ── R13-W：--emit-spec 一步到位 ────────────────────────────────
// 把反推结论展开成一条**可直接编译的新片 spec**：结构模型 → opening/more/ending/
// rounds(card+style)，每轮页面按通用配方页填（用户可自行换风格再 lint）。
let emittedSpec = null;
if (args['emit-spec']) {
  const st = report.structure;
  if (!st || !st.ok) { console.error('[error] [E_EMIT_SPEC] 结构拟合失败，无法展开成片'); process.exit(13); }
  const themeId = report.visual?.theme?.id || 'coral-noir';
  const title = String(path.basename(videoArg).replace(/\.[^.]+$/, '')).slice(0, 14);
  // R13-W：结构必须**精确闭合**（E_DURATION 只差 1/fps 都拒）——反推的粗略占比只当
  // 方向，把 duration 重新分配到 opening / 每轮(卡+风格) / ending，分完必为零残差。
  const F = fitRefStructure(st);
  const stylePage = { page: 'templates/recipe-flat.html', t0: 0.35, speed: 1 };
  const roundsList = Array.from({ length: F.rounds }, (_, i) => ({
    id: `r${String(i + 1).padStart(2, '0')}`,
    name: title,
    card: { layout: 0, first: '想', keyword: '看片？', page: 'templates/big-card.html' },
    style: stylePage,
  }));
  emittedSpec = {
    specVersion: 1,
    meta: { name: `from-ref-${title}`, brand: 'CVS', cta: '开始', locale: 'zh-CN',
            lookSource: { video: path.basename(videoArg), at: new Date().toISOString() } },
    format: { width: 1920, height: 1080, fps: 30, aspect: '16:9', duration: st.totalDuration },
    look: { mode: 'showcase', style: 'flat', theme: themeId },
    audio: { mood: 'electronic', bpm: report.tempo?.bpm ? Math.max(60, Math.min(200, Math.round(report.tempo.bpm))) : 120 },
    structure: {
      opening: F.opening, rounds: F.rounds, round: Number(F.round.toFixed(2)),
      card: F.card, moreCard: F.moreCard, ending: Number(F.ending.toFixed(2)),
      flash: st.flash.each != null ? { count: st.flash.count, each: st.flash.each } : { count: 4 },
    },
    opening: { page: 'templates/segment.html', name: '开场' },
    rounds: roundsList,
    moreCard: { first: '更多', keyword: '玩法？', page: 'templates/big-card.html' },
    flash: { page: 'templates/segment.html' },
    ending: { page: 'templates/segment.html', name: '收尾' },
    _meta: { engine: 'ref-emit/1', confidence: st.confidence, residualVsSource: st.residualVsSource },
  };
  const outPath = path.resolve(String(args['emit-spec']));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(emittedSpec, null, 2) + '\n');
  console.error(`[emit-spec] -> ${outPath}（${st.totalDuration}s · ${st.rounds} 轮 · 置信 ${Math.round(st.confidence * 100)}%）`);
}
void emittedSpec;

// ── R22-W：复刻度量（与 openfilm/skill-replicate 同思想）──────────────────
// agent 看的是静帧不是视频——只看帧会把 look 对上、把时间感丢掉。此块给 agent
// 一个「时间的度量」：切点对齐（带帧偏移）、节奏相似度、色板距离、帧级色彩相似度。
let compareResult = null;
if (args.compare) {
  const renderPath = path.resolve(String(args.compare));
  if (!fs.existsSync(renderPath)) {
    console.error(`[error] [E_REF_VIDEO_UNREADABLE] 复刻片不存在：${args.compare}`);
    process.exit(15);
  }
  const rp = spawnSync(FFPROBE, [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height',
    '-of', 'json', renderPath,
  ], { encoding: 'utf8', timeout: 60000 });
  if (rp.status !== 0 || !rp.stdout) {
    console.error(`[error] [E_REF_VIDEO_UNREADABLE] ffprobe failed on ${args.compare}: ${String(rp.stderr || '').slice(0, 150)}`);
    process.exit(15);
  }
  let renderDur = 0;
  try { renderDur = Number(JSON.parse(rp.stdout).format?.duration || 0); } catch { renderDur = 0; }
  // 复刻片的切点（同阈值口径）
  const rsraw = spawnSync(FFMPEG, [
    '-hide_banner', '-nostats', '-i', renderPath,
    '-an', '-vf', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  const renderCuts = [];
  for (const m of String(rsraw.stdout || '').matchAll(/pts_time:(\d+(?:\.\d+)?)/g)) renderCuts.push(Number(m[1]));
  for (const m of String(rsraw.stderr || '').matchAll(/pts_time:(\d+(?:\.\d+)?)/g)) renderCuts.push(Number(m[1]));
  // 复刻片像素流（同栅格：fps=2 → 96×96 rgb24）
  const rpix = spawnSync(FFMPEG, [
    '-hide_banner', '-nostats', '-i', renderPath,
    ...(Number.isFinite(effectiveDur) && effectiveDur < renderDur ? ['-t', String(Math.min(effectiveDur, renderDur))] : []),
    '-vf', `fps=${Math.max(1, sampleFps)},scale=96:96:flags=area`, '-f', 'rawvideo',
    '-pix_fmt', 'rgb24', 'pipe:1',
  ], { encoding: 'buffer', timeout: 180000, maxBuffer: 128 * 1024 * 1024 });
  // 色板两侧统一自聚类（kmeans 直接出 oklab 中心，l/a/b 全字段；analyzePixels 的
  // palette 只投影 l/c/h，拿不到完整坐标）——对称口径才有可比性。
  const bufToClusters = (buf) => {
    const fb = 96 * 96 * 3;
    const npix = Math.floor((buf?.length || 0) / fb);
    if (!npix) return [];
    const pixObj = [];
    for (let f = 0; f < npix; f++) {
      for (let i = 0; i < fb; i += 3) {
        const o = f * fb + i;
        pixObj.push({ r: buf[o] / 255, g: buf[o + 1] / 255, b: buf[o + 2] / 255 });
      }
    }
    return kmeansPixels(pixObj.length >= fb ? pixObj : [], 6);
  };
  let renderClusters = [];
  try { renderClusters = bufToClusters(rpix.stdout); } catch (e) { console.error(`[warn] compare: palette of render skipped (${String(e.message || e).slice(0, 100)})`); }
  let refClustersForCompare = [];
  try { refClustersForCompare = bufToClusters(srPixels.stdout); } catch { /* 如实：参考像素缺失则色板一侧为 null */ }

  const cutMatch = matchCuts(cuts, renderCuts);
  const rhythm = rhythmSimilarity(cuts, renderCuts);
  const frameSim = frameColorSimilarity(srPixels.stdout || Buffer.alloc(0), rpix.stdout || Buffer.alloc(0));
  const palSim = paletteDistanceBetween(refClustersForCompare, renderClusters);
  compareResult = {
    engine: 'ref-compare/1',
    reference: path.basename(videoArg),
    render: path.basename(renderPath),
    durationDeltaSec: +(probe.duration - renderDur).toFixed(3),
    cutMatch,
    rhythm,
    frameSim,
    palSim,
    verdict: null,
  };
  compareResult.verdict = overallVerdict(compareResult);
  console.error('[compare]');
  console.error(`  duration   Δ ${compareResult.durationDeltaSec >= 0 ? '+' : ''}${compareResult.durationDeltaSec}s`);
  console.error(`  cuts       ${cutMatch.matched}/${cuts.length} matched · ${cutMatch.unmatched.length} missed · ${cutMatch.extraRender} extra · offsets [${cutMatch.offsetsSec.map((x) => x.toFixed(3)).join(', ')}]`);
  console.error(`  rhythm     score ${rhythm.score} (${rhythm.note})`);
  console.error(`  frames     similarity ${frameSim.similarity} (${frameSim.note})`);
  console.error(`  palette    distance ${palSim.distance ?? '—'} · similarity ${palSim.similarity ?? '—'}`);
  console.error(`  verdict    ${compareResult.verdict}`);
}

// ── 6. 输出 ────────────────────────────────────────────────────────────────
const outDir = args.out ? path.resolve(String(args.out)) : path.resolve(process.cwd(), 'analysis', path.basename(videoArg).replace(/\.[^.]+$/, ''));
// 证据图（contact sheet）：每秒一帧的拼版，人眼复核用（tile 8 列）。
(report.evidence ||= []);
{
  const cs = spawnSync(FFMPEG, [
    '-hide_banner', '-nostats', '-i', path.resolve(videoArg),
    '-vf', `fps=1,scale=320:-2,tile=8x8:padding=4:margin=6`,
    '-frames:v', '1',
    path.join(outDir, 'contact-sheet.jpg'),
  ], { encoding: 'utf8', timeout: 180000 });
  if (cs.status !== 0) {
    report.evidence.push('contact-sheet.jpg (生成失败: ' + String((cs.stderr || '').trim().slice(-100) || '').trim() + ')');
  } else {
    report.evidence.push('contact-sheet.jpg');
  }
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'ref-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

if (args.json) {
  process.stdout.write(JSON.stringify({ ...report, ...(compareResult ? { compare: compareResult } : {}) }) + '\n');
} else {
  console.log(`■ 反推 ${path.basename(videoArg)}  ·  engine=ref-video/1`);
  console.log(`  时长 ${probe.duration.toFixed(1)}s @ ${probe.fps}fps · ${probe.width}×${probe.height}${probe.hasAudio ? ' · 含音轨' : ''}`);
  console.log(`  结构 D = ${structure.opening}(open) + ${structure.rounds}×${structure.round.toFixed(2)}(round) + ${structure.card.toFixed(2)}(card) + ${structure.moreCard}(more) + ${structure.flash.count}×${structure.flash.each ?? '-' }(flash) + ${structure.ending}(end) = ${structure.totalDuration}s  残差 ${structure.residualVsSource}s  置信 ${(structure.confidence * 100).toFixed(0)}%`);
  console.log(`  主题 ${visual?.theme?.id ?? '-'}（${visual?.theme?.name ?? '-'}）置信 ${(visual?.theme?.confidence ?? 0).toFixed(2)} · runnerUp ${visual?.theme?.runnerUp ?? '-'}`);
  console.log(`  点缀 ${visual?.metrics?.accent ?? '-'} · APCA ${visual?.metrics?.apca ?? '-'} · 密度 ${visual?.hints?.density ?? '-'} · 材质 ${visual?.hints?.material ?? '-'}`);
  console.log(`  tempo ${tempo.ok ? `${tempo.bpm} BPM（自相关）` : '不可用（降级）'}`);
  for (const n of structure.notes || []) console.log(`  note ${n}`);
  console.log(`  报告 ${path.relative(process.cwd(), path.join(outDir, 'ref-report.json'))}`);
  if (report.applied) console.log(`  ✓ 已 patch ${report.applied.file}（look/audio.structure）`);
}
process.exit(report.ok ? 0 : 13);

/** 把反推结论并入既有 spec（深合并，不毁用户内容）。 */
/** 把反推的结构模型精确拟合到 totalDuration（D 公式零残差，lint 的容差是 1/fps）。
 * 顺序：flash 与 moreCard 从模型取定 → 剩余时长按 2:5:2 分给 opening/每轮/ending，
 * 取整后把残差逐秒补回（先每轮再开场），保证 opening + N×round + more + flash + ending
 * 与 duration 逐秒相等。
 */
function fitRefStructure(st) {
  const dur = Number(st.totalDuration) || 8;
  const flashEach = st.flash.each != null ? Number(st.flash.each) : 0.5;
  const flashCount = Math.max(0, Math.min(16, Math.round(Number(st.flash.count) || 0)));
  const moreCard = 1;
  const flashTotal = flashCount * flashEach;
  let remaining = dur - flashTotal - moreCard;
  if (!Number.isFinite(remaining) || remaining < 6) remaining = 6;

  // 轮数：每轮至少 3s，超预算就递减（不硬凑不合法结构）
  let rounds = Math.max(1, Math.round(Number(st.rounds) || 1));
  while (rounds > 1 && remaining / rounds < 3) rounds--;

  let opening = Math.max(1, Math.floor((remaining * 2) / 9));
  let ending = Math.max(1, Math.floor((remaining * 2) / 9));
  let perRound = Math.max(3, Math.floor((remaining * 5) / 9));
  // 下限挤压时从其它部分扣
  while (opening + ending + perRound * rounds > remaining) {
    if (perRound > 3 && perRound > 1) perRound--;
    else if (opening > 1) opening--;
    else if (ending > 1) ending--;
    else break;
  }
  // 残差补回：先每轮、余数给开场
  let rem = remaining - (opening + ending + perRound * rounds);
  if (rem > 0) {
    perRound += Math.floor(rem / rounds);
    opening += rem - Math.floor(rem / rounds) * rounds;
  }
  return {
    opening, ending,
    rounds,
    round: perRound,
    card: Math.min(1, Math.max(1, Math.floor(perRound / 3))),
    moreCard,
  };
}

function applyPatch(specFile, patch) {
  const abs = path.resolve(specFile);
  let spec;
  try { spec = JSON.parse(fs.readFileSync(abs, 'utf8')); }
  catch (e) { console.error(`[error] [E_SPEC] cannot read/parse spec ${abs}: ${e.message}`); process.exit(10); }
  const merge = (dst, src) => {
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object') merge(dst[k], v);
      else if (v !== undefined) dst[k] = v;
    }
  };
  const out = {};
  // look
  out.look = { ...spec.look, ...patch.look };
  // audio
  out.audio = { ...spec.audio, ...patch.audio };
  // structure：实测量值优先，但用户显式写过 flash.each 的保留
  const ps = patch.structure || {};
  out.structure = {
    opening: ps.opening ?? spec.structure?.opening,
    round: ps.round ?? spec.structure?.round,
    card: ps.card ?? spec.structure?.card,
    moreCard: ps.moreCard ?? spec.structure?.moreCard,
    ending: ps.ending ?? spec.structure?.ending,
    flash: {
      count: ps.flash?.count ?? spec.structure?.flash?.count,
      each: ps.flash?.each ?? spec.structure?.flash?.each,
    },
  };
  fs.writeFileSync(abs, JSON.stringify({ ...spec, ...out }, null, 2) + '\n', 'utf8');
  return { file: abs, keys: Object.keys(patch) };
}