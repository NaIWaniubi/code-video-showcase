#!/usr/bin/env node
/**
 * demo.mjs — `cvs demo <style>`：一键把导演演示集里的一个风格排成可播短片。
 *
 *   cvs demo skeleton                       # 出 out/demo-skeleton/master.mp4
 *   cvs demo firework --seconds 8 --platform gif
 *   cvs demo skeleton --json                # stdout 一行 JSON
 *
 * 组合器（scripts/lib/demo-spec.mjs）生成闭合结构 spec → 交给 compile
 * （同款 validate→plan→render→qa 全链）。--dry-run 透传可只验证不出片。
 */
import fs from 'node:fs';
import os from 'node:os';
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

if (args.help || !positional.length) {
  console.log(`Usage: node scripts/demo.mjs <style-id> [options]
  <style-id>            wireframe | skeleton | fractal | firework | terrain | network |
                       generative + 全部常规风格（cvs --help 列 STYLE vocab）
  --seconds <n>         film length (default 6)
  --theme <id>          theme override (default per style)
  --outdir <dir>        output dir (default out/demo-<style>)
  --platform <id>       also encode delivery copy (gif/webm/mp3/… or mp4 presets)
  --dry-run             validate + plan only (no render)
  --json                one-line JSON on stdout, human text to stderr`);
  process.exit(args.help ? 0 : 2);
}

const styleId = String(positional[0]);
let spec;
try { spec = composeDemoSpec(styleId, { seconds: Number(args.seconds || 6), theme: args.theme || null }); }
catch (e) {
  console.error(`[error] [${e.code || 'E_UNKNOWN_STYLE'}] ${e.message}`);
  process.exit(e.code === 'E_UNKNOWN_STYLE' ? 2 : 13);
}

const outDir = path.resolve(process.cwd(), String(args.outdir || path.join('out', `demo-${styleId}`)));
fs.mkdirSync(outDir, { recursive: true });
const specPath = path.join(outDir, 'project.spec.json');
fs.writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n');

console.error(`[demo]    style=${styleId} · ${spec.format.duration}s · theme=${spec.look.theme}`);

// compile 走同一条链（含 QA）。python/ffmpeg 不可用时 compile 的 fail 会带真实 code。
const extra = [];
if (args.platform) extra.push('--platform', String(args.platform));
if (args['dry-run']) extra.push('--dry-run');
const r = spawnSync(process.execPath, [
  path.join(ROOT, 'bin/cvs.mjs'), 'build', specPath,
  '--root', ROOT, '--outdir', outDir, ...extra,
], { cwd: ROOT, stdio: 'inherit' });

const result = {
  ok: r.status === 0, style: styleId, seconds: spec.format.duration,
  theme: spec.look.theme, outDir: path.relative(process.cwd(), outDir),
  spec: path.relative(process.cwd(), specPath),
};
if (args.json) process.stdout.write(JSON.stringify(result) + '\n');

if (r.status !== 0) {
  console.error(`[error] [E_DEMO_FAILED] demo build exited ${r.status}`);
  process.exit(r.status ?? 14);
}
console.error(`[done]    ${path.join(outDir, 'master.mp4')}`);
process.exit(0);