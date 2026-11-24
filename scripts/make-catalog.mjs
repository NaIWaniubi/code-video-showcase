#!/usr/bin/env node
/**
 * make-catalog.mjs — G11：27 画风目录页。
 * 每画风渲一张 640×360 代表帧进 assets/catalog/<id>.png，并生成 assets/catalog.html
 * （缩略图网格 + 教义 12 维摘要 + 一键复制的 recipe 命令）。
 * 页面/查询参数全部走 templates/style-pages.mjs 的单一真值表（stylePageFor/styleQueryFor），
 * 教义文本走 content/style-doctrine.json——不新造映射。
 *
 *   node scripts/make-catalog.mjs                 # 全量（缺图的补渲，已有的跳过；--force 重渲）
 *   node scripts/make-catalog.mjs --only glitch,ink-wash
 *   node scripts/make-catalog.mjs --html-only     # 只重建 catalog.html
 *
 * 单张失败：记录进报告继续下一张（不许整体崩）；退出码在「任何期望条目缺图」时 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stylePageFor, styleQueryFor } from '../templates/style-pages.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RENDERER = path.join(ROOT, 'templates/render-segment.mjs');
const DEST = path.join(ROOT, 'assets', 'catalog');
const HTML = path.join(ROOT, 'assets', 'catalog.html');
const T = 0.8;             // 代表帧时刻：入场完成、未到退场
const W = 640, H = 360;
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (k) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a && a.slice(k.length + 3); };

const doctrine = JSON.parse(fs.readFileSync(path.join(ROOT, 'content/style-doctrine.json'), 'utf8'));
const styles = doctrine.styles || doctrine;
const ids = Object.keys(styles).filter((id) => !id.startsWith('$'));
const only = val('only') ? val('only').split(',').map((s) => s.trim()) : null;
const targets = only ? ids.filter((id) => only.includes(id)) : ids;

fs.mkdirSync(DEST, { recursive: true });

function renderStill(id) {
  const page = stylePageFor(id);
  const q = styleQueryFor(id) || '';
  const url = `${page}?${q ? q + '&' : ''}theme=${encodeURIComponent(styles[id]?.themes?.[0] || 'coral-noir')}&title=${encodeURIComponent(id)}&sub=${encodeURIComponent(String(styles[id]?.essence || '').slice(0, 24))}`;
  const outdir = path.join(ROOT, 'out', 'catalog-tmp', id);
  fs.rmSync(outdir, { recursive: true, force: true });
  fs.mkdirSync(outdir, { recursive: true });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = spawnSync(process.execPath, [RENDERER,
      '--page', url, '--still', String(T), '--outdir', outdir, '--root', ROOT,
      '--width', String(W), '--height', String(H), '--duration', '3',
      '--format', 'png', '--timeout', '90000',
    ], { cwd: ROOT, encoding: 'utf8', timeout: 220000, windowsHide: true });
    const png = r.status === 0 && fs.readdirSync(outdir).find((f) => /^still-.*\.png$/.test(f));
    if (png) {
      fs.copyFileSync(path.join(outdir, png), path.join(DEST, `${id}.png`));
      fs.rmSync(outdir, { recursive: true, force: true });
      return { ok: true, bytes: fs.statSync(path.join(DEST, `${id}.png`)).size };
    }
    if (attempt === 3) return { ok: false, err: String((r.stderr || r.stdout || `exit ${r.status}`)).slice(-200) };
    spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${4000 * attempt})`], { windowsHide: true });
  }
  return { ok: false, err: 'unreachable' };
}

const results = {};
if (!has('--html-only')) {
  const force = has('--force');
  for (const id of targets) {
    const file = path.join(DEST, `${id}.png`);
    if (!force && fs.existsSync(file)) { results[id] = { ok: true, skipped: true }; console.log(`[catalog] ${id} exists, skip`); continue; }
    process.stdout.write(`[catalog] ${id} … `);
    const t0 = Date.now();
    results[id] = renderStill(id);
    console.log(results[id].ok ? `${((Date.now() - t0) / 1000).toFixed(1)}s ${(results[id].bytes / 1024).toFixed(0)}KB` : `FAIL ${results[id].err}`);
  }
} else {
  for (const id of targets) results[id] = { ok: fs.existsSync(path.join(DEST, `${id}.png`)), skipped: true };
}

// catalog.html —— 自包含静态页，图片相对路径，教义摘要直读 JSON
const cards = targets.map((id) => {
  const s = styles[id] || {};
  const esc = (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // 真实存在的预览命令（cvs image --page 单帧），不造 --style 这种不存在的话术
  const cmd = `cvs image --page "${stylePageFor(id)}?${styleQueryFor(id) || ''}" --out preview-${id}.png`;
  return `<figure class="card${results[id]?.ok ? '' : ' missing'}">
  <img loading="lazy" src="catalog/${encodeURIComponent(id)}.png" alt="${esc(id)} representative frame" width="${W}" height="${H}">
  <figcaption><b>${esc(id)}</b>
  <p>${esc(s.essence || '')}</p>
  <p class="dims">${esc(['colourLogic', 'typeRules', 'motionQuality', 'soundPalette'].map((k) => s[k] ? `${k}: ${String(s[k]).slice(0, 60)}` : '').filter(Boolean).join(' · '))}</p>
  <code>${esc(cmd)}</code></figcaption>
</figure>`;
}).join('\n');
fs.writeFileSync(HTML, `<!doctype html><meta charset="utf-8"><title>CVS style catalog (${targets.length})</title>
<style>body{font:14px/1.5 system-ui;background:#0e0e0d;color:#eee;margin:2rem auto;max-width:1200px;padding:0 1rem}
h1{font-size:1.3rem}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:1rem}
.card{background:#17161a;border:1px solid #2a2930;border-radius:8px;overflow:hidden;margin:0}
.card img{width:100%;display:block}.card figcaption{padding:.6rem .8rem}
.card.missing{opacity:.35}.dims{color:#9a96a6;font-size:.8rem}code{font-size:.75rem;color:#8fd0a8}</style>
<h1>CVS 画风目录 · ${targets.length} styles · 由 scripts/make-catalog.mjs 生成，参数复制即用</h1>
<div class="grid">\n${cards}\n</div>
`);
console.log(`[catalog] wrote ${path.relative(ROOT, HTML)} (${targets.length} entries)`);

const missing = targets.filter((id) => !results[id]?.ok);
if (missing.length) { console.error(`[catalog] MISSING ${missing.length}: ${missing.join(', ')}`); process.exit(1); }
console.log(`[catalog] all ${targets.length} present`);
