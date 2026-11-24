#!/usr/bin/env node
/**
 * test-readability.mjs — S1-3 页面契约 + S1-4 可读性闸 + 余项③ QA 像素文本 的回归测试（G7）。
 *
 * 两个层次：
 *   A) 纯逻辑（无浏览器，永远真跑）：qa-text.mjs 的判决函数（聚合/停留/重叠/字幕带/
 *      占位词/期望文案收集）+ tokens.safe() 字幕带 + common.js 记录器的行合成。
 *   B) 真 Chrome（fixtures/readability-cases/ 假页三对正反例 + 真实 golden/mini 页零假阳）：
 *      无浏览器时逐条打 SKIP 行，绝不假绿（仓内 test-render-perf/test-attest 先例）。
 *
 * 验收对位（ROADMAP-GAPS G7）：
 *   ①「页不吃 ?title 但内建文案上屏」注入样例 → QA 必红（v2.9.0/v4.10.1 病根的像素级抗体）。
 *   ②两条正文文本硬重叠 → 必红。
 *   ③长文案 0.4s 短停 → 必红（--strict 拦；非 strict 记 WARN 入报告）。
 *   ④三对应绿例全绿；真实页（golden-card / mini-41s 全 19 段）零 FAIL（防闸误伤存量设计）。
 *
 *   node scripts/test-readability.mjs
 * 退出码 0/1。零 npm 依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { browserCandidates } from '../templates/cdp.mjs';
import { safe as safeArea } from '../templates/tokens.mjs';
import { buildPlanFromSpec } from '../templates/plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const QA_TEXT = path.join(HERE, 'qa-text.mjs');
const OUT = path.join(ROOT, 'out', 'readability-cases');

let passed = 0, failed = 0, skipped = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { failed++; console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { failed++; console.error(`✗ ${name}\n  ${e && e.message || e}`); process.exitCode = 1; }
}
function skip(name, why) { skipped++; console.log(`SKIP ${name}  (${why})`); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const enc = encodeURIComponent;
const CASES = 'fixtures/readability-cases';
const PAGE = {
  ignores: `${CASES}/ignores-title.html`,
  honors: `${CASES}/honors-title.html`,
  overlap: `${CASES}/overlap.html`,
  spaced: `${CASES}/spaced.html`,
  shortDwell: `${CASES}/short-dwell.html`,
  fullDwell: `${CASES}/full-dwell.html`,
  naked: `${CASES}/naked-no-contract.html`,
};

function segOf(id, kind, page, duration, start = 0) {
  return { id, kind, page, duration, start, end: start + duration, t0: 0, speed: 1 };
}
function fakePlan(segments, copy) {
  return {
    version: 1,
    meta: { root: ROOT, width: 1920, height: 1080, fps: 30 },
    spec: { copy: copy || {} },
    stats: { duration: segments.reduce((s, x) => Math.max(s, x.end), 0), frames: 0 },
    segments,
  };
}
fs.mkdirSync(OUT, { recursive: true });
function writePlan(name, plan) {
  const p = path.join(OUT, `plan-${name}.json`);
  fs.writeFileSync(p, JSON.stringify(plan, null, 2));
  return p;
}

// ── qa-text.mjs 的接口（CLI 形态；测试用子进程跑真闸，不依赖内部导出）────────
function runQaText(planPath, extra = []) {
  const outJson = planPath.replace(/\.json$/, '.qa.json');
  const r = spawnSync(process.execPath,
    [QA_TEXT, '--plan', planPath, '--json', outJson, '--quiet', ...extra],
    { cwd: ROOT, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  let report = null;
  try { report = JSON.parse(fs.readFileSync(outJson, 'utf8')); } catch { /* 下面按 null 判 */ }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', report };
}
const checkOf = (report, name) => (report.checks || []).find((c) => c.name === name) || null;

const HAS_BROWSER = !!(process.env.CHROME_EXE || browserCandidates()[0]);

// ── 内部模块（纯判决函数供 A 组直接用）────────────────────────────────────────
const qa = await import('./qa-text.mjs');
const {
  normText, estSpeechSeconds, aggregateSpans, intersectArea,
  collectExpectedFromPlan, PLACEHOLDER_WORDS, analyzeFrames, runTextQa,
} = qa;

// ═══ A) 纯逻辑 ═══════════════════════════════════════════════════════════════

test('A1 estSpeechSeconds：码点越多念得越久，CJK > ASCII 同字符数', () => {
  assert(estSpeechSeconds('') < estSpeechSeconds('短'), '单调性失败');
  assert(estSpeechSeconds('这是一条比较长的中文文案用来测试语速估计') > estSpeechSeconds('短'), '长文案应更久');
  assert(estSpeechSeconds('中文中文中文') > estSpeechSeconds('abcdef'), 'CJK 每字念得比一个 ASCII 字母久');
});

test('A2 aggregateSpans：相邻帧聚合成区间，缺口/跨段断开', () => {
  const step = 0.25;
  const samples = [
    { t: 0.125, id: 'x', segId: 'a' }, { t: 0.375, id: 'x', segId: 'a' }, { t: 0.625, id: 'x', segId: 'a' },
    { t: 1.625, id: 'x', segId: 'a' },               // 中间空了 0.75s（>1.5×step）→ 必须断开
    { t: 0.125, id: 'x', segId: 'b' },               // 跨段不相连（另一段同 id 另算）
  ];
  const spans = aggregateSpans(samples, { step });
  assert(spans.length === 3, `期望 3 个区间，实际 ${spans.length}: ${JSON.stringify(spans)}`);
  const a0 = spans.find((s) => s.segId === 'a' && s.start < 1);
  assert(a0 && Math.abs(a0.dwell - 0.75) < 1e-6, `首区间停留应 0.75s：${JSON.stringify(a0)}`);
});

test('A3 intersectArea：交并面积数学', () => {
  const a = { x0: 0, y0: 0, x1: 100, y1: 100 };
  assert(intersectArea(a, { x0: 200, y0: 0, x1: 300, y1: 100 }) === 0, '不相交应为 0');
  assert(intersectArea(a, { x0: 50, y0: 50, x1: 150, y1: 150 }) === 2500, '四分之一重叠应为 2500');
});

test('A4 tokens.safe()：字幕带存在、左右对称、带在画布底部', () => {
  const s = safeArea(1920, 1080);
  assert(s.left === s.right, `左右必须相等：${s.left}/${s.right}`);
  assert(s.subtitle && Number.isFinite(s.subtitle.y0), 'safe() 缺 subtitle 带');
  assert(s.subtitle.y0 >= s.top && s.subtitle.y1 <= 1081, '字幕带必须落在纵向安全范围内侧到底部');
  assert(s.subtitle.y0 > 1080 - 1080 * 0.5, '字幕带应在下半屏');
  const v = safeArea(1080, 1920);
  assert(v.subtitle.x0 === v.left && v.subtitle.x1 === 1080 - v.right, '竖屏字幕带左右应贴安全边');
});

test('A5 collectExpectedFromPlan：spec.copy + 段 URL 文案参数全收，保留参数不进', () => {
  const plan = fakePlan(
    [segOf('a', 'style', `${PAGE.honors}?title=${enc('标题甲')}&sub=${enc('副题乙')}&seg=1&t0=0&dur=3&theme=coral-noir`, 3),
     segOf('b', 'card', `${PAGE.honors}?first=${enc('开场词')}&keyword=${enc('问句？')}`, 1, 3)],
    { title: '片名', sub: null, cta: '去试试' });
  const exp = collectExpectedFromPlan(plan);
  const vals = exp.map((e) => e.value);
  for (const w of ['片名', '去试试', '标题甲', '副题乙', '开场词', '问句？']) {
    assert(vals.includes(w), `期望文案缺 ${w}：${JSON.stringify(vals)}`);
  }
  assert(!vals.includes('coral-noir') && !vals.includes('1'), 'theme/seg 保留参数不得进期望集');
});

test('A6 占位词表覆盖页面兜底常量', () => {
  const words = PLACEHOLDER_WORDS.map((w) => w.word);
  for (const w of ['想做', '结构图示', '播放量竞速', '科普视频？']) {
    assert(words.includes(w), `占位词表缺 ${w}`);
  }
});

test('A7 analyzeFrames：动能逐字 fillText 合成行文案（per-grapheme 不误报）', () => {
  // 模拟 drawKineticText：一行文案逐字 fillText，同 userY、水平递增。
  const texts = '可读文案'.split('').map((c, i) => ({
    id: `g${i}@r5`, text: c, kind: 'fill',
    x0: 200 + i * 60, y0: 500, x1: 260 + i * 60, y1: 570, size: 64, userY: 535,
  }));
  const plan = fakePlan([segOf('a', 'style', 'x.html?title=可读文案', 3)], { title: '可读文案' });
  const res = analyzeFrames({ plan, frames: [{ segId: 'a', kind: 'style', t: 0.5, texts }] });
  const cov = res.find((c) => c.name === 'pixel text coverage');
  assert(cov && cov.status === 'PASS', `合成行应让逐字文案判 PASS：${JSON.stringify(cov)}`);
});

test('A8 analyzeFrames：dwell 红例（长文案 0.5s）+ flash 豁免 + 短词豁免', () => {
  const LONG = '这是一条超过八个码点的可读性回归文案';
  const mk = (kind, u0, u1) => {
    const frames = [];
    for (let t = 0.125; t < 3; t += 0.25) {
      if (t < u1 && t > u0) {
        frames.push({ segId: 'a', kind, t, texts: [{ id: 'L@r5', text: LONG, kind: 'fill', x0: 200, y0: 500, x1: 1700, y1: 570, size: 56, userY: 535 }] });
      }
    }
    return frames;
  };
  const plan = fakePlan([segOf('a', 'style', `x.html?title=${enc(LONG)}`, 3)]);
  const red = analyzeFrames({ plan, frames: mk('style', 0, 0.5) }).find((c) => c.name === 'text dwell');
  assert(red && red.status !== 'PASS', `0.5s 长文案必须红：${JSON.stringify(red)}`);
  const flashPlan = fakePlan([segOf('a', 'flash', `x.html?title=${enc(LONG)}`, 3)]);
  const flashOk = analyzeFrames({ plan: flashPlan, frames: mk('flash', 0, 0.5) }).find((c) => c.name === 'text dwell');
  assert(flashOk && flashOk.status === 'PASS', `flash 段应豁免停留：${JSON.stringify(flashOk)}`);
  // 短词（≤8 码点）即使一闪而过也不拦——S9 冲击卡词是设计行为（G4-1 ≤8 码点口径）。
  const shortPlan = fakePlan([segOf('a', 'style', 'x.html?title=' + enc('短词'), 3)]);
  const shortFrames = mk('style', 0, 0.5).map((f) => ({ ...f, texts: [{ ...f.texts[0], id: 'S@r5', text: '短词', x1: 400 }] }));
  const shortOk = analyzeFrames({ plan: shortPlan, frames: shortFrames }).find((c) => c.name === 'text dwell');
  assert(shortOk && shortOk.status === 'PASS', `≤8 码点短词应豁免停留：${JSON.stringify(shortOk)}`);
});

test('A9 analyzeFrames：overlap 红例 / 同 id（描边+填充）豁免 / caption 级不参与', () => {
  const box = (id, text, x0, y0, x1, y1, size) => ({ id, text, kind: 'fill', x0, y0, x1, y1, size, userY: y0 + size / 2 });
  const frames = [{ segId: 'a', kind: 'style', t: 0.5, texts: [
    box('r1', '正文甲', 200, 400, 700, 480, 64),
    box('r2', '正文乙被压在上面所以文本更长一些超过八个码点', 250, 410, 900, 490, 64),
  ] }];
  const plan = fakePlan([segOf('a', 'style', 'x.html?title=正文甲&sub=正文乙被压在上面所以文本更长一些超过八个码点', 3)]);
  const res = analyzeFrames({ plan, frames });
  const ov = res.find((c) => c.name === 'text overlap');
  assert(ov && ov.status !== 'PASS', `硬重叠必须红：${JSON.stringify(ov)}`);
  // 同 id 的描边+填充对不算重叠
  const sameId = [{ segId: 'a', kind: 'style', t: 0.5, texts: [
    box('r1', '正文甲', 200, 400, 700, 480, 64), box('r1', '正文甲', 200, 400, 700, 480, 64) ] }];
  const res2 = analyzeFrames({ plan, frames: sameId });
  assert(res2.find((c) => c.name === 'text overlap').status === 'PASS', '同 id 描边/填充不得判重叠');
  // caption 级小字不参与重叠（HUD 角标同排是合法设计）
  const hud = [{ segId: 'a', kind: 'style', t: 0.5, texts: [
    box('h1', '00:03', 1500, 990, 1620, 1024, 22), box('h2', 'ACME', 1520, 995, 1600, 1020, 20) ] }];
  const res3 = analyzeFrames({ plan, frames: hud });
  assert(res3.find((c) => c.name === 'text overlap').status === 'PASS', 'caption 级不得进重叠口径');
});

test('A10 analyzeFrames：越字幕带红，flash 不豁免越带', () => {
  const texts = [{ id: 'B@r9', text: '压进字幕带的正文文案', kind: 'fill', x0: 300, y0: 1000, x1: 900, y1: 1060, size: 56, userY: 1030 }];
  const plan = fakePlan([segOf('a', 'style', 'x.html?title=' + enc('压进字幕带的正文文案'), 3)]);
  for (const kind of ['style', 'flash']) {
    const res = analyzeFrames({ plan, frames: [{ segId: 'a', kind, t: 0.5, texts }] });
    const band = res.find((c) => c.name === 'subtitle band');
    assert(band && band.status !== 'PASS', `${kind} 段压带都必须红：${JSON.stringify(band)}`);
  }
});

test('A11 analyzeFrames：占位词仅在未被期望文案覆盖时红', () => {
  const texts = [{ id: 'P@r5', text: '想做', kind: 'fill', x0: 200, y0: 500, x1: 330, y1: 564, size: 64, userY: 532 }];
  const uncovered = fakePlan([segOf('a', 'card', 'x.html?first=' + enc('真问句'), 1)]);
  const r1 = analyzeFrames({ plan: uncovered, frames: [{ segId: 'a', kind: 'card', t: 0.5, texts }] });
  assert(r1.find((c) => c.name === 'placeholder text').status === 'FAIL', '未被覆盖的内建兜底必须 FAIL');
  const covered = fakePlan([segOf('a', 'card', 'x.html?first=' + enc('想做') + '&keyword=' + enc('黄金基线？'), 1)]);
  const r2 = analyzeFrames({ plan: covered, frames: [{ segId: 'a', kind: 'card', t: 0.5, texts }] });
  assert(r2.find((c) => c.name === 'placeholder text').status === 'PASS', 'spec 本来就写「想做」→ 不得误报（golden-card 实况）');
});

// ═══ B) 真 Chrome：契约 + 假页正反例 + 真实页零假阳 ═══════════════════════════

async function main() {
  // A12：环境降级路径必须真实可达且语义正确（exit=3 + 「未验证」字样），
  // 与 HAS_BROWSER 无关——这是 qa-video 把「无浏览器」映射成 WARN 的依据。
  await atest('A12 runTextQa 无浏览器降级：exit=3 且显式「未运行」（不许假绿）', async () => {
    const pp = writePlan('no-browser', fakePlan([segOf('x', 'style', `${PAGE.honors}?title=${enc('降级测试')}`, 1)], { title: '降级测试' }));
    const { exit, report } = await runTextQa(pp, { noBrowser: true });
    assert(exit === 3, `降级 exit 应为 3，实际 ${exit}`);
    const br = (report.checks || []).find((c) => c.name === 'browser');
    assert(br && br.status === 'ADVISORY' && /未运行/.test(br.detail), `browser 条目缺失/措辞不对：${JSON.stringify(br)}`);
  });

  if (!HAS_BROWSER) {
    const why = 'no Chrome/Edge found (set CHROME_EXE)';
    for (const n of ['契约 __textsAt/__ev 形状', '假页 R1 红（页不吃 ?title）', '假页 R1 绿（honors）',
      '假页 R2 红（硬重叠）', '假页 R2 绿（分行）', '假页 R3 红（0.4s 短停）', '假页 R3 绿（全段停留）',
      '假页 R0 无契约（全裸）→ text contract FAIL 非降级装绿',
      '真实页 golden-card 零 FAIL', '真实页 mini-41s 零 FAIL']) skip(n, why);
  } else {
    // 契约探针（直接开页问 __textsAt 的形状与纯度，走 qa-text 的采集器）
    const contractPlan = writePlan('contract', fakePlan(
      [segOf('c1', 'style', `${PAGE.honors}?title=${enc('契约形状')}&sub=${enc('副题')}`, 3)],
      { title: '契约形状' }));
    const { report } = runQaText(contractPlan);
    await atest('契约 __textsAt 形状：metrics 带 id/text/单调 bbox', async () => {
      assert(report, `qa-text 未产出报告：exit 状态异常`);
      assert(report.metrics && report.metrics.framesSampled > 0, '没有采到帧');
      const rows = (report.metrics.samples || []).filter((s) => s.ok);
      assert(rows.length > 0, '无采样成功帧');
      const t0 = rows[0].texts[0];
      assert(t0, '帧里没有文本记录');
      for (const k of ['id', 'text', 'x0', 'y0', 'x1', 'y1']) assert(k in t0, `记录缺字段 ${k}`);
      assert(t0.x0 <= t0.x1 && t0.y0 <= t0.y1, 'bbox 单调性失败');
      assert(typeof t0.id === 'string' && t0.id.length > 0, 'id 必须非空字符串');
    });
    await atest('契约 __textsAt 纯函数性 + 正常渲染后原型未污染', async () => {
      const { probeContract } = await import('./qa-text.mjs');
      const pr = await probeContract({ root: ROOT, width: 1920, height: 1080, page: `${PAGE.honors}?title=A&sub=B`, t: 1.0 });
      assert(pr.hasTextsAt === true, '__textsAt 未安装（common.js 契约缺位）');
      assert(Array.isArray(pr.first) && pr.first.length >= 2, '应记录到 ≥2 条文本');
      assert(JSON.stringify(pr.first) === JSON.stringify(pr.second), '__textsAt(同 t) 两次调用结果必须一致（f(t) 契约）');
      assert(pr.stableId === true, '同一静止文本跨帧 id 必须稳定');
      assert(pr.prototypeClean === true, '__textsAt 返回后 fillText/strokeText 原型必须已还原（零像素风险面）');
      assert(Array.isArray(pr.ev), '__ev 必须是数组');
      assert(pr.evFrame === true, '__evAt 应在带 createSegment 的页上产出事件数据（本刀只产数据不判决）');
    });

    const cases = [
      { n: '假页 R1 红（页不吃 ?title）', plan: () => fakePlan(
          [segOf('x', 'style', `${PAGE.ignores}?title=${enc('像素标题验证')}&sub=${enc('副题也要上屏')}`, 3)],
          { title: '像素标题验证', sub: '副题也要上屏' }),
        expect: [['pixel text coverage', 'FAIL'], ['placeholder text', 'FAIL']] },
      { n: '假页 R1 绿（honors）', plan: () => fakePlan(
          [segOf('x', 'style', `${PAGE.honors}?title=${enc('像素标题验证')}&sub=${enc('副题也要上屏')}`, 3)],
          { title: '像素标题验证', sub: '副题也要上屏' }),
        expect: [['pixel text coverage', 'PASS'], ['placeholder text', 'PASS'], ['text overlap', 'PASS'], ['subtitle band', 'PASS']] },
      { n: '假页 R2 红（硬重叠）', plan: () => fakePlan(
          [segOf('x', 'style', `${PAGE.overlap}?title=${enc('甲文案行一')}`, 3)], { title: '甲文案行一' }),
        expect: [['text overlap', 'NOT-PASS']] },
      { n: '假页 R2 绿（分行）', plan: () => fakePlan(
          [segOf('x', 'style', `${PAGE.spaced}?title=${enc('甲文案行一')}`, 3)], { title: '甲文案行一' }),
        expect: [['text overlap', 'PASS'], ['pixel text coverage', 'PASS']] },
      { n: '假页 R3 红（0.4s 短停长文案）', plan: () => fakePlan(
          [segOf('x', 'style', `${PAGE.shortDwell}?title=${enc('这是一条超过八个码点的可读性回归文案')}`, 3)],
          { title: '这是一条超过八个码点的可读性回归文案' }),
        expect: [['text dwell', 'NOT-PASS']] },
      { n: '假页 R3 绿（全段停留）', plan: () => fakePlan(
          [segOf('x', 'style', `${PAGE.fullDwell}?title=${enc('这是一条超过八个码点的可读性回归文案')}`, 5)],
          { title: '这是一条超过八个码点的可读性回归文案' }),
        expect: [['text dwell', 'PASS'], ['subtitle band', 'PASS']] },
      // R0 降级负例：页不 import common.js（无契约）。全裸 = text contract FAIL
      // （不是 ADVISORY 装绿），且 copy 无从出现 = coverage FAIL。G7-1「有 DOM 无文本」防线。
      { n: '假页 R0 无契约（全裸）→ text contract FAIL 非降级装绿', plan: () => fakePlan(
          [segOf('x', 'style', `${PAGE.naked}?title=${enc('无契约标题')}`, 3)],
          { title: '无契约标题' }),
        expect: [['text contract', 'FAIL'], ['pixel text coverage', 'FAIL']], red: true },
    ];
    for (const c of cases) {
      await atest(c.n, async () => {
        const pp = writePlan(c.n.replace(/\W+/g, '_'), c.plan());
        const { status, report: rep } = runQaText(pp, ['--strict']);
        assert(rep, `闸没写报告（exit=${status}）\n` );
        for (const [name, want] of c.expect) {
          const ch = (rep.checks || []).find((x) => x.name === name);
          assert(ch, `缺检查项 ${name}；有 ${JSON.stringify((rep.checks || []).map((x) => x.name))}`);
          if (want === 'NOT-PASS') {
            assert(ch.status !== 'PASS', `${name} 应非 PASS（红例），实际 ${ch.status}｜${ch.detail}`);
          } else {
            assert(ch.status === want, `${name} 期望 ${want} 实际 ${ch.status}｜${ch.detail}`);
          }
        }
        if (c.red || c.n.includes('红')) assert(status !== 0, `红例 --strict 必须非零退出，实际 ${status}`);
        else assert(status === 0, `绿例必须 exit 0，实际 ${status}\n${JSON.stringify(rep.checks, null, 1)}`);
      });
    }

    // 真实页对账（G7 验收的另一半：抗体不能对存量设计滥杀，也不能对已知病根装绿）：
    //   · golden-card 全链（segment.html + big-card.html）必须零 FAIL——闸与契约对
    //     「fillText 直绘 + __textInfo 缓存层」两条通路都无假阳。
    //   · mini-41s 含 7 个离屏文字缓存/未消费 ?sub 的 recipe 页——它们的缺失此刻是
    //     登记在册的 KNOWN_GAPS（正解=给页挂 __textInfo / 接通 ?sub 消费，禁碰文件域
    //     外故留主线程）。账本语义：**新缺失必红；账内条目销账只会打印提示。**
    {
      const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'golden/card', 'spec.json'), 'utf8'));
      const { plan } = buildPlanFromSpec(spec, { root: ROOT });
      const pp = writePlan('real-card', plan);
      await atest('真实页 golden-card：qa-text 零 FAIL（直绘+缓存层通路均无假阳）', async () => {
        const { report: rep } = runQaText(pp);
        assert(rep, '闸没写报告');
        const fails = (rep.checks || []).filter((c) => c.status === 'FAIL');
        assert(fails.length === 0, `card 出现 FAIL：${JSON.stringify(fails, null, 1).slice(0, 1000)}`);
        const cov = (rep.checks || []).find((c) => c.name === 'pixel text coverage');
        assert(cov && cov.status === 'PASS', `card 覆盖率应 PASS：${cov && cov.detail}`);
      });
    }
    {
      const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/mini-41s/spec.json'), 'utf8'));
      const { plan } = buildPlanFromSpec(spec, { root: ROOT });
      const pp = writePlan('real-mini-41s', plan);
      await atest('真实页 mini-41s：缺失必须 ⊆ KNOWN_GAPS 账本（新假阳/新盲区必红）', async () => {
        // 账本：mini-41s 用到 recipe 页（datarace/whiteboard 不读 ?sub= 属真缺陷；
        // glitch 标题走离屏缓存且文件域外无法挂 __textInfo 属契约盲区；
        // subtitle band 两处 = guofeng 水墨大字 '白' 入带 16px）。
        // G11 收官：四条旧账全部销清（datarace/whiteboard ?sub 真槽位、glitch TMP.__textInfos）——
        // 账本清零后本断言即「真实页零缺失」硬闸，任何页面回退都会红。
        const KNOWN_MISSING = new Set();
        const KNOWN_BAND_MAX = 2;
        const { report: rep } = runQaText(pp);
        assert(rep, '闸没写报告');
        const fails = (rep.checks || []).filter((c) => c.status === 'FAIL');
        for (const f of fails) {
          assert(['pixel text coverage', 'subtitle band'].includes(f.name),
            `mini-41s 出现账外 FAIL 检查项「${f.name}」——新假阳或新缺陷：${f.detail.slice(0, 300)}`);
        }
        const cov = fails.find((c) => c.name === 'pixel text coverage');
        const missing = new Set(cov ? [...cov.detail.matchAll(/"([^"]+)"\(/g)].map((m) => m[1]) : []);
        for (const m of missing) assert(KNOWN_MISSING.has(m), `mini-41s 新缺失文案（不在账本）："${m}"`);
        for (const m of KNOWN_MISSING) if (!missing.has(m)) console.log(`  [note] KNOWN_GAPS 销账：?sub/?title "${m}" 已能上屏——可从 test-readability 的 KNOWN_MISSING 移除`);
        const band = fails.find((c) => c.name === 'subtitle band');
        const bandCount = band ? Number(/^(\d+) 处/.exec(band.detail)?.[1] || 1) : 0;
        assert(bandCount <= KNOWN_BAND_MAX, `mini-41s 越带处数 ${bandCount} 超账本 ${KNOWN_BAND_MAX}（guofeng '白'）——检查闸是否变严：${band && band.detail.slice(0, 300)}`);
      });
    }
  }

  console.log(`\n[test-readability] ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (skipped && !failed) console.log('[test-readability] 浏览器类用例为 SKIP（环境缺 Chrome）；纯逻辑用例真实通过，不计假绿。');
  process.exitCode = failed ? 1 : 0;
}
await main();
