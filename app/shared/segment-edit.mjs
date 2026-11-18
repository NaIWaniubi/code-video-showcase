/**
 * segment-edit.mjs — 帧工作台段级编辑的纯函数核（R5-W7）。
 *
 * 为什么单独成模块：app/frames/app.js 是浏览器端状态机（依赖 DOM），而「分割」
 * 的正确性值得 Node 单测钉死——两段的帧数守恒、id 稳定可读、边界拒绝、
 * 撤销快照语义。UI 只消费这里的结果。
 */
export const EDIT_UNDO_LIMIT = 50;

/**
 * 在第 n 帧把所在段一分为二。
 * @param {Array<{startFrame:number,endFrame:number,id?:string,...}>} segments 已按 startFrame 有序
 * @param {number} n 播放头帧号
 * @returns {{ok:boolean, segments:Array, reason?:string}}
 *   ok=false 时原样返回 segments（调用方按 reason 提示）。
 */
export function splitSegmentAt(segments, n, fps = 30) {
  if (!Array.isArray(segments) || !segments.length) return { ok: false, segments, reason: 'no-segments' };
  const idx = segments.findIndex((s) => n >= s.startFrame && n < s.endFrame);
  if (idx < 0) return { ok: false, segments, reason: 'frame-not-in-segment' };
  const seg = segments[idx];
  const len = seg.endFrame - seg.startFrame;
  if (n - seg.startFrame < 1 || n > seg.endFrame - 2) {
    return { ok: false, segments, reason: 'too-close-to-edge' };
  }
  const leftLen = n - seg.startFrame;
  const rightLen = seg.endFrame - n;
  const left = { ...seg, id: `${seg.id}a`, endFrame: n, frames: leftLen, duration: Number((leftLen / fps).toFixed(3)) };
  const right = { ...seg, id: `${seg.id}b`, t0: 0, startFrame: n, endFrame: seg.endFrame,
                  frames: rightLen, duration: Number((rightLen / fps).toFixed(3)) };
  const next = [...segments];
  next.splice(idx, 1, left, right);
  // 帧数守恒：编辑不能凭空增删总帧数。
  const before = segments.reduce((a, s) => a + (s.endFrame - s.startFrame), 0);
  const after = next.reduce((a, s) => a + (s.endFrame - s.startFrame), 0);
  if (before !== after) return { ok: false, segments, reason: 'frame-budget-mismatch' };
  return { ok: true, segments: next };
}

/** 撤销栈：push 深拷贝快照，超限丢最旧；pop 取回。 */
export class EditStack {
  constructor(limit = EDIT_UNDO_LIMIT) { this.limit = limit; this.snapshots = []; }
  push(segments) {
    this.snapshots.push(segments.map((s) => ({ ...s })));
    if (this.snapshots.length > this.limit) this.snapshots.shift();
    return this.snapshots.length;
  }
  pop() { return this.snapshots.pop() || null; }
  get size() { return this.snapshots.length; }
}