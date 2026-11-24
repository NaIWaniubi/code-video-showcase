#!/usr/bin/env node
/**
 * test-ui.mjs — 统一工作台（app/ui/serve.mjs）与界面壳的验收。
 *
 *   1. /app/ 首页存在，六个界面都从它链得到
 *   2. 六个 surface 在同一 origin 下都是 200
 *   3. /frames/api/* 与 /jobs/*（评审反代）挂在同一 server 上
 *   4. 浏览器可直接 import spec.mjs（链上不能出现 node: 内置模块）
 *   5. 静态缓存策略：HTML no-store；模板/模块 max-age=120；字体 600
 *   6. 默认静态服务器仍保持 no-store（不影响 canvas/review 的既有行为）
 *   7. 路径穿越仍被挡
 *
 * 纯 Node（不需要 Chrome/ffmpeg）。退出码 0/1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUiServer } from '../app/ui/serve.mjs';
import { createStaticServer } from '../app/canvas/serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
}
const section = (t) => console.log(`\n--- ${t} ---`);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
const close = (server) => new Promise((r) => server.close(() => r()));

async function getText(base, p) {
  const res = await fetch(base + p);
  return { res, text: await res.text() };
}

(async () => {
  const ui = createUiServer(ROOT, { apiTarget: 'http://127.0.0.1:1' });
  const port = await listen(ui);
  const base = `http://127.0.0.1:${port}`;

  try {
    section('首页与导航');
    const landing = await getText(base, '/app/');
    check('/app/ 200', landing.res.status === 200);
    check('首页有产品名', landing.text.includes('code-video-showcase'));
    check('首页列出六个界面', (landing.text.match(/class="card"/g) || []).length === 6, String((landing.text.match(/class="card"/g) || []).length));
    for (const s of ['wizard', 'script', 'canvas', 'versions', 'review', 'frames']) {
      check(`首页链到 ${s}`, landing.text.includes(`href="./${s}/"`));
    }

    section('六个 surface 同源可用');
    const titles = {
      wizard: '开始', script: '剧本表格', canvas: '画布', versions: '版本树', review: '评审', frames: '帧预览',
    };
    for (const [s, title] of Object.entries(titles)) {
      const r = await getText(base, `/app/${s}/`);
      check(`/app/${s}/ 200 且标题含「${title}」`, r.res.status === 200 && r.text.includes(title), String(r.res.status));
      check(`/app/${s}/ 有返回工作台入口`, r.text.includes('class="app-home"') && r.text.includes('href="/app/"'));
    }

    section('API 与反代');
    const health = await getText(base, '/frames/api/health');
    check('/frames/api/health 200', health.res.status === 200);
    check('health JSON ok', (() => { try { return JSON.parse(health.text).ok === true; } catch { return false; } })());
    const cand = await getText(base, '/frames/api/candidates');
    check('/frames/api/candidates JSON', cand.res.status === 200 && (() => { try { const j = JSON.parse(cand.text); return Array.isArray(j.videos) && Array.isArray(j.plans); } catch { return false; } })());
    const jobs = await fetch(base + '/jobs/does-not-exist');
    const jobsType = jobs.headers.get('content-type') || '';
    check('/jobs/* 反代到 API（目标不可达时 502 JSON）', jobs.status === 502 && jobsType.includes('application/json'), `${jobs.status} ${jobsType}`);

    section('浏览器可导入的模块链');
    const specSrc = fs.readFileSync(path.join(ROOT, 'templates/spec.mjs'), 'utf8');
    const coreSrc = fs.readFileSync(path.join(ROOT, 'templates/timeline-core.mjs'), 'utf8');
    check('spec.mjs 无 node: 静态导入', !/from\s+['"]node:/.test(specSrc));
    check('timeline-core.mjs 无 node: 导入', !/from\s+['"]node:/.test(coreSrc));
    const specHttp = await getText(base, '/templates/spec.mjs');
    check('spec.mjs 可被 HTTP 取到', specHttp.res.status === 200 && specHttp.text.includes('normalizeSpec'));
    check('spec.mjs 改从 timeline-core 导入', specSrc.includes("from './timeline-core.mjs'"));

    section('缓存策略');
    const tpl = await fetch(base + '/templates/spec.mjs');
    check('模板/模块 max-age=120', (tpl.headers.get('cache-control') || '').includes('max-age=120'), String(tpl.headers.get('cache-control')));
    const html = await fetch(base + '/app/index.html');
    check('HTML no-store', (html.headers.get('cache-control') || '') === 'no-store', String(html.headers.get('cache-control')));
    const font = await fetch(base + '/node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2');
    check('字体长缓存或 404 但不报错', font.status === 404 || (font.headers.get('cache-control') || '').includes('max-age=600'), `${font.status} ${font.headers.get('cache-control')}`);

    section('安全边界');
    const trav = await fetch(base + '/app/%2e%2e/%2e%2e/Windows/win.ini');
    check('穿越被挡', trav.status === 404 || trav.status === 403, String(trav.status));
    const missing = await fetch(base + '/app/nope/');
    check('未知页面 404', missing.status === 404, String(missing.status));

    section('默认静态服务器行为不变');
    const plain = createStaticServer(ROOT);
    const pport = await listen(plain);
    try {
      const r = await fetch(`http://127.0.0.1:${pport}/templates/spec.mjs`);
      check('createStaticServer 默认仍 no-store', r.headers.get('cache-control') === 'no-store', String(r.headers.get('cache-control')));
    } finally {
      await close(plain);
    }
  } finally {
    await close(ui);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('[fatal]', e && e.stack || e); process.exit(1); });
