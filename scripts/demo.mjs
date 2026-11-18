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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseStrict, rejectUnknown } from './lib/strict-flags.mjs';
import { composeDemoSpec } from './lib/demo-spec.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROG = 'node scripts/demo.mjs';
const KNOWN = new Set(['style', 'seconds', 'theme', 'outdir', 'platform', 'dry-run', 'json', 'help']);
const argv = process.argv.slice(2);
const positional = argv.filter((a) => !String(a).startsWith('--'));
const { args, unknown } = parseStrict(argv, KNOWN);
if (unknown.length) rejectUnknown(PROG, unknown, KNOWN);

// `all`：导演演示集六件（不带常规风格——那是 combos 矩阵的事，演示集才有现场感）。
const DEMO_SET = ['wireframe', 'skeleton', 'fractal', 'firework', 'terrain', 'network'];
/** 对单个风格跑一遍「组合→写 spec→compile」，返回结果行。 */
function runOne(styleId) {
  const seconds = Number(args.seconds || 6);
  let spec;
  try { spec = composeDemoSpec(styleId, { seconds, theme: args.theme || null }); }
  catch (e) {
    return { style: styleId, ok: false, error: e.code || 'E_UNKNOWN_STYLE',
             message: String(e.message), seconds: 0 };
  }
  const outDir = path.resolve(process.cwd(), path.join('out', `demo-${styleId}`));
  fs.mkdirSync(outDir, { recursive: true });
  const specPath = path.join(outDir, 'project.spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n');

  const extra = [];
  if (args.platform && styleId === positional[0]) extra.push('--platform', String(args.platform));
  if (args['dry-run']) extra.push('--dry-run');
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'bin/cvs.mjs'), 'build', specPath,
    '--root', ROOT, '--outdir', outDir, ...extra,
  ], { cwd: ROOT, stdio: 'inherit' });
  return {
    style: styleId, ok: r.status === 0, exitCode: r.status ?? null,
    seconds: spec.format.duration, theme: spec.look.theme,
    outDir: path.relative(process.cwd(), outDir),
    master: r.status === 0 ? 'master.mp4' : null,
  };
}

if (args.help || !positional.length) {
  console.log(`Usage: node scripts/demo.mjs <style-id|all> [options]
  <style-id>            wireframe | skeleton | fractal | firework | terrain | network |
                       generative + 全部常规风格（cvs --help 列 STYLE vocab）
                       all = 六个演示风格依次出片（单个 --outdir 忽略）
  --seconds <n>         film length (default 6)
  --theme <id>          theme override (default per style)
  --outdir <dir>        output dir (default out/demo-<style>)
  --platform <id>       also encode delivery copy (gif/webm/mp3/… or mp4 presets;
                        仅单风格生效)
  --dry-run             validate + plan only (no render)
  --json                one-line JSON on stdout, human text to stderr`);
  process.exit(args.help ? 0 : 2);
}

const requested = String(positional[0]);
const styles = requested === 'all' ? DEMO_SET : [requested];

console.error(`[demo]    ${styles.length === 1 ? `style=${styles[0]}` : `batch=${styles.length} styles (${styles.join(', ')})`}`);

const rows = [];
for (const s of styles) {
  console.error(`[demo]    ── ${s} ──`);
  rows.push(runOne(s));
  // dry-run/批量时不因单个失败中断：全部跑完再汇总（如实报，不静默吞）
}

// all 模式：manifest.json 汇总每个风格的成败
if (styles.length > 1) {
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