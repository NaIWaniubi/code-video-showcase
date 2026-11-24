#!/usr/bin/env node
/**
 * demo.mjs — `cvs demo <style|all>`：一键把导演演示集排成可播短片。
 *
 *   cvs demo skeleton                       # 出 out/demo-skeleton/master.mp4
 *   cvs demo firework --seconds 8 --platform gif
 *   cvs demo all                            # 六个演示风格全部出片 + manifest.json
 *   cvs demo skeleton --json                # stdout 一行 JSON
 *
 * 单风格：组合器（scripts/lib/demo-spec.mjs）生成闭合结构 spec → compile
 * （同款 validate→plan→render→qa 全链）。
 * `all`：逐个风格出片，任何一个失败如实记录进 manifest，最终退出码按成败汇总；
 * 单风格的 --outdir 会整体覆盖，所以 all 时忽略它（每个风格有自己的目录）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseStrict, rejectUnknown } from './lib/strict-flags.mjs';
import { composeDemoSpec } from './lib/demo-spec.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROG = 'node scripts/demo.mjs';
const KNOWN = new Set(['style', 'seconds', 'theme', 'outdir', 'platform', 'dry-run',
  'json', 'concurrency', 'retries', 'only', 'help']);
const argv = process.argv.slice(2);
const positional = argv.filter((a) => !String(a).startsWith('--'));
const { args, unknown } = parseStrict(argv, KNOWN);
if (unknown.length) rejectUnknown(PROG, unknown, KNOWN);

// `all`：导演演示集六件（不带常规风格——那是 combos 矩阵的事，演示集才有现场感）。
const DEMO_SET = ['wireframe', 'skeleton', 'fractal', 'firework', 'terrain', 'network'];

/** R9-W1：`--only` 在批量模式下选子集（组合校验失败即 exit 2，不静默吞）。 */
function onlyList() {
  if (!args.only) return null;
  const ids = String(args.only).split(',').map((x) => x.trim()).filter(Boolean);
  const bad = ids.filter((id) => !DEMO_SET.includes(id));
  if (bad.length) {
    console.error(`[error] [E_DEMO_ONLY] --only 里的未知演示风格：${bad.join(', ')}；可选：${DEMO_SET.join('|')}`);
    process.exit(2);
  }
  return ids.length ? ids : null;
}

/** 对单个风格跑一遍「组合→写 spec→compile」，可重试，返回结果行。 */
async function runOne(styleId, { retryCount = 0 } = {}) {
  const seconds = Number(args.seconds || 6);
  let spec;
  try { spec = composeDemoSpec(styleId, { seconds, theme: args.theme || null }); }
  catch (e) {
    return { style: styleId, ok: false, error: e.code || 'E_UNKNOWN_STYLE',
             message: String(e.message), attempts: 0 };
  }
  const outDir = path.resolve(process.cwd(), path.join('out', `demo-${styleId}`));
  fs.mkdirSync(outDir, { recursive: true });
  const specPath = path.join(outDir, 'project.spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2) + "\n");
  const extra = [];
  // 只跑一路时 --platform 才有意义（无论这个风格来自 positional[0] 还是 --only）。
  if (args.platform && styles.length === 1) {
    extra.push('--platform', String(args.platform));
  }
  if (args['dry-run']) extra.push('--dry-run');

  let attempt = 0;
  let lastCode = 0;
  for (;;) {
    attempt++;
    lastCode = await runCompile(specPath, outDir, extra);
    if (lastCode === 0 || attempt > retryCount) break;
    console.error(`[demo]    ${styleId} 第 ${attempt} 次失败，重试中…`);
  }
  const ok = lastCode === 0;
  return {
    style: styleId, ok, exitCode: ok ? 0 : lastCode,
    attempts: attempt, retried: attempt > 1,
    seconds: spec.format.duration, theme: spec.look.theme,
    outDir: path.relative(process.cwd(), outDir),
    master: ok ? 'master.mp4' : null,
  };
}

/** compile 的异步包装：stdio inherit 透传，退出码 resolve。 */
function runCompile(specPath, outDir, extra) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(ROOT, 'bin/cvs.mjs'), 'build', specPath,
      '--root', ROOT, '--outdir', outDir, ...extra,
    ], { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

if (args.help || !positional.length) {
  console.log(`Usage: node scripts/demo.mjs <style-id|all> [options]
  <style-id>            wireframe | skeleton | fractal | firework | terrain | network |
                       generative + 全部常规风格（cvs --help 列 STYLE vocab）
                       all = 六个演示风格依次出片（单个 --outdir 忽略）
  --only a,b,c          (批量) 只出这些演示风格；非法名 exit 2
  --seconds <n>         film length (default 6)
  --theme <id>          theme override (default per style)
  --outdir <dir>        output dir (default out/demo-<style>)
  --platform <id>       also encode delivery copy (gif/webm/mp3/… or mp4 presets;
                        仅单风格生效)
  --dry-run             validate + plan only (no render)
  --concurrency <n>     parallel renders in batch mode (default 1, clamped to 2 —
                        SwiftShader software raster saturates CPU beyond that)
  --retries <n>         retry failed renders once (default 0; transient CDP timeouts
                        are the usual cause)
  --json                one-line JSON on stdout, human text to stderr`);
  process.exit(args.help ? 0 : 2);
}

const requested = String(positional[0]);
let styles;
if (requested === 'all') {
  // 混合用法：`demo all --only skeleton,fractal` 只出两个。
  styles = onlyList() || DEMO_SET;
} else {
  styles = [requested];
}

console.error(`[demo]    ${styles.length === 1 ? `style=${styles[0]}` : `batch=${styles.length} styles (${styles.join(', ')})`}`);

// ── 执行：顺序或有限并行 ────────────────────────────────────
// 并发钳制 ≤2：SwiftShader 软件光栅下每路渲染都吃满 CPU，
// 再高只会互相拖慢（与 render-farm 的 cap 同口径，见其注释）。
let conc = Math.max(1, Math.min(2, Number(args.concurrency || 1)));
const retryCount = Number(args.retries || 0);

const rows = [];
if (styles.length === 1 || conc <= 1) {
  for (const s of styles) {
    console.error(`[demo]    ── ${s} ──`);
    rows.push(await runOne(s, { retryCount }));
  }
} else {
  console.error(`[demo]    batch concurrency=${conc}`);
  let nextIdx = 0;
  const workers = Array.from({ length: conc }, async () => {
    while (nextIdx < styles.length) {
      const s = styles[nextIdx++];
      console.error(`[demo]    ── ${s} ──`);
      rows.push(await runOne(s, { retryCount }));
    }
  });
  await Promise.all(workers);
  rows.sort((a, b) => styles.indexOf(a.style) - styles.indexOf(b.style));
}

// all 模式：manifest.json 汇总每个风格的成败
// R9-W1：任何批量（含 --only 出的单个子集）都留 manifest——
// 少了它「跑了什么、成败如何」就没有落盘凭据。
if (true) {
  const manifestDir = path.resolve(process.cwd(), args.outdir ? String(args.outdir) : path.join('out', 'demo-all'));
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifest = {
    schema: 'cvs.demomanifest/v1',
    generatedAt: new Date().toISOString(),
    secondsPerFilm: Number(args.seconds || 6),
    platform: args.platform || null,
    rows,
    summary: {
      total: rows.length,
      ok: rows.filter((r) => r.ok).length,
      failed: rows.filter((r) => !r.ok).length,
    },
  };
  fs.writeFileSync(path.join(manifestDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.error(`[demo]    manifest -> ${path.join(manifestDir, 'manifest.json')} · ${manifest.summary.ok}/${manifest.summary.total} 成功`);
  if (args.json) process.stdout.write(JSON.stringify(manifest) + '\n');
} else {
  const r = rows[0];
  if (!r.ok) {
    console.error(`[error] [E_DEMO_FAILED] demo build exited ${r.exitCode ?? 'unknown'}`);
    process.exit(r.exitCode ?? 14);
  }
  console.error(`[done]    ${path.join(path.resolve(process.cwd(), `out/demo-${requested}`), 'master.mp4')}`);
}
if (styles.length > 1 && rows.some((r) => !r.ok)) process.exit(1);
process.exit(0);