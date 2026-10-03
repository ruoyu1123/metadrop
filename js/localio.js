/**
 * localio.js — 浏览器这一侧对「本地服务」的封套。
 *
 * 背景:光靠浏览器是没法把文件写进一个**用户指定的绝对路径**的
 * (File System Access API 只给你一个不透明目录手柄,拿不到 `D:\\结果` 这样的路径)。
 * 而 metadrop 的服务本来就跑在这台机器上,所以让它顺手把字节落盘是最自然的做法。
 *
 * 于是有两条"直写磁盘"的路子,优先级从高到低:
 *   1. 本地服务(serve.mjs)在线  →  POST /__local__/write,写进用户指定的绝对路径;
 *   2. 浏览器目录手柄           →  File System Access API,写进用户点选的目录;
 *   两条都不通才退化成"打包成 ZIP 下载"。
 *
 * 隐私边界:本地服务只监听 127.0.0.1。即使在用这条路,字节也只从浏览器
 * 走到**同一台机器**的另一个进程,不出本机。
 */

/** 服务端 tools/serve.mjs 里 DEFAULT_API_PORT 改了,这里要同步 */
const DEFAULT_PORT = '8788';
const API_BASE = '/__local__';

/** 探测结果:available=false 表示当前没有本地服务,应走浏览器目录手柄或下载 */
export const localApi = {
  available: false,
  version: '',
  base: '',
  output: null,   // { dir, name, exists, writable }
  cwd: '',
  tmp: '',
};

let probing = null;
let probed = false;

async function tryPing(base, timeoutMs) {
  if (typeof fetch !== 'function') return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/ping`, { signal: ac.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const j = await res.json();
    // 认领标记:别的本地服务恰好占了同端口也不会被误认为是我们
    if (!j || j.app !== 'metadrop') return null;
    return j;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 探测本地服务。只会真正跑一次,后续调用直接拿到缓存结果。
 * @returns {Promise<typeof localApi>}
 */
export async function probeLocal(timeoutMs = 1500) {
  if (probed) return localApi;
  if (probing) return probing;

  probing = (async () => {
    probed = true;
    // file:// 打开的单文件离线版本来就是"零服务"形态,不必去探
    if (typeof location !== 'undefined' && location.protocol === 'file:') return localApi;

    const bases = [API_BASE];
    // 页面若不是由本服务托管(例如你自己用 `python -m http.server 8765` 起的),
    // 再按默认端口探一次。跨域,但服务端只放行 localhost 来源。
    if (typeof location !== 'undefined' && location.port !== DEFAULT_PORT) {
      bases.push(`http://127.0.0.1:${DEFAULT_PORT}${API_BASE}`);
    }

    for (const base of bases) {
      // eslint-disable-next-line no-await-in-loop
      const info = await tryPing(base, timeoutMs);
      if (info) {
        localApi.available = true;
        localApi.base = base;
        localApi.version = info.version || '';
        localApi.output = info.output || null;
        localApi.cwd = info.cwd || '';
        localApi.tmp = info.tmp || '';
        return localApi;
      }
    }
    return localApi;
  })();

  return probing;
}

/** 本地服务掉线了:退回其它方式,别让用户卡在"看起来像成功了"的状态 */
export function markLocalGone() {
  localApi.available = false;
  localApi.base = '';
}

async function postJson(p, payload) {
  const res = await fetch(`${localApi.base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || j.ok !== true) throw new Error((j && j.error) || `HTTP ${res.status}`);
  return j;
}

/**
 * 让本地服务弹出**操作系统原生**的文件夹选择框,并把它选中的绝对路径带回来。
 *
 * 为什么需要它:浏览器的 showDirectoryPicker 只会给你一个不透明的目录手柄,
 * 拿不到 `D:\结果` 这样的路径,也就没法告诉服务端往哪写。绕开这个限制的唯一办法,
 * 是让真正拥有文件系统的那个进程(本机服务)自己去问用户。
 *
 * 拿不到原生对话框(无图形界面 / 平台不支持)时应抛错,由调用方退化成"手动填路径"。
 * @returns {Promise<{cancelled:boolean, output?:{dir:string,name:string}}>}
 */
export async function pickLocalFolder() {
  const j = await postJson('/pick', {});
  return { cancelled: !!j.cancelled, output: j.output || null };
}

/**
 * 让本地服务切换输出目录(页面上直接输入路径时用)。
 * @returns {Promise<{dir:string,name:string}>}
 */
export async function setLocalOutput(dir) {
  const j = await postJson('/output', { path: dir });
  localApi.output = j.output;
  return j.output;
}

/**
 * 把一个文件原样写到本机磁盘。
 *
 * 用 `application/octet-stream` 发原始字节,而不是包成 JSON 或 base64 ——
 * 清理后的 MAG 序列动辄上百 MB,base64 会平白多出 33% 的传输与内存开销。
 * 逐条调用而不是攒成数组,是为了让调用方能"边生成边写",峰值内存只有单个文件。
 *
 * @param {string} name 目标文件名(服务端还会再净化一次)
 * @param {string|Uint8Array|Blob} data
 * @returns {Promise<{path:string, dir:string, bytes:number}>}
 */
export async function writeLocalFile(name, data) {
  if (!localApi.available) throw new Error('LOCAL_NOT_AVAILABLE');
  const body = typeof Blob !== 'undefined' && data instanceof Blob
    ? data
    : new Blob([data], { type: 'application/octet-stream' });
  const res = await fetch(`${localApi.base}/write?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body,
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || j.ok !== true) throw new Error((j && j.error) || `HTTP ${res.status}`);
  return { path: j.path, dir: j.dir, bytes: j.bytes };
}

/**
 * 没指定输出目录时,"导出 ZIP"先把包丢到本机临时目录,再从这个地址取回。
 * 这样浏览器不用把整包常驻内存,用户也能看到包实际落在哪。
 */
export async function stageZip(name, blob) {
  if (!localApi.available) throw new Error('LOCAL_NOT_AVAILABLE');
  const res = await fetch(`${localApi.base}/stage?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: blob,
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || j.ok !== true) throw new Error((j && j.error) || `HTTP ${res.status}`);
  return { ...j, downloadUrl: `${localApi.base}${j.url}` };
}

/** 在资源管理器 / Finder 里定位到输出目录 */
export async function revealLocal(dir) {
  return postJson('/reveal', dir ? { path: dir } : {});
}

/** 供测试与调试:把探测状态复位 */
export function resetProbe() {
  probed = false;
  probing = null;
  localApi.available = false;
  localApi.base = '';
  localApi.output = null;
}
