#!/usr/bin/env node
/**
 * test-trust-fixes.mjs — S0 可信度批次的命名回归测试（内审 F1/F2/F3/F5）。
 *
 * 每条断言对应一个已复验的「假绿」缺陷，防止它再从新接口面长回来：
 *   T1 (F5) bare 模块说明符在 plan 期硬闸 E_PAGE_BARE（此前静默不进哈希）。
 *   T2 (F2) toolchain 指纹含渲染浏览器（Chrome 自更新后缓存必须失效）。
 *   T3 (F3) film.mjs --overrides 真把 overrides 写进 film.html 属性。
 *   T4 (F1) mcp cvs_qa 以 --plan 旗标传 plan（不再当位置参数被吞）。
 *   T5      正常 fixture 不受影响：mini-41s 仍能 plan（无 bare、指纹新格式）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let fails = 0;
const ok = (name, cond, note = '') => {
  if (cond) console.log(`  ok  ${name}${note ? ` — ${note}` : ''}`);
  else { fails++; console.error(`  FAIL ${name}${note ? ` — ${note}` : ''}`); }
};

// 复制 fixture spec 到临时 root，页面替换成带 bare import 的页
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-trust-'));
const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2));

const baseSpec = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/mini-41s/spec.json'), 'utf8'));

// ── T1: bare import 硬闸 ─────────────────────────────────────────────
{
  const r = path.join(tmp, 'bare');
  fs.mkdirSync(path.join(r, 'templates'), { recursive: true });
  const spec = structuredClone(baseSpec);
  spec.opening.page = 'templates/bare-page.html';
  fs.writeFileSync(path.join(r, 'templates/bare-page.html'),
    `<!doctype html><script type="module">import { something } from 'some-npm-package';\nwindow.DURATION=8;window.renderFrame=()=>{};window.__ready=true;</script>`);
  writeJson(path.join(r, 'spec.json'), spec);
  const res = spawnSync(process.execPath, [path.join(ROOT, 'templates/plan.mjs'), '--spec', path.join(r, 'spec.json'), '--root', r, '--check'],
    { encoding: 'utf8', timeout: 60000 });
  const out = (res.stdout || '') + (res.stderr || '');
  ok('T1 E_PAGE_BARE blocks plan', res.status !== 0 && out.includes('E_PAGE_BARE'), `exit=${res.status}`);
}

// ── T2: 指纹含浏览器（plan.meta.toolchain 外可见 + 值含 node/ffmpeg/浏览器） ──
{
  const r = path.join(tmp, 'fp');
  fs.mkdirSync(r, { recursive: true });
  const res2 = spawnSync(process.execPath, [path.join(ROOT, 'templates/plan.mjs'), '--spec', path.join(ROOT, 'fixtures/mini-41s/spec.json'), '--root', ROOT, '--out', path.join(r, 'plan.json')],
    { encoding: 'utf8', timeout: 120000 });
  let tc = '';
  try { tc = String(JSON.parse(fs.readFileSync(path.join(r, 'plan.json'), 'utf8')).meta?.toolchain || ''); } catch { /* fail below */ }
  ok('T2 meta.toolchain visible + has browser slot', res2.status === 0 && tc.includes('node') && tc.includes('ffmpeg') && /chrome|edge|chromium|no-browser/i.test(tc), tc.slice(0, 140));
}

// ── T3: film --overrides 落进 film.html ─────────────────────────────
{
  const r = path.join(tmp, 'film');
  fs.mkdirSync(r, { recursive: true });
  const overrides = [{ clipId: '00-opening', overrides: { style: { color: '#ff8800' } } }];
  writeJson(path.join(r, 'ov.json'), overrides);
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts/film.mjs'), path.join(ROOT, 'fixtures/mini-41s/spec.json'), '--root', ROOT, '--out', path.join(r, 'film'), '--overrides', path.join(r, 'ov.json')],
    { encoding: 'utf8', timeout: 60000, cwd: ROOT });
  const filmPath = path.join(r, 'film', 'film.html');
  const filmHtml = fs.existsSync(filmPath) ? fs.readFileSync(filmPath, 'utf8') : '';
  ok('T3 film.html carries overrides attr', res.status === 0 && filmHtml.includes(`overrides='`), `exit=${res.status}`);
}

// ── T4: MCP cvs_qa argv 用 --plan ───────────────────────────────────
{
  const src = fs.readFileSync(path.join(ROOT, 'mcp/server.mjs'), 'utf8');
  const qaSeg = src.slice(src.indexOf("name: 'cvs_qa'"), src.indexOf("name: 'cvs_qa'") + 1200);
  ok('T4 mcp cvs_qa passes --plan', qaSeg.includes("'--plan', a.planPath") || qaSeg.includes('"--plan", a.planPath'));
  ok('T4b mcp cvs_qa no bare positional plan', !/a\.planPath \? \[a\.planPath\]/.test(qaSeg));
}

// ── T5: 正常 fixture 仍过 plan（回归安全） ──────────────────────────
{
  const res = spawnSync(process.execPath, [path.join(ROOT, 'templates/plan.mjs'), '--spec', path.join(ROOT, 'fixtures/mini-41s/spec.json'), '--root', ROOT, '--check'],
    { encoding: 'utf8', timeout: 120000 });
  ok('T5 fixture plan still --check clean', res.status === 0, `exit=${res.status}`);
}

// ── T6: 生产 URL 保留 plan 的合法 query（v2.9.0 RT-07 P2-2 过度矫正回归——
//        全剥 query 让成片渲染成页面内建 demo 文案，theme/brand/custom copy 静默失效，
//        qa 只验 plan 不验像素所以全绿。校园墙宣传片实测暴露。）
{
  const { withSegmentParams } = await import('../templates/render-segment.mjs');
  const url = withSegmentParams('templates/big-card.html?theme=amber-noir&mp=dynamic&title=%E5%85%AB%E5%A4%A7&first=%E8%A1%A8%E7%99%BD&layout=2', 9999, { t0: 0, speed: 1, duration: 1 });
  const u = new URL(url);
  ok('T6 keeps theme/mp/title/first/layout', u.searchParams.get('theme') === 'amber-noir' && u.searchParams.get('title') === '八大' && u.searchParams.get('layout') === '2', url.slice(0, 120));
  ok('T6b renderer params still force-set', u.searchParams.get('seg') === '1' && u.searchParams.get('dur') === '1' && u.searchParams.has('t0') && u.searchParams.has('speed'));
  const t6c = withSegmentParams('templates/segment.html?seg=0&t0=99', 9999, { t0: 0, speed: 1, duration: 1 });
  ok('T6c plan page cannot override renderer seg/t0', /[?&]seg=1(&|$)/.test(t6c) && t6c.includes('t0=0'), t6c.slice(0, 90));
}

// ── T7: URL 溯源闸双向（v4.9.2）——剥参 manifest 必须 FAIL，全参必须无此 FAIL ──
{
  const dir = path.join(tmp, 'prov');
  fs.mkdirSync(dir, { recursive: true });
  const mp4 = path.join(dir, 'm.mp4');
  const mk = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'testsrc=size=64x64:rate=30:duration=0.3', '-pix_fmt', 'yuv420p', '-frames:v', '9', mp4], { timeout: 90000 });
  if (mk.status !== 0 || !fs.existsSync(mp4)) ok('T7 fixture mp4', false, 'ffmpeg 造不了小样');
  else {
    const planDoc = { meta: { root: ROOT, fps: 30, width: 64, height: 64 }, stats: { frames: 9, duration: 0.3 },
      segments: [{ id: 's1', page: 'templates/segment.html?theme=amber-noir&title=%E6%A0%B7', frames: 9, duration: 0.3, start: 0, t0: 0, speed: 1 }] };
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(planDoc));
    const qaRun = (url) => {
      fs.writeFileSync(path.join(dir, 'render-manifest.json'), JSON.stringify({ version: 1, segments: { s1: { status: 'done', frames: 9, renderUrl: url } } }));
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/qa-video.mjs'), mp4, '--plan', path.join(dir, 'plan.json'), '--no-contact'],
        { encoding: 'utf8', timeout: 280000 });
      return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
    };
    const bad = qaRun('http://127.0.0.1:1/templates/segment.html?seg=1&t0=0&speed=1&dur=0.3');
    ok('T7 FAIL on stripped params', bad.code !== 0 && bad.out.includes('url provenance') && bad.out.includes('theme=amber-noir lost'), `exit=${bad.code}`);
    const good = qaRun('http://127.0.0.1:1/templates/segment.html?theme=amber-noir&title=%E6%A0%B7&seg=1&t0=0&speed=1&dur=0.3');
    ok('T7b no provenance FAIL when params kept', !good.out.includes('lost in rendered URL'), `exit=${good.code}`);
  }
}

// ── T8-T12: v4.9.3 证伪批次回归（F2/F4/F5/F7/F9） ──────────────────
{
  const { toVtt, toSrt } = await import('./caption.mjs');
  const doc2 = { segments: [{ start: 0, end: 1.5, text: 'Hello, world, 你好，世界' }] };
  const vtt = toVtt(doc2);
  ok('T8 vtt dots only in timecodes (F7)', vtt.includes('00:00:01.500') && vtt.includes('Hello, world') && vtt.includes('你好，世界'), vtt.split('\n')[3] || '');
}
{
  // F5：动态 import('pkg') 必须被 E_PAGE_BARE 拦
  const r = path.join(tmp, 'dyn');
  fs.mkdirSync(path.join(r, 'templates'), { recursive: true });
  const spec = structuredClone(baseSpec);
  spec.opening.page = 'templates/dyn-page.html';
  fs.writeFileSync(path.join(r, 'templates/dyn-page.html'),
    `<!doctype html><script type="module">const m = await import('chart.js');\nwindow.DURATION=8;window.renderFrame=()=>{};window.__ready=true;</script>`);
  writeJson(path.join(r, 'spec.json'), spec);
  const res = spawnSync(process.execPath, [path.join(ROOT, 'templates/plan.mjs'), '--spec', path.join(r, 'spec.json'), '--root', r, '--check'],
    { encoding: 'utf8', timeout: 60000 });
  ok('T9 dynamic import blocked (F5)', res.status !== 0 && ((res.stdout || '') + (res.stderr || '')).includes('E_PAGE_BARE'), `exit=${res.status}`);
}
{
  // F2：qa.mjs 的 --plan 值不得泄漏成视频路径（在空临时目录跑，缺省视频必然不存在）
  const wd = path.join(tmp, 'qawd'); fs.mkdirSync(wd, { recursive: true });
  writeJson(path.join(wd, 'plan.json'), { segments: [] });
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts/qa.mjs'), '--plan', path.join(wd, 'plan.json')],
    { encoding: 'utf8', timeout: 60000, cwd: wd });
  const out = (res.stdout || '') + (res.stderr || '');
  ok('T10 flag value not positional (F2)', res.status === 13 && /master\.mp4/.test(out) && !out.includes(path.join(wd, 'plan.json')), `exit=${res.status}`);
}
{
  // F4：overrides 文本含撇号必须转义（单引号属性不破）
  const { buildFilmHtml } = await import('./lib/film-export.mjs');
  const ovs = new Map([['00-opening', { text: "don't stop" }]]);
  const html = buildFilmHtml(baseSpec, { overridesByClip: ovs });
  ok('T11 apostrophe escaped in overrides attr (F4)', html.includes('&#39;') && !/overrides='[^']*don't/.test(html));
}
{
  // F9：规则目录与 EVALS 脱节必须拦（闸自身故障不许绿）
  const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema/taste-rules.json'), 'utf8'));
  cat.rules.push({ id: 'ghost-rule', title: '不存在的规则', severity: 'warning', weight: 5, input: 'spec', waivable: false });
  const rf = path.join(tmp, 'rules.json'); writeJson(rf, cat);
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts/taste.mjs'), path.join(ROOT, 'fixtures/mini-41s/spec.json'), '--root', ROOT, '--rules', rf],
    { encoding: 'utf8', timeout: 90000 });
  const out = (res.stdout || '') + (res.stderr || '');
  ok('T12 unimplemented rule blocks (F9)', res.status === 13 && out.includes('gate-fault'), `exit=${res.status}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
if (fails) { console.error(`[test-trust-fixes] ${fails} FAIL`); process.exit(1); }
console.log('[test-trust-fixes] all green');
