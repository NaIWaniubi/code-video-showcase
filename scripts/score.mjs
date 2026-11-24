#!/usr/bin/env node
/**
 * score.mjs — cvs score：成片主观质量评分（R24-W，evals 思想）。
 *
 *   node scripts/score.mjs <video.mp4> [--plan plan.json] [--qa-audio qa.json]
 *
 * 把「这条片好不好」从感觉变成证据清单：运动密度 / 色彩活力 / 节奏感 /
 * 音画同步 / 标题文本五维（0..1），加权总分 + A–D 等级，每维附实测数字。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseStrict, rejectUnknown } from './lib/strict-flags.mjs';
import { kmeansPixels } from './ref-core.mjs';
import { motionDensity, chromaSpread, pacingScore, cueSyncScore, overallScore } from './lib/score-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROG = 'node scripts/score.mjs';
const KNOWN = new Set(['video', 'plan', 'qa-audio', 'threshold', 'out', 'json', 'help']);
const argv = process.argv.slice(2);
const { args, unknown } = parseStrict(argv, KNOWN);
if (unknown.length) rejectUnknown(PROG, unknown, KNOWN);
const positional = argv.filter((a) => !String(a).startsWith('--'));
const videoArg = String(args.video || positional[0] || '');

if (args.help || !videoArg) {
  console.log(`Usage: node scripts/score.mjs <video.mp4> [options]
  <video.mp4>        the film to score
  --plan <f>         plan.json (cuts / cues evidence)
  --qa-audio <f>     qa-audio report json (cue alignment evidence)
  --threshold <t>    scene-cut threshold for pacing (default 0.18)
  --out <dir>        write score.json here (default out/qa)`);
  process.exit(args.help ? 0 : 2);
}

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';

// ── probe + cuts ──
const pr = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
  '-of', 'json', path.resolve(videoArg)], { encoding: 'utf8', timeout: 60000 });
let durSec = 0;
try { durSec = Number(JSON.parse(pr.stdout).format?.duration || 0); } catch { durSec = 0; }
const threshold = Number(args.threshold ?? 0.18);
const sr = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', path.resolve(videoArg),
  '-an', '-vf', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'],
  { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
const cuts = [];
for (const m of String(sr.stdout || '').matchAll(/pts_time:(\d+(?:\.\d+)?)/g)) cuts.push(Number(m[1]));
for (const m of String(sr.stderr || '').matchAll(/pts_time:(\d+(?:\.\d+)?)/g)) cuts.push(Number(m[1]));

// ── pixels → motion + chroma ──
const rpix = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', path.resolve(videoArg),
  '-vf', 'fps=2,scale=96:96:flags=area', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
  { encoding: 'buffer', timeout: 180000, maxBuffer: 128 * 1024 * 1024 });
const motion = motionDensity(rpix.stdout);

const rrgb = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', path.resolve(videoArg),
  '-vf', 'fps=2,scale=96:96:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
  { encoding: 'buffer', timeout: 180000, maxBuffer: 128 * 1024 * 1024 });
const fb = 96 * 96 * 3;
const npix = Math.floor((rrgb.stdout?.length || 0) / fb);
let chromaVal = null, chromaNote = 'no frames';
try {
  if (npix >= 1) {   // R24 修：此前误写 npix >= fb（帧数 vs 帧字节数恒假→chroma 恒缺）
    const pixObj = [];
    for (let f = 0; f < npix; f++) {
      for (let i = 0; i < fb; i += 3) {
        const o = f * fb + i;
        pixObj.push({ r: rrgb.stdout[o] / 255, g: rrgb.stdout[o + 1] / 255, b: rrgb.stdout[o + 2] / 255 });
      }
    }
    const cl = kmeansPixels(pixObj, 6);
    if (cl.length) { const c = chromaSpread(cl); chromaVal = c.value; chromaNote = c.note; }
  }
} catch (e) { chromaNote = `skipped: ${String(e.message || e).slice(0, 80)}`; }

// ── evidence assembly ──
// S0-7（内审 F5/F6）：①缺 --plan 不再整体 exit 13——自动推断（视频同目录 →
//   out/plan.json），找不到则如实把叙事/节奏维标 skipped，机器四维照常出分；
// ②标题维不再凭段 id「00-opening/99-ending」恒给 1.0——读 spec.copy 真文本，
//   占位词（Lorem/TBD/示例）按 0.3 计，note 里给依据。
const PLACEHOLDER = /lorem|tbd|todo|示例|placeholder|待填/i;
let planFile = args.plan ? path.resolve(String(args.plan)) : null;
if (!planFile) {
  for (const cand of [path.join(path.dirname(path.resolve(videoArg)), 'plan.json'), path.resolve('out', 'plan.json')]) {
    if (fs.existsSync(cand)) { planFile = cand; break; }
  }
}
let pacing = { value: null, note: 'no plan — pacing skipped' };
let titleV = null, titleNote = 'no plan — narrative dimension skipped';
let syncVal = null, syncNote = 'no --qa-audio';
if (planFile) {
  try {
    const pdoc = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    const segs = pdoc.segments || [];
    const flashCount = segs.filter((s) => s.kind === 'flash').length;
    pacing = pacingScore(cuts, durSec, flashCount);
    const copy = pdoc.spec?.copy || {};
    const rawTitle = String(copy.title || '').trim();
    if (rawTitle && !PLACEHOLDER.test(rawTitle)) { titleV = 1; titleNote = `real title "${rawTitle.slice(0, 40)}"`; }
    else if (rawTitle) { titleV = 0.3; titleNote = 'title is a placeholder string'; }
    else { titleV = 0.3; titleNote = 'spec.copy.title empty'; }
  } catch (e) { pacing = { value: null, note: `plan unreadable: ${String(e.message || e).slice(0, 80)}` }; }
} else {
  console.error('[score] [W_NO_PLAN] 未找到 plan.json —— 节奏/叙事两维标 skipped，不计入总分归一（非全绿假象）');
}
if (args['qa-audio']) {
  try {
    const qj = JSON.parse(fs.readFileSync(path.resolve(String(args['qa-audio'])), 'utf8'));
    const sc = cueSyncScore(qj);
    syncVal = sc.value; syncNote = sc.note;
  } catch { syncNote = 'unreadable'; }
}
try {
  const total = overallScore({
    motion: { value: motion.value }, chroma: { value: chromaVal },
    pacing: { value: pacing.value }, sync: { value: syncVal }, title: { value: titleV },
  });
  const report = {
    engine: 'score/1', video: path.basename(videoArg), durationSec: +durSec.toFixed(3),
    plan: planFile ? path.basename(planFile) : null,
    parts: { motion: { value: motion.value, note: motion.note }, chroma: { value: chromaVal, note: chromaNote },
             pacing, sync: { value: syncVal, note: syncNote },
             title: { value: titleV, note: titleNote } },
    total, grade: total.grade,
  };
  console.error('[score]');
  console.error(`  duration  ${report.durationSec}s · ${cuts.length} scene cuts`);
  console.error(`  motion    ${motion.value ?? '—'} (${motion.note})`);
  console.error(`  chroma    ${chromaVal ?? '—'} (${chromaNote})`);
  console.error(`  pacing    ${pacing.value ?? '—'} (${pacing.note})`);
  console.error(`  sync      ${syncVal ?? '—'} (${syncNote})`);
  console.error(`  title     ${titleV ?? '—'} (${titleNote})`);
  console.error(`  TOTAL     ${total.total} · grade ${total.grade}`);
  const outDir = args.out ? path.resolve(String(args.out)) : path.resolve(process.cwd(), 'out', 'qa');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'score.json'), JSON.stringify(report, null, 2) + '\n');
  if (args.json) process.stdout.write(JSON.stringify({ ok: true, ...report }) + '\n');
} catch (e) {
  console.error(`[error] [E_SCORE] ${String(e.message || e).slice(0, 300)}`);
  process.exit(13);
}