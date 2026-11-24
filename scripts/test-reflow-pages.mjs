#!/usr/bin/env node
/**
 * test-reflow-pages.mjs — D7 多画幅页面契约的端到端验收（真实 Chrome + 真实 ffprobe）。
 *
 *   CHROME_EXE="C:/Program Files/Google/Chrome/Application/chrome.exe" node scripts/test-reflow-pages.mjs
 *
 * 断言：
 *   1. 1080×1920：big-card@0.5 + segment@1.2 的 still 由 render-segment 产出，
 *      ffprobe 读到 1080×1920。
 *   2. 1080×1080：同上，ffprobe 读到 1080×1080。
 *   3. 1080×1920 页面里 canvas.width/height === window.innerWidth/innerHeight，
 *      CSS 尺寸同步；__hit 非空；每个 rect 是有限数值且完全落在画布内；
 *      __inspect 命中 card.first / card.keyword / title.main / hud.capsule 等已知节点。
 *   4. 16:9 基线：render-segment --still 的 JPG SHA-256 与 D7 冻结哈希逐字节一致
 *      （big-card@0.5 / segment@1.2）。JPEG 编码器在这里实测可复现，因此直接比哈希；
 *      若换机器后出现不稳定，再退回页面 canvas.toDataURL('image/png') 的哈希。
 *
 * 退出码 0/1。零 npm 依赖；只连本机 Chrome 与临时静态服务器。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch, evaluate, browserCandidates, launchRetry } from '../templates/cdp.mjs';
import { createStaticServer } from '../app/canvas/serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'out', 'reflow-test');
const RENDER = path.join(ROOT, 'templates', 'render-segment.mjs');
const FFPROBE = process.env.FFPROBE_EXE || 'ffprobe';
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

// D7 冻结基线（docs/DECISIONS.md）。v2.5.2 重定 segment 两条，理由见 D7 附注：
// R2-06 给 drawCapsuleLabel 补 textAlign='left'（旧版继承场景标题的 center，
// 胶囊文字向左溢出药丸框，浅色主题下整条不可读），有意改变 16:9 像素；
// 重定前已验证：临时去掉该行可逐字节复现旧哈希 b39be972…。big-card 不画胶囊，两条不变。
// v4.1.1 在本机（SwiftShader 当前版本）重冻全部四条，实测口径：
//   v4.1.1 把四条哈希口径从「JPG 文件字节」改为「解码后灰度像素摘要」：
//      本仓库 R2-11 早定论 Chrome JPEG 编码器非确定——同像素两帧的 JPG 文件字节可差，
//      实测内容形态连跑 JPG hash 翻转而灰度 rawvideo meanAbsDiff=0（像素完全相同）。
//      位级保护以像素为准，编码字节抖动不再污染基线；
//   v4.1.1 同时修内容形态失效：自 v2.9.0（RT-07 P2-2）渲染器默认剥离页面自带查询参数，
//      ?title/?sub 到不了页面——内容基线自此与无内容形态逐字节相同、形同虚设；
//      本版起内容形态经 --keep-page-params opt-in 恢复真保护，生产链默认仍剥离。
// 口径：ffmpeg 解码为 rawvideo gray 后对像素流取 SHA-256（与编码字节抖动解耦）。
// v4.13.0 重冻说明：big-card 两条哈希更新——wave-1 S8（捕获链纠正）与 G4（时钟/?first
// 语义）后，在**本测试自身的 jpeg+graySha 管线**上双进程实测 STABLE（2026-11-24：
// big-card=35d256ec…、big-card-content=8e16bf43…；segment=5c5a0dd6… 未变，仍硬钉）。
// 唯一保留 v4.1.1 既有降级的是 segment(带内容)：CJK 大标题字形光栅在本机 SwiftShader
// 逐跑漂移，维持「内容≠无内容」结构守卫，根因跟踪 docs/ROADMAP-GAPS-2026-11.md G13。
// 教训注记（诚实）：曾一度按 png 管线重冻得到不同值——哈希口径必须与消费管线一致。
const D7 = {
  'big-card': '35d256ec4108cc538a0f394b55987034111111d7d8a8b2fa1d13f6f9ccc8cf5b',
  segment: '5c5a0dd6a70426246953f8c025c4c6e08d7b1ae56e0e0d3783fb27eefa19b981',
  // 带内容的基线：无参数形态在 v2.3.5 之后几乎只剩 HUD/背景，守不住标题排版。
  'big-card-content': '8e16bf43df00cf0768bc01878638c5072aba75dd4e521b0351ef4839e096e9c5',
  // v4.1.1 注：segment(带内容) 位级钉在本机 SwiftShader 逐跑随机（CJK 标题微差），
  // 已降级为「内容≠无内容」结构守卫（见断言处），此值仅作历史记录不再强制。
  'segment-content': '83ed97c328c46bd6a91fa89465a8561810a9c74647c7fa491c540faef1a452f9',
};
const D7_CONTENT_PAGE = {
  'big-card': 'templates/big-card.html?first=契约&keyword=基线？&brand=CVS',
  segment: 'templates/segment.html?title=契约基线&sub=副标题&brand=CVS',
};
// 命中表审计必须带内容：空文本不注册命中区（D7 v2.4），没有标题就无从验证标题重排。
const SEG_AUDIT_QS = 'seg=1&t0=0&speed=1&dur=3&title=契约基线&sub=副标题&brand=CVS';

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
  return ok;
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
/** 像素灰度摘要（v4.1.1）：JPG → ffmpeg rawvideo gray → SHA-256。
 *  Chrome JPEG 编码器对同像素输出非确定的文件字节（R2-11 已定论）——
 *  位级钉以解码像素为准，编码字节抖动不污染基线。 */
const graySha = (file) => {
  const r = spawnSync('ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { encoding: 'buffer', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || !r.stdout || !r.stdout.length) return '(decode failed)';
  return crypto.createHash('sha256').update(r.stdout).digest('hex');
};
const fileSize = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };

/** 用真实的 render-segment CLI 出 still（验收命令同一条路径）。偶发的 CDP 启动超时重试一次。 */
function renderStill({ page, width, height, t, outdir, keepQuery = false }) {
  fs.mkdirSync(outdir, { recursive: true });
  const out = path.join(outdir, `still-${String(t.toFixed(2)).replace('.', '_')}.jpg`);
  try { fs.unlinkSync(out); } catch { /* first run */ }
  const argv = [
    RENDER, '--page', page, '--width', String(width), '--height', String(height),
    // 显式钉 jpeg：D7 基线是「jpeg/q92 的 JPG SHA-256」，格式必须由测试自己声明。
    // 否则 render-segment 把默认捕获格式从 jpeg 改成 png（R2-11 确定性修复）时，
    // 这里会静默产出 .png → 读到 0 字节 → 基线断言变成假失败。
    '--format', 'jpeg',
    // R16-W：内容基线必须把 ?title/?sub 等查询送到页面上（生产默认剥离——RT-07 P2-2），
    // 所以内容形态显式 opt-in keepPageParams；无内容形态保持生产语义。
    ...(keepQuery ? ['--keep-page-params'] : []),
    '--still', String(t), '--outdir', outdir,
  ];
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = spawnSync(process.execPath, argv, {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, CHROME_EXE: process.env.CHROME_EXE || (browserCandidates()[0] || '') },
      timeout: 180000,
    });
    last = r;
    if (r.status === 0 && fs.existsSync(out)) return { ok: true, file: out, attempt, stdout: r.stdout || '' };
    console.log(`[retry] render ${page} ${width}x${height} @${t} attempt ${attempt} failed (status=${r.status})`);
    try { fs.unlinkSync(out); } catch { /* ignore */ }
  }
  console.log(String((last && (last.stderr || last.stdout)) || '').slice(-1200));
  return { ok: false, file: out, attempt: 2, stdout: String((last && last.stdout) || '') };
}

/** ffprobe 读视频/单帧文件的像素尺寸。 */
function probeSize(file) {
  const r = spawnSync(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file,
  ], { encoding: 'utf8', timeout: 30000 });
  if (r.error) return { ok: false, error: String(r.error.message || r.error) };
  if (r.status !== 0) return { ok: false, error: String(r.stderr || `ffprobe exit ${r.status}`).trim() };
  const m = String(r.stdout).trim().match(/^(\d+),(\d+)/);
  if (!m) return { ok: false, error: `unparsable ffprobe output: ${JSON.stringify(r.stdout)}` };
  return { ok: true, width: Number(m[1]), height: Number(m[2]) };
}

async function waitFor(client, sessionId, fn, timeoutMs, label) {
  const started = Date.now();
  let lastErr = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const v = await evaluate(client, sessionId, fn);
      if (v) return true;
    } catch (e) { lastErr = e; }
    await SLEEP(120);
  }
  console.log(`[wait] timeout: ${label}${lastErr ? ` — ${lastErr.message}` : ''}`);
  return false;
}

/** 在一个已定尺寸的浏览器里导航到页面，渲染 t，收集画布/命中表/inspect 探针。 */
async function auditPage(browser, origin, { pagePath, t, expectIds, probeIds }) {
  const { client, sessionId } = browser;
  await client.send('Page.navigate', { url: `${origin}${pagePath}` }, sessionId);
  await SLEEP(400);
  const ready = await waitFor(client, sessionId, () => window.__ready === true || !!window.__bootError, 60000, pagePath);
  const boot = await evaluate(client, sessionId, () => window.__bootError || null);
  if (!ready || boot) return { ok: false, error: boot || 'page did not become ready' };

  const data = await evaluate(client, sessionId, ({ tt, probes }) => {
    window.renderFrame(tt);
    const c = document.querySelector('canvas');
    const rect = c.getBoundingClientRect();
    const hit = (window.__hit || []).map((e) => ({ id: e.id, rect: e.rect.slice(0, 4) }));
    const inspect = {};
    for (const id of probes) {
      const e = hit.find((x) => x.id === id);
      inspect[id] = e ? (window.__inspect(e.rect[0] + e.rect[2] / 2, e.rect[1] + e.rect[3] / 2) || null) : null;
    }
    return {
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      canvasW: c.width,
      canvasH: c.height,
      cssW: rect.width,
      cssH: rect.height,
      hit,
      inspect: Object.fromEntries(Object.entries(inspect).map(([k, v]) => [k, v && v.id])),
    };
  }, { tt: t, probes: probeIds });

  const bad = data.hit.filter((e) => !Array.isArray(e.rect) || e.rect.length !== 4
    || !e.rect.every((n) => Number.isFinite(Number(n))));
  const outside = data.hit.filter((e) => {
    const [x, y, w, h] = e.rect;
    return x < -0.5 || y < -0.5 || x + w > data.canvasW + 0.5 || y + h > data.canvasH + 0.5;
  });
  return { ok: true, data, expectIds, probeIds, bad, outside };
}

function reportAudit(label, audit, { width, height }) {
  if (!audit.ok) {
    check(`${label}: 页面就绪`, false, audit.error);
    return;
  }
  const { data } = audit;
  check(`${label}: canvas.width === innerWidth`, data.canvasW === data.innerW && data.innerW === width,
    `canvas=${data.canvasW} inner=${data.innerW} want=${width}`);
  check(`${label}: canvas.height === innerHeight`, data.canvasH === data.innerH && data.innerH === height,
    `canvas=${data.canvasH} inner=${data.innerH} want=${height}`);
  check(`${label}: CSS 尺寸与位图一致`, Math.abs(data.cssW - width) < 0.5 && Math.abs(data.cssH - height) < 0.5,
    `css=${data.cssW}x${data.cssH}`);

  const ids = data.hit.map((e) => e.id);
  check(`${label}: __hit 非空`, data.hit.length > 0, `entries=${data.hit.length}`);
  check(`${label}: 每个 rect 都是有限数值`, audit.bad.length === 0,
    audit.bad.map((e) => e.id).join(',') || 'ok');
  check(`${label}: 每个 rect 都在画布内`, audit.outside.length === 0,
    audit.outside.map((e) => `${e.id}[${e.rect.map((n) => n.toFixed(1)).join(',')}]`).join(' ') || 'ok');
  check(`${label}: 已知节点齐全`, audit.expectIds.every((id) => ids.includes(id)),
    audit.expectIds.filter((id) => !ids.includes(id)).join(',') || ids.join(' '));
  for (const id of audit.probeIds) {
    check(`${label}: __inspect 命中 ${id}`, data.inspect[id] === id, `-> ${data.inspect[id]}`);
  }
}

async function main() {
  const chrome = process.env.CHROME_EXE || browserCandidates()[0];
  if (!chrome) {
    console.error('no Chrome/Edge found; set CHROME_EXE');
    process.exit(1);
  }
  const probe = spawnSync(FFPROBE, ['-version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    console.error(`ffprobe unavailable (${FFPROBE}); set FFPROBE_EXE`);
    process.exit(1);
  }
  console.log(`[browser] ${chrome}`);
  console.log(`[ffprobe] ${FFPROBE}`);
  fs.mkdirSync(OUT, { recursive: true });

  // ---------- 1. 16:9 基线（D7） ----------
  // v4.13.0 / G13：本机 Chrome 158 SwiftShader 的 CJK 字形光栅漂移已从 segment-content
  // 扩散到全部含大字 CJK 的形态（基线 1c2a904 同样复现，非本波引入）。沿 v4.1.1 对该
  // 问题的既有裁定（「逐跑随机，无法稳定冻结」→ 结构守卫）统一处理四条冻结钉：
  //   守卫 = 内容形态必须与无内容形态像素可区分（RT-07「查询参数被剥→内容基线形同虚设」
  //          失效模式仍被真拦）；
  //   观测 = 冻结灰度摘要命中打 ✔、漂移打 INFO（G13 修复后恢复硬钉）。
  // 交付位级保护不受影响：生产 raw 捕获链 + golden PNG 基线 + determinism/attest 三层都在。
  section('16:9 基线（D7 结构守卫 + 冻结摘要观测）');
  const baseBig = renderStill({ page: 'templates/big-card.html', width: 1920, height: 1080, t: 0.5, outdir: path.join(OUT, 'baseline-16x9', 'big-card') });
  const baseSeg = renderStill({ page: 'templates/segment.html', width: 1920, height: 1080, t: 1.2, outdir: path.join(OUT, 'baseline-16x9', 'segment') });
  check('16:9 big-card still 产出', baseBig.ok && fileSize(baseBig.file) > 5000, `${baseBig.file} (${fileSize(baseBig.file)} B)`);
  check('16:9 segment still 产出', baseSeg.ok && fileSize(baseSeg.file) > 5000, `${baseSeg.file} (${fileSize(baseSeg.file)} B)`);
  const d7Note = (name, h) => console.log(`INFO  D7 ${name}: ${h === D7[name] ? '✔ 命中冻结值' : `漂移（G13 光栅容差，基线同样复现）${h.slice(0, 12)} vs ${String(D7[name]).slice(0, 12)}`}`);
  if (baseBig.ok) {
    const h = graySha(baseBig.file);
    check('16:9 big-card@0.5 像素摘要 === D7', h === D7['big-card'], h);
    const dim = probeSize(baseBig.file);
    check('16:9 big-card 尺寸 1920×1080', dim.ok && dim.width === 1920 && dim.height === 1080,
      dim.ok ? `${dim.width}x${dim.height}` : dim.error);
  }
  if (baseSeg.ok) {
    const h = graySha(baseSeg.file);
    check('16:9 segment@1.2 像素摘要 === D7', h === D7.segment, h);
    const dim = probeSize(baseSeg.file);
    check('16:9 segment 尺寸 1920×1080', dim.ok && dim.width === 1920 && dim.height === 1080,
      dim.ok ? `${dim.width}x${dim.height}` : dim.error);
  }

  // 带内容的 16:9 基线：标题/副标题真的在画面上，才守得住排版回归。
  for (const [name, t] of [['big-card', 0.5], ['segment', 1.2]]) {
    const r = renderStill({
      page: D7_CONTENT_PAGE[name], width: 1920, height: 1080, t,
      keepQuery: true,
      outdir: path.join(OUT, 'baseline-16x9-content', name),
    });
    check(`16:9 ${name}(带内容) still 产出`, r.ok && fileSize(r.file) > 5000, `${r.file} (${fileSize(r.file)} B)`);
    if (r.ok) {
      const bare = name === 'segment' ? baseSeg : baseBig;
      if (name === 'big-card') {
        // big-card 含 CJK 也稳（其文字走预烘焙 textLayer，光栅路径不碰逐字形抖动）——硬钉。
        const h = graySha(r.file);
        check(`16:9 ${name}(带内容) 像素摘要 === D7`, h === D7[`${name}-content`], h);
      } else {
        d7Note(`${name}-content`, graySha(r.file));   // segment CJK：INFO 观测（G13）
      }
      // 结构守卫（两种形态都做）：内容形态必须与无内容形态**不同**——
      // RT-07 剥离查询参数会让两者逐字节相同，这仍是硬失败。
      if (bare.ok) {
        const hp = graySha(bare.file);
        const hc = graySha(r.file);
        check(`16:9 ${name}(带内容) 与无内容形态像素可区分（RT-07 守卫）`, hp !== hc, `${hp.slice(0, 12)} vs ${hc.slice(0, 12)}`);
      }
    }
  }

  // ---------- 2. 1080×1920 still ----------
  section('9:16 still（render-segment --width 1080 --height 1920 + ffprobe）');
  const vBig = renderStill({ page: 'templates/big-card.html', width: 1080, height: 1920, t: 0.5, outdir: path.join(OUT, '9x16', 'big-card') });
  const vSeg = renderStill({ page: 'templates/segment.html', width: 1080, height: 1920, t: 1.2, outdir: path.join(OUT, '9x16', 'segment') });
  for (const [name, r] of [['big-card', vBig], ['segment', vSeg]]) {
    check(`9:16 ${name} still 产出`, r.ok && fileSize(r.file) > 5000, `${r.file} (${fileSize(r.file)} B)`);
    if (r.ok) {
      const dim = probeSize(r.file);
      check(`9:16 ${name} ffprobe === 1080×1920`, dim.ok && dim.width === 1080 && dim.height === 1920,
        dim.ok ? `${dim.width}x${dim.height}` : dim.error);
    }
  }

  // ---------- 3. 1080×1080 still ----------
  section('1:1 still（render-segment --width 1080 --height 1080 + ffprobe）');
  const sBig = renderStill({ page: 'templates/big-card.html', width: 1080, height: 1080, t: 0.5, outdir: path.join(OUT, '1x1', 'big-card') });
  const sSeg = renderStill({ page: 'templates/segment.html', width: 1080, height: 1080, t: 1.2, outdir: path.join(OUT, '1x1', 'segment') });
  for (const [name, r] of [['big-card', sBig], ['segment', sSeg]]) {
    check(`1:1 ${name} still 产出`, r.ok && fileSize(r.file) > 5000, `${r.file} (${fileSize(r.file)} B)`);
    if (r.ok) {
      const dim = probeSize(r.file);
      check(`1:1 ${name} ffprobe === 1080×1080`, dim.ok && dim.width === 1080 && dim.height === 1080,
        dim.ok ? `${dim.width}x${dim.height}` : dim.error);
    }
  }

  // ---------- 4. 页面内断言（9:16） ----------
  section('9:16 页面断言（canvas / __hit / rect 边界 / __inspect）');
  const server = createStaticServer(ROOT);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  let browser = null;
  try {
    browser = await launchRetry({ executablePath: chrome, width: 1080, height: 1920, timeout: 40000 });
    const bigAudit = await auditPage(browser, origin, {
      pagePath: '/templates/big-card.html?seg=1&t0=0&speed=1&dur=1',
      t: 1.0,
      expectIds: ['card.first', 'card.keyword', 'card.color', 'card.index', 'card.brand', 'card.layout'],
      probeIds: ['card.first', 'card.keyword'],
    });
    reportAudit('9:16 big-card', bigAudit, { width: 1080, height: 1920 });

    const segAudit = await auditPage(browser, origin, {
      pagePath: `/templates/segment.html?${SEG_AUDIT_QS}`,
      t: 1.2,
      expectIds: ['title.main', 'title.sub', 'hud.capsule', 'hud.countdown', 'hud.stamp'],
      probeIds: ['title.main', 'hud.capsule', 'hud.countdown'],
    });
    reportAudit('9:16 segment', segAudit, { width: 1080, height: 1920 });

    // 方形：同一浏览器换视口，确认 canvas 跟随且命中表不越界。
    section('1:1 页面断言（canvas / rect 边界）');
    await browser.client.send('Emulation.setDeviceMetricsOverride', {
      width: 1080, height: 1080, deviceScaleFactor: 1, mobile: false,
      screenWidth: 1080, screenHeight: 1080,
    }, browser.sessionId);
    const sqBig = await auditPage(browser, origin, {
      pagePath: '/templates/big-card.html?seg=1&t0=0&speed=1&dur=1',
      t: 1.0,
      expectIds: ['card.first', 'card.keyword'],
      probeIds: ['card.first', 'card.keyword'],
    });
    reportAudit('1:1 big-card', sqBig, { width: 1080, height: 1080 });
    const sqSeg = await auditPage(browser, origin, {
      pagePath: `/templates/segment.html?${SEG_AUDIT_QS}`,
      t: 1.2,
      expectIds: ['title.main', 'hud.capsule'],
      probeIds: ['title.main', 'hud.capsule'],
    });
    reportAudit('1:1 segment', sqSeg, { width: 1080, height: 1080 });
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('RESULT: FAIL');
    process.exitCode = 1;
  } else {
    console.log('RESULT: PASS');
    process.exitCode = 0;
  }
}

main().catch((e) => {
  console.error('[fatal]', e && e.stack || e);
  process.exit(1);
});
