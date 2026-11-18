/**
 * zip.mjs — 极简 ZIP 写入器（STORE + DEFLATE 两档，零依赖）。
 *
 * 为什么自己写：市面无免依赖 zip CLI（PowerShell 5.1 的 Compress-Archive 与
 * tar 均非全平台可用），npm 装 archiver 又给纯代码工具加一个运行时依赖。
 * ZIP 结构本身只有三件套：local file header + data + central directory，
 * deflate 用 node:zlib（raw deflate，method=8）。够打包交付物即可，不追求压缩极限。
 */
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_EPOCH_OFFSET = (1980 - 1980) * 365 + Math.floor((1980 - 1980) / 4); // 简化：直接构造
function dosTime(date = new Date()) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) |
    ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const dtime = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, dtime };
}
void DOS_EPOCH_OFFSET;

/**
 * @param {Map<string, Buffer>|[string, Buffer][]} files basename → bytes（路径用正斜杠，
 *        不允许绝对路径/.. —— 交付包必须可安全解压）
 * @param {{deflate?:boolean}} opts deflate=true（默认）对 >64B 的文件做 raw deflate
 */
export function writeZip(files, opts = {}) {
  const useDeflate = opts.deflate !== false;
  const chunks = [];
  const central = [];
  let offset = 0;
  const names = [...files.keys()].sort();

  for (const name of names) {
    const data = files.get(name);
    if (!Buffer.isBuffer(data)) throw new Error(`zip: entry not a buffer: ${name}`);
    if (name.includes('..') || name.startsWith('/') || /^[a-z]:/i.test(name)) {
      throw new Error(`zip: unsafe path in entry: ${name}`);
    }
    const nameB = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    let stored;
    let method = 0;
    if (useDeflate && data.length > 64) {
      const deflated = zlib.deflateRawSync(data);
      // 只有真变小才用 deflate（小文件压了反而变大）
      if (deflated.length < data.length) { stored = deflated; method = 8; } else { stored = data; method = 0; }
    } else {
      stored = data; method = 0;
    }
    const { time, dtime } = dosTime();
    // ── local file header（30B 固定字段 + name） ──
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);                       // signature
    lh.writeUInt16LE(20, 4);                              // version needed（deflate）
    lh.writeUInt16LE(0, 6);                               // flags（无 UTF-8 标志位——名字已显式 utf8，
    // 现代解析器按 utf8 flag 判断；这里置位更稳：见下方修正
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(dtime, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(stored.length, 18);                  // compressed size
    lh.writeUInt32LE(data.length, 22);                    // uncompressed size
    lh.writeUInt16LE(nameB.length, 26);
    lh.writeUInt16LE(0, 28);                              // extra len
    const lhBuf = Buffer.concat([lh, nameB, stored]);
    chunks.push(lhBuf);

    // ── central directory header（46B 固定字段 + name） ──
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);                               // version made by
    ch.writeUInt16LE(20, 6);                               // version needed
    ch.writeUInt16LE(0x0800, 8);                          // flags：bit11 = UTF-8 文件名
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(dtime, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(stored.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt16LE(0, 30);                              // extra len
    ch.writeUInt16LE(0, 32);                              // comment len
    ch.writeUInt16LE(0, 34);                              // disk
    ch.writeUInt16LE(0, 36);                              // internal attr
    ch.writeUInt32LE(0, 38);                              // external attr
    ch.writeUInt32LE(offset, 42);                         // local header offset
    central.push(Buffer.concat([ch, nameB]));
    offset += lhBuf.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) { chunks.push(c); cdSize += c.length; }
  offset += cdSize;

  // ── end of central directory（22B） ──
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                               // disk
  eocd.writeUInt16LE(0, 6);                               // disk with cd
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);                              // comment len
  chunks.push(eocd);

  return Buffer.concat(chunks);
}