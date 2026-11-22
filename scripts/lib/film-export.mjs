/**
 * lib/film-export.mjs — spec → OpenFilm IR（film.html）导出 + overrides 非破坏编辑。
 *
 * 对标 openfilm/openfilm 的 SPEC（0.1 draft）：一条片是一个 web 时间线，
 * 每个镜头是一页网页、以 frame(t) 画任意时刻——与我们的 segment.html 逐帧
 * 确定性渲染同源。导出器把 CVS spec 的段表展开成 OpenFilm 的 sections/tracks：
 *   <section> = 轨道（我们的 kind：opening/card/style/flash/more/ending）
 *   <iframe src=pages/xxx.html#t=in,out at=…> = 帧（页面即我们的配方页，
 *       #t 与 withSegmentParams 同口径：t = t0 + u·speed）
 *
 * R24-W：overrides 非破坏编辑（与 OpenFilm 同语义）——剪辑界面的手改
 * （文本/颜色/位置/尺寸）写进 clip 的 overrides 属性，不落回页面源码；
 * agent 重写页面后 overrides 仍然生效。附 locked/hidden 轨道标志。
 *
 * 超越点：CVS 侧把 overrides 汇总回 spec patch（style.copy / card.first 等），
 * 可再进编译链重出片——OpenFilm 只有前端编辑，没有「改意图 → 重编译」的闭环。
 */
import path from 'node:path';
import fs from 'node:fs';

/** 轨道语义（与 OpenFilm SPEC 对齐）：person=人的轨道，agent 不许动。 */
export const TRACK_FLAGS = { PERSON: 'person', AGENT: 'agent' };

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  // v4.9.3（证伪 F4）：overrides 写进**单引号** HTML 属性，撇号不转义会让
  // 含 don't 类文案截断属性甚至注入。
  .replace(/'/g, '&#39;');

/** 每段的 OpenFilm 时间区间：at=起点秒；#t=in,out 由 t0/speed/duration 推。 */
function clipRange(seg, fps = 30) {
  const startSec = seg.startFrame != null ? seg.startFrame / fps : 0;
  const durSec = seg.duration != null ? seg.duration : (seg.frames || 30) / fps;
  return { at: startSec, durSec };
}

/** 把 spec 展开成与编译链同构的段表（opening → round×N(卡+风格) → more → flash×n → ending）。 */
function specToSegments(spec) {
  const st = spec.structure || {};
  const fps = Number(spec.format?.fps) || 30;
  const segs = [];
  let t = 0;
  const push = (id, kind, page, { duration = 0, t0 = 0, speed = 1 } = {}) => {
    if (!duration) return null;
    const s = { id, kind, startFrame: Math.round(t * fps), frames: Math.round(duration * fps),
                duration, t0, speed, page };
    t += duration;
    segs.push(s);
    return s;
  };
  if (spec.opening?.page) push('00-opening', 'opening', spec.opening.page, { duration: st.opening });
  for (const r of spec.rounds || []) {
    const rd = Number(st.round || 0);
    if (!rd) continue;
    push(`${r.id}-card`, 'card', r.card?.page || 'templates/big-card.html', { duration: st.card });
    push(`${r.id}-style`, 'style', r.style?.page, { duration: Number((rd - Number(st.card || 0)).toFixed(3)), t0: r.style?.t0 ?? 0, speed: r.style?.speed ?? 1 });
  }
  if (spec.moreCard?.page) push('99-more', 'more', spec.moreCard.page, { duration: st.moreCard });
  const fc = st.flash?.count || 0;
  for (let i = 1; i <= fc; i++) {
    push(`99-flash-${i}`, 'flash', spec.flash?.page || 'templates/segment.html',
      { duration: st.flash?.each ?? 0.25 });
  }
  if (spec.ending?.page) push('99-ending', 'ending', spec.ending.page, { duration: st.ending });
  return segs;
}

/** 构造 film.html 主体（不写盘——测试与 CLI 共用）。 */
export function buildFilmHtml(spec, { overridesByClip = null } = {}) {
  const fmt = spec.format || {};
  const w = fmt.width || 1920;
  const h = fmt.height || 1080;
  const fps = fmt.fps || 30;
  const sections = [];
  for (const s of specToSegments(spec)) {
    const page = String(s.page || '');
    if (!page) continue;
    const { at, durSec } = clipRange(s);
    const inSec = s.t0 || 0;
    const outSec = durSec > 0 ? Math.max(inSec + 0.01, inSec + durSec) : inSec + 0.5;
    const src = `#t=${inSec.toFixed(3)},${outSec.toFixed(3)}`;
    const id = esc(s.id);
    const ov = overridesByClip && overridesByClip.get(s.id)
      ? ` overrides='${esc(JSON.stringify(overridesByClip.get(s.id)))}'` : '';
    // 轨道语义：opening/ending/card 为人的轨道（可锁），风格轮为 agent 主战场
    const personTrack = ['opening', 'card', 'ending'].includes(s.kind);
    const flags = [];
    if (personTrack) { flags.push('locked'); }
    else { flags.push('hidden'); }  // 风格轨默认隐藏：预览只显人控点
    const cls = `track cvs-${esc(s.kind)} ${flags.join(' ')}`;
    sections.push(`<section class="${cls}"><iframe id="${id}" src="pages/${id}.html?${page.split('?')[1] || ''}${src}" at="${at.toFixed(3)}" style="left:0; top:0; width:${w}; height:${h}"${ov}></iframe></section>`);
    void fps;
  }
  const body = sections.join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${w}, height=${h}">
<title>${esc(spec.meta?.title || spec.meta?.name || 'film')}</title>
<style>
  .track iframe { border: 0; display: block; object-fit: contain; }
  .track.locked { outline: 2px dashed rgba(217,119,87,.55); }   /* 人的轨道 */
  .track.hidden { outline: 1px dotted rgba(128,128,128,.4); }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/**
 * 把 overrides 汇总回 spec patch（R24-W 超越点）：前端手改 → 编译链闭环。
 * overrides 项与 OpenFilm 同形：{ at, style, text, t }；此处取 style/text 增量
 * 写入 style.copy（title/subtitle）与 card（first/keyword）。
 */
export function overridesToSpecPatch(spec, overridesByClip) {
  if (!overridesByClip || !overridesByClip.size) return { stylePatch: [], cardPatch: [] };
  const stylePatch = [];
  const cardPatch = [];
  for (const [clipId, ov] of overridesByClip) {
    if (!ov || typeof ov !== 'object') continue;
    const s = ov.style || {};
    if (s.color != null) stylePatch.push({ at: clipId, field: 'accentOverride', value: s.color });
    if (ov.text != null) stylePatch.push({ at: clipId, field: 'copy.title', value: ov.text });
    if (Array.isArray(ov.t)) cardPatch.push({ at: clipId, field: 'transform', dx: ov.t[0] ?? 0, dy: ov.t[1] ?? 0 });
  }
  return { stylePatch, cardPatch };
}

/** CLI：把 spec 展成 OpenFilm IR 目录（film.html + 每段页面壳）。
 *  S0-3：overridesByClip 真正下传 buildFilmHtml（此前 film.mjs 解析了却不传，
 *  导出的 film.html 里没有 overrides 属性）。 */
export function writeFilmProject(spec, { outDir, overridesByClip = null }) {
  fs.mkdirSync(outDir, { recursive: true });
  const dir = path.dirname(outDir);
  const pagesDir = path.join(outDir, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });
  let wrotePages = 0;
  for (const s of specToSegments(spec)) {
    if (!s.page) continue;
    const stem = String(s.id).replace(/[^A-Za-z0-9_-]/g, '_');
    // 页面壳：iframe 场景页（同 URL 参数：seg/t0/speed/dur）——浏览器直开即可 scrub。
    const { at, durSec } = clipRange(s);
    const inSec = s.t0 || 0;
    const outSec = Math.max(inSec + 0.01, inSec + (durSec || 1));
    const qs = `${String(s.page).split('?')[1] || ''}`;
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=${(spec.format?.width || 1920)}, height=${(spec.format?.height || 1080)}"></head>
<body style="margin:0;background:#101014;">
<iframe id="frame" src="${String(s.page)}${String(s.page).includes('?') ? '&' : '?'}seg=1&t0=${inSec}&speed=${s.speed || 1}&dur=${durSec.toFixed(3)}" style="position:fixed; inset:0; width:100%; height:100%; border:0;"></iframe>
<script>window.__clip = { id: ${JSON.stringify(String(s.id))}, at: ${at.toFixed(3)}, out: ${outSec.toFixed(3)} };</script>
</body></html>`;
    fs.writeFileSync(path.join(pagesDir, `${stem}.html`), html);
    wrotePages++;
  }
  const film = buildFilmHtml(spec, { overridesByClip });
  fs.writeFileSync(path.join(outDir, 'film.html'), film);
  return { filmPath: path.join(outDir, 'film.html'), pages: wrotePages };
}