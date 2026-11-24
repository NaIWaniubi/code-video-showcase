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
// 取值旗标（证伪代理 F2）：这些 flag 的下一个 token 是**值**，不是位置参数。
// 旧代码 positional 用「不以--开头」裸过滤，`cvs qa --plan out/plan.json` 会把
// plan 路径当成视频送 ffprobe——恰好是 help 承诺的缺省用法。
const VALUED = new Set(['video', 'audio', 'plan']);
const argv = process.argv.slice(2);
const positional = (() => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a.startsWith('--')) {
      const name = a.slice(2).split('=')[0];
      if (VALUED.has(name) && !a.includes('=') && i + 1 < argv.length) i++; // 跳过它的值
      continue;
    }
    out.push(a);
  }
  return out;
})();
const { args, unknown } = parseStrict(argv, KNOWN);
if (unknown.length) rejectUnknown(PROG, unknown, KNOWN);

if (args.help) {
  console.log(`Usage: node scripts/qa.mjs [video.mp4] [options]
  [video.mp4]           video gate target (default ./out/master.mp4)
  --plan <plan.json>    plan for content checks (default: 视频同目录 plan.json → out/plan.json)
  --audio <wav|mp4>     audio gate source; omit = the video itself (track is measured)
  --strict              warnings fail too
  --json                one-line JSON on stdout`);
  process.exit(0);
}

const videoFile = path.resolve(process.cwd(), String(positional[0] || args.video || path.join('out', 'master.mp4')));
if (!fs.existsSync(videoFile)) {
  console.error(`[error] [E_QA_VIDEO] no such file: ${videoFile}（先 cvs build）`);
  process.exit(13);
}

// S0-1（内审 F1/F12）：help 承诺「--plan 默认 ./out/plan.json」但代码从不兑现，
// 缺省调用静默降级——帧数/切点/占位页/内容级检查全部没跑还报全绿（MCP 面放大）。
// 现在自动推断：显式 --plan ＞ 视频同目录 plan.json（与 build 产物同区）＞ ./out/plan.json；
// 三处都没有 → 显式 W_NO_PLAN，降级不再是沉默的。
let planFile = args.plan ? path.resolve(process.cwd(), String(args.plan)) : null;
if (!planFile) {
  for (const cand of [path.join(path.dirname(videoFile), 'plan.json'), path.resolve('out', 'plan.json')]) {
    if (fs.existsSync(cand)) { planFile = cand; break; }
  }
}
if (!planFile) console.error('[qa] [W_NO_PLAN] 未找到 plan.json —— 内容级检查（帧数/切点/占位页/标题）全部跳过；本次不是交付级质检');

// G3-1（已复现 finding）：旧代码算出 strict 却从不转发——子闸收不到 --strict，
// WARN 在子进程里永远放行，`cvs qa --strict` 的「warnings fail too」是空头承诺。
// 现在两个子闸都收到 --strict，语义由子闸自身兑现（qa-video/qa-audio 均有该旗标）。
const strict = !!args.strict;
const extraV = [];
if (planFile) extraV.push('--plan', planFile);
if (strict) extraV.push('--strict');
// 音频源缺省 = 视频本身（qa-audio 内部抽音轨，量的是交付流而非合成 wav）。
const audioArg = args.audio ? path.resolve(process.cwd(), String(args.audio)) : videoFile;

const extraA = [];
if (planFile) extraA.push('--plan', planFile);
if (strict) extraA.push('--strict');

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
const hardFail = vCode !== 0 || aCode !== 0;
// strict 下 WARN 也拦：G3-1 已把 --strict 转发给两个子闸，退出码即含该语义，无需再算。
console.error(
  `[qa]   video=${vCode === 0 ? 'PASS' : 'FAIL'} · audio=${aCode === 0 ? 'PASS' : 'FAIL'}` +
  (hardFail ? '  ✗ 交付不通过' : '  ✓ 全闸通过'),
);
if (args.json) {
  process.stdout.write(JSON.stringify({ ok: !hardFail, videoExit: vCode, audioExit: aCode,
    video: vCode === 0, audio: aCode === 0 }) + '\n');
}
process.exit(hardFail ? 13 : 0);