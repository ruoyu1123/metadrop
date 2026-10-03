/**
 * zip.js — 极简 ZIP 打包器(零依赖)。
 *
 * 为什么要自己写:
 *   1. 整个项目的硬约束是"纯本地、零外部请求、不引第三方依赖",不能为了打个包
 *      去装 archiver / jszip;
 *   2. 离线单文件版会把每个模块内联进 HTML,依赖越多,体积与转义风险越大。
 *
 * 支持两种存储方式:
 *   - deflate-raw(方法 8):浏览器 CompressionStream 与 Node 18+ 都自带;
 *   - store(方法 0):拿不到压缩流、或压缩后反而更大时的兜底。
 * 条目名一律按 UTF-8 写入并置位 0x0800 标志位,中文名在 Windows 资源管理器、
 * macOS 归档工具、unzip 里都能正常显示。
 *
 * 只在 ZIP32 范围内工作:总字节数超过 4 GiB、或条目数超过 65535 时**直接抛错**,
 * 由调用方提示"请改用输出文件夹直写",而不是静默产出一个解不开的坏包。
 *
 * 这个模块不碰 DOM(window / document),所以 Node 里能直接 import 来做单测。
 */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const MAX_ZIP32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

/** 预计算 CRC32 查表(多项式 0xEDB88320,ZIP 规范要求的那个) */
const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    tbl[n] = c >>> 0;
  }
  return tbl;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS 打包时间/日期(1980 起算,秒只有 2 秒精度) */
function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
    date: (((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff,
  };
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream !== 'function') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (err) {
    // 某些环境(如被裁剪的 WebView)声明了 CompressionStream 却拒绝 deflate-raw,
    // 这时退回 store 就好,不值得让整个导出失败。
    return null;
  }
}

function setU16(view, off, v) { view.setUint16(off, v & 0xffff, true); }
function setU32(view, off, v) { view.setUint32(off, v >>> 0, true); }

function toBytes(data, enc) {
  if (typeof data === 'string') return enc.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('zip: entry data must be a string, Uint8Array or ArrayBuffer');
}

/**
 * 打一个 ZIP 包。
 *
 * @param {Array<{name: string, data: string|Uint8Array|ArrayBuffer}>} entries
 * @param {{compress?: boolean, onProgress?: (ratio:number, name:string)=>void, now?: Date}} [opts]
 * @returns {Promise<Blob>}
 */
export async function buildZip(entries, opts = {}) {
  const { compress = true, onProgress = null, now = new Date() } = opts;
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(now);

  const chunks = [];
  const central = [];
  let offset = 0;
  let totalRaw = 0;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (i >= MAX_ENTRIES) throw new Error('ZIP_TOO_MANY_ENTRIES');

    const nameBytes = enc.encode(String(e.name));
    const raw = toBytes(e.data, enc);
    totalRaw += raw.length;
    if (totalRaw > MAX_ZIP32) throw new Error('ZIP_TOO_BIG');

    let method = 0;
    let payload = raw;
    if (compress && raw.length > 64) {
      // eslint-disable-next-line no-await-in-loop
      const def = await deflateRaw(raw);
      if (def && def.length < raw.length) { method = 8; payload = def; }
    }

    const head = new Uint8Array(30 + nameBytes.length);
    const hv = new DataView(head.buffer);
    setU32(hv, 0, SIG_LOCAL);
    setU16(hv, 4, 20);         // 解压所需版本 2.0
    setU16(hv, 6, 0x0800);     // 文件名是 UTF-8
    setU16(hv, 8, method);
    setU16(hv, 10, time);
    setU16(hv, 12, date);
    setU32(hv, 14, crc32(raw));
    setU32(hv, 18, payload.length);
    setU32(hv, 22, raw.length);
    setU16(hv, 26, nameBytes.length);
    setU16(hv, 28, 0);         // 无 extra field
    head.set(nameBytes, 30);

    chunks.push(head, payload);
    central.push({ nameBytes, method, crc: crc32(raw), comp: payload.length, uncomp: raw.length, offset, time, date });
    offset += head.length + payload.length;

    if (onProgress) onProgress((i + 1) / entries.length, e.name);
  }

  let cdSize = 0;
  for (const c of central) {
    const h = new Uint8Array(46 + c.nameBytes.length);
    const v = new DataView(h.buffer);
    setU32(v, 0, SIG_CENTRAL);
    setU16(v, 4, 20);          // 生成者版本
    setU16(v, 6, 20);          // 所需版本
    setU16(v, 8, 0x0800);
    setU16(v, 10, c.method);
    setU16(v, 12, c.time);
    setU16(v, 14, c.date);
    setU32(v, 16, c.crc);
    setU32(v, 20, c.comp);
    setU32(v, 24, c.uncomp);
    setU16(v, 28, c.nameBytes.length);
    setU16(v, 30, 0);          // extra
    setU16(v, 32, 0);          // comment
    setU16(v, 34, 0);          // 起始磁盘号
    setU16(v, 36, 0);          // 内部属性
    setU32(v, 38, 0);          // 外部属性(Unix 权限位一律 0,跨平台最稳)
    setU32(v, 42, c.offset);
    h.set(c.nameBytes, 46);
    chunks.push(h);
    cdSize += h.length;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  setU32(ev, 0, SIG_EOCD);
  setU16(ev, 4, 0);
  setU16(ev, 6, 0);
  setU16(ev, 8, central.length);
  setU16(ev, 10, central.length);
  setU32(ev, 12, cdSize);
  setU32(ev, 16, offset);
  setU16(ev, 20, 0);
  chunks.push(eocd);

  return new Blob(chunks, { type: 'application/zip' });
}

/** 生成带时间戳的包名,例如 metadrop_results_20260916-142530.zip */
export function zipFileName(prefix = 'metadrop_results', d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${prefix}_${stamp}.zip`;
}
