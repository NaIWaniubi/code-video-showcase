#!/usr/bin/env node
/**
 * film.mjs — cvs film：spec → OpenFilm IR（film.html 时间线）。
 *
 *   node scripts/film.mjs <spec.json> --out <dir> [--overrides patch.json]
 *
 * R24-W：对标 openfilm/openfilm SPEC——把 CVS 的段表展开成 OpenFilm 的
 * film.html（sections=轨道 / iframes=帧，#t 与 withSegmentParams 同口径）；
 * 附 overrides 非破坏编辑层与 locked/hidden 轨道语义；另产 pages/*.html 直开 scrub。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStrict, rejectUnknown } from './lib/strict-flags.mjs';
import { writeFilmProject, overridesToSpecPatch } from './lib/film-export.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROG = 'node scripts/film.mjs';
const KNOWN = new Set(['spec', 'out', 'overrides', 'root', 'help']);
const argv = process.argv.slice(2);
const { args, unknown } = parseStrict(argv, KNOWN);
if (unknown.length) rejectUnknown(PROG, unknown, KNOWN);
// 位置参数兜底（parseStrict 按白名单跳过裸 token）
const positionalSpec = argv.filter((a)=>!String(a).startsWith('--'))[0] || '';

if (args.help || !args.spec && !positionalSpec) {
  console.log(`Usage: node scripts/film.mjs <spec.json> [options]
  <spec.json>      project spec
  --out <dir>      output dir (default out/film)
  --overrides f    apply a prior overrides patch JSON (list of {clipId, overrides})
  --root <dir>     project root (default cwd)`);
  process.exit(args.help ? 0 : 2);
}

try {
  const specArg = String(args.spec || positionalSpec);
  if (!specArg) { console.error('[error] [E_FILM] pass <spec.json> 或 --spec'); process.exit(2); }
  const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), specArg)), 'utf8');
  const outDir = path.resolve(process.cwd(), String(args.out || path.join('out', 'film')));
  let ovMap = null;
  if (args.overrides) {
    const pd = JSON.parse(fs.readFileSync(path.resolve(String(args.overrides)), 'utf8'));
    const list = Array.isArray(pd) ? pd : (pd.overrides || []);
    ovMap = new Map(list.map((o) => [String(o.clipId ?? o.at), o.overrides || {}]));
  }
  // S0-3（内审 F3）：ovMap 此前只用来打汇总行，从未进导出器——film.html 里
  // 根本没有 overrides 属性，「非破坏编辑层」名存实亡。现在真正传给
  // writeFilmProject→buildFilmHtml，先产片再汇总。
  // G5-1：writeFilmProject 入口过 validateSpec/deepValidate（root 决定页面
  // 存在性判定基准），被拒的 spec 不再产出任何文件。
  const res = writeFilmProject(raw, { outDir, overridesByClip: ovMap, root: path.resolve(String(args.root || process.cwd())) });
  console.error(`[film]   ${res.filmPath}（${res.pages} 个页面壳 · 尺寸 ${raw.format?.width || 1920}×${raw.format?.height || 1080}）`);
  if (ovMap) {
    const patch = overridesToSpecPatch(raw, ovMap);
    console.error(`[film]   overrides 已写入 film.html 属性：${patch.stylePatch.length + patch.cardPatch.length} 条增量 → 可回 spec patch 再编译`);
  }
  process.stdout.write(JSON.stringify({ ok: true, film: res.filmPath, pages: res.pages }) + '\n');
} catch (e) {
  console.error(`[error] [E_FILM] ${String(e.message || e).slice(0, 300)}`);
  process.exit(10);
}