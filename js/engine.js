/**
 * engine.js — CheckM2 复算引擎(浏览器内运行,不需要 DIAMOND / CheckM2 本体)。
 *
 * 与官方实现的一致性:
 *   特征向量 = [20 种氨基酸计数, AALength, CDS] + KO 计数(19999)
 *              + 通路完整度(416) + 模块完整度(757) + 类别完整度(47) = 21241 维
 *   完整度 = 通用模型(LightGBM) 与 特定模型(CNN) 二选一(官方靠余弦相似度决策;
 *            本项目不打包那 47MB 参考库,改为沿用报告里的模型,详见 predict())
 *   污染度 = 通用模型(LightGBM)
 *   LightGBM 目标为 regression sqrt,故预测值 = raw * |raw|
 *
 * 已验证:GBDT 与官方 LightGBM 输出逐元素一致(误差 0),
 *         CNN 与官方 Keras 输出误差 < 1e-10(见 tools/validate_engine.py)。
 *
 * WASM 内核负责 GBDT / CNN / 分组这些热路径,缺失时自动退回纯 JS。
 */

import { parseGbm, parseScaler, parseNn, parseGroups, loadWasmCore } from './packed.js';

export const N_METADATA = 22;                     // [0..19] 氨基酸, [20] AALength, [21] CDS
export const N_KO = 19999;
export const KO_OFFSET = N_METADATA;
export const N_COUNTS = N_METADATA + N_KO;        // 20021 = 参与 CNN 的部分
export const N_FEATURES = 21241;

export const AA_LIST = ['A', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'K', 'L',
  'M', 'N', 'P', 'Q', 'R', 'S', 'T', 'V', 'W', 'Y'];

/** 组装好的特征向量下标 → (偏移, 数量),便于 UI 展示 */
export const FEATURE_BLOCKS = [
  { key: 'metadata', label: 'Genome metadata', offset: 0, count: N_METADATA },
  { key: 'ko', label: 'KO gene counts', offset: 22, count: N_KO },
  { key: 'pathway', label: 'KEGG pathway completeness', offset: 20021, count: 416 },
  { key: 'module', label: 'KEGG module completeness', offset: 20437, count: 757 },
  { key: 'category', label: 'KEGG category completeness', offset: 21194, count: 47 },
];

// ---------------------------------------------------------------------------- 结果分级

/**
 * MIMAG(Bowers et al. 2017)质量分级。
 *
 * 只返回 `key`(机器可读)与 `labelKey`(交给 i18n 翻译),不在这里拼自然语言 ——
 * 计算层保持无语言依赖,才能被 Node 测试与导出脚本直接复用。
 * `label` 保留英文名,供 TSV 导出等机器消费场景使用。
 */
export const MIMAG_LABELS = {
  high: { labelKey: 'cls.high', label: 'High quality (HQ)' },
  medium: { labelKey: 'cls.medium', label: 'Medium quality (MQ)' },
  partial: { labelKey: 'cls.partial', label: 'Low completeness' },
  contaminated: { labelKey: 'cls.contaminated', label: 'Too contaminated' },
};

export function mimagClass(completeness, contamination) {
  let key;
  if (completeness >= 90 && contamination <= 5) key = 'high';
  else if (completeness >= 50 && contamination <= 10) key = 'medium';
  else if (completeness < 50) key = 'partial';
  else key = 'contaminated';
  return { key, ...MIMAG_LABELS[key] };
}

// ---------------------------------------------------------------------------- 引擎

export class CheckM2Engine {
  constructor(parts) {
    this.manifest = parts.manifest;
    this.names = parts.names;
    this.gbmComp = parts.gbmComp;
    this.gbmCont = parts.gbmCont;
    this.scaler = parts.scaler;
    this.nn = parts.nn;
    this.groups = parts.groups;
    this.wasm = parts.wasm || null;

    this.koIds = this.names.ko_ids;
    this.koIndex = new Map();
    for (let i = 0; i < this.koIds.length; i++) this.koIndex.set(this.koIds[i], i);

    this.pathwayNames = this.names.pathways;
    this.moduleNames = this.names.modules;
    this.categoryNames = this.names.categories;

    // 复用的工作缓冲
    this._features = new Float64Array(N_FEATURES);
    this._scaled = new Float64Array(N_COUNTS);
    this._scaled32 = new Float32Array(N_COUNTS);
    this._scratch = new Float64Array(N_COUNTS);

    if (this.wasm) {
      // 模型与映射表常驻 wasm 线性内存,只放一次
      this._wp = {
        gbmComp: this.wasm.putBuffer('gbmComp', parts.gbmCompBuffer),
        gbmCont: this.wasm.putBuffer('gbmCont', parts.gbmContBuffer),
        groups: this.wasm.putBuffer('groups', parts.groupsBuffer),
        nn: this.wasm.putBuffer('nn', parts.nnBuffer),
        scalerMin: this.wasm.putBuffer('scalerMin', parts.scalerMinBuffer),
        scalerScale: this.wasm.putBuffer('scalerScale', parts.scalerScaleBuffer),
        features: this.wasm.slot('features', N_FEATURES * 8).ptr,
        scaled32: this.wasm.slot('scaled32', N_COUNTS * 4).ptr,
      };
    }
  }

  get usingWasm() { return !!this.wasm; }

  get backendLabel() {
    return this.wasm ? 'WebAssembly (SIMD)' : 'JavaScript fallback';
  }

  // ------------------------------------------------------------------ 加载

  /**
   * @param {object} opts
   * @param {(name:string)=>Promise<ArrayBuffer>} opts.fetchBinary 资产读取函数
   * @param {ArrayBuffer|null} opts.wasmBinary 计算内核
   */
  static async create(opts) {
    const get = async (name) => {
      const buf = await opts.fetchBinary(name);
      if (!buf) throw new Error(`Asset not found: ${name}`);
      return buf;
    };

    const [manifestBuf, namesBuf, gbmCompBuffer, gbmContBuffer, scalerBuffer,
      nnBuffer, groupsBuffer, wasm] = await Promise.all([
      get('manifest.json').then((b) => JSON.parse(new TextDecoder().decode(b))),
      get('feature_names.json').then((b) => JSON.parse(new TextDecoder().decode(b))),
      get('general_comp.gbm.bin'),
      get('cont.gbm.bin'),
      get('scaler.bin'),
      get('nn_comp.bin'),
      get('groups.bin'),
      opts.wasmBinary ? loadWasmCore(opts.wasmBinary) : Promise.resolve(null),
    ]);

    const parts = {
      manifest: manifestBuf,
      names: namesBuf,
      gbmComp: parseGbm(gbmCompBuffer, 'general_comp'),
      gbmCont: parseGbm(gbmContBuffer, 'cont'),
      scaler: parseScaler(scalerBuffer),
      nn: parseNn(nnBuffer),
      groups: parseGroups(groupsBuffer),
      wasm,
      gbmCompBuffer,
      gbmContBuffer,
      groupsBuffer,
      nnBuffer,
      scalerMinBuffer: sliceBuffer(scalerBuffer, 12, 0, N_FEATURES * 8),
      scalerScaleBuffer: sliceBuffer(scalerBuffer, 12 + N_FEATURES * 8, 0, N_FEATURES * 8),
    };
    return new CheckM2Engine(parts);
  }

  /** 把 KO id 转成特征下标(未知 KO 返回 -1) */
  koPosition(koId) { return this.koIndex.has(koId) ? this.koIndex.get(koId) : -1; }

  newCounts() { return new Float64Array(N_COUNTS); }

  // ------------------------------------------------------------------ 计数容器

  /** 一个 contig 对特征向量的贡献(稀疏 KO 表示,便于快速增删) */
  static newContribution() {
    return {
      aa: new Float64Array(20),
      aalength: 0,
      cds: 0,
      koIdx: new Int32Array(0),
      koCnt: new Float64Array(0),
      // 核苷酸层面的信息(不进模型,只作报告与展示)
      ntLength: 0,
      gc: 0,
      nBases: 0,
      nProteins: 0,
    };
  }

  /** counts += sign * contrib */
  static applyContribution(counts, contrib, sign = 1) {
    for (let i = 0; i < 20; i++) counts[i] += sign * contrib.aa[i];
    counts[20] += sign * contrib.aalength;
    counts[21] += sign * contrib.cds;
    const idx = contrib.koIdx;
    const cnt = contrib.koCnt;
    for (let i = 0; i < idx.length; i++) {
      const v = counts[22 + idx[i]] + sign * cnt[i];
      counts[22 + idx[i]] = v < 0 ? 0 : v;
    }
    return counts;
  }

  /** counts = Σ contributions */
  sumContributions(contribs) {
    const counts = this.newCounts();
    for (const c of contribs) CheckM2Engine.applyContribution(counts, c, 1);
    return counts;
  }

  // ------------------------------------------------------------------ 特征组装

  /** 把 counts(20021) 展开成 21241 维特征 */
  fillFeatures(counts, out = this._features) {
    out.set(counts, 0);
    this._computeGroups(counts, out, N_COUNTS);
    return out;
  }

  _computeGroups(counts, out, outOffset) {
    const G = this.groups;
    const base = G.koOffset;
    let o = outOffset;

    const pwOff = G.pw.offsets;
    const pwIdx = G.pw.indices;
    for (let g = 0; g < G.nPathways; g++) {
      const s = pwOff[g], e = pwOff[g + 1];
      let num = 0;
      for (let j = s; j < e; j++) if (counts[base + pwIdx[j]] > 0) num++;
      out[o++] = num / (e - s);
    }

    const mdOff = G.md.offsets;
    const mdIdx = G.md.indices;
    const mdDenom = G.md.denom;
    for (let g = 0; g < G.nModules; g++) {
      const s = mdOff[g], e = mdOff[g + 1];
      let num = 0;
      for (let j = s; j < e; j++) if (counts[base + mdIdx[j]] > 0) num++;
      out[o++] = num / mdDenom[g];
    }

    const ctOff = G.ct.offsets;
    const ctIdx = G.ct.indices;
    for (let g = 0; g < G.nCategories; g++) {
      const s = ctOff[g], e = ctOff[g + 1];
      let num = 0;
      for (let j = s; j < e; j++) if (counts[base + ctIdx[j]] > 0) num++;
      out[o++] = num / (e - s);
    }
    return out;
  }

  /** 每个分组的"存在 KO 数",用于解释去掉 contig 后丢了什么 */
  groupPresenceCounts(counts, out = new Int32Array(1220)) {
    const G = this.groups;
    const base = G.koOffset;
    let o = 0;
    for (let g = 0; g < G.nPathways; g++) {
      let num = 0;
      for (let j = G.pw.offsets[g]; j < G.pw.offsets[g + 1]; j++) {
        if (counts[base + G.pw.indices[j]] > 0) num++;
      }
      out[o++] = num;
    }
    for (let g = 0; g < G.nModules; g++) {
      let num = 0;
      for (let j = G.md.offsets[g]; j < G.md.offsets[g + 1]; j++) {
        if (counts[base + G.md.indices[j]] > 0) num++;
      }
      out[o++] = num;
    }
    for (let g = 0; g < G.nCategories; g++) {
      let num = 0;
      for (let j = G.ct.offsets[g]; j < G.ct.offsets[g + 1]; j++) {
        if (counts[base + G.ct.indices[j]] > 0) num++;
      }
      out[o++] = num;
    }
    return out;
  }

  /** 对比两份 counts,列出受影响最大的通路/模块(用于 UI 解释) */
  diffGroups(before, after, limit = 8) {
    const b = this.groupPresenceCounts(before);
    const a = this.groupPresenceCounts(after);
    const items = [];
    const push = (names, offset, total) => {
      for (let g = 0; g < total; g++) {
        const d = a[offset + g] - b[offset + g];
        if (d !== 0) items.push({ name: names[g], delta: d, before: b[offset + g], after: a[offset + g] });
      }
    };
    push(this.pathwayNames, 0, this.groups.nPathways);
    push(this.moduleNames, this.groups.nPathways, this.groups.nModules);
    push(this.categoryNames, this.groups.nPathways + this.groups.nModules,
      this.groups.nCategories);
    items.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
    return items.slice(0, limit);
  }

  // ------------------------------------------------------------------ 模型推理

  /** LightGBM 原始累加值(未做 sqrt 目标的反变换) */
  _gbmRawNamed(which, features) {
    if (this.wasm) {
      const modelPtr = which === 'comp' ? this._wp.gbmComp : this._wp.gbmCont;
      this.wasm.writeF64('features', features);
      return this.wasm.gbmPredict(modelPtr, this._wp.features, 0);
    }
    return gbdtJs(which === 'comp' ? this.gbmComp : this.gbmCont, features);
  }

  static toCompleteness(raw) {
    const v = raw * Math.abs(raw);          // regression sqrt 目标
    return v > 100 ? 100 : (v < 0 ? 0 : v);
  }

  static toContamination(raw) {
    const v = raw * Math.abs(raw);
    return v < 0 ? 0 : v;                    // CheckM2 只截断下界
  }

  /** MinMaxScaler 变换(与 sklearn 的 MinMaxScaler.transform 等价) */
  _scale(features) {
    const { min, scale } = this.scaler;
    const s = this._scaled;
    const s32 = this._scaled32;
    for (let i = 0; i < N_COUNTS; i++) {
      const v = features[i] * scale[i] + min[i];
      s[i] = v;
      s32[i] = v;
    }
    return { s, s32 };
  }

  /** CNN(specific 模型)输出完整度 0..100 */
  nnCompleteness(features) {
    const { s32 } = this._scale(features);
    let sigmoid;
    if (this.wasm) {
      this.wasm.writeF32('scaled32', s32);
      sigmoid = this.wasm.nnForward(this._wp.nn, this._wp.scaled32, N_COUNTS);
    } else {
      sigmoid = nnJs(this.nn, s32);
    }
    const v = sigmoid * 100;
    return v < 0 ? 0 : v;
  }

  /**
   * 缺报告时的模型兜底选择。
   *
   * 官方 CheckM2 在报告缺失时靠 novelty_ratio = general / cosine² 来在 general 与
   * specific 之间二选一,那需要与 5300 个参考基因组比余弦(47MB 参考库)。本项目不再
   * 打包该参考库,因此只保留官方 cosine_decider 里**不依赖余弦**的那一半判断:
   * 平均完整度偏低且 AA/完整度比值小,视为"陌生且高度精简的基因组",直接取 general
   * —— 与官方同一分支同一结论。其余情况无从区分,取两模型均值,比赌单个模型更保守。
   *
   * @param {object} p {general, specific, aaRatio}
   * @returns {{completeness:number, model:string}}
   */
  static pickModelFallback({ general, specific, aaRatio }) {
    const meanComp = (general + specific) / 2;
    if (meanComp < 55 && aaRatio < 1500) {
      return { completeness: general, model: 'Gradient Boost (General Model)' };
    }
    // 没有余弦就区分不出 general 与 specific,取均值;标签写明原因以免被误当成官方行为
    return {
      completeness: meanComp,
      model: 'General+Specific mean (no report)',
    };
  }

  /**
   * 完整预测。
   *
   * 完整度取哪个模型:`forcedModel` 优先(主流程由报告里的 Completeness_Model_Used
   * 反推),为 'auto' 时交给 pickModelFallback() 兜底 —— 见该方法上的说明。
   *
   * @param {Float64Array} counts 20021 维计数
   * @param {object} opts
   *   nn:      是否计算 specific 模型(默认 true)
   *   forcedModel: 'general' | 'specific' | 'auto' | 报告里的模型名 —— 决定最终完整度取哪个
   */
  predict(counts, opts = {}) {
    const features = this.fillFeatures(counts);
    const general = CheckM2Engine.toCompleteness(this._gbmRawNamed('comp', features));
    const contamination = CheckM2Engine.toContamination(this._gbmRawNamed('cont', features));

    const wantNn = opts.nn !== false;
    const specific = wantNn ? this.nnCompleteness(features) : null;

    let completeness;
    let model;
    let modelSource;

    const forced = opts.forcedModel || 'auto';
    if (forced === 'general') {
      completeness = general; model = 'Gradient Boost (General Model)'; modelSource = 'forced';
    } else if (forced === 'specific' && specific != null) {
      completeness = specific; model = 'Neural Network (Specific Model)'; modelSource = 'forced';
    } else if (forced !== 'auto' && /specific/i.test(String(forced)) && specific != null) {
      completeness = specific; model = 'Neural Network (Specific Model)'; modelSource = 'report';
    } else if (forced !== 'auto' && /general|gradient/i.test(String(forced))) {
      completeness = general; model = 'Gradient Boost (General Model)'; modelSource = 'report';
    } else if (specific == null) {
      completeness = general; model = 'Gradient Boost (General Model)'; modelSource = 'no-nn';
    } else {
      const aaRatio = counts[20] / (((general + specific) / 2) || 1);
      const d = CheckM2Engine.pickModelFallback({ general, specific, aaRatio });
      completeness = d.completeness; model = d.model; modelSource = 'no-report';
    }

    const round = (x) => Math.round(x * 100) / 100;
    const out = {
      completeness: round(completeness),
      contamination: round(contamination),
      completenessGeneral: round(general),
      completenessSpecific: specific == null ? null : round(specific),
      aaRatio: Math.round(counts[20] / (((general + (specific ?? general)) / 2) || 1)),
      model,
      modelSource,
      mimag: mimagClass(completeness, contamination),
    };
    return out;
  }

  /** 快速预测(只跑 GBDT,用于即时反馈) */
  predictFast(counts) {
    const features = this.fillFeatures(counts);
    const general = CheckM2Engine.toCompleteness(this._gbmRawNamed('comp', features));
    const contamination = CheckM2Engine.toContamination(this._gbmRawNamed('cont', features));
    const round = (x) => Math.round(x * 100) / 100;
    return {
      completeness: round(general),
      contamination: round(contamination),
      completenessGeneral: round(general),
      completenessSpecific: null,
      model: 'Gradient Boost (General Model)',
      modelSource: 'fast',
      mimag: mimagClass(general, contamination),
      fast: true,
    };
  }

  /** 基于基础计数,去掉若干 contig 后的预测 */
  predictWithoutContigs(baseCounts, contributions, removedIdx, opts = {}) {
    const scratch = this._scratch;
    scratch.set(baseCounts);
    for (const i of removedIdx) {
      CheckM2Engine.applyContribution(scratch, contributions[i], -1);
    }
    return this.predict(scratch, opts);
  }

  /** 用于解释:去掉这些 contig 后丢失的通路/模块 */
  explainRemoval(baseCounts, contributions, removedIdx, limit = 8) {
    const scratch = new Float64Array(N_COUNTS);
    scratch.set(baseCounts);
    for (const i of removedIdx) {
      CheckM2Engine.applyContribution(scratch, contributions[i], -1);
    }
    return this.diffGroups(scratch, baseCounts, limit);
  }
}

// ---------------------------------------------------------------------------- 纯 JS 回退实现

/** LightGBM 单棵树累加 */
export function gbdtTreeSum(model, t, features) {
  const n0 = model.nodeOffsets[t];
  const l0 = model.leafOffsets[t];
  let node = 0;
  for (;;) {
    const g = n0 + node;
    const fval = features[model.splitFeature[g]];
    const nxt = fval <= model.threshold[g] ? model.leftChild[g] : model.rightChild[g];
    if (nxt < 0) return model.leafValue[l0 + (-nxt - 1)];
    node = nxt;
  }
}

export function gbdtJs(model, features) {
  let acc = 0;
  for (let t = 0; t < model.nTrees; t++) acc += gbdtTreeSum(model, t, features);
  return acc;
}

/** CNN 前向传播(与 Keras Sequential 等价) */
export function nnJs(model, input32) {
  let a = Float32Array.from(input32);
  let curLen = a.length;
  let curCh = 1;

  for (const layer of model.layers) {
    if (layer.kind === 'conv1d') {
      const { k, cin, cout, stride, act, w, b } = layer;
      if (cin !== curCh) return NaN;
      const tOut = Math.floor((curLen - k) / stride) + 1;
      const dst = new Float32Array(tOut * cout);
      for (let p = 0; p < tOut; p++) {
        const base = p * stride;
        for (let kk = 0; kk < k; kk++) {
          const row = base + kk;
          const wBase = kk * cin * cout;
          for (let ci = 0; ci < cin; ci++) {
            const v = a[row * cin + ci];
            if (v === 0) continue;
            const wOff = wBase + ci * cout;
            const dOff = p * cout;
            for (let f = 0; f < cout; f++) dst[dOff + f] += v * w[wOff + f];
          }
        }
        const dOff = p * cout;
        for (let f = 0; f < cout; f++) {
          let val = dst[dOff + f] + b[f];
          if (act === 1 && val < 0) val = 0;
          dst[dOff + f] = val;
        }
      }
      a = dst; curLen = tOut; curCh = cout;
    } else if (layer.kind === 'bn') {
      const { n, eps, gamma, beta, mean, variance } = layer;
      for (let i = 0; i < curLen * curCh; i++) {
        const c = i % curCh;
        a[i] = gamma[c] * (a[i] - mean[c]) / Math.sqrt(variance[c] + eps) + beta[c];
      }
    } else if (layer.kind === 'flatten') {
      curLen *= curCh; curCh = 1;
    } else if (layer.kind === 'dense') {
      const { nin, nout, act, w, b } = layer;
      if (curLen !== nin) return NaN;
      const dst = new Float32Array(nout);
      for (let j = 0; j < nout; j++) {
        let acc = b[j];
        for (let i = 0; i < nin; i++) acc += a[i] * w[i * nout + j];
        if (act === 1) { if (acc < 0) acc = 0; } else if (act === 2) acc = 1 / (1 + Math.exp(-acc));
        dst[j] = acc;
      }
      a = dst; curLen = nout; curCh = 1;
    }
  }
  return a[0];
}

/** 从 ArrayBuffer 里切一段(用于把 scaler 的 min/scale 单独喂给 WASM) */
function sliceBuffer(buf, byteOffset, _unused, byteLength) {
  return buf.slice(byteOffset, byteOffset + byteLength);
}
