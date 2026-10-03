#!/usr/bin/env node
/**
 * serve.mjs — metadrop 本地服务(零依赖)。
 *
 * 这个进程只干一件事:把 `metadrop` 这个网页递给浏览器,并且**在本机磁盘上**
 * 替浏览器写结果。它不做任何计算,也不往任何地方转发数据 —— 计算全在浏览器里
 * (WebAssembly),数据全在这台机器上。
 *
 *   ┌─────────────┐   GET /            ┌──────────────────────────┐
 *   │  浏览器      │ ─────────────────▶ │ serve.mjs (127.0.0.1)    │
 *   │  (计算发生地) │ ◀───────────────── │  ① 静态托管 app/          │
 *   └──────┬──────┘   POST /__local__/write └────────┬─────────────────┘
 *          │                                        │ 写文件
 *          └──── 结果直接落到本机 output 目录 ◀──────┘
 *
 * 用法:
 *   node tools/serve.mjs                                  # 输出到 ./metadrop_out
 *   node tools/serve.mjs --out "D:/projects/out"          # 指定输出目录
 *   node tools/serve.mjs --port 8788 --out ./out --open   # 指定端口并自动打开浏览器
 *
 * 只要浏览器能连上本服务,页面上的「完成输出」就会把结果**直写磁盘**,
 * 不再走浏览器下载。连不上时页面自动退化成"打包成 ZIP 下载",功能不丢。
 *
 * 安全边界(本地工具也要守住):
 *   1. 只监听回环地址,局域网里别的机器连不上;
 *   2. 校验 Host 头,挡住 DNS rebinding —— 恶意网页即使能访问 127.0.0.1,
 *      也无法用自己域名把这个服务当成后门;
 *   3. 跨域来源只放行 localhost 系(方便你换别的方式起页面),其余一律拒绝;
 *   4. 写入文件名做净化,`../` 之类的路径穿越会被拍平成普通文件名。
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');

const VERSION = '1.0.0';
/** 客户端在跨域场景下按这个默认端口探测,两边必须一致 */
const DEFAULT_API_PORT = 8788;

// ------------------------------------------------------------------ 参数

function parseArgs(argv) {
  const o = { port: DEFAULT_API_PORT, host: '127.0.0.1', out: null, open: false, root: APP };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') o.port = Number(argv[++i]);
    else if (a === '--host') o.host = argv[++i];
    else if (a === '--out' || a === '-o') o.out = argv[++i];
    else if (a === '--root') o.root = path.resolve(argv[++i]);
    else if (a === '--open') o.open = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else rest.push(a);
  }
  // 允许把输出目录当位置参数写:node tools/serve.mjs D:/out
  if (!o.out && rest.length) o.out = rest[0];
  return o;
}

const ARGS = parseArgs(process.argv.slice(2));

if (ARGS.help) {
  console.log(`metadrop 本地服务 ${VERSION}

用法: node tools/serve.mjs [选项] [输出目录]

选项:
  -p, --port <n>    监听端口(默认 ${DEFAULT_API_PORT};被占用时自动往后找)
      --host <ip>   监听地址(默认 127.0.0.1,只允许本机访问)
  -o, --out <dir>   输出文件夹,结果直接写到这里(默认 ./metadrop_out)
      --root <dir>  静态站点根目录(默认就是本项目的 app/ 目录)
      --open        启动后自动用默认浏览器打开页面
  -h, --help        显示这份帮助
`);
  process.exit(0);
}

if (!Number.isFinite(ARGS.port) || ARGS.port <= 0 || ARGS.port > 65535) {
  console.error(`端口不合法: ${ARGS.port}`);
  process.exit(2);
}

/** 输出目录:相对路径按"当前工作目录"解析,并确保存在 */
const OUT_DIR = path.resolve(process.cwd(), ARGS.out || 'metadrop_out');

/**
 * 输出目录在运行期可以被页面上输入的路径改写,所以用一个引用盒装起来,
 * 免得到处传可变状态。进程启动时的默认值来自 --out。
 */
const OUT_DIR_REF = { dir: OUT_DIR };

// ------------------------------------------------------------------ 工具

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.fa': 'text/plain; charset=utf-8',
  '.fna': 'text/plain; charset=utf-8',
  '.fasta': 'text/plain; charset=utf-8',
  '.faa': 'text/plain; charset=utf-8',
  '.gz': 'application/gzip',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bin': 'application/octet-stream',
  '.h5': 'application/octet-stream',
  '.keras': 'application/octet-stream',
  '.zip': 'application/zip',
};

const isLocalHostName = (h) => {
  if (!h) return true;                       // HTTP/1.0 之类不带 Host 的请求放行
  const name = h.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
};

const isLocalOrigin = (origin) => {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && isLocalHostName(u.host);
  } catch { return false; }
};

function send(res, code, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(buf);
}

const ok = (res, obj) => send(res, 200, JSON.stringify({ ok: true, ...obj }));
const bad = (res, code, msg) => send(res, code, JSON.stringify({ ok: false, error: String(msg) }));

const readJson = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
  req.on('error', () => resolve({}));
});

/**
 * 文件名净化:把路径成分拍平,挡掉 `../`、绝对路径、Windows 保留字符。
 * 返回 null 表示这个名字没法用,调用方应回 400。
 */
function safeName(raw) {
  const s = String(raw == null ? '' : raw);
  // 先取 basename —— 无论用户传 ../x 还是 C:\a\b,都只剩最后一段
  const base = path.basename(s.replace(/\\/g, '/'))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .trim();
  if (!base || base === '.' || base === '..') return null;
  if (Buffer.byteLength(base) > 200) return null;
  return base;
}

/**
 * 已确认存在的目录缓存起来,避免每写一个文件都 mkdir + stat 一轮(写结果时
 * 每个文件都会调到这里,热路径上不该有重复的系统调用)。
 */
const ensuredDirs = new Set();

async function ensureDir(dir) {
  const abs = path.resolve(dir);
  if (ensuredDirs.has(abs)) return abs;
  await fsp.mkdir(abs, { recursive: true });
  const st = await fsp.stat(abs);
  if (!st.isDirectory()) throw new Error('不是目录');
  ensuredDirs.add(abs);
  return abs;
}

/**
 * 清掉输出目录里上次运行残留的探针文件。
 *
 * 为什么需要这个:Windows 上刚写完的文件偶尔会被杀软 / 索引器短暂占用,`rm`
 * 会失败(EBUSY/EPERM)。一旦失败,探针就永远留在用户的输出目录里。与其依赖
 * "删一定能成功",不如在每次探测前先扫一遍,让上次的残渣**在下一次启动时自愈**。
 */
async function sweepProbes(dir) {
  let names;
  try { names = await fsp.readdir(dir); } catch { return; }
  for (const n of names) {
    if (n.startsWith('.metadrop-write-test-')) {
      await fsp.rm(path.join(dir, n), { force: true }).catch(() => {});
    }
  }
}

/**
 * 可写性探测:真写一个探针文件再删掉,比 access(W_OK) 可靠(后者在 Windows
 * 上常常骗人)。只在"启动"和"改输出目录"这两个时机各做一次 —— 千万不要放进
 * 写文件的热路径:真正写文件本身就是最好的可写性检验,失败了错误自然会上报,
 * 每个文件额外建/删一个探针既慢又容易留下残渣。
 */
async function assertWritable(dir) {
  await sweepProbes(dir);   // 先把上次可能留下的残渣清掉
  const probe = path.join(dir, `.metadrop-write-test-${process.pid}`);
  try {
    await fsp.writeFile(probe, 'ok');
  } finally {
    // 删除可能因文件被瞬时占用而失败 —— 退避重试,别一次不成就算了
    for (let i = 0; i < 6 && fs.existsSync(probe); i++) {
      await fsp.rm(probe, { force: true }).catch(() => {});
      if (fs.existsSync(probe)) await new Promise((r) => setTimeout(r, 120));
    }
  }
  return dir;
}

function outputInfo() {
  return {
    dir: OUT_DIR_REF.dir,
    name: path.basename(OUT_DIR_REF.dir),
    exists: fs.existsSync(OUT_DIR_REF.dir),
    writable: true,
    platform: process.platform,
  };
}

function reveal(dir) {
  if (process.env.METADROP_NO_REVEAL === '1') return { skipped: true };
  const target = path.resolve(dir);
  if (!fs.existsSync(target)) throw new Error('目录不存在');
  const cmd = process.platform === 'win32' ? 'explorer.exe'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? [path.win32.normalize(target)] : [target];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return { cmd };
}

/**
 * 弹出操作系统原生的"选择文件夹"对话框,把选中的绝对路径带回来。
 *
 * 为什么要绕这一圈:浏览器的 showDirectoryPicker 只给一个不透明目录手柄,
 * 拿不到 `D:\结果` 这样的真实路径,也就没法告诉服务端往哪写。真正有文件系统
 * 权限的是服务进程,所以只能让它自己去问用户。
 */
function pickFolder() {
  return new Promise((resolve, reject) => {
    let cmd; let args;
    if (process.platform === 'win32') {
      cmd = 'powershell.exe';
      args = ['-NoProfile', '-STA', '-Command',
        'Add-Type -AssemblyName System.Windows.Forms | Out-Null;\n'
        + '$f = New-Object System.Windows.Forms.FolderBrowserDialog;\n'
        + "$f.Description = 'metadrop: 选择输出文件夹';\n"
        + '$f.ShowNewFolderButton = $true;\n'
        + 'if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) '
        + '{ [Console]::Out.Write($f.SelectedPath) }'];
    } else if (process.platform === 'darwin') {
      cmd = 'osascript';
      args = ['-e', 'POSIX path of (choose folder with prompt "metadrop: 选择输出文件夹")'];
    } else {
      cmd = 'zenity';
      args = ['--file-selection', '--directory', '--title=metadrop: 选择输出文件夹'];
    }

    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { err += c.toString(); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 忽略 */ }
      reject(new Error('选择文件夹超时'));
    }, 180000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const picked = out.trim();
      if (picked) return resolve(picked);
      // 退出码 0 但没输出 = 用户点了取消;不是错误
      if (code === 0) return resolve('');
      return reject(new Error(err.trim().split('\n')[0] || `选择器退出码 ${code}`));
    });
  });
}

// ------------------------------------------------------------------ 本地 API

/** 每次「导出 ZIP」都会在系统临时目录下开一个独立小目录,互不覆盖 */
const STAGE_ROOT = path.join(os.tmpdir(), 'metadrop-export');
const staged = new Map();   // token -> { dir, name, file }

/**
 * 清理上次运行遗留的暂存目录。每次导出都会在系统临时目录开一个 token 子目录,
 * 进程退出后这些文件就没人管了,长期跑会慢慢堆积。启动时扫一遍,把超过 24 小时
 * 的删掉 —— 只动 STAGE_ROOT 自己的子目录,且只删足够旧的,不会误伤本次会话
 * 正在导出的压缩包。
 */
async function pruneStageRoot(maxAgeMs = 24 * 3600 * 1000) {
  let names;
  try { names = await fsp.readdir(STAGE_ROOT); } catch { return 0; }
  const now = Date.now();
  let removed = 0;
  for (const n of names) {
    const p = path.join(STAGE_ROOT, n);
    try {
      const st = await fsp.stat(p);
      if (st.isDirectory() && now - st.mtimeMs > maxAgeMs) {
        await fsp.rm(p, { recursive: true, force: true });
        removed++;
      }
    } catch { /* 单个删不掉不影响其余,忽略 */ }
  }
  return removed;
}

async function handleLocalApi(req, res, url) {
  const route = url.pathname.slice('/__local__'.length);

  // --- 连通性探测:页面靠它判断"是否处于本地直写模式"
  if (route === '/ping' && req.method === 'GET') {
    return ok(res, {
      app: 'metadrop',
      version: VERSION,
      output: outputInfo(),
      cwd: process.cwd(),
      tmp: STAGE_ROOT,
    });
  }

  // --- 让服务进程弹出原生文件夹选择框(浏览器拿不到绝对路径,只能它来问)
  if (route === '/pick' && req.method === 'POST') {
    if (process.env.METADROP_NO_DIALOG === '1') return bad(res, 501, '当前环境不弹原生对话框');
    try {
      const picked = await pickFolder();
      if (!picked) return ok(res, { cancelled: true });
      await ensureDir(picked);
      await assertWritable(picked);
      OUT_DIR_REF.dir = picked;
      console.log(`  · 输出目录改为 ${picked}`);
      return ok(res, { cancelled: false, output: outputInfo() });
    } catch (err) {
      return bad(res, 500, err.message);
    }
  }

  // --- 改写输出目录(页面上直接输入路径)
  if (route === '/output' && req.method === 'POST') {
    const body = await readJson(req);
    const p = String(body.path || '').trim();
    if (!p) return bad(res, 400, '路径为空');
    const next = path.resolve(process.cwd(), p);
    try {
      await ensureDir(next);
      await assertWritable(next);
    } catch (err) {
      return bad(res, 400, `无法写入 ${next}: ${err.message}`);
    }
    OUT_DIR_REF.dir = next;
    console.log(`  · 输出目录改为 ${next}`);
    return ok(res, { output: outputInfo() });
  }

  // --- 把浏览器算好的文件直接落到磁盘
  if (route === '/write' && req.method === 'POST') {
    const name = safeName(url.searchParams.get('name'));
    if (!name) return bad(res, 400, '文件名不合法');
    const dir = String(url.searchParams.get('dir') || '') || OUT_DIR_REF.dir;
    const target = path.join(path.resolve(process.cwd(), dir), name);
    const targetDir = path.dirname(target);
    try {
      await ensureDir(targetDir);
      await pipeline(req, fs.createWriteStream(target));
    } catch (err) {
      // 目录可能被外部删了才导致失败,清掉缓存让下次重试重新 mkdir
      ensuredDirs.delete(path.resolve(targetDir));
      return bad(res, 500, err.message);
    }
    const st = await fsp.stat(target);
    return ok(res, { path: target, dir: targetDir, bytes: st.size });
  }

  // --- 没设输出目录时的"导出 ZIP":先落到本机临时目录,再从本地取回下载
  if (route === '/stage' && req.method === 'POST') {
    const name = safeName(url.searchParams.get('name')) || 'metadrop_results.zip';
    const token = randomBytes(6).toString('hex');
    const dir = path.join(STAGE_ROOT, token);
    try {
      await fsp.mkdir(dir, { recursive: true });
      const file = path.join(dir, name);
      await pipeline(req, fs.createWriteStream(file));
      const st = await fsp.stat(file);
      staged.set(token, { dir, name, file });
      return ok(res, {
        path: file,
        dir,
        bytes: st.size,
        url: `/__local__/tmp/${token}/${encodeURIComponent(name)}`,
      });
    } catch (err) {
      return bad(res, 500, err.message);
    }
  }

  // --- 取回暂存的压缩包
  const m = route.match(/^\/tmp\/([a-f0-9]{12})\/(.+)$/);
  if (m && req.method === 'GET') {
    const rec = staged.get(m[1]);
    if (!rec) return bad(res, 404, '已过期的临时文件');
    const name = safeName(decodeURIComponent(m[2]));
    if (!name || name !== rec.name) return bad(res, 404, '文件名不匹配');
    const buf = await fsp.readFile(rec.file);
    return send(res, 200, buf, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${name}"`,
    });
  }

  // --- 在资源管理器 / Finder 里打开输出目录
  if (route === '/reveal' && req.method === 'POST') {
    const body = await readJson(req);
    const dir = path.resolve(process.cwd(), body.path || OUT_DIR_REF.dir);
    try {
      return ok(res, { dir, ...reveal(dir) });
    } catch (err) {
      return bad(res, 500, err.message);
    }
  }

  return bad(res, 404, `未知的本地接口: ${route}`);
}

// ------------------------------------------------------------------ 静态站点

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel.endsWith('/')) rel += 'index.html';

  const root = ARGS.root;
  const full = path.resolve(root, `.${path.posix.normalize(rel)}`);
  // 路径穿越防线:解析后的绝对路径必须仍在 root 之内
  if (full !== root && !full.startsWith(root + path.sep)) {
    return bad(res, 403, '越界访问');
  }

  let stat;
  try { stat = await fsp.stat(full); } catch { return bad(res, 404, `找不到 ${rel}`); }
  if (stat.isDirectory()) return serveStatic(req, res, new URL(`${url.pathname}index.html`, 'http://x'));

  const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache' });
    return res.end();
  }

  const ext = path.extname(full).toLowerCase();
  const noStore = ['.html', '.js', '.mjs', '.css', '.json'].includes(ext);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': noStore ? 'no-store' : 'no-cache',
    etag,
    'last-modified': stat.mtime.toUTCString(),
  });
  if (req.method === 'HEAD') return res.end();
  return pipeline(fs.createReadStream(full), res).catch(() => res.end());
}

// ------------------------------------------------------------------ 服务

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  // 防 DNS rebinding:Host 必须是本机名,否则别想碰这个服务
  if (!isLocalHostName(req.headers.host)) {
    return bad(res, 403, '只接受本机访问');
  }

  // 跨域只放行 localhost 系(方便你用别的静态服务器托管页面时也能直写)
  const origin = req.headers.origin;
  if (origin) {
    if (!isLocalOrigin(origin)) return bad(res, 403, '只接受本机来源');
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('vary', 'origin');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }

  try {
    if (url.pathname.startsWith('/__local__')) return await handleLocalApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return bad(res, 405, '方法不支持');
    return await serveStatic(req, res, url);
  } catch (err) {
    console.error('请求出错:', err);
    return bad(res, 500, err.message);
  }
});

/** 端口被占用就顺着往后找,最多试 10 个 —— 比直接报错友好得多 */
async function listen(port, host, tries = 10) {
  for (let i = 0; i < tries; i++) {
    const p = port + i;
    const result = await new Promise((resolve) => {
      const onErr = (err) => { server.off('listening', onOk); resolve(err); };
      const onOk = () => { server.off('error', onErr); resolve(null); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(p, host);
    });
    if (!result) return p;
    if (result.code !== 'EADDRINUSE') throw result;
  }
  throw new Error(`端口 ${port} ~ ${port + tries - 1} 都被占用了`);
}

const main = async () => {
  await ensureDir(OUT_DIR_REF.dir);
  await assertWritable(OUT_DIR_REF.dir);   // 启动时就暴露"这个目录写不了",而不是等用户点输出
  const pruned = await pruneStageRoot();   // 顺手清掉上次运行遗留的过期暂存
  const port = await listen(ARGS.port, ARGS.host);
  const url = `http://${ARGS.host}:${port}/`;

  console.log('');
  console.log('  metadrop 本地服务已启动');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  页面地址   ${url}`);
  console.log(`  输出文件夹 ${OUT_DIR_REF.dir}`);
  console.log(`  静态根目录 ${ARGS.root}`);
  if (pruned) console.log(`  已清理旧暂存 ${pruned} 项(系统临时目录)`);
  console.log('  ─────────────────────────────────────────────');
  console.log('  数据全程只在本机流转:计算在浏览器里做,结果直接写到上面这个目录。');
  console.log('  页面上的「完成输出」= 直写磁盘;「导出 ZIP」= 打包成一个压缩包下载。');
  console.log('  按 Ctrl+C 结束。');
  console.log('');

  if (ARGS.open) {
    const cmd = process.platform === 'win32' ? 'cmd'
      : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  }
};

main().catch((err) => {
  console.error(`启动失败: ${err.message}`);
  process.exit(1);
});
