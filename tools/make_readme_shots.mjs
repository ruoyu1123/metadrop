/**
 * make_readme_shots.mjs — 为 README 生成配图。
 *
 * 只抓四张最能说明问题的画面,并输出到 docs/screenshots/(**会被提交到仓库**,
 * 与 tools/browser_shots/ 不同 —— 那个目录在 .gitignore 里,只留给测试产物)。
 *
 * 为什么要单独一个脚本,而不是复用 browser_check.mjs 的截图:
 * 后者是回归测试,要覆盖 17 节流程、跑各种边界;README 配图只需要
 * "干净地讲清四件事"。两者生命周期也不同 —— 测试截图随代码变,
 * 文档配图应该保持稳定,只在界面有实质变化时重跑。
 *
 * 用法(需要先起任意静态服务器):
 *   python -m http.server 8765 &
 *   node tools/make_readme_shots.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const OUT = path.join(APP, 'docs', 'screenshots');
const PORT = process.env.SHOT_PORT || '8765';
const BASE = `http://127.0.0.1:${PORT}/`;

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
  throw new Error('找不到 playwright-core');
}

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const root = path.join(os.homedir(), '.agent-browser', 'browsers');
  if (fs.existsSync(root)) {
    for (const d of fs.readdirSync(root)) {
      const p = path.join(root, d, 'chrome.exe');
      if (fs.existsSync(p)) return p;
      const m = path.join(root, d, 'chrome', 'Google Chrome for Testing.app', 'Contents', 'MacOS',
        'Google Chrome for Testing');
      if (fs.existsSync(m)) return m;
    }
  }
  return undefined; // 交给 playwright 自带的 chromium
}

// 界面就绪的判据要用**会变的状态**:status-text 的初始值就是静态占位文案
// 「就绪」/「Ready」,只盯文案会在引擎真正加载完之前就立刻放行。
// 真正的判据是后端徽章从「正在加载模型」变成具体后端,或状态栏明确报出失败。
// (与 browser_check.mjs 的 waitReady 保持一致 —— 那个坑踩过,别再踩。)
async function waitReady(page) {
  await page.waitForFunction(
    () => {
      const badge = document.getElementById('backend-badge')?.textContent || '';
      const st = document.getElementById('status-text')?.textContent || '';
      return /WebAssembly|JavaScript|SIMD|fallback/i.test(badge)
        || /失败|failed|error/i.test(st);
    },
    null, { timeout: 180000 },
  );
}

async function waitMags(page) {
  await page.waitForFunction(() => document.querySelectorAll('.mag-card').length > 0,
    null, { timeout: 180000 });
  // 等悬停预计算的读数落定,否则截图会拍到"计算中"
  await page.waitForFunction(
    () => {
      const st = document.getElementById('status-text')?.textContent || '';
      return !/计算中|重算|calculating/i.test(st);
    },
    null, { timeout: 180000 },
  ).catch(() => {});
  await page.waitForTimeout(500);
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2, // 2x 缩放,README 里缩到 800px 宽仍清晰
});

fs.mkdirSync(OUT, { recursive: true });
const shot = (name) => page.screenshot({ path: path.join(OUT, name) });

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await waitReady(page);
  console.log('  · 引擎就绪,后端 =', (await page.textContent('#backend-badge') || '').trim());

  // ① 载入演示数据 —— 主界面全貌
  await page.click('#btn-demo');
  await waitMags(page);
  await shot('01-overview.png');
  console.log('  ✓ 01-overview.png');

  // ② 悬停一条污染 contig —— 展示"移除后会怎样"的即时预测
  const row = page.locator('#contig-body tr').filter({ hasText: 'Z19' }).first();
  if (await row.count()) {
    await row.hover();
    await page.waitForFunction(() => !document.getElementById('hover-card').hidden,
      null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(300);
    await shot('02-hover.png');
    console.log('  ✓ 02-hover.png');
  }

  // ③ 自动建议之后 —— 清理结果与判断依据
  await page.click('#btn-suggest');
  await waitMags(page);
  await page.waitForTimeout(600);
  await shot('03-suggested.png');
  console.log('  ✓ 03-suggested.png');

  // ④ 指向右侧详情面板 —— 讲清"为什么判它是污染"
  await page.locator('#contig-body tr').filter({ hasText: 'Z19' }).first().click()
    .catch(() => {});
  await page.waitForTimeout(600);
  await shot('04-evidence.png');
  console.log('  ✓ 04-evidence.png');
} finally {
  await browser.close();
}

console.log(`\n输出目录 ${OUT}`);
