/**
 * build_offline.mjs — 把整个应用打成**一个** HTML 文件。
 *
 * 为什么需要它:
 *   开发版是 ES 模块,`file://` 下浏览器会以 CORS 为由拒绝加载模块与 fetch 资源,
 *   所以必须跑一个静态服务器 —— 那终究还是"起了一个服务"。
 *   本脚本把 JS 转成经典脚本、把 CSS 与所有模型资产一起内联,
 *   产出的 dist/metadrop-offline.html 双击即可运行:零服务器、零网络请求。
 *
 * 模块处理:
 *   不用打包器(装 esbuild 需要联网),而是自己做一个极小的模块注册表 ——
 *   每个模块包在一个工厂函数里,`import` 变成 `require`。
 *   这样每个模块仍然有自己的作用域,不会出现"拼接后顶层变量重名"的隐患。
 *
 * 资产处理:
 *   模型权重直接 base64 会膨胀 33%;先 gzip 再 base64,
 *   47MB 的参考矩阵压到 ~7MB,整体 HTML 约 22MB。
 *   浏览器端用原生 DecompressionStream('gzip') 解压,无额外依赖。
 *
 * 用法:node tools/build_offline.mjs [--out dist/metadrop-offline.html]
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const OUT = path.resolve(APP, argOf('--out', 'dist/metadrop-offline.html'));

/** 模块加载顺序:入口放最后,其余按依赖从底到顶排列(注册表本身不依赖顺序,这里只是让产物好读) */
const MODULES = ['i18n.js', 'zip.js', 'localio.js', 'packed.js', 'engine.js', 'parsers.js', 'dataset.js', 'analyze.js', 'app.js'];
const ENTRY = 'app.js';

const fmt = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
};

// ---------------------------------------------------------------------------- 精简版 ESM → 工厂函数

/**
 * 把单个 ES 模块转成 `function(exports, require){ ... }` 的函数体。
 *
 * 只处理本项目实际用到的语法,不追求通用:
 *   import { a, b } from './x.js'   →  const { a, b } = require('./x.js')
 *   import './x.js'                 →  require('./x.js')
 *   export function/class/const X   →  function/class/const X  (+ 登记导出)
 *   export { A, B }                 →  仅登记导出
 */
export function transformModule(src) {
  const exportNames = new Set();

  // 1) 收集并删除 `export { A, B as C };`
  let code = src.replace(/^export\s*\{([^}]*)\}\s*;?[ \t]*$/gm, (m, inner) => {
    for (const part of inner.split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z0-9_$]+$/.test(name)) exportNames.add(name);
    }
    return '';
  });

  // 2) 登记 `export <decl> X` 的名字
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/gm)) {
    exportNames.add(m[1]);
  }
  // 3) 去掉行首的 `export `
  code = code.replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\s)/gm, '');

  // 4) 具名 / 命名空间 import
  code = code.replace(
    /^import\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2\s*;?[ \t]*$/gm,
    (m, clause, q, spec) => {
      const c = clause.trim();
      if (c.startsWith('{')) {
        const inner = c.slice(c.indexOf('{') + 1, c.lastIndexOf('}')).trim();
        return `const { ${inner} } = require(${q}${spec}${q});`;
      }
      if (c.startsWith('*')) {
        return `const ${c.replace(/^\*\s+as\s+/, '')} = require(${q}${spec}${q});`;
      }
      return `const ${c} = require(${q}${spec}${q});`;
    },
  );
  // 5) 副作用 import
  code = code.replace(/^import\s+(['"])([^'"]+)\1\s*;?[ \t]*$/gm, (m, q, spec) => `require(${q}${spec}${q});`);

  // 6) 动态 import 属于模块加载,在单文件里没有意义 —— 显式报错,别留隐患
  if (/\bimport\s*\(/.test(code)) {
    throw new Error('模块里还有动态 import(),单文件构建不支持,请改成静态 import');
  }

  const tail = exportNames.size
    ? `\n${[...exportNames].map((n) => `exports.${n} = ${n};`).join('\n')}\n`
    : '';

  return { code: `${code}${tail}`, exportNames: [...exportNames] };
}

function buildRuntime() {
  const factories = MODULES.map((id) => {
    const src = fs.readFileSync(path.join(APP, 'js', id), 'utf8');
    const { code, exportNames } = transformModule(src);
    return { id, code, exportNames };
  });

  // 去掉 './' 统一成 basename,避免 require('./x.js') 与 require('x.js') 被当两个模块
  const norm = (spec) => spec.replace(/^\.\//, '');

  const defs = factories.map(({ id, code }) => {
    const body = code.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n');
    return `__md_define__(${JSON.stringify(id)}, function (exports, require) {\n${body}\n});`;
  }).join('\n\n');

  return `(function () {
  "use strict";
  var registry = {};
  var cache = {};
  function __md_define__(id, factory) { registry[id] = factory; }
  function __md_require__(spec) {
    var id = String(spec).replace(/^\\.\\//, '');
    if (!registry[id]) throw new Error('module not found: ' + id);
    if (!cache[id]) {
      var exports = {};
      cache[id] = exports;
      registry[id](exports, __md_require__);
    }
    return cache[id];
  }
  window.__md_define__ = __md_define__;
  window.__md_require__ = __md_require__;
})();

${defs}

__md_require__(${JSON.stringify(ENTRY)});
`;
}

// ---------------------------------------------------------------------------- 内联资产

const parts = [];
for (const name of ['general_comp.gbm.bin', 'cont.gbm.bin', 'scaler.bin',
  'nn_comp.bin', 'groups.bin', 'manifest.json', 'feature_names.json']) {
  const p = path.join(APP, 'assets', name);
  if (!fs.existsSync(p)) {
    console.warn(`  ! 跳过缺失资产 ${name}(先运行 tools/export_assets.py)`);
    continue;
  }
  parts.push({ name, bytes: fs.readFileSync(p) });
}
const wasmPath = path.join(APP, 'wasm', 'checkm2_core.wasm');
if (fs.existsSync(wasmPath)) parts.push({ name: 'checkm2_core.wasm', bytes: fs.readFileSync(wasmPath) });
else console.warn('  ! 未找到 wasm/checkm2_core.wasm,将回退到纯 JS 计算');

// 演示数据:全是文本,拼成一个 JSON 再统一压缩
const demoDir = path.join(APP, 'samples', 'demo');
if (fs.existsSync(demoDir)) {
  const demo = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const rel = path.relative(demoDir, full).replace(/\\/g, '/');
        if (rel === 'manifest.json') continue;
        demo[rel] = fs.readFileSync(full, 'utf8');
      }
    }
  };
  walk(demoDir);
  const n = Object.keys(demo).length;
  parts.push({ name: 'demo.json', bytes: Buffer.from(JSON.stringify(demo), 'utf8') });
  console.log(`内联资产(demo.json 含 ${n} 个文件):`);
} else {
  console.warn('  ! 未找到 samples/demo,离线版将没有演示数据');
  console.log('内联资产:');
}

let rawTotal = 0;
let b64Total = 0;
const blocks = parts.map(({ name, bytes }) => {
  const gz = zlib.gzipSync(bytes, { level: 9 });
  const b64 = gz.toString('base64');
  rawTotal += bytes.length;
  b64Total += b64.length;
  console.log(`  ${name.padEnd(24)} ${fmt(bytes.length).padStart(9)} → gz ${fmt(gz.length).padStart(9)} → b64 ${fmt(b64.length).padStart(9)}`);
  return `<script type="application/octet-stream" data-md-asset="${name}">${b64}</script>`;
}).join('\n');

// ---------------------------------------------------------------------------- 组装 HTML

console.log('\n转换 JS 模块…');
const runtime = buildRuntime();
console.log(`  入口 ${ENTRY},共 ${MODULES.length} 个模块,产物 ${fmt(Buffer.byteLength(runtime))}`);

const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(APP, 'css', 'app.css'), 'utf8');

/**
 * 内联进 <script> / <style> 之前必须转义:
 * 模块源码(哪怕只是注释里)出现字面量 "</script>" 时,HTML 解析器会
 * 直接把脚本元素截断,后面整段运行时都变成非法 token。
 * JS 里 "<\/script>" 与 "</script>" 等值,"<\!--" 亦同理。
 */
const guardScript = (code) => code
  .replace(/<\/script/gi, '<\\/script')
  .replace(/<!--/g, '<\\!--');
const guardStyle = (code) => code.replace(/<\/style/gi, '<\\/style');

const offline = html
  .replace(/<html lang="[^"]*">/, '<html lang="zh-CN">')
  .replace(/\s*<link rel="stylesheet" href="css\/app\.css">/, `\n<style>\n${guardStyle(css)}\n</style>`)
  .replace(
    /\s*<script type="module" src="js\/app\.js"><\/script>/,
    `\n<!-- 内联的模型资产(gzip + base64),读取时用 DecompressionStream 解压 -->\n${blocks}\n`
    + '<script>window.__METADROP_EMBEDDED__ = { encoding: "gzip" };</script>\n'
    + `<script>\n${guardScript(runtime)}\n</script>`,
  );

if (offline === html) {
  console.error('\n!! index.html 里没有找到 <script type="module" src="js/app.js"></script>,注入失败');
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, offline, 'utf8');

// ---------------------------------------------------------------------------- 自检
// 内联转义一旦漏掉,浏览器只会报一句 "Invalid or unexpected token",
// 定位成本很高;这里在构建阶段就把产出里的运行时脚本编译一遍。
{
  const at = offline.indexOf('window.__METADROP_EMBEDDED__');
  const start = offline.indexOf('<script>', at);
  const end = offline.indexOf('</script>', start);
  const code = offline.slice(start + '<script>'.length, end);
  const defines = (code.match(/__md_define__\("/g) || []).length;
  try {
    // eslint-disable-next-line no-new
    new vm.Script(code);
  } catch (err) {
    console.error(`\n!! 内联运行时有语法错误:${err.message}`);
    process.exit(1);
  }
  if (defines !== MODULES.length || !code.includes(`__md_require__("${ENTRY}")`)) {
    console.error(`\n!! 运行时不完整:定义了 ${defines}/${MODULES.length} 个模块,入口 ${ENTRY}`);
    process.exit(1);
  }
  console.log(`\n自检:内联运行时 ${defines} 个模块,入口 ${ENTRY} 已加载,语法通过`);
}

console.log('\n输出:');
console.log(`  ${OUT}`);
console.log(`  原始资产 ${fmt(rawTotal)} → 内联后 ${fmt(b64Total)},最终 HTML ${fmt(fs.statSync(OUT).size)}`);
console.log('\n这一个文件双击就能用:全部计算在浏览器里跑,不联网、不上传、不需要服务器。');
