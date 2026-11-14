/**
 * app.js — 帧工作台宿主。
 *
 * 两条预览通道，帧号是唯一时间轴：
 *   live   spec 源：模板页放在同源 iframe 里，宿主直接调 renderFrame(段内帧号/fps)。
 *          不读回像素，renderFrame 实测 ~1ms → 真正实时的逐帧拖动/播放。
 *          页面 URL 的 seg/t0/speed/dur 与 templates/render-segment.mjs 完全一致；
 *          iframe 池（最多 3 个）+ 相邻段预加载，切段时直接激活已就绪的页面。
 *   img    video / images 源：服务端按帧号吐图片，浏览器缓存 + 预取。
 *          视频是 ffmpeg 逐帧解码的 JPEG（-fps_mode passthrough），图片序列直接读盘。
 *
 * 帧 n 的时刻恒为 n/fps；导出 PNG 在 live 模式下直接取 iframe canvas 原始像素。
 */
const $ = (id) => document.getElementById(id);

const el = {
  form: $('sourceForm'),
  kind: $('kind'),
  path: $('path'),
  paths: $('paths'),
  fps: $('fps'),
  openBtn: $('openBtn'),
  status: $('status'),
  stageWrap: $('stageWrap'),
  img: $('frameImg'),
  stageMsg: $('stageMsg'),
  hudFrame: $('hudFrame'),
  hudTc: $('hudTc'),
  hudSeg: $('hudSeg'),
  hudMs: $('hudMs'),
  rangebar: $('rangebar'),
  first: $('first'),
  prev10: $('prev10'),
  prev: $('prev'),
  play: $('play'),
  next: $('next'),
  next10: $('next10'),
  last: $('last'),
  loop: $('loop'),
  rate: $('rate'),
  download: $('download'),
  slider: $('slider'),
  frameNum: $('frameNum'),
  total: $('total'),
  time: $('time'),
  perf: $('perf'),
  ruler: $('ruler'),
  strip: $('strip'),
  stride: $('stride'),
  restrip: $('restrip'),
  sourceInfo: $('sourceInfo'),
  recent: $('recent'),
};

const state = {
  id: null,
  meta: null,
  mode: 'img',          // img | live
  n: 0,
  shown: false,
  playing: false,
  rate: 1,
  loop: true,
  seq: 0,               // img 通道的显示序号（防旧请求覆盖新帧）
  urls: new Map(),
  hdr: new Map(),
  pending: new Map(),
  order: [],
  stripRange: null,
  stripToken: 0,
  stripTimer: 0,
  poll: 0,
  stats: { delivered: [], failures: [] },
  range: { in: null, out: null, on: false },
  live: { url: null, pendingUrl: null, ready: false, token: 0, ms: 0, renders: 0, active: null, segId: null, prefetchQueue: [], prefetching: false },
  raf: 0,
  playT0: 0,
  playF0: 0,
};

const CACHE_LIMIT = 260;
const LIVE_POOL_MAX = 6;
const LIVE_PREFETCH_AHEAD = 3;

// ── 小工具 ─────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function fmtInt(v) { return Number(v || 0).toLocaleString('en-US'); }

function timecodeOf(n, fps) {
  const f = Number(fps) || 30;
  const frame = Math.max(0, Math.round(Number(n) || 0));
  const secTotal = Math.floor(frame / f);
  const ff = clamp(Math.round(frame - secTotal * f), 0, Math.max(1, Math.round(f)) - 1);
  const p = (v) => String(v).padStart(2, '0');
  return `${p(Math.floor(secTotal / 3600))}:${p(Math.floor((secTotal % 3600) / 60))}:${p(secTotal % 60)}:${p(ff)}`;
}

function fmtDuration(sec) {
  const s = Number(sec) || 0;
  return s >= 60 ? `${Math.floor(s / 60)}m ${(s % 60).toFixed(1)}s` : `${s.toFixed(3)}s`;
}

function setStatus(text, kind = '') {
  el.status.textContent = text;
  el.status.className = 'status' + (kind ? ' ' + kind : '');
}

function setStageMsg(text, isErr = false, autoHide = 0) {
  el.stageMsg.textContent = text || '';
  el.stageMsg.className = 'stage-msg' + (text ? ' show' : '') + (isErr ? ' err' : '');
  clearTimeout(setStageMsg._t);
  if (autoHide) setStageMsg._t = setTimeout(() => setStageMsg(''), autoHide);
}

function setControlsEnabled(on) {
  for (const b of [el.first, el.prev10, el.prev, el.play, el.next, el.next10, el.last, el.download]) b.disabled = !on;
  el.slider.disabled = !on;
  el.frameNum.disabled = !on;
  el.rate.disabled = !on;
  el.loop.disabled = !on;
}

async function api(pathname, { timeoutMs = 8000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  let res;
  try {
    res = await fetch(pathname, { headers: { Accept: 'application/json' }, signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e && /timeout/i.test(String(e.message || e))) throw new Error('请求超时（8s）：服务可能已退出。用 cvs ui 或 node app/frames/serve.mjs 重新启动后刷新本页。');
    throw new Error('无法连接帧 API（服务没在跑？）。用 cvs ui 或 node app/frames/serve.mjs 启动后刷新本页。');
  }
  clearTimeout(timer);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

// ── img 通道缓存 / 预取 ─────────────────────────────────────────────────────

function revokeAll() {
  for (const url of state.urls.values()) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }
  state.urls.clear();
  state.hdr.clear();
  state.pending.clear();
  state.order = [];
}

function touchUrl(n) {
  const i = state.order.indexOf(n);
  if (i >= 0) { state.order.splice(i, 1); state.order.push(n); }
}

function trimCache() {
  while (state.order.length > CACHE_LIMIT) {
    const victim = state.order.find((n) => n !== state.n);
    if (victim === undefined) break;
    state.order.splice(state.order.indexOf(victim), 1);
    const url = state.urls.get(victim);
    if (url) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }
    state.urls.delete(victim);
    state.hdr.delete(victim);
  }
}

function ensure(n) {
  const m = state.meta;
  if (!m || n < 0 || n >= m.frames) return Promise.resolve(null);
  if (state.urls.has(n)) { touchUrl(n); return Promise.resolve(state.urls.get(n)); }
  if (state.pending.has(n)) return state.pending.get(n);

  const t0 = performance.now();
  const p = fetch(`/frames/api/frame?id=${encodeURIComponent(state.id)}&n=${n}`)
    .then(async (res) => {
      if (!res.ok) {
        const text = await res.text();
        let msg = `HTTP ${res.status}`;
        try { msg = JSON.parse(text).error || msg; } catch { /* keep */ }
        throw new Error(msg);
      }
      const header = {
        tc: res.headers.get('X-Frame-Timecode') || '',
        ms: Number(res.headers.get('X-Render-Ms')) || null,
      };
      const blob = await res.blob();
      return { blob, header, wall: performance.now() - t0 };
    })
    .then(({ blob, header, wall }) => {
      const url = URL.createObjectURL(blob);
      state.urls.set(n, url);
      state.hdr.set(n, { ...header, wall });
      state.order.push(n);
      trimCache();
      return url;
    })
    .catch((e) => { state.stats.failures.push(n); throw e; })
    .finally(() => { state.pending.delete(n); });

  state.pending.set(n, p);
  return p;
}

function activeRange() {
  const m = state.meta;
  if (!m) return [0, 0];
  const hiMax = m.frames - 1;
  const r = state.range;
  if (r.on && r.in !== null && r.out !== null) {
    return [clamp(Math.min(r.in, r.out), 0, hiMax), clamp(Math.max(r.in, r.out), 0, hiMax)];
  }
  return [0, hiMax];
}

function prefetchAround(n) {
  const [, hi] = activeRange();
  for (let k = 1; k <= 8; k++) {
    if (state.pending.size >= 4) break;
    const target = n + k;
    if (target > hi) break;
    ensure(target).catch(() => {});
  }
  for (let k = 1; k <= 2; k++) {
    if (state.pending.size >= 4) break;
    const target = n - k;
    if (target < 0) break;
    ensure(target).catch(() => {});
  }
}

// ── 段定位 / HUD ───────────────────────────────────────────────────────────

function segmentAt(n) {
  const segs = (state.meta && state.meta.segments) || [];
  return segs.find((s) => n >= s.startFrame && n < s.endFrame) || null;
}

function updateHud() {
  const m = state.meta;
  if (!m) return;
  const n = state.n;
  el.hudFrame.textContent = `#${n} / ${fmtInt(m.frames - 1)}`;
  const tc = timecodeOf(n, m.fps);
  el.hudTc.textContent = tc;
  el.time.textContent = (n / m.fps).toFixed(3);
  el.slider.value = String(n);
  if (document.activeElement !== el.frameNum) el.frameNum.value = String(n);
  const seg = segmentAt(n);
  el.hudSeg.textContent = seg ? `${seg.id} · ${seg.startFrame}–${seg.endFrame - 1}` : '';
  if (state.mode === 'live') {
    el.hudMs.textContent = state.live.ready ? `${state.live.ms.toFixed(2)} ms 渲染` : '载入段…';
  } else {
    const h = state.hdr.get(n);
    el.hudMs.textContent = h ? `${h.ms !== null ? h.ms + ' ms' : ''}${h.wall ? ' · ' + Math.round(h.wall) + ' ms 到达' : ''}` : '';
  }
  markStrip();
}

// ── live 通道（spec）：iframe 池 ───────────────────────────────────────────

/** url → { el, url, ready, error, used } */
const livePool = new Map();

function liveUrl(seg) {
  const m = state.meta;
  const u = new URL(seg.page, location.origin);
  // 与 templates/render-segment.mjs 的 withSegmentParams 完全一致
  u.searchParams.set('seg', '1');
  u.searchParams.set('t0', String(seg.t0 ?? 0));
  u.searchParams.set('speed', String(seg.speed ?? 1));
  u.searchParams.set('dur', String(seg.duration ?? (seg.frames / m.fps)));
  return u.toString();
}

function sizeLiveFrame(frame) {
  const m = state.meta;
  if (!m) return;
  frame.style.width = `${m.width}px`;
  frame.style.height = `${m.height}px`;
}

function fitLiveFrames() {
  const m = state.meta;
  if (!m || state.mode !== 'live') return;
  const w = el.stageWrap.clientWidth;
  const h = el.stageWrap.clientHeight;
  if (!w || !h) return;
  const s = Math.min(w / m.width, h / m.height);
  for (const entry of livePool.values()) {
    sizeLiveFrame(entry.el);
    entry.el.style.transform = `scale(${s})`;
    entry.el.style.left = `${Math.max(0, (w - m.width * s) / 2)}px`;
    entry.el.style.top = `${Math.max(0, (h - m.height * s) / 2)}px`;
  }
}

function createLiveFrame(url) {
  const frame = document.createElement('iframe');
  frame.className = 'live-frame off';
  frame.title = '实时帧渲染';
  sizeLiveFrame(frame);
  el.stageWrap.append(frame);
  // 先定尺寸再导航：页面在 load 时读 window.innerWidth/innerHeight 决定画布，
  // 顺序反了会拿到 iframe 的默认 300×150（或 display:none 时的 0）。
  frame.src = url;
  const entry = { el: frame, url, ready: false, error: null, used: Date.now() };
  livePool.set(url, entry);
  const started = Date.now();
  const check = () => {
    if (!livePool.has(url)) return;              // 已被回收
    let ready = false;
    let bootErr = null;
    try {
      ready = frame.contentWindow.__ready === true;
      bootErr = frame.contentWindow.__bootError || null;
    } catch { /* 还在导航 */ }
    if (bootErr) { entry.error = String(bootErr).slice(0, 240); return; }
    if (ready) { entry.ready = true; return; }
    if (Date.now() - started > 25000) { entry.error = '等待 __ready 超时（25s）'; return; }
    setTimeout(check, 40);
  };
  setTimeout(check, 40);
  evictLive();
  return entry;
}

function evictLive() {
  if (livePool.size <= LIVE_POOL_MAX) return;
  const entries = [...livePool.entries()].sort((a, b) => a[1].used - b[1].used);
  for (const [url, entry] of entries) {
    if (livePool.size <= LIVE_POOL_MAX) break;
    if (entry === state.live.active) continue;
    livePool.delete(url);
    try { entry.el.remove(); } catch { /* ignore */ }
  }
}

async function ensureLive(url) {
  let entry = livePool.get(url);
  if (!entry) entry = createLiveFrame(url);
  entry.used = Date.now();
  if (entry.ready) return entry;
  const started = Date.now();
  while (!entry.ready && !entry.error) {
    if (Date.now() - started > 26000) throw new Error('iframe 载入超时');
    await new Promise((r) => setTimeout(r, 40));
  }
  if (entry.error) throw new Error(entry.error);
  return entry;
}

function activateLive(entry) {
  for (const e of livePool.values()) e.el.classList.toggle('off', e !== entry);
  state.live.active = entry;
  entry.used = Date.now();
  entry.el.classList.remove('off');
  fitLiveFrames();
}

function renderLive(idx) {
  const m = state.meta;
  const seg = segmentAt(idx);
  const entry = state.live.active;
  if (!m || !seg || !entry) return;
  const local = idx - seg.startFrame;
  const t = local / m.fps;
  const a = performance.now();
  try {
    entry.el.contentWindow.renderFrame(t);
  } catch (e) {
    setStageMsg('renderFrame 失败：' + (e && e.message || e), true, 5000);
    return;
  }
  state.live.ms = performance.now() - a;
  state.live.renders++;
  state.stats.delivered.push(performance.now());
  if (el.stageMsg.classList.contains('show') && !el.stageMsg.classList.contains('err')) setStageMsg('');
}

function prefetchNextSegment(seg) {
  const segs = state.meta.segments || [];
  const i = segs.findIndex((s) => s.id === seg.id);
  if (i < 0) return;
  // 顺序播放时下一段常常只有 0.4–1s 提前量。并发预载 3 个 1920×1080 页面会
  // 互相拖慢（实测切点反而卡住），改为**排队串行**：最近的先载，载完再下一个。
  for (let k = 1; k <= LIVE_PREFETCH_AHEAD; k++) {
    const next = segs[i + k];
    if (!next) break;
    const url = liveUrl(next);
    if (livePool.has(url) || state.live.prefetchQueue.includes(url)) continue;
    state.live.prefetchQueue.push(url);
  }
  pumpPrefetch();
}

async function pumpPrefetch() {
  if (state.live.prefetching) return;
  state.live.prefetching = true;
  try {
    while (state.live.prefetchQueue.length) {
      const url = state.live.prefetchQueue.shift();
      if (livePool.has(url)) continue;
      if (livePool.size >= LIVE_POOL_MAX) break;
      await ensureLive(url).catch(() => {});
    }
  } finally {
    state.live.prefetching = false;
  }
}

function showLive(idx) {
  const m = state.meta;
  const seg = segmentAt(idx);
  if (!m || !seg) { setStageMsg(`第 ${idx} 帧不在任何段内`, true); return; }
  const url = liveUrl(seg);

  const cached = livePool.get(url);
  if (cached && cached.ready) {
    state.live.segId = seg.id;
    state.live.ready = true;
    state.live.pendingUrl = null;
    if (state.live.active !== cached) activateLive(cached);
    renderLive(idx);
    prefetchNextSegment(seg);
    return;
  }

  state.live.segId = seg.id;
  state.live.ready = false;
  if (state.live.pendingUrl === url) return;      // 同一段的载入已在进行
  state.live.pendingUrl = url;
  const token = ++state.live.token;
  setStageMsg(`载入段 ${seg.id}…`);
  ensureLive(url)
    .then((entry) => {
      if (token !== state.live.token) return;
      state.live.pendingUrl = null;
      activateLive(entry);
      state.live.ready = true;
      setStageMsg('');
      const cur = segmentAt(state.n);
      if (!cur || liveUrl(cur) !== url) { showLive(state.n); return; }
      renderLive(state.n);
      prefetchNextSegment(seg);
    })
    .catch((e) => {
      if (token !== state.live.token) return;
      state.live.pendingUrl = null;
      // __bootError 存的是 stack：只取首行给用户，完整堆栈留在控制台。
      const first = String(e.message || e).split('\n')[0].slice(0, 160);
      setStageMsg(`段页面启动失败：${first}\n\n刷新页面重试；持续失败时打开浏览器控制台看完整堆栈。`, true);
      setStatus(`段加载失败：${first}`, 'err');
    });
}

// ── 显示一帧（统一入口） ───────────────────────────────────────────────────

function show(n, { force = false } = {}) {
  const m = state.meta;
  if (!m) return;
  const idx = clamp(Math.round(Number(n) || 0), 0, m.frames - 1);
  if (!force && idx === state.n && state.shown) return;
  state.n = idx;
  state.shown = true;
  updateHud();

  if (state.mode === 'live') {
    showLive(idx);
  } else {
    const seq = ++state.seq;
    ensure(idx)
      .then((url) => {
        if (!url || seq !== state.seq) return;
        el.img.src = url;
        if (!el.stageMsg.classList.contains('err')) setStageMsg('');
      })
      .catch((e) => {
        if (seq !== state.seq) return;
        setStageMsg(`帧 ${idx} 加载失败：${e.message}`, true, 4000);
      });
    prefetchAround(idx);
  }

  el.prev.disabled = idx <= 0;
  el.first.disabled = idx <= 0;
  el.next.disabled = idx >= m.frames - 1;
  el.last.disabled = idx >= m.frames - 1;
  scheduleStrip();
}

// ── 播放 ────────────────────────────────────────────────────────────────────

function stopPlay() {
  state.playing = false;
  cancelAnimationFrame(state.raf);
  el.play.textContent = '播放';
  el.play.classList.remove('playing');
  scheduleStrip(true);
}

function startPlay() {
  const m = state.meta;
  if (!m) return;
  const [lo, hi] = activeRange();
  if (state.n >= hi) show(lo, { force: true });
  const seg = segmentAt(state.n);
  if (seg && state.mode === 'live') prefetchNextSegment(seg);
  state.playing = true;
  el.play.textContent = '暂停';
  el.play.classList.add('playing');
  state.playT0 = performance.now();
  state.playF0 = state.n;
  state.raf = requestAnimationFrame(tick);
}

function tick(now) {
  if (!state.playing) return;
  const m = state.meta;
  if (!m) { stopPlay(); return; }
  // live 段还没就绪：冻结播放时钟。否则 HUD 会跑到画面之前，切点后直接跳过内容。
  if (state.mode === 'live' && (!state.live.ready || state.live.pendingUrl)) {
    state.playT0 = now;
    state.playF0 = state.n;
    state.raf = requestAnimationFrame(tick);
    return;
  }
  const [lo, hi] = activeRange();
  const span = hi - lo + 1;
  const elapsed = (now - state.playT0) / 1000;
  let target = state.playF0 + Math.floor(elapsed * m.fps * state.rate);
  if (span > 0 && target > hi) {
    if (state.loop) target = lo + ((target - lo) % span);
    else { show(hi, { force: true }); stopPlay(); return; }
  }
  if (target !== state.n) show(target);
  state.raf = requestAnimationFrame(tick);
}

// ── 胶片条 / 段落条 ─────────────────────────────────────────────────────────

function stripStride() {
  const m = state.meta;
  if (!m) return 1;
  return Math.max(1, Math.round(m.frames / 100));
}

function buildStrip(center) {
  const m = state.meta;
  if (!m) return;
  const token = ++state.stripToken;
  const stride = stripStride();
  const count = 13;
  const span = stride * (count - 1);
  const start = clamp(Math.round((center ?? state.n) - span / 2), 0, Math.max(0, m.frames - 1));
  const end = Math.min(m.frames - 1, start + span);
  state.stripRange = [start, end, stride];

  el.strip.textContent = '';
  el.stride.textContent = String(stride);
  const upper = m.done ? m.frames : Math.max(1, Math.min(m.frames, m.ready || 1));

  const frag = document.createDocumentFragment();
  for (let n = start, i = 0; n <= end && i < count; n += stride, i++) {
    if (n >= upper) break;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'thumb';
    btn.dataset.n = String(n);
    btn.title = `第 ${n} 帧 · ${timecodeOf(n, m.fps)}`;
    if (state.mode === 'live') {
      // spec 源不向服务端要缩略图：那会在服务端再起一个 Chrome，和当前 iframe
      // 抢 CPU（实测切段从 3s 掉到 15s+）。这里用帧号卡，点击同样跳转。
      btn.classList.add('text-thumb');
      const no = document.createElement('b');
      no.textContent = `#${n}`;
      const tc = document.createElement('span');
      tc.className = 'tc';
      tc.textContent = timecodeOf(n, m.fps);
      btn.append(no, tc);
    } else {
      const im = document.createElement('img');
      im.loading = 'lazy';
      im.alt = `帧 ${n}`;
      im.src = `/frames/api/frame?id=${encodeURIComponent(state.id)}&n=${n}&q=55`;
      const cap = document.createElement('span');
      cap.textContent = `#${n}`;
      btn.append(im, cap);
    }
    btn.addEventListener('click', () => {
      stopPlay();
      show(n);
      const seg = segmentAt(n);
      setStatus(`跳到第 ${n} 帧 · ${timecodeOf(n, m.fps)}${seg ? ' · ' + seg.id : ''}`, 'ok');
    });
    frag.append(btn);
  }
  if (token !== state.stripToken) return;
  el.strip.append(frag);
  markStrip(true);
}

function markStrip(scroll = false) {
  const n = state.n;
  let active = null;
  for (const btn of el.strip.querySelectorAll('.thumb')) {
    const v = Number(btn.dataset.n);
    const on = v === n;
    btn.classList.toggle('active', on);
    if (on) active = btn;
  }
  if (active && scroll) {
    try { active.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* ignore */ }
  }
}

function scheduleStrip(force = false) {
  clearTimeout(state.stripTimer);
  state.stripTimer = setTimeout(() => {
    if (state.playing && !force) return;
    const m = state.meta;
    if (!m) return;
    const r = state.stripRange;
    const stride = stripStride();
    const inside = r && r[2] === stride && state.n >= r[0] && state.n <= r[1];
    if (force || !inside) buildStrip(state.n);
    else markStrip(true);
  }, 120);
}

function buildRuler() {
  const m = state.meta;
  el.ruler.textContent = '';
  if (!m || !m.segments || !m.segments.length) { el.ruler.hidden = true; return; }
  el.ruler.hidden = false;
  for (const seg of m.segments) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'band';
    b.dataset.kind = seg.kind || '';
    const pct = (v) => `${(v / m.frames) * 100}%`;
    b.style.left = pct(seg.startFrame);
    b.style.width = pct(seg.endFrame - seg.startFrame);
    b.title = `${seg.id} · ${seg.kind} · 帧 ${seg.startFrame}–${seg.endFrame - 1}（${seg.frames} 帧）`;
    b.setAttribute('aria-label', `跳到段 ${seg.id}（帧 ${seg.startFrame}）`);
    b.textContent = (seg.endFrame - seg.startFrame) / m.frames > 0.06 ? seg.id : '';
    b.addEventListener('click', () => { stopPlay(); show(seg.startFrame); });
    el.ruler.append(b);
  }
}

// ── 源信息 / 最近产物 ───────────────────────────────────────────────────────

function kvRows(rows) {
  el.sourceInfo.textContent = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v === null || v === undefined || v === '' ? '—' : String(v);
    el.sourceInfo.append(dt, dd);
  }
}

function renderSourceInfo() {
  const m = state.meta;
  if (!m) { kvRows([['状态', '未打开']]); return; }
  const rows = [
    ['类型', m.kind],
    ['预览方式', state.mode === 'live' ? '实时渲染（iframe）' : '逐帧图片'],
    ['帧数', `${fmtInt(m.frames)} 帧`],
    ['帧率', `${Number(m.fps).toFixed(3)} fps`],
    ['尺寸', `${m.width}×${m.height}${m.sourceWidth && m.sourceWidth !== m.width ? `（源 ${m.sourceWidth}×${m.sourceHeight}）` : ''}`],
    ['时长', fmtDuration(m.duration)],
    ['末帧', timecodeOf(m.frames - 1, m.fps)],
    ['来源', m.file || m.plan || m.spec || m.dir || '—'],
  ];
  if (m.name) rows.push(['片名', m.name]);
  if (m.theme) rows.push(['主题', m.theme]);
  if (m.kind === 'video') rows.push(['解码', `${m.decoded} / ${m.frames}${m.done ? '（完成）' : '（进行中）'}`]);
  if (m.kind === 'spec') {
    rows.push(['段数', (m.segments || []).length]);
    rows.push(['本次已渲染', `${fmtInt(state.live.renders)} 帧`]);
    rows.push(['当前帧耗时', state.live.ready ? `${state.live.ms.toFixed(2)} ms` : '—']);
    rows.push(['已预载', `${livePool.size} / ${LIVE_POOL_MAX} 段`]);
  }
  if (m.error) rows.push(['错误', m.error]);
  kvRows(rows);
}

async function loadCandidates() {
  try {
    const c = await api('/frames/api/candidates');
    el.recent.textContent = '';
    el.paths.textContent = '';

    const datalist = (paths) => {
      for (const p of paths) {
        const o = document.createElement('option');
        o.value = p;
        el.paths.append(o);
      }
    };
    datalist(c.videos.map((v) => v.path));
    datalist(c.plans.map((p) => p.path));
    datalist(c.specs.map((p) => p.path));
    datalist(c.images.map((p) => p.path));

    const group = (title, items, kind, fmt) => {
      if (!items.length) return;
      const h = document.createElement('div');
      h.className = 'group';
      h.textContent = title;
      el.recent.append(h);
      for (const item of items.slice(0, 6)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = fmt(item);
        b.title = item.path;
        b.addEventListener('click', () => {
          el.kind.value = kind;
          el.path.value = item.path;
          openFromForm();
        });
        el.recent.append(b);
      }
    };

    group('视频', c.videos, 'video', (v) => v.path);
    group('plan（分段时间表）', c.plans, 'spec', (p) => p.path);
    group('spec（设计稿）', c.specs, 'spec', (p) => p.path);
    group('图片序列', c.images, 'images', (p) => p.path + (p.manifest ? ' · manifest' : ` · ${p.images} 张`));

    if (!el.recent.children.length) {
      const p = document.createElement('p');
      p.className = 'muted small';
      p.textContent = 'out/ 下没有可预览产物。先跑 cvs build / cvs image。';
      el.recent.append(p);
    }
  } catch (e) {
    el.recent.textContent = '';
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = '扫描失败：' + e.message;
    el.recent.append(p);
  }
}

// ── 打开 / 挂载帧源 ─────────────────────────────────────────────────────────

function clearSource() {
  stopPlay();
  clearInterval(state.poll);
  state.poll = 0;
  revokeAll();
  for (const entry of livePool.values()) { try { entry.el.remove(); } catch { /* ignore */ } }
  livePool.clear();
  state.meta = null;
  state.id = null;
  state.n = 0;
  state.shown = false;
  state.stripRange = null;
  state.stripToken++;
  state.stats.failures = [];
  state.stats.delivered = [];
  state.live = { url: null, pendingUrl: null, ready: false, token: state.live.token + 1, ms: 0, renders: 0, active: null, segId: null, prefetchQueue: [], prefetching: false };
  el.ruler.hidden = true;
  el.ruler.textContent = '';
  el.img.hidden = false;
  el.img.removeAttribute('src');
  el.stageWrap.classList.add('no-source');
  setControlsEnabled(false);
  setStageMsg('');
}

function attach(id, meta) {
  clearSource();
  state.id = id;
  state.meta = meta;
  state.mode = meta.kind === 'spec' && meta.segments && meta.segments.length ? 'live' : 'img';

  if (state.mode === 'live') {
    el.img.hidden = true;
  } else {
    el.img.hidden = false;
  }

  el.slider.max = String(Math.max(0, meta.frames - 1));
  el.frameNum.max = String(Math.max(0, meta.frames - 1));
  el.total.textContent = fmtInt(meta.frames);
  el.stageWrap.classList.remove('no-source');
  setControlsEnabled(true);
  renderSourceInfo();
  buildRuler();
  buildStrip(0);
  show(0, { force: true });
  startPolling();
}

async function openFromForm(ev) {
  if (ev) ev.preventDefault();
  const kind = el.kind.value;
  const raw = el.path.value.trim();
  if (!raw) { setStatus('先填路径（或点右侧最近产物）', 'err'); return; }
  const q = new URLSearchParams();
  if (kind === 'video') q.set('video', raw);
  else if (kind === 'images') q.set('dir', raw);
  else if (/plan\.json$/i.test(raw)) q.set('plan', raw);
  else q.set('spec', raw);
  if (el.fps.value) q.set('fps', el.fps.value);
  setStatus('打开中…');
  el.openBtn.disabled = true;
  try {
    const { id, meta } = await api('/frames/api/open?' + q.toString());
    attach(id, meta);
    setStatus(`已打开 ${meta.kind} · ${fmtInt(meta.frames)} 帧 @ ${Number(meta.fps).toFixed(3)}fps · ${meta.width}×${meta.height}`, 'ok');
    const u = new URL(location.href);
    u.search = '';
    u.searchParams.set('id', id);
    history.replaceState(null, '', u);
  } catch (e) {
    setStatus('打开失败：' + e.message, 'err');
    setStageMsg('打开失败：' + e.message, true);
  } finally {
    el.openBtn.disabled = false;
  }
}

function startPolling() {
  clearInterval(state.poll);
  if (!state.meta || state.meta.done) return;
  state.poll = setInterval(async () => {
    if (!state.id) return;
    try {
      const { meta } = await api('/frames/api/meta?id=' + encodeURIComponent(state.id));
      const wasDone = state.meta && state.meta.done;
      state.meta = { ...state.meta, ...meta };
      renderSourceInfo();
      updateHud();
      if (!wasDone && meta.done) {
        clearInterval(state.poll);
        state.poll = 0;
        buildStrip(state.n);
        setStatus(`解码完成 · ${fmtInt(meta.frames)} 帧全部可预览`, 'ok');
      } else if (!meta.done) {
        setStatus(`解码中 ${meta.decoded} / ${meta.frames} 帧…（已解码的帧可立即预览）`, 'warn');
      }
    } catch (e) {
      metaFailures++;
      if (metaFailures === 3) setStatus('元数据刷新失败（服务可能已退出），继续重试…', 'err');
    }
  }, 500);
}
let metaFailures = 0;

// ── 下载当前帧 ──────────────────────────────────────────────────────────────

function triggerDownload(href, name) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
}

async function downloadFrame() {
  const m = state.meta;
  if (!m) return;
  const n = state.n;
  const name = `frame-${String(n).padStart(6, '0')}`;

  if (state.mode === 'live') {
    const seg = segmentAt(n);
    const entry = state.live.active;
    if (!seg || !entry) { setStatus('该帧不在任何段内', 'err'); return; }
    setStatus(`导出第 ${n} 帧 PNG（原生 ${m.width}×${m.height}，编码约 1s）…`);
    await new Promise((r) => setTimeout(r, 30));
    try {
      const win = entry.el.contentWindow;
      win.renderFrame((n - seg.startFrame) / m.fps);
      const cv = win.document.querySelector('canvas');
      if (!cv) throw new Error('页面里没有 canvas');
      const dataUrl = cv.toDataURL('image/png');
      triggerDownload(dataUrl, `${name}.png`);
      setStatus(`已导出第 ${n} 帧 · ${cv.width}×${cv.height} PNG`, 'ok');
    } catch (e) {
      setStatus('导出失败：' + e.message, 'err');
    }
    return;
  }

  setStatus(`取第 ${n} 帧…`);
  try {
    const res = await fetch(`/frames/api/frame?id=${encodeURIComponent(state.id)}&n=${n}&fmt=png&q=95`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('Content-Type') || 'image/png';
    const blob = await res.blob();
    const ext = /png/.test(type) ? 'png' : /webp/.test(type) ? 'webp' : /gif/.test(type) ? 'gif' : 'jpg';
    const url = URL.createObjectURL(blob);
    triggerDownload(url, `${name}.${ext}`);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    setStatus(`已下载 ${name}.${ext}`, 'ok');
  } catch (e) {
    setStatus('下载失败：' + e.message, 'err');
  }
}

// ── 每秒性能读数 ────────────────────────────────────────────────────────────

el.img.addEventListener('load', () => {
  if (state.mode === 'img') state.stats.delivered.push(performance.now());
});

setInterval(() => {
  const now = performance.now();
  state.stats.delivered = state.stats.delivered.filter((t) => now - t < 1000);
  const fps = state.stats.delivered.length;
  const m = state.meta;
  const target = m ? m.fps * state.rate : 0;
  const parts = [];
  parts.push(`实测 ${state.playing ? fps : '—'} fps`);
  if (m) parts.push(`目标 ${target.toFixed(1)}`);
  if (state.mode === 'live') parts.push(`渲染 ${state.live.ms.toFixed(2)} ms`);
  else {
    const h = state.hdr.get(state.n);
    parts.push(`延迟 ${h && h.wall ? Math.round(h.wall) : '—'} ms`);
  }
  if (state.stats.failures.length) parts.push(`失败 ${state.stats.failures.length}`);
  el.perf.textContent = parts.join(' · ');
  el.perf.style.color = state.playing && m && fps < target * 0.75 ? 'var(--warn)' : '';
  if (state.mode === 'live') renderSourceInfo();
}, 1000);

// ── 事件 ────────────────────────────────────────────────────────────────────

el.form.addEventListener('submit', openFromForm);
el.kind.addEventListener('change', () => {
  el.path.placeholder = el.kind.value === 'video'
    ? 'out/api/…/master.mp4'
    : el.kind.value === 'images'
      ? 'out/images'
      : 'out/…/plan.json 或 project.spec.json';
});

el.first.addEventListener('click', () => { stopPlay(); show(activeRange()[0], { force: true }); });
el.last.addEventListener('click', () => { stopPlay(); show(activeRange()[1], { force: true }); });
el.prev.addEventListener('click', () => { stopPlay(); show(state.n - 1); });
el.next.addEventListener('click', () => { stopPlay(); show(state.n + 1); });
el.prev10.addEventListener('click', () => { stopPlay(); show(state.n - 10); });
el.next10.addEventListener('click', () => { stopPlay(); show(state.n + 10); });
el.play.addEventListener('click', () => (state.playing ? stopPlay() : startPlay()));
el.loop.addEventListener('change', () => { state.loop = el.loop.checked; });
el.rate.addEventListener('change', () => { state.rate = Number(el.rate.value) || 1; });
el.download.addEventListener('click', downloadFrame);
el.restrip.addEventListener('click', () => { state.stripRange = null; buildStrip(state.n); });

el.slider.addEventListener('pointerdown', stopPlay);
el.slider.addEventListener('input', () => show(Number(el.slider.value)));
el.frameNum.addEventListener('change', () => {
  const v = Number(el.frameNum.value);
  if (Number.isFinite(v)) { stopPlay(); show(v); }
});
el.frameNum.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); el.frameNum.blur(); }
});

el.img.addEventListener('dblclick', () => {
  if (!document.fullscreenElement) el.stageWrap.requestFullscreen?.().catch(() => {});
  else document.exitFullscreen?.().catch(() => {});
});

window.addEventListener('resize', fitLiveFrames);
if (typeof ResizeObserver === 'function') new ResizeObserver(fitLiveFrames).observe(el.stageWrap);

window.addEventListener('keydown', (ev) => {
  const t = ev.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON')) return;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const m = state.meta;
  if (!m) return;
  const step = ev.shiftKey ? 10 : 1;
  switch (ev.key) {
    case 'ArrowLeft': ev.preventDefault(); stopPlay(); show(state.n - step); break;
    case 'ArrowRight': ev.preventDefault(); stopPlay(); show(state.n + step); break;
    case 'Home': ev.preventDefault(); stopPlay(); show(activeRange()[0], { force: true }); break;
    case 'End': ev.preventDefault(); stopPlay(); show(activeRange()[1], { force: true }); break;
    case ' ':
      ev.preventDefault();
      if (state.playing) stopPlay(); else startPlay();
      break;
    case 'd': case 'D': ev.preventDefault(); downloadFrame(); break;
    case 'f': case 'F':
      ev.preventDefault();
      if (!document.fullscreenElement) el.stageWrap.requestFullscreen?.().catch(() => {});
      else document.exitFullscreen?.().catch(() => {});
      break;
    case 'i': case 'I':
      ev.preventDefault();
      state.range.in = state.n;
      setStatus(`循环入点 = 第 ${state.n} 帧`, 'ok');
      renderRange();
      break;
    case 'o': case 'O':
      ev.preventDefault();
      state.range.out = state.n;
      setStatus(`循环出点 = 第 ${state.n} 帧`, 'ok');
      renderRange();
      break;
    case 'l': case 'L':
      ev.preventDefault();
      state.range.on = !state.range.on;
      setStatus(state.range.on ? '循环区间开' : '循环区间关', 'ok');
      renderRange();
      break;
    default: break;
  }
});

function renderRange() {
  const m = state.meta;
  const r = state.range;
  if (!m || !r.on || r.in === null || r.out === null) { el.rangebar.hidden = true; return; }
  const lo = clamp(Math.min(r.in, r.out), 0, m.frames - 1);
  const hi = clamp(Math.max(r.in, r.out), 0, m.frames - 1);
  el.rangebar.hidden = false;
  el.rangebar.style.left = `${(lo / m.frames) * 100}%`;
  el.rangebar.style.width = `${((hi - lo + 1) / m.frames) * 100}%`;
}

// ── boot ────────────────────────────────────────────────────────────────────

async function boot() {
  renderSourceInfo();
  loadCandidates();

  const params = new URLSearchParams(location.search);
  const existing = params.get('id');
  if (existing) {
    setStatus('挂载已有帧源…');
    try {
      const { meta } = await api('/frames/api/meta?id=' + encodeURIComponent(existing));
      attach(existing, meta);
      setStatus(`已挂载 ${meta.kind} · ${fmtInt(meta.frames)} 帧 @ ${Number(meta.fps).toFixed(3)}fps`, 'ok');
      return;
    } catch (e) {
      setStatus('挂载失败：' + e.message, 'err');
    }
  }

  const q = new URLSearchParams();
  if (params.get('video')) { el.kind.value = 'video'; el.path.value = params.get('video'); q.set('video', params.get('video')); }
  else if (params.get('dir')) { el.kind.value = 'images'; el.path.value = params.get('dir'); q.set('dir', params.get('dir')); }
  else if (params.get('plan')) { el.kind.value = 'spec'; el.path.value = params.get('plan'); q.set('plan', params.get('plan')); }
  else if (params.get('spec')) { el.kind.value = 'spec'; el.path.value = params.get('spec'); q.set('spec', params.get('spec')); }
  if (params.get('fps')) { el.fps.value = params.get('fps'); q.set('fps', params.get('fps')); }
  if (![...q.keys()].length) {
    setStatus('选一个帧源：右侧「最近产物」或填路径', '');
    setStageMsg('还没有打开帧源。\n\n① 右侧「最近产物」点一项\n② 或在上方选类型、填路径，再点「打开」\n③ 打开后：← / → 逐帧，空格播放，D 下载当前帧');
    setControlsEnabled(false);
    return;
  }

  try {
    const { id, meta } = await api('/frames/api/open?' + q.toString());
    attach(id, meta);
    const u = new URL(location.href);
    u.search = '';
    u.searchParams.set('id', id);
    history.replaceState(null, '', u);
    setStatus(`已打开 ${meta.kind} · ${fmtInt(meta.frames)} 帧 @ ${Number(meta.fps).toFixed(3)}fps`, 'ok');
  } catch (e) {
    setStatus('打开失败：' + e.message, 'err');
  }
}

boot();
