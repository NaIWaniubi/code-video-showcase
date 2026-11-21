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

fs.rmSync(tmp, { recursive: true, force: true });
if (fails) { console.error(`[test-trust-fixes] ${fails} FAIL`); process.exit(1); }
console.log('[test-trust-fixes] all green');
