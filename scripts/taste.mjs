#!/usr/bin/env node
/**
 * taste.mjs — `cvs taste`：S1 审美裁判机（纯确定性，无网络无 LLM）。
 *
 *   node scripts/taste.mjs <spec.json> [--root dir] [--waivers f] [--strict] [--json] [--out dir]
 *                            [--rules f] [--today YYYY-MM-DD] [--report-unused-waivers] [--sarif]
 *
 * 设计（依据 E:\myzcode\_research_22\notes\G3.md，蓝本=impeccable 工程形态 ×
 * hallmark 58 门可判定子集 × taste-skill 的 GATE/waiver 纪律）：
 *  - 规则目录 schema/taste-rules.json 是数据，**判决阈值/正则的唯一真值在目录的
 *    assert 字段**（G3-6：EVALS 不再硬编码口径，改表即改判）；目录缺 assert 或
 *    字段非法 → 启动即错 [E_TASTE_ASSERT] exit 2，绝不静默回退旧硬编码。
 *  - 对比度类规则吃 look.accentOverride 合成后的主题（G3-4，与 templates/spec-check.mjs
 *    的 accentOverride() 同一把尺；override-silent 例外，它要比未覆盖原值）。
 *  - 转场多样性读真实源 render.transition（G3-3；旧实现读 schema 里不存在的
 *    rounds[].style.transition → 对任何 ≥3 轮恒 fail）。
 *  - beat-grid 首/尾段豁免按**段身份**（name==='opening'/'ending'），不按秒数相等
 *    （G3-8：round=8s 撞上 opening=8s 曾被误当首尾段放宽容差假绿）。
 *  - 帧级规则（schema input:"frames"）依赖 G7 像素通路：本闸**显式 skip 并计数**
 *    （G3-9 诚实报告「帧级未实装 N 条」），不进判决、不假绿。
 *  - 豁免生命周期（G3-7）：reason 必填非空；rule 必须在目录；date 过 --today 判定
 *    过期，过期豁免不许静默——不再豁免该条且计入 blocking；--report-unused-waivers
 *    时未命中的豁免参与退出码。
 *  - 三层判决：error 永远拦 · warning 计入 100−Σweight 且 --strict 拦 ·
 *    advisory 永不拦只列示。
 * 退出码（G3-9，对齐 ROADMAP 0/1/2 承诺；13 是 qa 族退出码，taste 不再借用）：
 *   0 通过 · 1 判决阻断（error/blocked）· 2 用法/读盘/目录非法/豁免非法。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseStrict, rejectUnknown } from './lib/strict-flags.mjs';
import { parseColor, toOklch, auditApca } from '../templates/color.js';
import { THEMES, THEME_IDS, DEFAULT_THEME, accentOverride } from '../templates/themes.js';
import { isTransition, isTransitionOff } from '../templates/transitions.mjs';

const PROG = 'node scripts/taste.mjs';
const KNOWN = new Set(['root', 'waivers', 'strict', 'json', 'out', 'rules', 'report-unused-waivers', 'today', 'sarif', 'help']);
const argv = process.argv.slice(2);
const { args, unknown } = parseStrict(argv, KNOWN);
if (unknown.length) rejectUnknown(PROG, unknown, KNOWN);
const specArg = String(argv.find((a) => !String(a).startsWith('--')) || '');
if (args.help || !specArg) {
  console.log(`Usage: node scripts/taste.mjs <spec.json> [options]
  --root <dir>                project root (default cwd)
  --rules <f>                 rule catalog (default schema/taste-rules.json)
  --waivers <f>               waivers JSON (default <root>/.cvs/waivers.json)
  --strict                    warnings fail too
  --today <YYYY-MM-DD>        injectable clock for waiver expiry tests
  --report-unused-waivers     unused waivers are reported AND block the gate
  --sarif                     write <out>/taste.sarif (SARIF 2.1.0)
  --json                      machine report on stdout
  --out <dir>                 write taste.json (default <root>/out/qa)
Exit: 0 pass · 1 verdict blocking (error/expired waiver) · 2 usage/read/invalid catalog`);
  process.exit(args.help ? 0 : 2);
}
const die2 = (code, msg) => { console.error(`[error] [${code}] ${msg}`); process.exit(2); };

const ROOT = path.resolve(String(args.root || process.cwd()));
let spec;
try { spec = JSON.parse(fs.readFileSync(path.resolve(specArg), 'utf8')); }
catch (e) { die2('E_TASTE_READ', `spec 不可读: ${String(e.message).slice(0, 160)}`); }
let catalog;
try { catalog = JSON.parse(fs.readFileSync(path.resolve(String(args.rules || path.join(ROOT, 'schema', 'taste-rules.json'))), 'utf8')); }
catch (e) { die2('E_TASTE_READ', `rules 不可读: ${String(e.message).slice(0, 160)}`); }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const today = args.today ? String(args.today) : new Date().toISOString().slice(0, 10);
if (!DATE_RE.test(today)) die2('E_USAGE', `--today 需 YYYY-MM-DD，收到 "${today}"`);

// ── G3-6：规则目录自检。assert 是判决口径唯一真值；缺失/非法 = 闸自身故障，启动即错。
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => typeof v === 'string' && v.length > 0;
const reOk = (v) => { try { new RegExp(v); return str(v); } catch { return false; } };
const pair2 = (v) => Array.isArray(v) && v.length === 2 && v.every(str);
const ASSERT_OK = {
  'placeholder-copy': (a) => reOk(a.regex) && Array.isArray(a.fields) && a.fields.length > 0,
  'theme-known': (a) => a.in === 'THEME_IDS',
  'contrast-body': (a) => str(a.metric),
  'contrast-large': (a) => str(a.metric),
  'black-on-black': (a) => pair2(a.pair) && num(a.maxLightDist) && num(a.maxChromaDist),
  'neutral-chroma': (a) => str(a.metric) && num(a.min),
  'override-silent': (a) => pair2(a.eq),
  'style-duplicate-page': (a) => num(a.maxPerValue),
  'transition-variety': (a) => num(a.whenRoundsGte) && a.of === 'render.transition',
  'beat-grid': (a) => num(a.tolerance) && num(a.edgeTolerance) && Array.isArray(a.edgeSegments),
  'flash-overload': (a) => num(a.max),
  'duration-band': (a) => num(a.min) && num(a.max) && a.min <= a.max,
  'copy-density': (a) => str(a.allNonEmpty),
  'fabricated-metric': (a) => reOk(a.regex) && reOk(a.exemptIfMatches),
};
if (!Array.isArray(catalog.rules) || !catalog.rules.length) die2('E_TASTE_ASSERT', '规则目录缺 rules[] 或为空');
{
  const seen = new Set();
  for (const rule of catalog.rules) {
    if (!str(rule?.id)) die2('E_TASTE_ASSERT', `规则缺合法 id: ${JSON.stringify(rule).slice(0, 80)}`);
    if (seen.has(rule.id)) die2('E_TASTE_ASSERT', `规则 id 重复: ${rule.id}`);
    seen.add(rule.id);
    if (!['error', 'warning', 'advisory'].includes(rule.severity)) die2('E_TASTE_ASSERT', `${rule.id}: severity 非法(${rule.severity})`);
    if (typeof rule.waivable !== 'boolean') die2('E_TASTE_ASSERT', `${rule.id}: waivable 需 boolean`);
    if (!rule.assert || typeof rule.assert !== 'object') die2('E_TASTE_ASSERT', `${rule.id}: 缺 assert（阈值唯一真值，不许静默回退硬编码）`);
    if (rule.input === 'frames') continue; // 帧级只要求 assert 存在，字段口径等 G7 实装时再校验
    const chk = ASSERT_OK[rule.id];
    if (chk && !chk(rule.assert)) die2('E_TASTE_ASSERT', `${rule.id}: assert 非法/不完整 ${JSON.stringify(rule.assert).slice(0, 140)}`);
  }
}

// ── 小工具 ──
const baseTheme = () => (spec.look && spec.look.theme && THEMES[spec.look.theme]) || THEMES[DEFAULT_THEME];
// G3-4：对比度类规则吃 accentOverride 之后的有效主题（与 spec-check 同尺）。
const themeOf = () => {
  const ov = spec.look?.accentOverride;
  if (!ov) return baseTheme();
  try { return accentOverride(baseTheme(), ov); } catch { return baseTheme(); }
};
const c = (k) => themeOf().colors?.[k] || null;     // 有效（覆盖后）
const cb = (k) => baseTheme().colors?.[k] || null;  // 原主题（override-silent 用）
const normHex = (h) => {
  if (!h) return '';
  const s = String(h).trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return '#' + [...s.slice(1)].map((x) => x + x).join('');
  try { const { r, g, b } = parseColor(s); return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join(''); } catch { return s; }
};
const copyStrings = () => {
  const out = [];
  const push = (label, v) => { if (typeof v === 'string' && v) out.push([label, v]); };
  const m = spec.meta || {};
  push('meta.brand', m.brand); push('meta.title', m.title); push('meta.cta', m.cta); push('meta.description', m.description);
  for (const [k, v] of Object.entries(spec.copy || {})) push(`copy.${k}`, typeof v === 'string' ? v : JSON.stringify(v));
  for (const r of spec.rounds || []) {
    push(`rounds[${r.id}].card.first`, r.card?.first); push(`rounds[${r.id}].card.keyword`, r.card?.keyword);
    const sc = r.style?.copy || {};
    for (const [k, v] of Object.entries(sc)) push(`rounds[${r.id}].style.copy.${k}`, typeof v === 'string' ? v : JSON.stringify(v));
  }
  return out;
};

// ── 判定实现（阈值/正则一律取自 catalog 的 rule.assert；缺字段上一步已启动报错）──
export const EVALS = {
  'placeholder-copy': (a) => {
    const re = new RegExp(a.regex, 'i');
    const hits = copyStrings().filter(([, v]) => re.test(v));
    return hits.length ? { pass: false, value: hits.map(([l, v]) => `${l}="${v.slice(0, 40)}"`).join(', ') } : { pass: true, value: 'clean' };
  },
  'theme-known': () => {
    const t = spec.look?.theme;
    const okv = !t || t === DEFAULT_THEME || THEME_IDS.includes(t);
    return { pass: okv, value: String(t ?? `default(${DEFAULT_THEME})`) };
  },
  'contrast-body': () => {
    // 单一真值：直接消费模板层 auditApca 的行（ink/bg≥60 等），不在这里复写阈值。
    const row = auditApca(themeOf()).find((r) => r.pair === 'ink / bg');
    if (!row) return { pass: true, value: 'N/A' };
    return { pass: row.pass, value: `Lc=${row.lc}`, threshold: row.need };
  },
  'contrast-large': () => {
    const rows = auditApca(themeOf()).filter((r) => r.pair === 'muted / bg' || r.pair === 'accent / bg');
    const fails = rows.filter((r) => !r.pass);
    return fails.length
      ? { pass: false, value: fails.map((r) => `${r.pair.split(' ')[0]}=${r.lc}(需${r.need})`).join(','), threshold: 'auditApca 口径' }
      : { pass: true, value: rows.map((r) => `${r.pair.split(' ')[0]}=${r.lc}`).join(',') };
  },
  'black-on-black': (a) => {
    const [k1, k2] = a.pair;
    const x = toOklch(c(k1)), y = toOklch(c(k2));
    const dl = Math.abs(x.l - y.l) * 100, dc = Math.abs(x.c - y.c);
    const bad = dl < a.maxLightDist && dc < a.maxChromaDist && x.h != null && y.h != null;
    return { pass: !bad, value: `ΔL=${dl.toFixed(1)} ΔC=${dc.toFixed(3)}`, threshold: `ΔL<${a.maxLightDist}且ΔC<${a.maxChromaDist}` };
  },
  'neutral-chroma': (a) => {
    const cc = toOklch(c('muted')).c ?? 0;
    return { pass: cc >= a.min, value: +cc.toFixed(4), threshold: a.min };
  },
  'override-silent': (a) => {
    // 要比的是「未覆盖的原主题 accent」——有效主题里 accent 恒等于覆盖值，不能用 themeOf()。
    const ov = spec.look?.accentOverride;
    const ovs = typeof ov === 'string' ? ov : ov?.accent;
    if (!ovs) return { pass: true, value: 'none（未覆盖 accent，N/A）' };
    const same = normHex(ovs) === normHex(cb('accent'));
    return { pass: !same, value: same ? `override==theme.accent(${ovs})` : `override=${ovs}` };
  },
  'style-duplicate-page': (a) => {
    const seen = new Map();
    for (const r of spec.rounds || []) {
      const p = String(r.style?.page || '').split('?')[0];
      if (!p) continue;
      seen.set(p, (seen.get(p) || 0) + 1);
    }
    const dup = [...seen.entries()].filter(([, n]) => n > a.maxPerValue);
    return dup.length ? { pass: false, value: dup.map(([p, n]) => `${path.basename(p)}×${n}`).join(',') } : { pass: true, value: `${seen.size} 页各一轮` };
  },
  'transition-variety': (a) => {
    // G3-3 真实源：段间转场在 schema 里只有一个真值 render.transition（xfade 全局 token）；
    // 旧实现读不存在的 rounds[].style.transition → 任何 ≥3 轮恒 fail（distinct 恒 1）。
    const rounds = spec.rounds || [];
    if (rounds.length < a.whenRoundsGte) return { pass: true, value: `rounds=${rounds.length}<${a.whenRoundsGte}（N/A）` };
    const raw = spec.render?.transition;
    if (isTransitionOff(raw)) return { pass: false, value: `render.transition 硬切/未设，${rounds.length} 轮全切` };
    return { pass: true, value: `render.transition=${raw}${isTransition(String(raw)) ? '' : '（非法 token：lint/build 会拦，此处按有转场记）'}` };
  },
  'beat-grid': (a) => {
    const bpm = Number(spec.audio?.bpm || 0), st = spec.structure || {};
    if (!bpm) return { pass: true, value: 'bpm 未声明（N/A）' };
    const edges = new Set(a.edgeSegments);
    const off = [];
    // G3-8：首/尾段用**段身份**（名字）判定，绝不用 Number(sec)===st.opening 的秒数相等——
    // round=8s 撞上 opening=8s 曾被当成首尾段套 ±edgeTolerance 宽限而假绿。
    for (const [name, sec] of [['round', st.round], ['card', st.card], ['opening', st.opening], ['ending', st.ending]]) {
      if (!sec) continue;
      const beats = (Number(sec) * bpm) / 60, f = Math.abs(beats - Math.round(beats));
      const limit = edges.has(name) ? a.edgeTolerance : a.tolerance;
      if (f > limit + 1e-9) off.push(`${name}=${sec}s→${beats.toFixed(2)}拍`);
    }
    return off.length
      ? { pass: false, value: off.join(','), threshold: `±${a.tolerance}拍(首尾±${a.edgeTolerance})` }
      : { pass: true, value: `bpm=${bpm} 全部落拍`, threshold: `±${a.tolerance}拍(首尾±${a.edgeTolerance})` };
  },
  'flash-overload': (a) => {
    const f = spec.structure?.flash || {}, dur = Number(spec.format?.duration || 0);
    const share = dur ? (Number(f.count || 0) * Number(f.each || 0)) / dur : 0;
    return { pass: share <= a.max + 1e-9, value: `${(share * 100).toFixed(1)}%`, threshold: a.max * 100 };
  },
  'duration-band': (a) => {
    const d = Number(spec.format?.duration || 0);
    return { pass: d >= a.min && d <= a.max, value: `${d}s`, threshold: `${a.min}–${a.max}` };
  },
  'copy-density': () => {
    const empt = (spec.rounds || []).filter((r) => !String(r.style?.copy?.subtitle || '').trim()).map((r) => r.id);
    return empt.length ? { pass: false, value: `无副题: ${empt.join(',')}` } : { pass: true, value: '每轮有副题' };
  },
  'fabricated-metric': (a) => {
    const re = new RegExp(a.regex);
    const exempt = new RegExp(a.exemptIfMatches, 'i');
    const bad = copyStrings().filter(([, v]) => re.test(v) && !exempt.test(v));
    return bad.length ? { pass: false, value: bad.map(([l]) => l).join(',') } : { pass: true, value: '无未溯源数字声明' };
  },
};

// ── 豁免（G3-7 生命周期真闸）──
const waiversPath = args.waivers ? path.resolve(String(args.waivers)) : path.join(ROOT, '.cvs', 'waivers.json');
let waivers = [];
if (fs.existsSync(waiversPath)) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(waiversPath, 'utf8')); }
  catch (e) { die2('E_TASTE_READ', `waivers 非法 JSON: ${waiversPath}（${String(e.message).slice(0, 120)}）`); }
  waivers = Array.isArray(doc) ? doc : doc?.waivers;
  if (!Array.isArray(waivers)) die2('E_TASTE_WAIVER', `waivers 需数组或 {waivers:[...]}: ${waiversPath}`);
}
const catalogIds = new Set(catalog.rules.map((r) => r.id));
const expiredWaivers = [];
const waiverMap = new Map();
for (const [i, w] of waivers.entries()) {
  const at = `waivers[${i}]`;
  if (!w || typeof w !== 'object') die2('E_TASTE_WAIVER', `${at} 需对象 {rule,reason,date}`);
  if (!catalogIds.has(String(w.rule))) die2('E_TASTE_WAIVER_RULE', `${at} rule="${w.rule}" 不在规则目录（目录是唯一真值，拼错/失效条目不许静默放行）`);
  if (typeof w.reason !== 'string' || !w.reason.trim()) die2('E_TASTE_WAIVER_REASON', `${at}(${w.rule}) reason 必填非空——豁免是留痕承诺，不是过闸开关`);
  if (w.date != null && !DATE_RE.test(String(w.date))) die2('E_TASTE_WAIVER_DATE', `${at}(${w.rule}) date 需 YYYY-MM-DD，收到 "${w.date}"`);
  if (w.date != null && String(w.date) < today) {
    expiredWaivers.push(`${w.rule}（豁免止于 ${w.date}，今日 ${today}）`);
    continue; // 过期即失效：不进 waiverMap，其 fail 照算 blocking
  }
  waiverMap.set(String(w.rule), w);
}

// ── 运行 ──
const results = [];
let frameSkipped = 0;
for (const rule of catalog.rules) {
  if (rule.input === 'frames') { // G3-9：帧级未实装——显式 skip+计数，绝不假绿也绝不假红
    frameSkipped++;
    results.push({ rule: rule.id, title: rule.title, from: rule.from, severity: rule.severity, status: 'skipped-frames',
      weight: 0, evidence: `帧级未实装（依赖 G7 像素通路；assert=${JSON.stringify(rule.assert)}）`, waivedBy: null, threshold: null });
    continue;
  }
  const ev = EVALS[rule.id];
  if (!ev) { results.push({ rule: rule.id, severity: rule.severity, status: 'unimplemented', evidence: 'EVALS 缺实现（闸不许假绿：视为 finding）' }); continue; }
  let r;
  try { r = ev(rule.assert); } catch (e) { results.push({ rule: rule.id, severity: rule.severity, status: 'error', evidence: String(e.message).slice(0, 120) }); continue; }
  let status = r.pass ? 'pass' : 'fail';
  const wv = waiverMap.get(rule.id);
  if (status === 'fail' && wv && rule.waivable && rule.severity !== 'error') status = 'waived';
  else if (status === 'fail' && wv && rule.waivable && rule.severity === 'error') status = 'fail'; // error 不可豁免于闸（记录但照拦）
  results.push({ rule: rule.id, title: rule.title, from: rule.from, severity: rule.severity, status,
    weight: rule.weight || 0, evidence: String(r.value ?? ''), threshold: r.threshold ?? null,
    waivedBy: status === 'waived' ? `${wv.reason}（${wv.date || '无日期'}）` : null });
}
const fired = new Set(results.filter((x) => x.status === 'fail' || x.status === 'waived').map((x) => x.rule));
const unusedWaivers = [...waiverMap.values()].filter((w) => !fired.has(String(w.rule))).map((w) => `${w.rule}: ${w.reason}`);

const fails = results.filter((x) => x.status === 'fail');
// v4.9.3（证伪 F9）+ G3-6：unimplemented/eval 异常不进判决＝假绿；规则目录与 EVALS 脱节属闸自身故障，按 error 拦。
const broken = results.filter((x) => x.status === 'unimplemented' || x.status === 'error');
const errs = fails.filter((x) => x.severity === 'error');
const warns = fails.filter((x) => x.severity === 'warning');
const advisories = fails.filter((x) => x.severity === 'advisory');
const deducted = warns.reduce((s, x) => s + (catalog.rules.find((r) => r.id === x.rule)?.weight || 5), 0);
const score = +Math.max(0, 100 - deducted).toFixed(1);
const unusedBlocking = Boolean(args['report-unused-waivers']) && unusedWaivers.length > 0;
const report = {
  engine: 'taste/1', rulesVersion: catalog.version, spec: path.basename(specArg), today,
  score,
  blocking: errs.length > 0 || broken.length > 0 || (Boolean(args.strict) && warns.length > 0)
    || expiredWaivers.length > 0 || unusedBlocking,
  counts: { error: errs.length, warning: warns.length, advisory: advisories.length, broken: broken.length,
    waived: results.filter((x) => x.status === 'waived').length,
    frameSkipped, expiredWaivers: expiredWaivers.length, unusedWaivers: unusedWaivers.length },
  results,
  expiredWaivers: expiredWaivers.length ? expiredWaivers : undefined,
  unusedWaivers: Boolean(args['report-unused-waivers']) ? unusedWaivers : undefined,
};

const outDir = args.out ? path.resolve(String(args.out)) : path.join(ROOT, 'out', 'qa');
try {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'taste.json'), JSON.stringify(report, null, 2) + '\n');
} catch { /* 报告写不进不掩判决 */ }

// ── G3-9 --sarif：CSARIF(SARIF) 2.1.0 最小实现（results=判决为 fail 的条目）──
if (args.sarif) {
  const LEVEL = { error: 'error', warning: 'warning', advisory: 'note' };
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: {
        name: 'cvs-taste',
        version: `rules-v${catalog.version}`,
        informationUri: 'https://example.invalid/code-video-showcase/taste',
        rules: catalog.rules.map((r) => ({
          id: r.id, name: r.id, shortDescription: { text: r.title },
          defaultConfiguration: { level: LEVEL[r.severity] || 'note' },
        })),
      } },
      results: results.filter((x) => x.status === 'fail').map((x) => ({
        ruleId: x.rule, level: LEVEL[x.severity] || 'note',
        message: { text: `${x.title} · ${x.evidence}${x.threshold != null ? ` · 阈值 ${x.threshold}` : ''}` },
        locations: [{ physicalLocation: { artifactLocation: { uri: path.basename(specArg) } } }],
      })),
    }],
  };
  try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'taste.sarif'), JSON.stringify(sarif, null, 2) + '\n'); }
  catch (e) { console.error(`[warn] [E_TASTE_WRITE] sarif 写入失败: ${String(e.message).slice(0, 120)}`); }
}

console.error(`[taste] score ${score}/100 · error ${errs.length}${broken.length ? ` · broken ${broken.length}` : ''} · warning ${warns.length} · advisory ${advisories.length}${report.counts.waived ? ` · waived ${report.counts.waived}` : ''}${frameSkipped ? ` · 帧级未实装(skip) ${frameSkipped}` : ''}${expiredWaivers.length ? ` · 过期豁免 ${expiredWaivers.length}` : ''}`);
for (const x of broken) console.error(`  ✗ [gate-fault] ${x.rule} — ${x.status} · ${x.evidence}`);
for (const x of results) {
  if (x.status === 'fail') console.error(`  ✗ [${x.severity}] ${x.rule} — ${x.title} · ${x.evidence}`);
  if (x.status === 'waived') console.error(`  ~ [waived] ${x.rule} — ${x.waivedBy}`);
}
for (const x of expiredWaivers) console.error(`  ✗ [E_TASTE_WAIVER_EXPIRED] 过期豁免计入 blocking — ${x}`);
if (args['report-unused-waivers'] && unusedWaivers.length) {
  console.error(`  ${unusedBlocking ? '✗' : '!'} [E_TASTE_WAIVER_UNUSED] 未命中豁免: ${unusedWaivers.join(' | ')}`);
}
if (args.json) process.stdout.write(JSON.stringify(report) + '\n');
if (report.blocking) console.error(`[error] [E_TASTE_FAIL] taste 闸不过：error=${errs.length}${broken.length ? ` 闸故障=${broken.length}` : ''} warning=${warns.length}${args.strict ? '（--strict）' : ''} 过期豁免=${expiredWaivers.length} 未命中豁免拦=${unusedBlocking ? unusedWaivers.length : 0} · 报告 ${path.join(outDir, 'taste.json')}`);
process.exit(report.blocking ? 1 : 0);
