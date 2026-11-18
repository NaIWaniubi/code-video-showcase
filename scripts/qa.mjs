#!/usr/bin/env node
/**
 * qa.mjs — `cvs qa`：一次把视频闸与音频闸都跑完，汇总退出码与报告路径。
 *
 *   cvs qa                          # 对 out/master.mp4（带 out/plan.json）
 *   cvs qa out/master.mp4 --strict
 *   cvs qa --json                   # stdout 一行汇总 JSON
 *
 * 为什么单独一层：旧入口只跑 qa-video；音频侧（响度闭环/真峰/节拍网格）的
 * 退出码从不参与交付判断。现在两路都跑、任一 FAIL 即整体 FAIL（WARN 仅 strict 拦）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseStrict, rejectUnknown } from './lib/strict-flags.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROG = 'node scripts/qa.mjs';
const KNOWN = new Set(['video', 'audio', 'plan', 'json', 'strict', 'help']);
const argv = process.argv.slice(2);
const positional = argv.filter((a) => !String(a).startsWith('--'));
const { args, unknown } = parseStrict(argv, KNOWN);
if (unknown.length) rejectUnknown(PROG, unknown, KNOWN);

if (args.help || (!positional.length && !args.video)) {
  console.log(`Usage: node scripts/qa.mjs <video.mp4> [options]
  <video.mp4>         video gate target (default ./out/master.mp4)
  --plan <plan.json>  plan for content checks (default ./out/plan.json)
  --audio <wav|mp4>   audio gate source; omit = the video itself (track is measured)
  --strict            warnings fail too
  --json              one-line JSON on stdout`);
  process.exit(args.help ? 0 : 2);
}

const videoFile = path.resolve(process.cwd(), String(positional[0] || path.join('out', 'master.mp4')));
if (!fs.existsSync(videoFile)) {
  console.error(`[error] [E_QA_VIDEO] no such file: ${videoFile}（先 cvs build）`);
  process.exit(13);
}


const extraV = [];
if (args['plan']) extraV.push('--plan', String(args.plan));
// 音频源缺省 = 视频本身（qa-audio 内部抽音轨，量的是交付流而非合成 wav）。
const audioArg = args.audio ? path.resolve(process.cwd(), String(args.audio)) : videoFile;

const extraA = [];
if (args['plan']) extraA.push('--plan', String(args.plan));

const py = process.env.PYTHON || 'python';

let vCode = 0, aCode = 0;

// ── 视频闸 ──────────────────────────────────────────────────
console.error('[qa] video gate…');
vCode = spawnSync(process.execPath,
  [path.join(ROOT, 'scripts', 'qa-video.mjs'), videoFile, ...extraV],
  { cwd: ROOT, stdio: 'inherit' }).status ?? 1;

// ── 音频闸 ──────────────────────────────────────────────────
console.error('[qa] audio gate…');
aCode = spawnSync(py,
  [path.join(ROOT, 'scripts', 'qa-audio.py'), audioArg, ...extraA],
  { cwd: ROOT, stdio: 'inherit' }).status ?? 1;

// ── 汇总 ───────────────────────────────────────────────────
const strict = !!args.strict;
const hardFail = vCode !== 0 || aCode !== 0;
// strict 下 WARN 也拦：qa-video/qa-audio 的退出码已含该语义，无需再算。
console.error(
  `[qa]   video=${vCode === 0 ? 'PASS' : 'FAIL'} · audio=${aCode === 0 ? 'PASS' : 'FAIL'}` +
  (hardFail ? '  ✗ 交付不通过' : '  ✓ 全闸通过'),
);
if (args.json) {
  process.stdout.write(JSON.stringify({ ok: !hardFail, videoExit: vCode, audioExit: aCode,
    video: vCode === 0, audio: aCode === 0 }) + '\n');
}
process.exit(hardFail ? 13 : 0);