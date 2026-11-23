#!/usr/bin/env node
/**
 * plan.mjs — spec.json (IR) → plan.json（带段哈希的渲染计划）
 *
 * 在 timeline.mjs 的帧对齐逻辑之上补三件事：
 *   1. spec 归一化 + 校验（错误直接阻断）；
 *   2. 每段一个内容哈希 segmentHash（缓存/增量的唯一依据）；
 *   3. plan 里记录 spec 摘要、资产哈希与渲染选项，供 render-farm / compile 使用。
 *
 *   node templates/plan.mjs --spec project.spec.json --out out/plan.json --concat out/segments.txt --print
 *   node templates/plan.mjs --spec project.spec.json --check
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildPlan as buildLegacyPlan, concatList, formatPlan } from './timeline.mjs';
import { normalizeSpec, validateSpec, specToTimeline, specDuration, SPEC_VERSION, ENGINE_VERSION } from './spec.mjs';
import { browserCandidates } from './cdp.mjs';
// G10/S3-3 seam gate 的数据面：入场向量语义是仓内既有定义，不新造账本——
// MOTION_PROFILES[level].transition 是「入场转场」（motion-profile.mjs 字段注释），
// transitionParams(name, 0) 给出该入场在 t=0 的初始位移 {x,y}（motion.js：位移随 t→1
// 归零，即元素从该位移处滑入）。出场侧同表只有标量档（easeOut 回弹缓动名，无方向），
// 所以静态判据落在「相邻段入场位移向量是否一致」上——方向学编辑的第一矛盾。
import { motionParams, isMotionLevel } from './motion-profile.mjs';
import { transitionParams } from './motion.js';

export const PLAN_VERSION = 2;

// S5a 运动模糊档位 → tmix 权重（词数=子帧采样倍率 N）。
export const BLUR_WEIGHTS = { weak: '1 1', normal: '1 2 1', strong: '1 2 3 2 1' };

const isAbsoluteUrl = (s) => /^https?:\/\//i.test(String(s || ''));

/** 从 HTML/JS/CSS 文本里抽本地依赖（import / @import / link / script src /
 *  CSS url() / <img src>）。
 *  S0-4：区分两类引用——importish（模块说明符，可能是 node_modules 的 bare
 *  specifier）与 resourceish（url/src/href 资源路径）。bare import 不进哈希
 *  是同类「假绿」里最难查的一种：`npm update` 改了库字节，段缓存命中出旧画面
 *  且 build 报成功。零依赖是 CVS 的卖点，所以这里升级成 E_PAGE_BARE 硬闸。 */
function localRefs(text) {
  const importish = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    // v4.9.3（证伪 F5）：动态 import('pkg') 以前两头都漏——既不进 bare 闸也不进递归。
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /@import\s+(?:url\()?['"]?([^'")\s]+)['"]?\)?/g,
  ];
  const resourceish = [
    /<link[^>]+href=["']([^"']+)["']/gi,
    /<script[^>]+src=["']([^"']+)["']/gi,
    // R3-审计（RT-04 #2）：CSS `url()` 与 `<img src>` 以前不在引用面——页面里
    // background-image 指向的素材被换掉，路径不变 hash 不变，缓存命中出旧画面。
    // 二进制按 utf8 读会得到稳定的乱码哈希，足以让缓存失效（不追求字节精确）。
    /url\(\s*['"]?([^'")\s]+)['"]?\)/g,
    /<img[^>]+src=["']([^"']+)["']/gi,
  ];
  const grab = (pats) => { const s = new Set(); for (const re of pats) for (const m of text.matchAll(re)) s.add(m[1]); return [...s]; };
  return { imports: grab(importish), resources: grab(resourceish) };
}

/**
 * 页面内容哈希：页面本身 + 递归依赖（本地 JS/CSS，深度 ≤4）。
 *
 * 为什么必须进段哈希：v2.3.4 的 segmentHash 只有页面**路径**。
 * 改 `recipe-greatwall.html` 或 `common.js` 后，路径没变、hash 没变、
 * 缓存命中 → 出片还是旧画面，而 build 报成功。这是最危险的一种「假绿」。
 *
 * @param {string} root 项目根
 * @param {string} pagePath 页面路径（可带 ?query）
 * @param {Set<string>} [seen] 递归去重集（内部用）
 * @param {number} [depth] 递归深度（内部用）
 * @param {string[]} [bare] 传入数组时收集 bare 模块说明符（S0-4 硬闸探测面）
 * @returns {string} 16 位 sha256；远程页面或缺失文件返回带前缀的标记
 */
export function pageContentHash(root, pagePath, seen = new Set(), depth = 0, bare = null) {
  const barePath = String(pagePath || '').split('?')[0].split('#')[0];
  if (!barePath) return 'none';
  if (isAbsoluteUrl(barePath)) return `remote:${barePath}`;
  const abs = path.resolve(root, barePath);
  if (seen.has(abs)) return 'cycle';
  seen.add(abs);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return `missing:${barePath}`;

  const text = fs.readFileSync(abs, 'utf8');
  const own = crypto.createHash('sha256').update(text).digest('hex');
  if (depth >= 4) return own.slice(0, 16);

  const deps = [];
  // 字体字形在 woff2 里，fonts.css 只是索引。localRefs 现在会抽 url()，若让
  // fonts.css 走通用递归，1187 个 woff2 子集全部进哈希（实测每页 +5s、16 页
  // 全链 >2min）。命中即早退：own + lock 指纹足以代表字体集合变更。
  const normRel = path.relative(root, abs).split(path.sep).join('/');
  if (normRel === 'shared/fonts.css') {
    // R3 回归自检：fonts.css 是**索引**不是依赖图——localRefs 的 url() 会把它
    // 的 1187 个 woff2 子集全部递归哈希（实测每页 +5s、16 页全链 >2min）。
    // 命中即早退：own + lock 指纹足以代表字体集合变更。
    const lockAbs = path.join(root, 'shared', 'fonts.lock.json');
    if (fs.existsSync(lockAbs)) {
      const lh = crypto.createHash('sha256').update(fs.readFileSync(lockAbs)).digest('hex').slice(0, 16);
      return crypto.createHash('sha256').update(`${own}|shared/fonts.lock.json:${lh}`).digest('hex').slice(0, 16);
    }
  }
  const { imports, resources } = localRefs(text);
  // S0-4 硬闸的探测面：bare 模块说明符（node_modules/CDN 包名）。data:/http/
  // 相对/仓内前缀之外的一律视为 bare，交给 assertPages 报 E_PAGE_BARE。
  const ROOT_PREFIXES = ['templates/', 'shared/', 'assets/', 'content/'];
  if (Array.isArray(bare)) {
    for (const ref of imports) {
      if (!ref || isAbsoluteUrl(ref) || ref.startsWith('data:') || ref.startsWith('.') || ref.startsWith('/')) continue;
      if (ROOT_PREFIXES.some((p) => ref.startsWith(p))) continue;
      bare.push(`${normRel} → ${ref}`);
    }
  }
  for (const ref of [...imports, ...resources]) {
    if (!ref || isAbsoluteUrl(ref) || ref.startsWith('data:')) continue;
    // S0-4：assets//content/ 根相对引用以前被静默跳过（换素材字节 hash 不变 =
    // RT-04 #2 同族假绿）。现在进递归哈希。
    if (!(ref.startsWith('.') || ref.startsWith('/') || ROOT_PREFIXES.some((p) => ref.startsWith(p)))) continue;
    let rel;
    if (ref.startsWith('/')) rel = ref.slice(1);
    else if (ROOT_PREFIXES.some((p) => ref.startsWith(p))) rel = ref;
    else rel = path.relative(root, path.resolve(path.dirname(abs), ref));
    const h = pageContentHash(root, rel, seen, depth + 1, bare);
    if (h && !h.startsWith('cycle')) deps.push(`${rel.replace(/\\/g, '/')}:${h}`);
  }
  deps.sort();
  return crypto.createHash('sha256').update(`${own}|${deps.join('|')}`).digest('hex').slice(0, 16);
}

/** 工具链指纹：Node 主版本 + ffmpeg 一行版本 + 渲染浏览器版本。升级编码器后旧段缓存自然失效，
 *  不再把上一个 ffmpeg 的字节当「同内容」交付（R3-审计 RT-04 #4）。
 *  S0-2（内审 F2）：Chrome 一直是像素变量——golden.mjs 把它当位级可比前提
 *  （E_ENV_MISMATCH），但段缓存指纹不含它：浏览器自更新后 warm build 会把新旧
 *  光栅化像素混拼进同一部片子且报缓存命中。现在与 golden 同口径（browserCandidates
 *  探测链同源），浏览器版本进 payload。 */
let buildFpCache = null;
export function toolchainFingerprint() {
  if (buildFpCache !== null) return buildFpCache;
  let ffmpeg = 'no-ffmpeg';
  try {
    const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    ffmpeg = String((r && r.stdout) || '').split('\n')[0].replace(/^ffmpeg version\s*/i, '').trim().slice(0, 40);
  } catch { /* keep default */ }
  let browser = 'no-browser';
  try {
    const exe = browserCandidates()[0];
    if (exe) {
      const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
      const line = (String((r && r.stdout) || '').trim().split('\n')[0] || path.basename(exe)).slice(0, 60);
      browser = `${path.basename(exe)}@${line}`;
    }
  } catch { /* keep default */ }
  buildFpCache = `node${process.versions.node}|ffmpeg${ffmpeg}|${browser}`;
  return buildFpCache;
}

/** 重算本地素材字节哈希。
 * R3-审计（RT-04 #3）：segmentHash 以前只信 spec 里自报的 hash——同路径换素材、
 * 声明 hash 不更新，内容寻址就命中旧字节。实测优先：声明的与实测不符 → E_ASSET_HASH；
 * 无声明时把实测值并入，返回的 Map 按 path 索引，供段哈希与 plan.spec.assets 使用。 */
export function resolveAssetHashes(spec, root) {
  const issues = [];
  const hashes = new Map();
  for (const [i, a] of (spec.assets || []).entries()) {
    if (!a || typeof a.path !== 'string' || isAbsoluteUrl(a.path)) continue;
    const bare = String(a.path).split('?')[0].split('#')[0];
    const abs = path.resolve(root, bare);
    let stat = null;
    try { stat = fs.statSync(abs); } catch { /* missing 已由 assertPages/E_ASSET_MISSING 报 */ }
    if (!stat || !stat.isFile()) continue;
    const h = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 16);
    hashes.set(String(a.path), h);
    const declared = a.hash || a.sha256;
    if (declared && String(declared).toLowerCase() !== h) {
      issues.push({
        code: 'E_ASSET_HASH', path: `assets[${i}].path`, level: 'error',
        message: `asset bytes changed since the recorded hash (${bare}): declared ${String(declared).toLowerCase().slice(0, 16)}, actual ${h}`,
      });
    }
  }
  return { issues, hashes };
}

/** FINDING-9（v4.12/G4）：brand.mjs 把 logo 写进 meta.brandKit（不进 spec.assets），
 *  resolveAssetHashes 覆盖不到它——同路径换 logo 字节，段哈希不变、缓存命中出旧
 *  画面且 build 报成功。logo 直接决定画面像素（big-card drawBrandLogo），必须进
 *  哈希面：实测字节哈希（路径不变字节变 → 缓存失效）。missing: 前缀让「给了路径
 *  但文件不存在」同样可区分（渲染期会以 __bootError 失败，这里先把账留全）。 */
export function brandLogoHash(spec, root) {
  const p = spec && spec.meta && spec.meta.brandKit && spec.meta.brandKit.logo && spec.meta.brandKit.logo.path;
  if (!p || typeof p !== 'string') return '';
  const bare = String(p).split('?')[0].split('#')[0];
  if (!bare) return '';
  if (isAbsoluteUrl(bare)) return `remote:${bare}`;
  const abs = path.resolve(root, bare);
  // 与 assets/page 同一条 containment 规矩：品牌 kit 也是 spec 可写字段，
  // 不能变成服务端任意文件读取 oracle（哈希就是探针）。
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return `escaped:${bare}`;
  try {
    if (!fs.statSync(abs).isFile()) return `missing:${bare}`;
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 16);
  } catch { return `missing:${bare}`; }
}

/** 段哈希：任何影响该段像素的输入都必须进来。 */
export function segmentHash(segment, meta, spec, opts = {}) {
  // R3（RT-04 #3/#4）：素材用实测哈希（与 spec.assets 同序对齐），再垫工具链指纹。
  const assetList = Array.isArray(spec.assets) ? spec.assets : [];
  let hashes;
  if (opts.assetHashes && Array.isArray(opts.assetHashes) && opts.assetHashes.length === assetList.length) {
    hashes = opts.assetHashes;
  } else {
    hashes = assetList.map((a) => a.hash || a.sha256 || null);
  }
  const assetHashes = hashes.filter(Boolean).sort();
  const scopedPatches = (spec.patches || []).filter((p) => !p.scope || p.scope === segment.id);
  const payload = JSON.stringify({
    plan: PLAN_VERSION,
    engine: ENGINE_VERSION,
    // R3（RT-04 #4）：Node/ffmpeg 版本进 payload，换工具链后缓存自然全量失效。
    toolchain: opts.root ? toolchainFingerprint() : '',
    id: segment.id,
    kind: segment.kind,
    page: segment.page,
    // v2.3.5：页面及其依赖的内容哈希。没有 root（例如单测只调 hash）时留空。
    pageHash: opts.root ? pageContentHash(opts.root, segment.page) : '',
    startFrame: segment.startFrame,
    frames: segment.frames,
    // 分辨率/帧率直接决定像素（竖屏重排、t=i/fps 采样）。缺了它们，换画幅/帧率
    // 而帧数不变时缓存命中 → 横屏帧被拷进「竖屏」成片，build 还报成功（假绿）。
    fps: meta.fps,
    width: meta.width,
    height: meta.height,
    // FINDING-6（v4.12/G4）：bpm 决定拍网格上的动效相位（generative 打拍、
    // flash 拍对齐）。以前改 bpm 全部段哈希不变 → 90BPM 片子命中 120BPM 旧缓存。
    bpm: Number(meta.bpm || (spec && spec.audio && spec.audio.bpm) || 120),
    // FINDING-9：brandKit logo 的实测字节哈希（同路径换 logo 必须失效）。
    logo: opts.logoHash || '',
    t0: segment.t0 ?? null,
    speed: segment.speed ?? null,
    motion: segment.motion || meta.motion || '',
    // 转场（v2.5）：换转场/时长必须让段缓存失效（它改变成片拼接结果）。
    transition: meta.transition ? JSON.stringify(meta.transition) : '',
    theme: meta.theme || '',
    accent: meta.accent ? JSON.stringify(meta.accent) : '',
    brand: meta.brand || '',
    // S5a 运动模糊进哈希：换档位必须让全部段缓存失效（它改变每个像素的时间采样）。
    blur: meta.blur || '',
    assets: assetHashes,
    patches: scopedPatches,
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * G10/S3-3 seam gate：静态校验相邻段「出场/入场运动向量」一致性。
 *
 * 判据（纯静态、零新依赖；表数据全部来自 motion-profile.mjs + motion.js 既有定义）：
 *   - 段的有效档位 = segment.motion || plan.meta.motion || 'standard'；
 *   - 入场向量 = transitionParams(MOTION_PROFILES[档位].transition, 0) 的初始位移 (x, y)。
 *     现有四档里只有 dynamic/whip 带横向位移（+0.18，即从右侧甩入），
 *     slam/fade/glitch 均无方向分量——所以本闸当前恰好拦「whip 贴着非 whip」
 *     这类方向接缝，calm↔standard↔maximal 相邻不误报（各向同性入场视为一致）。
 *   - 不一致 → W_SEAM_DIRECTION（warn）。默认不拦；plan.mjs --strict 升级为拦截。
 *
 * @param {{segments?:Array<object>, meta?:object}} plan buildPlanFromSpec 产物或其片段
 * @returns {Array<{code:string, path:string, level:string, message:string}>}
 */
export function seamDirectionIssues(plan) {
  const issues = [];
  const segments = (plan && Array.isArray(plan.segments)) ? plan.segments : [];
  const metaMotion = plan && plan.meta && plan.meta.motion;
  const fallback = isMotionLevel(metaMotion) ? metaMotion : 'standard';
  const entry = (seg) => {
    const level = isMotionLevel(seg && seg.motion) ? seg.motion : fallback;
    const p = motionParams(level);
    const t0 = transitionParams(p.transition, 0);
    return { level, transition: p.transition, x: Number(t0.x) || 0, y: Number(t0.y) || 0 };
  };
  for (let i = 0; i + 1 < segments.length; i++) {
    const a = entry(segments[i]);
    const b = entry(segments[i + 1]);
    if (a.x === b.x && a.y === b.y) continue;
    const fmt = (v) => `${v.level}/${v.transition}(${v.x.toFixed(2)},${v.y.toFixed(2)})`;
    issues.push({
      code: 'W_SEAM_DIRECTION',
      path: `${segments[i] && segments[i].id}→${segments[i + 1] && segments[i + 1].id}`,
      level: 'warn',
      message: `seam motion vector mismatch: ${fmt(a)} next to ${fmt(b)} — unify look.motion or the per-segment style.motion (or accept the cut); --strict blocks this seam`,
    });
  }
  return issues;
}

function assertPages(spec, root) {
  const missing = [];
  const pages = [
    ['opening.page', spec.opening.page],
    ...spec.rounds.flatMap((r, i) => [[`rounds[${i}].card.page`, r.card.page], [`rounds[${i}].style.page`, r.style.page]]),
    ['moreCard.page', spec.moreCard.page],
    ['flash.page', spec.flash.page],
    ['ending.page', spec.ending.page],
  ];
  for (const [label, page] of pages) {
    if (!page || isAbsoluteUrl(page)) continue;
    const p = String(page).split('?')[0];
    // R2-34：ERRORS.md 承诺「报错里会回显 root」——--root 指错是新手 #1 错法，
    // 不回显就等于让用户以为仓库缺文件。
    if (!fs.existsSync(path.resolve(root, p))) {
      missing.push({ code: 'E_PAGE_MISSING', path: label, message: `page not found: ${p} (resolved from --root "${root}"; run from the project root or pass --root <dir> containing ${p})`, level: 'error' });
    }
  }
  // 素材存在性：路径约束由 validateSpec 负责，这里补磁盘检查（Node 侧）。
  for (const [i, a] of (spec.assets || []).entries()) {
    const p = a && typeof a.path === 'string' ? a.path.split('?')[0].split('#')[0] : '';
    if (!p || isAbsoluteUrl(p)) continue;
    if (!fs.existsSync(path.resolve(root, p))) {
      missing.push({ code: 'E_ASSET_MISSING', path: `assets[${i}].path`, message: `asset not found: ${p}`, level: 'error' });
    }
  }
  // S0-4（内审 F5）：页面依赖图里的 bare 模块说明符（node_modules/CDN 包名）
  // 不进段哈希——库一升级就缓存命中出旧画面且 build 报成功。零依赖是卖点，
  // 升级为 plan 期硬闸（同文件去重，一次遍历顺带覆盖整条递归链）。
  const scanned = new Set();
  for (const [, page] of pages) {
    if (!page || isAbsoluteUrl(page)) continue;
    const p = String(page).split('?')[0];
    if (scanned.has(p) || !fs.existsSync(path.resolve(root, p))) continue;
    scanned.add(p);
    const bare = [];
    pageContentHash(root, p, new Set(), 0, bare);
    for (const b of bare) {
      missing.push({ code: 'E_PAGE_BARE', path: `page ${p}`, message: `bare module import escapes segmentHash (zero-dep invariant violated): ${b}`, level: 'error' });
    }
  }
  return missing;
}

/**
 * @param {object} input  spec v1 或 timeline v1
 * @param {{root?:string,outDir?:string,checkPages?:boolean}} opts
 */
export function buildPlanFromSpec(input, opts = {}) {
  const spec = normalizeSpec(input);
  const root = path.resolve(opts.root || process.env.CVS_ROOT || process.cwd());
  const issues = validateSpec(spec);
  if (opts.checkPages !== false) issues.push(...assertPages(spec, root));
  // R3（RT-04 #3）：素材字节哈希重算并入校验——声明与实测不符即 E_ASSET_HASH。
  const assetRes = resolveAssetHashes(spec, root);
  issues.push(...assetRes.issues);

  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warn');
  if (errors.length) {
    const e = new Error('invalid spec:\n  - ' + errors.map((x) => `[${x.code}] ${x.path}: ${x.message}`).join('\n  - '));
    e.code = 'SPEC_INVALID';
    e.issues = issues;
    throw e;
  }

  const timeline = specToTimeline(spec, { root, outDir: opts.outDir });
  const plan = buildLegacyPlan(timeline, { root, outDir: opts.outDir });

  plan.version = PLAN_VERSION;
  plan.generatedBy = 'templates/plan.mjs';
  // S0-2：把工具链指纹写进 plan 文档本体——segmentHash payload 里一直有它，
  // 但外不可见；golden/跨机对账与「这台机器与产片机指纹是否一致」现在一眼可读。
  plan.meta.toolchain = toolchainFingerprint();
  plan.spec = {
    version: SPEC_VERSION,
    engine: ENGINE_VERSION,
    authoredBy: spec._authoredBy,
    duration: specDuration(spec),
    look: spec.look,
    format: spec.format,
    audio: spec.audio,
    motion: plan.meta.motion || null,   // v2.3：实际生效的动效档位
    accent: plan.meta.accent || null,   // v2.3.1：实际下发给页面的强调色覆盖
    copy: {
      title: plan.meta.copyTitle || null,
      sub: plan.meta.copySub || null,
      cta: plan.meta.copyCta || null,
    },
    assets: (spec.assets || []).map((a) => {
      const actual = assetRes.hashes.get(String(a.path)) || null;
      return { id: a.id, hash: actual || a.hash || a.sha256 || null, kind: a.kind || null, path: a.path || null };
    }),
    patches: spec.patches || [],
  };
  plan.warnings = warnings.map((w) => ({ code: w.code, path: w.path, message: w.message }));
  // G10/S3-3：seam gate —— 段表成形后才能查相邻段入场向量；结果同时进
  // issues（返回值）与 plan.warnings（交付物），下游 compile/qa 只读不改。
  const seamIssues = seamDirectionIssues(plan);
  for (const s of seamIssues) {
    issues.push(s);
    plan.warnings.push({ code: s.code, path: s.path, message: s.message });
  }
  // S5a 运动模糊：档位 → tmix 权重（进 meta.blur → segmentHash）；渲染参数下发走
  // renderArgs（farm/batch 纯透传），qa/probe/concat 看到的输出帧率帧数与关时同构。
  plan.meta.blur = BLUR_WEIGHTS[spec.render?.motionBlur] || '';

  // FINDING-9：logo 哈希一次性算好，进全部段 payload（同路径换字节 = 全缓存失效）。
  const logoHash = brandLogoHash(spec, root);

  for (const s of plan.segments) {
    // 页面哈希同时写进段对象，便于排查「hash 为什么变了」。
    if (plan.meta.blur) s.renderArgs = [...(s.renderArgs || []), '--motion-blur', plan.meta.blur];
    s.pageHash = pageContentHash(root, s.page);
    s.hash = segmentHash(s, plan.meta, spec, {
      root,
      logoHash,
      assetHashes: (spec.assets || []).map((a) => assetRes.hashes.get(String(a.path)) || a.hash || a.sha256 || null),
    });
  }
  plan.stats.hashed = plan.segments.length;

  return { plan, spec, issues };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// 注意：本模块同时被 compile.mjs 当库 import——CLI 解析必须收在 main() 里，
// 模块顶层解析会在库进程里拿 compile 的 argv 去查 plan 白名单（--dry-run 等
// 一律被拒），这是把 build 全链打红的回归点。
import { parseStrict, rejectUnknown } from '../scripts/lib/strict-flags.mjs';
const PROG_PLAN = 'node templates/plan.mjs';
const PLAN_KNOWN = new Set(['spec', 'out', 'concat', 'root', 'outdir', 'check', 'print', 'json', 'strict', 'help']);

function main() {
  // CLI 解析收在这里（本模块也作为库被 compile.mjs import，顶层解析会误伤）。
  const { args, unknown } = parseStrict(process.argv.slice(2), PLAN_KNOWN);
  if (unknown.length) rejectUnknown(PROG_PLAN, unknown, PLAN_KNOWN);
  // R2-15（N04-F3）：SKILL §0.0 的退出码表只有 0/2/10/11/12/13/14。
  // 此前 spec 错误一律 exit 1——agent 路由表没有这一支，用户写错 spec
  // 会被上报成"编译器坏了"。usage→2、spec 类错误→10、崩溃才是 1。
  if (args.help) {
    console.log(`Usage: node templates/plan.mjs --spec <project.spec.json> [options]
  --out <plan.json>       default <outDir>/plan.json
  --concat <segments.txt> default <outDir>/segments.txt
  --root <dir>            project root (default cwd)
  --outdir <dir>          override outDir
  --check                 validate only
  --strict                W_SEAM_DIRECTION (adjacent-segment motion vectors) blocks
  --print                 print segment table
  --json                  print plan JSON (only JSON on stdout; progress → stderr)`);
    process.exit(0);
  }
  if (!args.spec) {
    console.error('usage: node templates/plan.mjs --spec <project.spec.json> [options]  (see --help)');
    process.exit(2);
  }

  const specPath = path.resolve(String(args.spec));
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  } catch (e) {
    console.error(`[error] [E_READ] cannot read/parse spec ${specPath}: ${e.message}`);
    process.exit(10);
  }
  const root = path.resolve(String(args.root || process.cwd()));

  if (args.check) {
    const spec = normalizeSpec(raw);
    const issues = [...validateSpec(spec), ...assertPages(spec, root)];
    // G10/S3-3：seam gate 只在 spec 无硬错时跑（有错则 timeline 构造可能抛，跳过即可）。
    if (!issues.some((i) => i.level === 'error')) {
      try {
        const tl = specToTimeline(spec, { root });
        issues.push(...seamDirectionIssues(buildLegacyPlan(tl, { root })));
      } catch { /* timeline 构造异常不是 seam 的锅，交给正常 build 路径报 */ }
    }
    for (const i of issues) console.error(`[${i.level}] [${i.code}] ${i.path}: ${i.message}`);
    // --strict：W_SEAM_DIRECTION 升级为拦截（与 compile/lint 的 strict 语义一致）。
    const blocking = issues.filter((i) => i.level === 'error' || (args.strict && i.code === 'W_SEAM_DIRECTION'));
    if (blocking.length) {
      if (args.strict && !issues.some((i) => i.level === 'error') && issues.some((i) => i.code === 'W_SEAM_DIRECTION')) {
        console.error('[strict] W_SEAM_DIRECTION 视为失败：统一 look.motion 或去掉 --strict 接受该接缝');
      }
      process.exit(10);
    }
    console.log(`✓ spec valid: ${spec.rounds.length} rounds, ${specDuration(spec)}s @ ${spec.format.fps}fps, ${spec.look.theme}`);
    return;
  }

  let built;
  try {
    built = buildPlanFromSpec(raw, { root, outDir: args.outdir ? String(args.outdir) : undefined });
  } catch (e) {
    console.error(String(e.message || e));
    // R2-15：spec 校验失败（buildPlanFromSpec 抛 SPEC_INVALID，或 E_* 码）→ 10；
    // 真正的意外崩溃才用 1。旧版一律 1，agent 路由表无法区分「用户 spec 错」与「编译器坏」。
    const code = e && e.code ? String(e.code) : '';
    process.exit(code === 'SPEC_INVALID' || code.startsWith('E_') ? 10 : 1);
  }
  const { plan, spec } = built;
  for (const w of plan.warnings) console.error(`[warn] [${w.code}] ${w.path}: ${w.message}`);
  // --strict：seam 不一致拦在写盘之前（plan.json 不落半成品账）。
  if (args.strict && plan.warnings.some((w) => w.code === 'W_SEAM_DIRECTION')) {
    console.error('[strict] W_SEAM_DIRECTION 视为失败：统一 look.motion 或去掉 --strict 接受这些接缝');
    process.exit(10);
  }

  const outDir = plan.meta.outDir;
  const planPath = path.resolve(String(args.out || path.join(root, outDir, 'plan.json')));
  const concatPath = path.resolve(String(args.concat || path.join(root, outDir, 'segments.txt')));
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.mkdirSync(path.dirname(concatPath), { recursive: true });
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  fs.writeFileSync(concatPath, concatList(plan));

  // R2-14（N04-F2）：--json 时 stdout 只有一行 JSON，进度行退到 stderr——
  // 此前 JSON 后面还挂着 4 行 [spec]/[plan]/…，parse 必炸。
  if (args.json) process.stdout.write(JSON.stringify(plan) + '\n');
  if (args.print && !args.json) console.log(formatPlan(plan));
  const say = args.json ? (...a) => console.error(...a) : (...a) => console.log(...a);
  say(`[spec]   ${specPath}`);
  say(`[plan]   ${planPath}`);
  say(`[concat] ${concatPath}`);
  say(`[stats]  ${plan.stats.duration.toFixed(3)}s / ${plan.stats.frames} frames / ${plan.stats.segments} segments / every segment hashed`);
}

const invokedDirectly = process.argv[1] && path.basename(process.argv[1]) === 'plan.mjs';
if (invokedDirectly) {
  try { main(); } catch (e) { console.error('[fatal]', e.stack || e); process.exit(1); }
}
