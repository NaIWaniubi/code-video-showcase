#!/usr/bin/env node
/**
 * test-frames.mjs — 逐帧实时预览（app/frames）的验收。
 *
 *   node scripts/test-frames.mjs              # 全量（需要 ffmpeg；有 Chrome 时含渲染）
 *   node scripts/test-frames.mjs --no-browser # 只测纯函数 + 视频/图片 API
 *
 * 断言分四层：
 *   1. 帧号数学：fps 有理数、round(duration*fps)、t=n/fps、时间码、段定位
 *   2. 视频源：ffmpeg 逐帧解码后的帧数、帧号索引、同帧稳定、越界/穿越/方法拒绝
 *   3. 图片源：目录/清单、自然排序、越界
 *   4. spec 源（真实 Chrome）：同一帧两次独立渲染字节一致；工作台 live 画布
 *      与服务端 PNG 逐像素相同（这就是「预览帧 == 成片帧」的硬证据），
 *      以及 UI 的逐帧步进/播放/跳转。
 *
 * 退出码 0/1。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { startFrameServer } from '../app/frames/serve.mjs';
import { parseRate, frameCountOf, frameToTime, timeToFrame, timecodeOf, findSegment, frameInfo, naturalCompare, imageSize } from '../app/frames/source.mjs';
import { launch, evaluate, browserCandidates } from '../templates/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TMP = path.join(ROOT, 'out', '_test-frames');
const NO_BROWSER = process.argv.includes('--no-browser');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 像素断言口径（R16-W 探明）：
//   rendererEndpoint 注入后 live iframe 与服务端取帧**同进程同 URL**——实测位级一致
//   （meanDiff=0，这是「预览帧 == 成片帧」的硬证据；非零是确定性信号，回头排查）。
//   --no-browser 时服务端自起独立 Chrome，跨实例仍有 ~0.07–21 的 AA 级抖动
//   （与 golden envCompare 同口径），此时按 PIXEL_TOL 容差兜底。
const PIXEL_TOL = 25;

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
  return ok;
}
const section = (t) => console.log(`\n--- ${t} ---`);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function apiJson(base, pathname) {
  const res = await fetch(base + pathname);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { res, body, text };
}
async function apiBuf(base, pathname) {
  const res = await fetch(base + pathname);
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf, type: res.headers.get('content-type'), headers: res.headers };
}

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', ...args], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + String(r.stderr || '').slice(0, 500));
}

// ── 1. 纯函数 ───────────────────────────────────────────────────────────────

function testMath() {
  section('帧号数学');
  check('parseRate 30/1', parseRate('30/1') === 30);
  check('parseRate 30000/1001', Math.abs(parseRate('30000/1001') - 29.97002997) < 1e-6, String(parseRate('30000/1001')));
  check('parseRate 0/0 回退', parseRate('0/0', 24) === 24);
  check('frameCountOf round', frameCountOf(0.4, 30) === 12 && frameCountOf(4, 30) === 120);
  check('frameCountOf 29.97', frameCountOf(10, 29.97) === 300, String(frameCountOf(10, 29.97)));
  check('frameToTime', frameToTime(42, 30) === 1.4);
  check('timeToFrame 四舍五入', timeToFrame(1.4, 30) === 42 && timeToFrame(1.416, 30) === 42);
  check('timecode 0', timecodeOf(0, 30) === '00:00:00:00', timecodeOf(0, 30));
  check('timecode 30', timecodeOf(30, 30) === '00:00:01:00', timecodeOf(30, 30));
  check('timecode 59', timecodeOf(59, 30) === '00:00:01:29', timecodeOf(59, 30));
  check('timecode 90', timecodeOf(90, 30) === '00:00:03:00', timecodeOf(90, 30));

  const segments = [
    { id: 'a', startFrame: 0, endFrame: 30 },
    { id: 'b', startFrame: 30, endFrame: 42 },
    { id: 'c', startFrame: 42, endFrame: 60 },
  ];
  check('段边界：29 → a', findSegment(segments, 29).id === 'a');
  check('段边界：30 → b', findSegment(segments, 30).id === 'b');
  check('段边界：41 → b', findSegment(segments, 41).id === 'b');
  check('段边界：42 → c', findSegment(segments, 42).id === 'c');
  check('段边界：60 → null', findSegment(segments, 60) === null);

  const plan = { stats: { fps: 30 }, segments };
  const i42 = frameInfo(plan, 42);
  check('frameInfo 42 段内帧号', i42.seg.id === 'c' && i42.localFrame === 0 && i42.t === 0, JSON.stringify({ seg: i42.seg.id, local: i42.localFrame, t: i42.t }));
  const i47 = frameInfo(plan, 47);
  check('frameInfo 47 t=5/30', i47.localFrame === 5 && Math.abs(i47.t - 5 / 30) < 1e-12, String(i47.t));

  check('naturalCompare', ['f_10', 'f_2', 'f_1'].sort(naturalCompare).join(',') === 'f_1,f_2,f_10');
}

// ── 2/3. 视频 + 图片源 API ─────────────────────────────────────────────────

async function testMediaApis() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'cache'), { recursive: true });
  fs.mkdirSync(path.join(TMP, 'images'), { recursive: true });

  const video = path.join(TMP, 'tiny.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '10', video]);
  const imgDir = path.join(TMP, 'images');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=64x36', '-frames:v', '1', path.join(imgDir, 'f_10.png')]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=green:s=64x36', '-frames:v', '1', path.join(imgDir, 'f_2.png')]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=64x36', '-frames:v', '1', path.join(imgDir, 'f_1.png')]);

  const { server, url } = await startFrameServer({ root: ROOT, port: 0, cacheRoot: path.join(TMP, 'cache'), host: '127.0.0.1' });

  try {
    section('视频源 API');
    const open = await apiJson(url, '/frames/api/open?video=' + encodeURIComponent(path.relative(ROOT, video)));
    check('open 200', open.res.status === 200, String(open.res.status));
    check('视频帧数 10', open.body && open.body.meta.frames === 10, JSON.stringify(open.body && open.body.meta && { frames: open.body.meta.frames, fps: open.body.meta.fps }));
    check('视频 fps 10', open.body && Math.abs(open.body.meta.fps - 10) < 1e-9);
    check('视频尺寸 160×90', open.body && open.body.meta.width === 160 && open.body.meta.height === 90);
    const id = open.body && open.body.id;

    for (let i = 0; i < 100; i++) {
      const m = await apiJson(url, '/frames/api/meta?id=' + id);
      if (m.body && m.body.meta.done) break;
      await sleep(100);
    }
    const meta = await apiJson(url, '/frames/api/meta?id=' + id);
    check('渐进解码完成', meta.body && meta.body.meta.done === true && meta.body.meta.decoded === 10, JSON.stringify(meta.body && meta.body.meta && { decoded: meta.body.meta.decoded, done: meta.body.meta.done }));

    const f0 = await apiBuf(url, `/frames/api/frame?id=${id}&n=0`);
    check('frame 0 200 jpeg', f0.res.status === 200 && f0.type === 'image/jpeg' && f0.buf.length > 500, `${f0.type} ${f0.buf.length}B`);
    check('X-Frame-Index 头', f0.headers.get('x-frame-index') === '0');
    check('X-Frame-Timecode 头', f0.headers.get('x-frame-timecode') === '00:00:00:00', String(f0.headers.get('x-frame-timecode')));
    const f4 = await apiBuf(url, `/frames/api/frame?id=${id}&n=4`);
    const f4b = await apiBuf(url, `/frames/api/frame?id=${id}&n=4`);
    check('frame 4 与 frame 0 不同', sha(f0.buf) !== sha(f4.buf));
    check('同一帧两次字节一致', sha(f4.buf) === sha(f4b.buf));
    check('帧 9 存在', (await apiBuf(url, `/frames/api/frame?id=${id}&n=9`)).res.status === 200);
    check('越界帧 10 → 400', (await apiBuf(url, `/frames/api/frame?id=${id}&n=10`)).res.status === 400);
    check('负帧 → 400', (await apiBuf(url, `/frames/api/frame?id=${id}&n=-1`)).res.status === 400);
    check('非整数帧 → 400', (await apiBuf(url, `/frames/api/frame?id=${id}&n=1.5`)).res.status === 400);

    section('安全边界');
    check('路径穿越 → 403', (await apiJson(url, '/frames/api/open?video=' + encodeURIComponent('../../Windows/win.ini'))).res.status === 403);
    check('未知 source → 404', (await apiJson(url, '/frames/api/meta?id=f-999')).res.status === 404);
    check('未知路由 → 404', (await apiJson(url, '/frames/api/nope')).res.status === 404);
    const post = await fetch(url + '/frames/api/health', { method: 'POST' });
    check('POST → 405', post.status === 405);
    const stat = await apiBuf(url, '/app/frames/');
    check('工作台页面 200', stat.res.status === 200 && stat.buf.toString('utf8').includes('帧预览'));

    section('图片序列 API');
    const imgOpen = await apiJson(url, '/frames/api/open?dir=' + encodeURIComponent(path.relative(ROOT, imgDir)));
    check('图片源 3 帧', imgOpen.body && imgOpen.body.meta.frames === 3, JSON.stringify(imgOpen.body && imgOpen.body.meta && { frames: imgOpen.body.meta.frames }));
    const iid = imgOpen.body && imgOpen.body.id;
    const im0 = await apiBuf(url, `/frames/api/frame?id=${iid}&n=0`);
    const im2 = await apiBuf(url, `/frames/api/frame?id=${iid}&n=2`);
    check('自然排序：0=f_1 红', sha(im0.buf) !== sha(im2.buf));
    check('图片是 png', im0.type === 'image/png', String(im0.type));
    const size = imageSize(im0.buf);
    check('imageSize 64×36', size && size.width === 64 && size.height === 36, JSON.stringify(size));
    check('图片越界 3 → 400', (await apiBuf(url, `/frames/api/frame?id=${iid}&n=3`)).res.status === 400);

    const cand = await apiJson(url, '/frames/api/candidates');
    check('candidates 结构', cand.res.status === 200 && Array.isArray(cand.body.videos) && Array.isArray(cand.body.plans));
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ── 4. spec 源 + 工作台（真实 Chrome） ─────────────────────────────────────

async function testSpecAndUi() {
  const candidates = browserCandidates();
  if (!candidates.length) {
    console.log('\n[skip] 没找到 Chrome/Edge，跳过 spec 渲染与工作台 UI 测试（设 CHROME_EXE 可强制指定）');
    return;
  }
  section('spec 源（真实 Chrome）');
  // R16-W：浏览器先行——先起工作台那台 Chrome，spec 源的服务端取帧经 rendererEndpoint
  // 连入同一进程（与 live iframe 同光栅化）。位级对比的前提是同进程；--no-browser 时
  // 不注入，渲染器自起独立 Chrome（历史行为）。
  let browser = null;
  let sharedEndpoint = null;
  if (!NO_BROWSER) {
    browser = await launch({ executablePath: process.env.CHROME_EXE || candidates[0], width: 1440, height: 900, timeout: 30000 });
    const lines = fs.readFileSync(path.join(browser.userDataDir || '', 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
    sharedEndpoint = `ws://127.0.0.1:${Number(lines[0])}${lines[1] || ''}`;
  }
  const { server, url } = await startFrameServer({
    root: ROOT, port: 0, cacheRoot: path.join(TMP, 'cache-spec'), host: '127.0.0.1',
    ...(sharedEndpoint ? { rendererEndpoint: sharedEndpoint } : {}),
  });
  try {
    const open = await apiJson(url, '/frames/api/open?spec=' + encodeURIComponent('fixtures/mini-41s/spec.json'));
    check('spec open 200', open.res.status === 200, String(open.res.status));
    const meta = open.body && open.body.meta;
    check('spec 帧数 1230', meta && meta.frames === 1230, String(meta && meta.frames));
    check('spec fps 30', meta && meta.fps === 30);
    check('spec 有段', meta && meta.segments.length > 5, String(meta && meta.segments.length));
    check('spec 每段带 page', meta && meta.segments.every((s) => typeof s.page === 'string' && s.page.length > 0));

    // R16-3：agent 建议层契约——结构切点数组（每段边界；卡→风格内部不算切点）。
    const sug = await apiJson(url, '/frames/api/suggestions?spec=' + encodeURIComponent('fixtures/mini-41s/spec.json'));
    check('suggestions 结构', sug.res.status === 200 && sug.body.ok === true && Array.isArray(sug.body.cuts) &&
      sug.body.cuts.length > 0 && sug.body.cuts.every((c) => Number.isFinite(c.at) && c.before && c.after && c.kind),
      `cuts=${sug.body && sug.body.cuts ? sug.body.cuts.length : 0} total=${sug.body && sug.body.total}`);
    const id = open.body && open.body.id;

    const t0 = Date.now();
    const f0 = await apiBuf(url, `/frames/api/frame?id=${id}&n=0&fmt=png&q=90`);
    check('spec frame 0 200 png', f0.res.status === 200 && f0.type === 'image/png' && f0.buf.length > 20 * 1024, `${f0.type} ${(f0.buf.length / 1024).toFixed(0)}KB ${Date.now() - t0}ms`);
    check('段头 = 首段', f0.headers.get('x-frame-segment') === meta.segments[0].id, String(f0.headers.get('x-frame-segment')));

    // 同一帧两次独立渲染（q 不同 → 缓存键不同）→ PNG 字节必须一致
    const a = await apiBuf(url, `/frames/api/frame?id=${id}&n=0&fmt=png&q=90`);
    const b = await apiBuf(url, `/frames/api/frame?id=${id}&n=0&fmt=png&q=91`);
    check('同一帧独立渲染字节一致', sha(a.buf) === sha(b.buf), `${sha(a.buf).slice(0, 12)} / ${sha(b.buf).slice(0, 12)}`);

    // 带 t0/speed 的风格段：取段首帧与次帧，验证 t 映射与段头
    const style = meta.segments.find((s) => s.kind === 'style');
    if (style) {
      const s0 = await apiBuf(url, `/frames/api/frame?id=${id}&n=${style.startFrame}&fmt=png&q=90`);
      const s1 = await apiBuf(url, `/frames/api/frame?id=${id}&n=${style.startFrame + 1}&fmt=png&q=90`);
      check(`风格段首帧段头 = ${style.id}`, s0.headers.get('x-frame-segment') === style.id, String(s0.headers.get('x-frame-segment')));
      check('风格段首帧 t=0', Number(s0.headers.get('x-frame-time')) === 0, String(s0.headers.get('x-frame-time')));
      check('风格段次帧 t=1/fps', Math.abs(Number(s1.headers.get('x-frame-time')) - 1 / 30) < 1e-6, String(s1.headers.get('x-frame-time')));
      check('相邻帧不同', sha(s0.buf) !== sha(s1.buf));
    }

    if (NO_BROWSER) { console.log('[skip] --no-browser：跳过工作台 UI 像素对比'); return; }

    // 释放 mini-41s 的服务端 Chrome，避免和下面工作台的 iframe 抢 CPU。
    await apiJson(url, '/frames/api/close?id=' + id);

    // 合成一个轻量 plan：两段、60 帧，一段带 t0/speed（覆盖非零段内时间映射）。
    // 页面用 segment.html / big-card.html（1920×1080 下 ~3s 就绪），
    // 让 UI 冒烟跑得快，同时保留与成片完全相同的 URL 参数。
    const planPath = path.join(TMP, 'ui-plan.json');
    const synth = {
      version: 2,
      meta: { name: 'frames-ui-test', theme: 'coral-noir' },
      stats: { fps: 30, frames: 60, duration: 2, segments: 2 },
      spec: { format: { width: 640, height: 360, fps: 30, duration: 2 } },
      segments: [
        {
          id: 's1-style', kind: 'style', label: 's1', startFrame: 0, endFrame: 30, frames: 30, start: 0, end: 1,
          page: 'templates/segment.html?theme=coral-noir', duration: 1, t0: 0.3, speed: 1.3,
        },
        {
          id: 's2-card', kind: 'card', label: 's2', startFrame: 30, endFrame: 60, frames: 30, start: 1, end: 2,
          page: 'templates/big-card.html?theme=coral-noir&layout=0&index=1&total=1&first=Frame&keyword=Preview&brand=CVS&seconds=1',
          duration: 1, t0: 0, speed: 1,
        },
      ],
    };
    fs.writeFileSync(planPath, JSON.stringify(synth, null, 2) + '\n');
    const uiOpen = await apiJson(url, '/frames/api/open?plan=' + encodeURIComponent(path.relative(ROOT, planPath)));
    check('UI 用 plan open 200', uiOpen.res.status === 200, String(uiOpen.res.status));
    const uiId = uiOpen.body && uiOpen.body.id;
    check('UI plan 60 帧', uiOpen.body && uiOpen.body.meta.frames === 60, String(uiOpen.body && uiOpen.body.meta.frames));

    section('工作台 UI（live iframe）');
    // R16-W：浏览器已在 spec 段先行启动并注入 rendererEndpoint——这里复用同一台，
    // live iframe 与服务端取帧同进程，光栅化状态一致。
    const page = await browser.createPage({ width: 1440, height: 900 });
    // R16-W：页面级未捕获异常捕获——tick/showLive 抛错会让 rAF 循环静默死亡（实测坑），
    // UI 段结束时断言零异常，让这类「不报错只死机」的故障进回归。
    const pageExc = [];
    browser.client.on('Runtime.exceptionThrown', (m) => {
      const d = m.params?.exceptionDetails;
      pageExc.push(String(d?.exception?.description || d?.text || '').slice(0, 160));
    });
    const ev = (fn, arg) => evaluate(browser.client, page.sessionId, fn, arg);
    await browser.client.send('Page.navigate', { url: `${url}/app/frames/?id=${uiId}` }, page.sessionId);
    const started = Date.now();
    while (Date.now() - started < 20000) {
      const total = await ev(() => document.getElementById('total') && document.getElementById('total').textContent);
      if (total && total !== '0') break;
      await sleep(120);
    }
    check('工作台挂载帧源', await ev(() => document.getElementById('total').textContent === '60'));

    const segReady = async () => ev(() => {
      const frames = [...document.querySelectorAll('.live-frame')];
      const active = frames.find((f) => !f.classList.contains('off'));
      if (!active || active.contentWindow.__ready !== true) return false;
      return { src: active.src, hud: document.getElementById('hudFrame').textContent };
    });
    let activeInfo = null;
    for (let i = 0; i < 100; i++) {
      const s = await segReady();
      if (s && s.hud.startsWith('#0 ')) { activeInfo = s; break; }
      await sleep(150);
    }
    check('live iframe 就绪并激活', !!activeInfo, activeInfo ? activeInfo.src.split('?')[1] : 'timeout');
    check('live URL 带 t0/speed', !!activeInfo && activeInfo.src.includes('t0=0.3') && activeInfo.src.includes('speed=1.3'), activeInfo && activeInfo.src.split('?')[1]);

    // CDP evaluate 把 arg 内联进表达式，PNG base64（~300KB+）会超限截断导致
    // "source image could not be decoded"。分两步：先注入 base64，再执行对比。
    const png0 = (await apiBuf(url, `/frames/api/frame?id=${uiId}&n=0&fmt=png&q=90`)).buf.toString('base64');
    const png1 = (await apiBuf(url, `/frames/api/frame?id=${uiId}&n=1&fmt=png&q=90`)).buf.toString('base64');
    await ev((b64) => { window.__pngB64 = b64; }, png0);
    const live = await ev(async (arg) => {
      const frames = [...document.querySelectorAll('.live-frame')];
      const active = frames.find((f) => !f.classList.contains('off'));
      const cv = active.contentWindow.document.querySelector('canvas');
      const out = [];
      for (const offset of [0, 1]) {
        // R16-W：字体换装会改像素——两侧都 settle（服务端页创建时已等过 fonts.ready）。
        await active.contentWindow.document.fonts.ready;
        const t0 = performance.now();
        active.contentWindow.renderFrame(offset / arg.fps);
        const ms = performance.now() - t0;
        const canvasData = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        if (offset === 1) {
          // 第二张 PNG 走页内 fetch（同源帧 API），绕开 evaluate 的 payload 限制。
          const blob = await (await fetch(`/frames/api/frame?id=${arg.id}&n=1&fmt=png&q=90`)).blob();
          const bmp = await createImageBitmap(blob);
          const off = new OffscreenCanvas(bmp.width, bmp.height);
          const oc = off.getContext('2d');
          oc.drawImage(bmp, 0, 0);
          const serverData = oc.getImageData(0, 0, bmp.width, bmp.height).data;
          let diff = 0;
          for (let i = 0; i < canvasData.length; i += 4) diff += Math.abs(canvasData[i] - serverData[i]);
          out.push({ offset, ms: +ms.toFixed(2), meanDiff: +(diff / (canvasData.length / 4)).toFixed(4) });
          continue;
        }
        const bytes = Uint8Array.from(atob(window.__pngB64), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const off = new OffscreenCanvas(bmp.width, bmp.height);
        const oc = off.getContext('2d');
        oc.drawImage(bmp, 0, 0);
        const serverData = oc.getImageData(0, 0, bmp.width, bmp.height).data;
        let diff = 0;
        for (let i = 0; i < canvasData.length; i += 4) diff += Math.abs(canvasData[i] - serverData[i]);
        out.push({ offset, ms: +ms.toFixed(2), meanDiff: +(diff / (canvasData.length / 4)).toFixed(4) });
      }
      return { w: cv.width, h: cv.height, out };
    }, { id: uiId, n: 0, fps: 30 });
    // R16-W：rendererEndpoint 注入时 live iframe 与服务端取帧同进程——期望位级一致（==0，
    // 非零是确定性信号而非抖动，回头排查）；--no-browser（独立 Chrome）时跨实例容差兜底。
    const shared = !!sharedEndpoint;
    const diffTag = (d) => d === 0 ? '（位级一致·同进程）' : shared ? `（共享进程未归零 ${d} → 待排查）` : '（跨实例 AA 容差内）';
    check('live 画布 = 服务端 PNG（段首帧）', shared ? live.out[0].meanDiff === 0 : live.out[0].meanDiff <= PIXEL_TOL,
      `meanDiff=${live.out[0].meanDiff} ${live.w}×${live.h}${diffTag(live.out[0].meanDiff)}`);
    check('live 画布 = 服务端 PNG（段内 +1 帧）', shared ? live.out[1].meanDiff === 0 : live.out[1].meanDiff <= PIXEL_TOL,
      `meanDiff=${live.out[1].meanDiff}${diffTag(live.out[1].meanDiff)}`);
    check('live 单帧渲染 < 20ms', live.out[0].ms < 20, `${live.out[0].ms}ms`);

    // 跨段：跳到第 30 帧（另一段、另一个页面）
    await ev(() => {
      const f = document.getElementById('frameNum');
      f.value = '30';
      f.dispatchEvent(new Event('change', { bubbles: true }));
    });
    let seg2 = null;
    for (let i = 0; i < 100; i++) {
      const s = await ev(() => {
        const frames = [...document.querySelectorAll('.live-frame')];
        const active = frames.find((f) => !f.classList.contains('off'));
        return { src: active ? active.src : '', ready: active ? active.contentWindow.__ready === true : false, hud: document.getElementById('hudFrame').textContent };
      });
      if (s.ready && s.src.includes('big-card') && s.hud.startsWith('#30 ')) { seg2 = s; break; }
      await sleep(150);
    }
    check('跨段切到 big-card 页面', !!seg2, seg2 ? seg2.src.split('?')[0].split('/').pop() : 'timeout');
    if (seg2) {
      const cross = await ev(async (arg) => {
        const frames = [...document.querySelectorAll('.live-frame')];
        const active = frames.find((f) => !f.classList.contains('off'));
        const cv = active.contentWindow.document.querySelector('canvas');
        await active.contentWindow.document.fonts.ready;   // R16-W：同 pixel-compare 的 settle 口径
        active.contentWindow.renderFrame(0);
        const canvasData = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        const blob = await (await fetch(`/frames/api/frame?id=${arg.id}&n=30&fmt=png&q=90`)).blob();
        const bmp = await createImageBitmap(blob);
        const off = new OffscreenCanvas(bmp.width, bmp.height);
        const oc = off.getContext('2d'); oc.drawImage(bmp, 0, 0);
        const serverData = oc.getImageData(0, 0, bmp.width, bmp.height).data;
        let diff = 0;
        for (let i = 0; i < canvasData.length; i += 4) diff += Math.abs(canvasData[i] - serverData[i]);
        return +(diff / (canvasData.length / 4)).toFixed(4);
      }, { id: uiId });
      check('跨段帧同样逐像素一致', shared ? cross === 0 : cross <= PIXEL_TOL,
        `meanDiff=${cross}${cross === 0 ? '（位级一致·同进程）' : shared ? '（共享进程未归零 → 待排查）' : '（跨实例 AA 容差内）'}`);
    }

    // 逐帧步进 / 播放
    const hudBefore = await ev(() => document.getElementById('hudFrame').textContent);
    await ev(() => document.getElementById('next').click());
    await sleep(150);
    const hudAfter = await ev(() => document.getElementById('hudFrame').textContent);
    const num = (h) => Number(String(h).split(' ')[0].replace('#', ''));
    check('下一步 +1 帧', num(hudAfter) === num(hudBefore) + 1, `${hudBefore} → ${hudAfter}`);
    await ev(() => document.getElementById('prev').click());
    await sleep(120);
    check('上一步 -1 帧', await ev(() => document.getElementById('hudFrame').textContent) === hudBefore);
    // R16-W：共享浏览器里服务端取帧开的渲染器标签页会遮挡本页（headless 仅最新
    // 目标有可见性，rAF 对后台标签冻结）——播放前必须前台化，否则 tick 死停。
    try { await browser.client.send('Page.bringToFront', {}, page.sessionId); } catch { /* ignore */ }
    await ev(() => document.getElementById('play').click());
    await sleep(900);
    const playing = await ev(() => ({ hud: document.getElementById('hudFrame').textContent, perf: document.getElementById('perf').textContent }));
    await ev(() => document.getElementById('play').click());
    check('播放推进帧号', playing.hud !== hudBefore, `${hudBefore} → ${playing.hud}`);
    check('实时帧率读数存在', /实测 \d+ fps/.test(playing.perf), playing.perf);
    check('渲染耗时读数 < 20ms', (() => { const m = playing.perf.match(/渲染 ([\d.]+) ms/); return m && Number(m[1]) < 20; })(), playing.perf);
    check('工作台全程无未捕获异常', pageExc.length === 0, pageExc.slice(0, 2).join(' | ').slice(0, 160));

    // ── R16-3/R17-W：段级编辑接线钉子（split → undo → redo 全往返）──
    // R17-W：播放头可能停在片尾（分割贴边偶发），编辑钉子固定到安全帧 15（s1-style
    // 中段），等 HUD 就位再动按钮。
    await ev(() => { const f = document.getElementById('frameNum'); f.value = '15'; f.dispatchEvent(new Event('change', { bubbles: true })); });
    for (let i = 0; i < 60; i++) {
      const hud = String(await ev(() => document.getElementById('hudFrame').textContent));
      if (hud.startsWith('#15 ')) break;
      await sleep(250);
    }
    const bandsBefore = Number(await ev(() => document.querySelectorAll('#ruler .band').length));
    await ev(() => document.getElementById('btn-split').click());
    await sleep(250);
    const splitInfo = await ev(() => JSON.stringify({
      bands: document.querySelectorAll('#ruler .band').length,
      status: document.getElementById('status').textContent,
    }));
    const sp = JSON.parse(splitInfo);
    check('分割段按钮接线', Number(sp.bands) === bandsBefore + 1 && /已分割/.test(sp.status), `${bandsBefore} → ${sp.bands} · ${sp.status}`);
    await ev(() => document.getElementById('btn-undo').click());
    await sleep(250);
    const undoInfo = await ev(() => JSON.stringify({
      bands: document.querySelectorAll('#ruler .band').length,
      status: document.getElementById('status').textContent,
    }));
    const un = JSON.parse(undoInfo);
    check('撤销按钮接线', Number(un.bands) === bandsBefore && /已撤销/.test(un.status), `${sp.bands} → ${un.bands} · ${un.status}`);

    // R17-W：重做链路——按钮一次、再撤销后键盘 Ctrl+Shift+Z 一次（状态精确回到分割态）。
    await ev(() => document.getElementById('btn-redo').click());
    await sleep(250);
    const redoInfo = await ev(() => JSON.stringify({
      bands: document.querySelectorAll('#ruler .band').length,
      status: document.getElementById('status').textContent,
    }));
    const rd = JSON.parse(redoInfo);
    check('重做按钮接线', Number(rd.bands) === bandsBefore + 1 && /已重做/.test(rd.status), `${un.bands} → ${rd.bands} · ${rd.status}`);
    await ev(() => document.getElementById('btn-undo').click());
    await sleep(200);
    await ev(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true })));
    await sleep(250);
    const kbInfo = await ev(() => JSON.stringify({
      bands: document.querySelectorAll('#ruler .band').length,
      status: document.getElementById('status').textContent,
    }));
    const kb = JSON.parse(kbInfo);
    check('Ctrl+Shift+Z 键盘重做', Number(kb.bands) === bandsBefore + 1 && /已重做/.test(kb.status), `${rd.bands} → ${kb.bands} · ${kb.status}`);

    // 编辑链路收尾：回到打开时的原始段表，后面「段落条 2 块」等计数断言才有基准。
    await ev(() => document.getElementById('btn-undo').click());
    await sleep(200);

    // 段条 / 胶片条
    check('段落条 2 块', await ev(() => document.querySelectorAll('#ruler .band').length) === 2);
    // R16-W：播放修复后 n 已推进到片尾——buildStrip 以当前帧为中心的窗口自适应
    // （≤13 张、步长 stride、边界截断）。旧断言写死在冻结时代（n 恒 0 时才恒 13 张）。
    check('胶片条窗口自适应（1–13 张 · stride 步进 · 含当前帧）', await ev(() => {
      const frames = Number(document.getElementById('total').textContent);
      const stride = Number(document.getElementById('stride').textContent) || 1;
      const thumbs = [...document.querySelectorAll('#strip .thumb')];
      if (!thumbs.length || thumbs.length > 13 || thumbs.length > frames) return false;
      const ns = thumbs.map((t) => Number(t.dataset.n));
      const okSeq = ns.every((n, i) => Number.isInteger(n) && n >= 0 && n < frames &&
        (i === 0 || n - ns[i - 1] === stride));
      const cur = Number(String(document.getElementById('hudFrame').textContent).split(' ')[0].replace('#', ''));
      return okSeq && thumbs.some((t) => t.classList.contains('active') && Number(t.dataset.n) === cur);
    }));
  } finally {
    if (browser) await browser.close().catch(() => {});
    await new Promise((r) => server.close(r));
  }
}

// ── main ───────────────────────────────────────────────────────────────────

(async () => {
  console.log('frames preview acceptance — root: ' + ROOT);
  testMath();
  await testMediaApis();
  await testSpecAndUi();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
  // 浏览器/服务器关闭后 win32 上可能还有 keep-alive socket；显式退出。
  setTimeout(() => process.exit(failed ? 1 : 0), 200);
})().catch((e) => {
  console.error('\n[fatal] ' + (e && e.stack || e));
  process.exit(1);
});
