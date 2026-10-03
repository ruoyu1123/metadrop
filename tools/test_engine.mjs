/**
 * test_engine.mjs — 引擎回归测试(Node 运行)。
 *
 * 验证三件事:
 *   1. packed.js 能正确解析导出的二进制资产
 *   2. 纯 JS 实现与官方 LightGBM / Keras 数值一致(tools/validation_vectors.json,由
 *      tools/validate_engine.py 用官方库生成)
 *   3. WASM 内核与纯 JS 实现一致(GBDT / 分组比率 / CNN)
 *
 * 用法: node tools/test_engine.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseGbm, parseScaler, parseNn, parseGroups, loadWasmCore,
} from '../js/packed.js';
import {
  CheckM2Engine, gbdtJs, nnJs, N_FEATURES, N_COUNTS, N_KO,
} from '../js/engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const ASSETS = path.join(APP, 'assets');
const WASM_PATH = path.join(APP, 'wasm', 'checkm2_core.wasm');

let failures = 0;
let checks = 0;

function ok(name, pass, detail = '') {
  checks++;
  if (!pass) failures++;
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? '  ' + detail : ''}`);
}

function readArrayBuffer(file) {
  const b = fs.readFileSync(file);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

console.log('=== 1. 资产解析 ===');
const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'manifest.json'), 'utf8'));
const names = JSON.parse(fs.readFileSync(path.join(ASSETS, 'feature_names.json'), 'utf8'));
const gbmCompBuf = readArrayBuffer(path.join(ASSETS, 'general_comp.gbm.bin'));
const gbmContBuf = readArrayBuffer(path.join(ASSETS, 'cont.gbm.bin'));
const scalerBuf = readArrayBuffer(path.join(ASSETS, 'scaler.bin'));
const nnBuf = readArrayBuffer(path.join(ASSETS, 'nn_comp.bin'));
const groupsBuf = readArrayBuffer(path.join(ASSETS, 'groups.bin'));

const gbmComp = parseGbm(gbmCompBuf, 'general_comp');
const gbmCont = parseGbm(gbmContBuf, 'cont');
const scaler = parseScaler(scalerBuf);
const nn = parseNn(nnBuf);
const groups = parseGroups(groupsBuf);

ok('特征维度 = 21241', manifest.layout.n_features === N_FEATURES,
  `manifest=${manifest.layout.n_features}`);
ok('完整度模型 450 棵树', gbmComp.nTrees === 450, `trees=${gbmComp.nTrees}`);
ok('污染度模型 450 棵树', gbmCont.nTrees === 450, `trees=${gbmCont.nTrees}`);
ok('scaler 长度正确', scaler.n === N_FEATURES, `n=${scaler.n}`);
ok('CNN 4 层卷积', nn.layers.filter((l) => l.kind === 'conv1d').length === 4);
ok('分组数量 416 / 757 / 47',
  groups.nPathways === 416 && groups.nModules === 757 && groups.nCategories === 47,
  `${groups.nPathways}/${groups.nModules}/${groups.nCategories}`);
ok('KO 列表 19999', names.ko_ids.length === N_KO);

console.log('\n=== 2. 与官方库数值对比(Python 基准) ===');
const reference = JSON.parse(
  fs.readFileSync(path.join(HERE, 'validation_vectors.json'), 'utf8'));
const vectors = reference.vectors.map((v) => Float64Array.from(v));

const jsCompPred = vectors.map((v) => {
  const raw = gbdtJs(gbmComp, v);
  return Math.min(100, Math.max(0, raw * Math.abs(raw)));
});
const jsContPred = vectors.map((v) => {
  const raw = gbdtJs(gbmCont, v);
  return Math.max(0, raw * Math.abs(raw));
});
ok('GBDT 完整度 vs LightGBM', maxAbsDiff(jsCompPred, reference.general_comp_predictions) < 1e-9,
  `maxErr=${maxAbsDiff(jsCompPred, reference.general_comp_predictions).toExponential(2)}`);
ok('GBDT 污染度 vs LightGBM', maxAbsDiff(jsContPred, reference.cont_predictions) < 1e-9,
  `maxErr=${maxAbsDiff(jsContPred, reference.cont_predictions).toExponential(2)}`);

const jsNn = vectors.map((v) => {
  const s = new Float32Array(N_COUNTS);
  for (let i = 0; i < N_COUNTS; i++) s[i] = v[i] * scaler.scale[i] + scaler.min[i];
  return nnJs(nn, s);
});
ok('CNN vs Keras', maxAbsDiff(jsNn, reference.nn_impl_predictions) < 1e-4,
  `maxErr=${maxAbsDiff(jsNn, reference.nn_impl_predictions).toExponential(2)}`);

console.log('\n=== 3. WASM 内核 vs 纯 JS ===');
let wasm = null;
try {
  wasm = await loadWasmCore(readArrayBuffer(WASM_PATH));
} catch (err) {
  console.log('  ! WASM 加载失败:', err.message);
}
if (!wasm) {
  console.log('  ! 跳过 WASM 对比');
} else {
  const pComp = wasm.putBuffer('gbmComp', gbmCompBuf);
  const pCont = wasm.putBuffer('gbmCont', gbmContBuf);
  const pGroups = wasm.putBuffer('groups', groupsBuf);
  const pNn = wasm.putBuffer('nn', nnBuf);

  // GBDT
  let worst = 0;
  for (const v of vectors) {
    wasm.writeF64('feat', v);
    const featPtr = wasm.ptr('feat');
    const w = wasm.gbmPredict(pComp, featPtr, 0);
    const j = gbdtJs(gbmComp, v);
    worst = Math.max(worst, Math.abs(w - j));
  }
  ok('WASM GBDT(完整度)与 JS 一致', worst < 1e-12, `maxErr=${worst.toExponential(2)}`);

  worst = 0;
  for (const v of vectors) {
    wasm.writeF64('feat', v);
    const w = wasm.gbmPredict(pCont, wasm.ptr('feat'), 0);
    worst = Math.max(worst, Math.abs(w - gbdtJs(gbmCont, v)));
  }
  ok('WASM GBDT(污染度)与 JS 一致', worst < 1e-12, `maxErr=${worst.toExponential(2)}`);

  // 分组比率:直接对比 c2_group_ratios 与 JS 实现
  const engineForGroups = new CheckM2Engine({
    manifest, names, gbmComp, gbmCont, scaler, nn, groups, wasm: null,
  });
  let gWorst = 0;
  for (const v of vectors) {
    const counts = v.subarray(0, N_COUNTS);
    const jsOut = new Float64Array(1220);
    engineForGroups._computeGroups(counts, jsOut, 0);

    const koView = new Float64Array(N_COUNTS);
    koView.set(counts);
    wasm.writeF64('koCounts', koView);
    const outPtr = wasm.slot('groupOut', 1220 * 8).ptr;
    wasm.groupRatios(pGroups, wasm.ptr('koCounts') + 22 * 8, outPtr);
    const wOut = new Float64Array(wasm.mem.buffer, outPtr, 1220).slice();
    gWorst = Math.max(gWorst, maxAbsDiff(jsOut, wOut));
  }
  ok('WASM 分组比率与 JS 一致', gWorst < 1e-12, `maxErr=${gWorst.toExponential(2)}`);

  // CNN
  let nWorst = 0;
  for (const v of vectors) {
    const s32 = new Float32Array(N_COUNTS);
    for (let i = 0; i < N_COUNTS; i++) s32[i] = v[i] * scaler.scale[i] + scaler.min[i];
    wasm.writeF32('nnIn', s32);
    const w = wasm.nnForward(pNn, wasm.ptr('nnIn'), N_COUNTS);
    nWorst = Math.max(nWorst, Math.abs(w - nnJs(nn, s32)));
  }
  ok('WASM CNN 与 JS 一致', nWorst < 1e-4, `maxErr=${nWorst.toExponential(2)}`);

  // 性能
  const v = vectors[0];
  wasm.writeF64('feat', v);
  let t0 = performance.now();
  for (let i = 0; i < 100; i++) wasm.gbmPredict(pCont, wasm.ptr('feat'), 0);
  const wasmGbmMs = (performance.now() - t0) / 100;
  t0 = performance.now();
  for (let i = 0; i < 100; i++) gbdtJs(gbmCont, v);
  const jsGbmMs = (performance.now() - t0) / 100;

  const s32 = new Float32Array(N_COUNTS);
  for (let i = 0; i < N_COUNTS; i++) s32[i] = v[i] * scaler.scale[i] + scaler.min[i];
  wasm.writeF32('nnIn', s32);
  t0 = performance.now();
  for (let i = 0; i < 5; i++) wasm.nnForward(pNn, wasm.ptr('nnIn'), N_COUNTS);
  const wasmNnMs = (performance.now() - t0) / 5;
  t0 = performance.now();
  for (let i = 0; i < 5; i++) nnJs(nn, s32);
  const jsNnMs = (performance.now() - t0) / 5;

  console.log(`  性能(单次): GBDT-cont WASM ${wasmGbmMs.toFixed(2)}ms / JS ${jsGbmMs.toFixed(2)}ms`
    + ` | CNN WASM ${wasmNnMs.toFixed(1)}ms / JS ${jsNnMs.toFixed(1)}ms`);
}

console.log('\n=== 4. 引擎端到端(对照官方 LightGBM/Keras 的基准) ===');
const engine = await CheckM2Engine.create({
  fetchBinary: async (name) => readArrayBuffer(path.join(ASSETS, name)),
  wasmBinary: readArrayBuffer(WASM_PATH),
});
ok('引擎初始化', !!engine && engine.usingWasm, engine.backendLabel);

const e2e = JSON.parse(fs.readFileSync(path.join(HERE, 'e2e_vectors.json'), 'utf8'));
const round2 = (x) => Math.round(x * 100) / 100;

for (const section of ['synthetic', 'reference']) {
  const sec = e2e[section];
  if (!sec) continue;
  let maxComp = 0; let maxCont = 0; let maxSpec = 0;
  sec.counts.forEach((c, i) => {
    const counts = Float64Array.from(c);
    const r = engine.predict(counts, { nn: true, forcedModel: 'general' });
    maxComp = Math.max(maxComp, Math.abs(r.completeness - round2(sec.general[i])));
    maxCont = Math.max(maxCont, Math.abs(r.contamination - round2(sec.contamination[i])));
    maxSpec = Math.max(maxSpec, Math.abs(r.completenessSpecific - round2(sec.specific[i])));
  });
  const tag = section === 'synthetic' ? '合成向量' : '真实训练基因组';
  ok(`${tag}: 完整度一致(${sec.counts.length} 例)`, maxComp < 0.011, `maxErr=${maxComp.toFixed(3)}`);
  ok(`${tag}: 污染度一致`, maxCont < 0.011, `maxErr=${maxCont.toFixed(3)}`);
  ok(`${tag}: CNN(specific)一致`, maxSpec < 0.011, `maxErr=${maxSpec.toFixed(3)}`);
}

// 快路径与增量重算
const baseCounts = Float64Array.from(e2e.reference.counts[0]);
const base = engine.predict(baseCounts, { nn: true, forcedModel: 'general' });

const contribution = CheckM2Engine.newContribution();
contribution.cds = 60;
contribution.aalength = 20000;
contribution.aa[0] = 1800; contribution.aa[6] = 1500; contribution.aa[10] = 1200;
const idxList = []; const cntList = [];
for (let i = 0; i < 60; i++) { idxList.push((i * 311) % N_KO); cntList.push(1); }
contribution.koIdx = Int32Array.from(idxList);
contribution.koCnt = Float64Array.from(cntList);

const t0 = performance.now();
const after = engine.predictWithoutContigs(baseCounts, [contribution], [0],
  { nn: true, forcedModel: 'general' });
const tAfter = performance.now() - t0;
ok('去掉 contig 后完整度不升(单拷贝基因只减不增)',
  after.completeness <= base.completeness + 1e-9,
  `${base.completeness} -> ${after.completeness}`);
ok('单次"移除并重算"(含 CNN)< 200ms', tAfter < 200, `${tAfter.toFixed(1)}ms`);

// 造 200 个 contig 的贡献,测量批量预计算耗时
const contribs = [];
for (let c = 0; c < 200; c++) {
  const z = CheckM2Engine.newContribution();
  z.cds = 25; z.aalength = 8000;
  z.aa[0] = 700; z.aa[6] = 600; z.aa[11] = 500;
  const ii = []; const cc = [];
  for (let i = 0; i < 40; i++) { ii.push((c * 97 + i * 31) % N_KO); cc.push(1); }
  z.koIdx = Int32Array.from(ii); z.koCnt = Float64Array.from(cc);
  contribs.push(z);
}
let tAll = performance.now();
for (let c = 0; c < 200; c++) {
  engine.predictWithoutContigs(baseCounts, contribs, [c],
    { nn: true, forcedModel: 'general' });
}
tAll = performance.now() - tAll;
console.log(`  预计算 200 个 contig 的"移除后"结果(含 CNN): ${tAll.toFixed(0)}ms `
  + `(${(tAll / 200).toFixed(1)}ms/个)`);

const presence = engine.groupPresenceCounts(baseCounts);
const lost = engine.explainRemoval(baseCounts, contribs, [0], 5);
ok('分组解释可用', Array.isArray(lost),
  `受影响分组 ${lost.length} 个,通路存在数合计 ${presence[0]}`);

console.log(`\n通过 ${checks - failures}/${checks} 项检查`);
if (failures > 0) {
  console.error(`!! ${failures} 项失败`);
  process.exit(1);
}
