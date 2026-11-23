#!/usr/bin/env node
/**
 * gc.mjs — 内容寻址段缓存回收（G6-4）。
 *
 * 渲染段缓存（`<outDir>/.cache/<hash>[.knobs].mp4` + 同名 `.json`）是**可再生**的：
 * 删了下次构建重渲即可。但它只增不减——审计实测单仓 out/ 涨到 21GB、E 盘仅剩 16GB，
 * 长跑用户会把盘撑爆（ROADMAP 风险表 worktree×N 磁盘条的同族）。本命令按「最近 N 个
 * / 超过 M 天」回收，只删 .cache 目录里的 .mp4+.json 对，**绝不碰**成片与非 .cache 内容。
 *
 *   node scripts/gc.mjs                          # 回收 out/.cache，全保留统计并报告（不删）需 --keep/--older-than 触发删除
 *   node scripts/gc.mjs --cache out/.cache --keep 200
 *   node scripts/gc.mjs --cache out/.cache --older-than 14
 *   node scripts/gc.mjs --dry-run --json         # 只算将释放多少字节，不删
 *
 * 安全闸：目标目录 basename 必须是 `.cache`，否则拒绝（防把 `--cache out` 误指向成片目录）。
 * 退出码：0 正常 · 2 用法/路径非法。零依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  const next = process.argv[i + 1];
  if (!next || next.startsWith('--')) args[key] = true;
  else { args[key] = next; i++; }
}

const HELP = `Usage: node scripts/gc.mjs [--cache <dir>] [--keep <N>] [--older-than <days>] [--dry-run] [--allow-any-dir] [--json]
  --cache <dir>        cache directory to prune (default out/.cache)
  --keep <N>           keep the N newest entries by mtime; delete older ones (0 = clear all)
  --older-than <days>  delete entries whose mtime is older than <days> days
  --dry-run            report what would be reclaimed; delete nothing
  --allow-any-dir      bypass the ".cache basename" safety guard (use with care)
  --json               machine-readable report
If neither --keep nor --older-than is given, --dry-run is implied (report only).`;

if (args.help) { console.log(HELP); process.exit(0); }

const json = !!args.json;
const dryRun = !!args['dry-run'];
const keepArg = args.keep;
const olderArg = args['older-than'];
const hasPolicy = keepArg !== undefined || olderArg !== undefined;
// 无任何回收策略时只报告，不动手（防「跑一下就清空缓存」）。
if (!hasPolicy && !dryRun) { args['dry-run'] = true; }
const effectiveDry = dryRun || !hasPolicy;

const cacheArg = args.cache === undefined ? 'out/.cache' : String(args.cache);
const cacheAbs = path.resolve(ROOT, cacheArg);

function die(msg, code = 2) {
  if (json) console.log(JSON.stringify({ ok: false, error: msg }));
  else console.error('[gc] ' + msg);
  process.exit(code);
}

if (!fs.existsSync(cacheAbs)) die(`cache dir not found: ${cacheArg}`);
let st;
try { st = fs.statSync(cacheAbs); } catch (e) { die(`cannot stat ${cacheArg}: ${e.message}`); }
if (!st.isDirectory()) die(`--cache must be a directory, got ${cacheArg}`);
// 护栏：非 .cache 名的目录默认拒绝——误指成片目录会 rm -rf 掉交付物。
if (!args['allow-any-dir'] && path.basename(cacheAbs) !== '.cache') {
  die(`refusing to prune "${cacheArg}": basename is not ".cache" (pass --allow-any-dir if intentional)`);
}

const names = fs.readdirSync(cacheAbs);
// 一个缓存条目 = 一个 .mp4（可再生画面字节）+ 同名 .json（记账）。按 basename 配对。
const entries = [];
for (const name of names) {
  if (!name.endsWith('.mp4')) continue;
  const base = name.slice(0, -'.mp4'.length);
  const mp4 = path.join(cacheAbs, name);
  const meta = path.join(cacheAbs, base + '.json');
  let size = 0, mtimeMs = 0;
  try { const s = fs.statSync(mp4); size = s.size; mtimeMs = s.mtimeMs; } catch { continue; }
  const files = [mp4];
  let metaSize = 0;
  if (fs.existsSync(meta)) {
    try { metaSize = fs.statSync(meta).size; files.push(meta); } catch { /* ignore */ }
  }
  entries.push({ base, mp4: name, size, metaSize, bytes: size + metaSize, mtimeMs, files });
}

// 非 .mp4/.json 的杂项（不该存在于 .cache）只报告不删，避免误伤未知用途文件。
const stray = names.filter((n) => !/\.(mp4|json)$/i.test(n));
// 孤儿 .json（没有配对 .mp4）也计入可回收（记账文件无画面引用即无用）。
const orphans = names.filter((n) => n.endsWith('.json') && !entries.some((e) => e.base === n.slice(0, -'.json'.length)))
  .map((n) => { let b = 0, m = 0; try { const s = fs.statSync(path.join(cacheAbs, n)); b = s.size; m = s.mtimeMs; } catch {} return { base: n.slice(0, -5), bytes: b, mtimeMs: m, files: [path.join(cacheAbs, n)] }; });

const totalEntries = entries.length;
const totalBytes = entries.reduce((n, e) => n + e.bytes, 0) + orphans.reduce((n, e) => n + e.bytes, 0);

// 决定删除集：--keep（按 mtime 保留最新 N 个）与 --older-than（按年龄）取并集删除。
const now = Date.now();
const doomed = new Set();
// 合并 entries + orphans 到统一按 mtime 排序的候选（orphan .json 也参与 keep 年龄判定）
const candidates = [...entries, ...orphans].sort((a, b) => b.mtimeMs - a.mtimeMs); // 新→旧
if (keepArg !== undefined) {
  const keep = Math.max(0, Number(keepArg));
  if (!Number.isFinite(keep)) die(`--keep must be a number, got ${keepArg}`);
  for (const e of candidates.slice(keep)) doomed.add(e);
}
if (olderArg !== undefined) {
  const days = Number(olderArg);
  if (!Number.isFinite(days) || days < 0) die(`--older-than must be a non-negative number, got ${olderArg}`);
  const cutoff = now - days * 86400000;
  for (const e of candidates) if (e.mtimeMs < cutoff) doomed.add(e);
}

const doomedArr = [...doomed];
const reclaim = doomedArr.reduce((n, e) => n + e.bytes, 0);
let deleted = 0;
if (!effectiveDry) {
  for (const e of doomedArr) {
    for (const f of e.files) { try { fs.rmSync(f, { force: true }); deleted++; } catch { /* ignore */ } }
  }
}

const report = {
  ok: true,
  cache: cacheArg,
  dryRun: effectiveDry,
  entries: totalEntries,
  orphanJson: orphans.length,
  totalBytes,
  toDelete: doomedArr.length,
  reclaimBytes: reclaim,
  deletedFiles: effectiveDry ? 0 : deleted,
  stray: stray.length,
};
if (json) {
  console.log(JSON.stringify(report));
} else {
  const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
  console.log(`[gc] cache ${cacheArg}: ${totalEntries} entries (${mb(totalBytes)})${stray.length ? `, ${stray.length} stray files (left untouched)` : ''}`);
  console.log(effectiveDry
    ? `[gc] ${totalEntries ? `would reclaim ${mb(reclaim)} from ${doomedArr.length} entr${doomedArr.length === 1 ? 'y' : 'ies'}` : 'nothing to reclaim'}${hasPolicy ? '' : '  (no --keep/--older-than given → dry-run only)'}`
    : `[gc] reclaimed ${mb(reclaim)}: ${doomedArr.length} entr${doomedArr.length === 1 ? 'y' : 'ies'}, ${deleted} files deleted`);
  console.log(effectiveDry ? '[gc] (dry-run: nothing deleted)' : '[gc] cache entries are regenerable — next build re-renders missing ones (warm→cold for those segments)');
}
process.exit(0);
