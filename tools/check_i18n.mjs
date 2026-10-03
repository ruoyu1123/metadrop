/**
 * check_i18n.mjs — 双语一致性 + 漏翻扫描。
 *
 * 检查四件事:
 *   1. zh / en 两个词典的 key 集合完全相同
 *   2. 同名 key 的 {占位符} 完全相同
 *   3. 代码里出现的每个 t('xxx') 都能在词典里找到
 *   4. js/ 下除 i18n.js 外的源文件里没有"硬编码的中文字面量"
 *      (注释与 JSDoc 不算 —— 注释是给人看的,不需要翻译)
 *
 * 用法:node tools/check_i18n.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keysOf, t, setLang, LANGS } from '../js/i18n.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const JS_DIR = path.join(APP, 'js');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${extra ? ` :: ${extra}` : ''}`); }
};

console.log('=== 1. 词典对齐 ===');
const keySets = {};
for (const l of LANGS) keySets[l] = new Set(keysOf(l));
ok('zh / en key 数量一致', keySets.zh.size === keySets.en.size,
  `zh=${keySets.zh.size} en=${keySets.en.size}`);
const onlyZh = [...keySets.zh].filter((k) => !keySets.en.has(k));
const onlyEn = [...keySets.en].filter((k) => !keySets.zh.has(k));
ok('没有只存在于中文的 key', onlyZh.length === 0, onlyZh.join(','));
ok('没有只存在于英文的 key', onlyEn.length === 0, onlyEn.join(','));

console.log('\n=== 2. 占位符一致 ===');
const text = {};
for (const l of LANGS) {
  setLang(l, { silent: true });
  text[l] = {};
  for (const k of keySets[l]) text[l][k] = t(k);
}
const ph = (s) => (s.match(/\{(\w+)\}/g) || []).sort().join(',');
const phBad = [];
for (const k of keySets.zh) {
  if (!keySets.en.has(k)) continue;
  if (ph(text.zh[k]) !== ph(text.en[k])) {
    phBad.push(`${k}: zh[${ph(text.zh[k])}] en[${ph(text.en[k])}]`);
  }
}
ok('占位符全部对齐', phBad.length === 0, phBad.slice(0, 5).join(' | '));

console.log('\n=== 3. 词典 key 都被真正用上 ===');
// 注意:i18n.js 自身要排除 —— 它里面写着 'key': '文案' 的定义,
// 若把词典文件算进语料,每个 key 都能"自证被引用",未使用检查就形同虚设。
const files = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));
const refFiles = files.filter((f) => f !== 'i18n.js');
const usedKeys = new Set();
const orphanRefs = [];

const corpus = [
  ['index.html', fs.readFileSync(path.join(APP, 'index.html'), 'utf8')],
  ...refFiles.map((f) => [f, fs.readFileSync(path.join(JS_DIR, f), 'utf8')]),
];

/**
 * 3a) 引用侧:每个 t('key') 都能在词典里查到。
 * 3b) 定义侧:每个词典 key 都能在源码/index.html 里找到字面量引用。
 *     —— 用的是"带引号的字面量"匹配,所以 labelKey: 'cls.high' 这类
 *        挂在数据上的 key 也能算数,不会被误判成未使用。
 */
for (const [name, src] of corpus) {
  for (const m of src.matchAll(/\bt\(\s*(['"])([a-zA-Z0-9_.\-]+)\1/g)) {
    if (!keySets.zh.has(m[2])) orphanRefs.push(`${name}: ${m[2]}`);
    else usedKeys.add(m[2]);
  }
  // 模板 key:t(`a.${x}`) / warn(`a.${x}`)
  // (warn() 是 dataset.js 里推警告的助手,同样只揣着 key 不揣文案)
  for (const m of src.matchAll(/\b(?:t|warn)\(\s*`([a-zA-Z0-9_.\-]*)\$\{/g)) {
    const matched = [...keySets.zh].filter((k) => k.startsWith(m[1]));
    if (!matched.length) orphanRefs.push(`${name}: ${m[1]}* (模板 key 无匹配前缀)`);
    for (const k of matched) usedKeys.add(k);
  }
}
ok('引用的 t() key 都能查到', orphanRefs.length === 0, orphanRefs.slice(0, 8).join(' | '));

for (const key of keySets.zh) {
  if (usedKeys.has(key)) continue;
  const hit = corpus.some(([, src]) => (
    src.includes(`'${key}'`) || src.includes(`"${key}"`) || src.includes(`\`${key}\``)));
  if (hit) usedKeys.add(key);
}

const unused = [...keySets.zh].filter((k) => !usedKeys.has(k));
ok(`全部 ${keySets.zh.size} 个 key 都有引用`, unused.length === 0, unused.slice(0, 12).join(', '));

/**
 * 3c) 属性侧:index.html 里 `data-i18n*` 属性的**取值**必须都在词典里。
 *
 * 这类 key 是通过 DOM 属性生效的,不写成 `t('...')` 调用,所以上面的引用扫描
 * 看不到它们。一旦写错(比如 tooltip 的 key 多打一个字母),界面会直接把裸 key
 * 显示给用户,而"未使用 key"检查未必响 —— 只有当那个错 key 恰好也存在于词典时
 * 才会彻底静默。单独钉一条,堵住这个盲区。
 * 注意排除 `data-i18n-vars`:它装的是 JSON 插值参数,不是 key。
 */
const htmlSrc = corpus[0][1];
const attrKeys = [...htmlSrc.matchAll(/data-i18n(?!-vars)[a-z-]*="([^"]*)"/g)]
  .map((m) => m[1].trim()).filter(Boolean);
const attrKeySet = new Set(attrKeys);
const attrBad = [...attrKeySet].filter((k) => !keySets.zh.has(k) || !keySets.en.has(k));
ok(`index.html 的 ${attrKeySet.size} 个 data-i18n* 属性 key 都在词典里`,
  attrBad.length === 0, attrBad.slice(0, 8).join(', '));

console.log('\n=== 4. 源码里没有硬编码中文 ===');
/**
 * 注释、JSDoc 与 console.* 都豁免:
 * 前者是给读代码的人看的,后者是开发者日志,都不属于界面文案。
 */
function stripNonUi(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .split('\n')
    .map((line) => (/\bconsole\.(log|warn|error|info|debug)\b/.test(line) ? '' : line))
    .join('\n');
}
const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
const leaks = [];
for (const f of files) {
  if (f === 'i18n.js') continue;
  const src = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
  stripNonUi(src).split('\n').forEach((line, i) => {
    if (CJK.test(line)) leaks.push(`${f}:${i + 1}  ${line.trim().slice(0, 90)}`);
  });
}
ok('js/ 下无硬编码中文', leaks.length === 0, leaks.slice(0, 14).join('\n        '));

console.log(`\n合计:${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
