/**
 * check_offline.mjs — 验证 dist/metadrop-offline.html 这个"单文件版"。
 *
 * 为什么单独有这个脚本:
 *   browser_check.mjs 要先起一个静态服务器才能跑开发版;而离线单文件版
 *   是双击 `file://` 直接打开的,它恰恰**不该**依赖服务器。
 *   所以这里在完全没有任何后台服务的情况下,把离线产物从头到尾跑一遍:
 *   引擎就绪 → 载入演示数据 → 数字与官方报告一致 → 悬停/自动建议 →
 *   写入输出目录 → 并且全程零网络请求。
 *
 * 用法:node tools/check_offline.mjs [--headful] [--file <路径>]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');

const PY = process.env.METADROP_PY
  || path.join(os.homedir(), '.workbuddy', 'binaries', 'python', 'envs', 'default', 'Scripts', 'python.exe');

const hasPython = (() => {
  try { execFileSync(PY, ['-c', 'print(1)'], { encoding: 'utf8' }); return true; } catch { return false; }
})();

/** 用 Python 标准库 zipfile 独立解包,拿另一套实现来验证我们自己写的 ZIP */
function unzipWithPython(zipPath, outDir) {
  const script = `
import json, sys, zipfile, hashlib
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
info = []
for n in z.namelist():
    data = z.read(n)
    info.append({"name": n, "size": len(data), "sha1": hashlib.sha1(data).hexdigest()})
z.extractall(sys.argv[2])
print(json.dumps({"bad": bad, "entries": info}))
`;
  const out = execFileSync(PY, ['-c', script, zipPath, outDir], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

const args = process.argv.slice(2);
const HEADFUL = args.includes('--headful');
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const FILE = path.resolve(APP, argOf('--file', 'dist/metadrop-offline.html'));

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${extra ? ` :: ${extra}` : ''}`); }
};
const near = (a, b, tol = 0.02) => Math.abs(Number(a) - Number(b)) <= tol;

if (!fs.existsSync(FILE)) {
  console.error(`找不到 ${FILE}\n请先运行 node tools/build_offline.mjs`);
  process.exit(1);
}

// ------------------------------------------------------------------ playwright + chrome

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE,
    'playwright-core',
    path.join(APP, 'node_modules', 'playwright-core', 'index.mjs'),
    path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace',
      'node_modules', 'playwright-core', 'index.mjs'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const spec = c.startsWith('file:') || /^[A-Za-z]:/.test(c) || c.startsWith('/')
        ? pathToFileURL(c).href : c;
      // eslint-disable-next-line no-await-in-loop
      const mod = await import(spec);
      if (mod.chromium) return mod;
    } catch { /* 试下一个 */ }
  }
  throw new Error('找不到 playwright-core。请 npm i -D playwright-core 或设置 PLAYWRIGHT_CORE');
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = path.join(os.homedir(), '.agent-browser', 'browsers');
  if (fs.existsSync(root)) {
    for (const d of fs.readdirSync(root).sort().reverse()) {
      for (const rel of ['chrome.exe', 'chrome', 'chrome-win/chrome.exe']) {
        const p = path.join(root, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

const { chromium } = await loadPlaywright();
const executablePath = findChrome();
const url = pathToFileURL(FILE).href;

console.log(`单文件: ${FILE}`);
console.log(`       ${(fs.statSync(FILE).size / 1048576).toFixed(2)} MB`);
console.log(`浏览器: ${executablePath || '(playwright 自带 chromium)'}`);
console.log(`地址:   ${url}\n`);

const browser = await chromium.launch({ executablePath, headless: !HEADFUL });
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 950 }, locale: 'zh-CN', acceptDownloads: true,
});
const page = await ctx.newPage();

const errors = { console: [], page: [], requests: [] };
const downloads = [];
page.on('download', async (d) => {
  const name = d.suggestedFilename();
  try {
    await d.saveAs(path.join(os.tmpdir(), `md-offline-verify-${name}`));
    downloads.push(name);
  } catch (e) { errors.console.push(`保存下载 ${name} 失败:${e.message}`); }
});

page.on('console', (m) => {
  const text = m.text();
  if (m.type() === 'error') errors.console.push(text);
});
page.on('pageerror', (e) => errors.page.push(`${e.message}`));
page.on('request', (r) => errors.requests.push(r.url()));
page.on('requestfailed', (r) => errors.page.push(`请求失败 ${r.url()}`));

// 用 OPFS 手柄顶替原生目录选择框,验证"写入输出目录"这条真实代码路径
await page.addInitScript(() => {
  window.__METADROP_PICK_DIR__ = async () => {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle('offline-verify-out', { create: true });
  };
});

await page.goto(url, { waitUntil: 'domcontentloaded' });

// ------------------------------------------------------------------ 1. 引擎就绪

console.log('=== 1. 引擎就绪(file:// 零服务器) ===');
const t0 = Date.now();
await page.waitForFunction(() => {
  const badge = document.getElementById('backend-badge')?.textContent || '';
  const st = document.getElementById('status-text')?.textContent || '';
  return /WebAssembly|JavaScript|SIMD|fallback/i.test(badge) || /失败|failed|error/i.test(st);
}, null, { timeout: 180000 });
console.log(`  引擎就绪耗时 ${Date.now() - t0} ms`);

const backend = (await page.textContent('#backend-badge')).trim();
const status = (await page.textContent('#status-text')).trim();
ok('引擎加载成功', !/失败|failed/i.test(status), status);
ok('使用 WebAssembly(SIMD)', /WebAssembly/i.test(backend), backend);
ok('显示「离线单文件」标识', await page.locator('.badge-offline').count() > 0);
ok('页面处于安全上下文', await page.evaluate(() => window.isSecureContext));
// 不写死份数,而是核对"该有的都在 + 已废弃的参考矩阵没被打进去"
ok('内联资产齐全,且不含已废弃的 ref_csr.bin', await page.evaluate(() => {
  const names = Array.from(document.querySelectorAll('script[data-md-asset]'))
    .map((s) => s.getAttribute('data-md-asset'));
  const need = ['general_comp.gbm.bin', 'cont.gbm.bin', 'scaler.bin', 'nn_comp.bin',
    'groups.bin', 'manifest.json', 'feature_names.json', 'checkm2_core.wasm', 'demo.json'];
  return need.every((n) => names.includes(n)) && !names.includes('ref_csr.bin');
}));

// ------------------------------------------------------------------ 2. 演示数据

console.log('\n=== 2. 载入演示数据,数字对齐官方报告 ===');
const t1 = Date.now();
await page.click('#btn-demo');
await page.waitForFunction(() => document.querySelectorAll('.mag-card').length >= 3, null, { timeout: 240000 });
await page.waitForFunction(
  () => /^[\d.]+$/.test(document.getElementById('qs-completeness')?.textContent?.trim() || ''),
  null, { timeout: 90000 },
);
console.log(`  载入 + 标注耗时 ${Date.now() - t1} ms`);

const cards = await page.$$eval('.mag-card', (nodes) => nodes.map((n) => ({
  name: n.querySelector('.mag-name')?.textContent?.trim(),
  comp: n.querySelectorAll('.mag-metric b')[0]?.textContent?.trim(),
  cont: n.querySelectorAll('.mag-metric b')[1]?.textContent?.trim(),
  badge: n.querySelector('.badge')?.textContent?.trim(),
})));
for (const c of cards) console.log(`    ${c.name}: ${c.comp} / ${c.cont}  [${c.badge}]`);
ok('载入 3 个 MAG', cards.length === 3, cards.map((m) => m.name).join(','));

const EXPECT = { MAG_A: [95.15, 6.56], MAG_B: [99.85, 0.71], MAG_C: [71.10, 6.96] };
for (const [name, [c, x]] of Object.entries(EXPECT)) {
  const card = cards.find((m) => m.name === name);
  ok(`${name} 完整度 = 报告`, card && near(card.comp, c), card?.comp);
  ok(`${name} 污染度 = 报告`, card && near(card.cont, x), card?.cont);
}

// 长度百分比列应当合计 100%
const pctSum = await page.$$eval('#contig-body tr .col-len .pct', (nodes) => nodes.reduce(
  (s, n) => s + (parseFloat(n.textContent) || 0), 0));
ok('contig 长度百分比合计 ≈ 100%', Math.abs(pctSum - 100) < 0.5, `${pctSum.toFixed(2)}%`);

// ------------------------------------------------------------------ 3. 悬停 / 自动建议

console.log('\n=== 3. 悬停预测与自动建议 ===');
await page.locator('#contig-body tr').filter({ hasText: 'Z19' }).first().hover();
await page.waitForFunction(() => !document.getElementById('hover-card').hidden, null, { timeout: 15000 });
const hover = (await page.textContent('#hover-card')) || '';
ok('悬停卡片给出「移除该 contig 后」的预测',
  /移除该 CONTIG 后/.test(hover) && /完整度/.test(hover) && /污染度/.test(hover));

await page.click('#btn-suggest');
await page.waitForFunction(
  () => /自动建议/.test(document.getElementById('status-text')?.textContent || ''),
  null, { timeout: 60000 },
);
const cleaned = await page.$$eval('.mag-card', (nodes) => nodes.map((n) => ({
  name: n.querySelector('.mag-name')?.textContent?.trim(),
  comp: n.querySelectorAll('.mag-metric b')[0]?.textContent?.trim(),
  cont: n.querySelectorAll('.mag-metric b')[1]?.textContent?.trim(),
})));
const ca = cleaned.find((m) => m.name === 'MAG_A');
ok('自动建议后 MAG_A → 92.87 / 0',
  ca && near(ca.comp, 92.87, 0.05) && near(ca.cont, 0, 0.05), `${ca?.comp}/${ca?.cont}`);

// ------------------------------------------------------------------ 4. 写出结果

console.log('\n=== 4. 写出结果 ===');
await page.click('#btn-outdir');

// file:// 是不透明源,OPFS(navigator.storage.getDirectory)在其中不可用,
// 所以这里有一个分支:能拿到目录手柄就验证"写入目录",拿不到就验证
// 应用是否优雅降级 —— 给出明确提示、并改走打包下载,而不是静默失败。
const dirState = await page.waitForFunction(() => {
  const st = document.getElementById('status-text')?.textContent || '';
  const label = document.getElementById('outdir-input')?.value?.trim() || '';
  if (label === 'offline-verify-out') return 'dir';
  if (/不支持直接写目录|cannot write to directories/.test(st)) return 'unsupported';
  if (/设置输出文件夹失败|Could not set the output folder/.test(st)) return 'failed';
  return false;
}, null, { timeout: 20000 }).then((h) => h.jsonValue()).catch(() => null);

if (dirState === 'dir') {
  console.log('  拿到目录手柄,验证写入目录');
  await page.click('#btn-output');
  const wrote = await page.waitForFunction(
    () => /offline-verify-out/.test(document.getElementById('status-text')?.textContent || ''),
    null, { timeout: 120000 },
  ).then(() => true).catch(() => false);
  console.log(`  ${(await page.textContent('#status-text')).trim()}`);
  ok('「完成输出」写入输出目录', wrote);

  const written = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('offline-verify-out');
    const out = {};
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file') continue;
      const f = await handle.getFile();
      out[name] = { size: f.size, contigs: ((await f.text()).match(/^>/gm) || []).length };
    }
    return out;
  });
  const names = Object.keys(written).sort();
  console.log(`  写入 ${names.length} 个文件: ${names.join(', ')}`);
  ok('写入 5 个文件(2 表 + 3 份清理后序列)', names.length === 5, names.join(','));
  ok('清理后 MAG_A.fa 剩 28 条 contig', written['MAG_A.cleaned.fa']?.contigs === 28,
    `${written['MAG_A.cleaned.fa']?.contigs}`);
  ok('清理后 MAG_C.fa 剩 14 条 contig', written['MAG_C.cleaned.fa']?.contigs === 14,
    `${written['MAG_C.cleaned.fa']?.contigs}`);
} else {
  console.log(`  file:// 下没有目录手柄(${dirState ?? '超时'}),改验降级路径`);
  ok('拿不到目录手柄时给出明确提示而非静默失败',
    dirState === 'unsupported' || dirState === 'failed', String(dirState));
}

// 「完成输出」在没有输出目录时应自动退化成打包下载,并说清原因 ——
// 这条路径恰好就是离线场景下的交付方式,两种情况都要验。
console.log('  验证「导出 ZIP」打包路径');
await page.click('#btn-export');
const zipDeadline = Date.now() + 120000;
while (Date.now() < zipDeadline && downloads.length < 1) {
  // eslint-disable-next-line no-await-in-loop
  await page.waitForTimeout(300);
}
console.log(`  收到下载: ${downloads.join(', ') || '(无)'}`);
ok('导出打包成 1 个 ZIP', downloads.length === 1, `${downloads.length} 个: ${downloads.join(',')}`);
ok('包名带时间戳', /^metadrop_results_\d{8}-\d{6}\.zip$/.test(downloads[0] || ''), downloads[0]);
if (hasPython && downloads.length === 1) {
  const zipPath = path.join(os.tmpdir(), `md-offline-verify-${downloads[0]}`);
  const unzipDir = path.join(os.tmpdir(), 'md-offline-unzip');
  const r = unzipWithPython(zipPath, unzipDir);
  ok('Python zipfile 自检无损坏项', r.bad === null, String(r.bad));
  const zn = r.entries.map((e) => e.name).sort();
  console.log(`  包内 ${zn.length} 个文件:${zn.join(', ')}`);
  ok('包内 5 个文件(2 表 + 3 份清理后序列)', zn.length === 5, zn.join(','));
  const faA = fs.readFileSync(path.join(unzipDir, 'MAG_A.cleaned.fa'), 'utf8');
  ok('包内 MAG_A.cleaned.fa 剩 28 条 contig', (faA.match(/^>/gm) || []).length === 28,
    `${(faA.match(/^>/gm) || []).length} 条`);
}

// ------------------------------------------------------------------ 5. 零网络

console.log('\n=== 5. 零网络 / 无异常 ===');
const external = errors.requests.filter((u) => /^https?:/i.test(u));
ok('全程零 http(s) 请求', external.length === 0, external.slice(0, 3).join(' | '));
ok('无页面异常', errors.page.length === 0, errors.page.slice(0, 3).join(' | '));
ok('无 console error', errors.console.length === 0, errors.console.slice(0, 3).join(' | '));

await browser.close();

console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
