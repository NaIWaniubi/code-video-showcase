/**
 * range.mjs — HTTP Range（bytes=）解析助手，供各静态服务复用。
 *
 * 返回值：
 *   null        → 无有效 Range（或 bytes=- 这种非法写法），按整文件 200 服务
 *   'unsat'     → 起点超出文件大小，调用方应回 416 + Content-Range: bytes-star-slash-size
 *   {start,end} → 闭区间，应回 206 Partial Content + Content-Range: bytes s-e/size
 */
export function parseByteRange(rangeHeader, size) {
  const m = /^bytes=(.+)$/.exec(String(rangeHeader || '').trim());
  if (!m || size <= 0) return null;
  const mm = /^(\d*)-(\d*)$/.exec(m[1]);
  if (!mm) return null;
  let a = mm[1] === '' ? null : Number(mm[1]);   // null = 未给起点
  let b = mm[2] === '' ? null : Number(mm[2]);
  if (a === null && b !== null) {                 // bytes=-N → 最后 N 个字节
    a = Math.max(0, size - Math.min(b, size));
    b = size - 1;
  } else if (a !== null) {
    b = b === null ? size - 1 : Math.min(b, size - 1);
    if (a >= size) return 'unsat';
  } else {
    return null;
  }
  if (a === null || a > b) return null;
  return { start: a, end: b };
}