/**
 * analyze.js — 把原始信号变成"这个 contig 要不要删"的判断依据。
 *
 * 对每个 MAG 的每个 contig 计算(全部挂在 c.metrics 上):
 *   uniqueKo     只由它贡献的 KO 数(删了就是真丢基因)
 *   sharedKo     与其他 contig 共享的 KO 数
 *   intra        Hi-C 信号指向本 MAG 内其他 contig 的总量
 *   inter        Hi-C 信号指向本 MAG 外 contig 的总量
 *   outFrac      外部信号占比 —— 越高越说明它"不属于这里"
 *   home         外部伙伴最集中的那个 MAG(它真正该待的地方)
 *   top          信号最强的若干伙伴 [{id, signal, inside, mags}]
 *   abundCos     本身丰度谱 vs 本 MAG 平均丰度谱的余弦相似度
 *   placement    归属证据分 0..1(0.55×Hi-C 外向 + 0.45×丰度不符),判断的主依据
 *   afterRemoval 单独移除它之后的 完整度 / 污染度 / 等级
 * 另外 c.verdict / c.reasons / c.suspicion 是判断结论。
 *
 * 注意 afterRemoval 需要跑一次模型推理,所以整体是异步 + 可报进度的。
 */

import { CheckM2Engine, mimagClass } from './engine.js';
import { t } from './i18n.js';

// ------------------------------------------------------------------ 小工具

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = Number.isFinite(a[i]) ? a[i] : 0;
    const y = Number.isFinite(b[i]) ? b[i] : 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function meanProfile(vectors) {
  const rows = vectors.filter((v) => Array.isArray(v) || ArrayBuffer.isView(v));
  if (!rows.length) return null;
  const n = rows[0].length;
  const out = new Array(n).fill(0);
  let used = 0;
  for (const v of rows) {
    if (!v || v.length !== n) continue;
    used++;
    for (let i = 0; i < n; i++) out[i] += Number.isFinite(v[i]) ? v[i] : 0;
  }
  if (!used) return null;
  for (let i = 0; i < n; i++) out[i] /= used;
  return out;
}

const fmt = (x, d = 2) => (x == null || !Number.isFinite(x) ? '–' : x.toFixed(d));

export function fmtBytes(n) {
  if (!n && n !== 0) return '–';
  if (n < 1000) return `${n} bp`;
  if (n < 1e6) return `${(n / 1000).toFixed(1)} kb`;
  return `${(n / 1e6).toFixed(2)} Mb`;
}

// ------------------------------------------------------------------ 单 contig 指标

function hicMetrics(ds, contig) {
  if (!contig.hic) return { intra: null, inter: null, outFrac: null, home: null, top: [] };
  const { intra, inter, top } = contig.hic;
  const total = intra + inter;
  const outFrac = total > 0 ? inter / total : null;

  // 外部伙伴最集中在哪个 MAG
  const votes = new Map();
  for (const p of top) {
    if (p.inside) continue;
    for (const m of p.mags || []) {
      if (m === contig.mag) continue;
      votes.set(m, (votes.get(m) || 0) + p.signal);
    }
  }
  let home = null;
  let best = 0;
  for (const [m, v] of votes) if (v > best) { best = v; home = m; }
  return { intra, inter, outFrac, home, top };
}

function abundanceMetrics(mag, contig, magMean) {
  if (!contig.abundance || !magMean) return { abundCos: null };
  return { abundCos: cosine(contig.abundance, magMean) };
}

// ------------------------------------------------------------------ 判断结论

/**
 * 判断结论文案。
 *
 * 统一只存 `key`(逻辑判断用)与 `labelKey`(界面翻译用),不在这里拼中文 ——
 * 语言可以随时切换,而标注只跑一次,把语言固化进数据就会切不干净。
 */
const VERDICTS = {
  duplicate: { key: 'duplicate', labelKey: 'verdict.duplicate', cls: 'badge-purple', tone: 'is-dup' },
  contaminant: { key: 'contaminant', labelKey: 'verdict.contaminant', cls: 'badge-bad', tone: 'is-contam' },
  misfit: { key: 'misfit', labelKey: 'verdict.misfit', cls: 'badge-warn', tone: 'is-dup' },
  core: { key: 'core', labelKey: 'verdict.core', cls: 'badge-good', tone: 'is-core' },
  neutral: { key: 'neutral', labelKey: 'verdict.neutral', cls: 'badge-quiet', tone: '' },
};

/** 目前界面语言下的结论名 */
export function verdictLabel(v) {
  return v ? t(v.labelKey) : t('verdict.neutral');
}

/** 把理由对象解析成当前语言的文本 */
export function reasonText(r) {
  if (!r) return '';
  if (r.text) return r.text;              // 兼容旧结构
  const vars = { ...(r.vars || {}) };
  if (Array.isArray(vars.mags)) vars.mags = vars.mags.join(t('list.sep'));
  return t(r.key, vars);
}

/** 把理由对象解析成当前语言的短标签 */
export function reasonTag(r) {
  if (!r) return '';
  if (r.tag) return r.tag;                // 兼容旧结构
  return t(r.tagKey, r.vars || {});
}

/**
 * 归属证据分 (0..1):"这个 contig 看起来属不属于当前 MAG"。
 *
 * 刻意**不依赖模型输出** —— Hi-C 物理接触与丰度谱是独立于 CheckM2 的证据。
 * 这一点很重要:污染物往往与宿主共享部分单拷贝基因,把它移掉时完整度看起来
 * 反而会掉(那是被它自己"垫高"的),只看 Δ完整度会漏判。
 *
 *   0.55 × Hi-C 外向占比  +  0.45 × (1 − 丰度余弦)
 * 缺数据时用中性缺省值,保证不会因为缺表而乱判。
 */
export function placementEvidence({ outFrac, abundCos }) {
  const hic = outFrac == null ? 0.35 : outFrac;
  const abs = abundCos == null ? 0.15 : Math.max(0, 1 - abundCos);
  return hic * 0.55 + abs * 0.45;
}

const EVIDENCE_CONTAMINANT = 0.60;
const EVIDENCE_MISFIT = 0.42;

function classify(mag, c) {
  const reasons = [];
  const dup = (c.duplicateOf || []).length > 0;
  const outFrac = c.metrics.outFrac;
  const absCos = c.metrics.abundCos;
  const impact = c.afterRemoval;
  const base = mag.prediction.recalc;
  const evidence = placementEvidence(c.metrics);
  c.metrics.placement = evidence;

  if (dup) reasons.push({ key: 'reason.dup', vars: { mags: c.duplicateOf }, tagKey: 'tag.dup' });

  if (outFrac != null && outFrac >= 0.6) {
    const pct = (outFrac * 100).toFixed(0);
    reasons.push(c.metrics.home
      ? { key: 'reason.hicOutHome', vars: { pct, home: c.metrics.home }, tagKey: 'tag.hicOut' }
      : { key: 'reason.hicOut', vars: { pct }, tagKey: 'tag.hicOut' });
  }
  if (absCos != null && absCos < 0.85) {
    reasons.push({ key: 'reason.abundMismatch', vars: { cos: absCos.toFixed(3) }, tagKey: 'tag.abund' });
  }
  let dC = null;
  let dX = null;
  if (impact) {
    dC = impact.completeness - base.completeness;
    dX = impact.contamination - base.contamination;
    if (dX <= -0.3) reasons.push({ key: 'reason.contamDown', vars: { d: Math.abs(dX).toFixed(2) }, tagKey: 'tag.contamDown' });
    if (dC >= 0.2) reasons.push({ key: 'reason.compUp', vars: { d: dC.toFixed(2) }, tagKey: 'tag.compUp' });
    if (dC <= -0.5) reasons.push({ key: 'reason.compDown', vars: { d: Math.abs(dC).toFixed(2) }, tagKey: 'tag.compDown' });
  }
  if (c.metrics.uniqueKo > 0 && c.contribution.cds > 0) {
    reasons.push({
      key: 'reason.uniqueKo',
      vars: { n: c.metrics.uniqueKo },
      tagKey: 'tag.uniqueKo',
    });
  }
  if (c.contribution.cds === 0) reasons.push({ key: 'reason.noCds', tagKey: 'tag.noGene' });

  // ---- 结论(优先级从上到下) ----
  // 1) 重复 bin 一定是"要处理"的对象 —— 但删哪一边由 suggestRemovals 投票决定
  // 2) 归属证据强 → 污染;中等 → 存疑
  // 3) 证据弱且移除明显掉完整度 → 核心
  let verdict;
  if (dup) verdict = VERDICTS.duplicate;
  else if (evidence >= EVIDENCE_CONTAMINANT) verdict = VERDICTS.contaminant;
  else if (evidence >= EVIDENCE_MISFIT) verdict = VERDICTS.misfit;
  else if (dC != null && dC <= -0.5 && c.metrics.uniqueKo > 0) verdict = VERDICTS.core;
  else if (dC != null && dC <= -0.2) verdict = VERDICTS.core;
  else verdict = VERDICTS.neutral;

  return { verdict, reasons };
}

// ------------------------------------------------------------------ 主入口

/**
 * 给整个数据集做标注(会修改 ds 里的对象)。
 * @param {Dataset} ds
 * @param {object} opts
 *   onProgress: (frac, msg) => void
 *   computeImpact: 是否跑"移除后"预测(默认 true)
 */
export async function annotateDataset(ds, { onProgress = () => {}, computeImpact = true } = {}) {
  const engine = ds.engine;
  const mags = Array.from(ds.mags.values());

  // ---- 1. 与模型无关的指标 ----
  for (const mag of mags) {
    const magMean = mag.abundance
      ? meanProfile(mag.contigList.map((c) => c.abundance).filter(Boolean))
      : null;
    for (const c of mag.contigList) {
      const sci = ds.singleCopyInfo(mag, c);
      c.metrics = {
        uniqueKo: sci.unique,
        sharedKo: sci.shared,
        ...hicMetrics(ds, c),
        ...abundanceMetrics(mag, c, magMean),
      };
    }
  }
  onProgress(0.05, t('status.progress.hicAbund'));

  // ---- 2. 逐个 contig 的"移除后"预测 ----
  if (computeImpact) {
    const contributions = mags.map((m) => m.contigList.map((c) => c.contribution));
    let done = 0;
    const total = mags.reduce((a, m) => a + m.contigList.length, 0);
    for (let mi = 0; mi < mags.length; mi++) {
      const mag = mags[mi];
      const contribs = contributions[mi];
      const useNn = mag.forcedModel !== 'general';
      for (let i = 0; i < contribs.length; i++) {
        const c = mag.contigList[i];
        c.afterRemoval = engine.predictWithoutContigs(mag.baseCounts, contribs, [i], {
          nn: useNn,
          forcedModel: mag.forcedModel,
        });
        done++;
        if ((done & 3) === 0) {
          onProgress(0.05 + 0.9 * (done / total), t('status.progress.removeImpact', { done, total }));
          // 让出主线程,别把界面卡住
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      // 顺便给整个 MAG 存一份 contributions 引用,后面复用
      mag.contributions = contribs;
    }
  }

  // ---- 3. 结论 ----
  for (const mag of mags) {
    for (const c of mag.contigList) {
      const { verdict, reasons } = classify(mag, c);
      c.verdict = verdict;
      c.reasons = reasons;
      // 排序用的综合"可疑度":重复最优先,其次是归属证据,再看移除收益
      const dX = c.afterRemoval
        ? Math.max(0, mag.prediction.recalc.contamination - c.afterRemoval.contamination) : 0;
      const dup = (c.duplicateOf || []).length ? 20 : 0;
      c.suspicion = dup + c.metrics.placement * 30 + dX * 3;
    }
  }

  onProgress(1, t('status.done'));
  return ds;
}

// ------------------------------------------------------------------ 自动建议

/**
 * 给整个数据集生成一套"建议移除"的集合。
 * 思路:
 *   1. 重复 contig —— 同名 contig 出现在多个 MAG 时,只保留"最贴合"的那个 MAG
 *   2. 污染/归属存疑 contig —— 外部 Hi-C 信号明显、且移除后污染度下降
 * 返回 Map<magName, Set<contigId>>
 */
export function suggestRemovals(ds, { allowContaminant = true } = {}) {
  const suggestion = new Map();
  const add = (mag, cid) => {
    let s = suggestion.get(mag);
    if (!s) { s = new Set(); suggestion.set(mag, s); }
    s.add(cid);
  };

  // ---- 1. 重复 ----
  for (const [cid, owners] of ds.duplicates) {
    let bestMag = owners[0];
    let bestFit = -Infinity;
    for (const m of owners) {
      const mag = ds.mags.get(m);
      const c = mag && mag.contigs.get(cid);
      if (!c || !c.metrics) continue;
      // 贴合度:Hi-C 内部信号占比为主,丰度一致性为辅,再考虑"独有 KO"权重
      const inFrac = c.metrics.outFrac == null ? 0.5 : 1 - c.metrics.outFrac;
      const absCos = c.metrics.abundCos == null ? 0.5 : c.metrics.abundCos;
      const keep = c.metrics.uniqueKo > 0 ? 0.15 : 0;
      const fit = inFrac * 0.5 + absCos * 0.5 + keep;
      if (fit > bestFit) { bestFit = fit; bestMag = m; }
    }
    for (const m of owners) if (m !== bestMag) add(m, cid);
  }

  // ---- 2. 污染 / 归属存疑 ----
  if (allowContaminant) {
    for (const mag of ds.mags.values()) {
      const base = mag.prediction.recalc;
      for (const c of mag.contigList) {
        if (!c.metrics || !c.afterRemoval) continue;
        if ((c.duplicateOf || []).length) continue; // 已经在重复里处理过
        const dX = c.afterRemoval.contamination - base.contamination;

        // 归属证据强(Hi-C 外向 + 丰度不符)且移除后污染度确实下降 → 建议移除。
        // 这里刻意不看 Δ完整度:污染物会把完整度"垫高",看它反而会漏判。
        const evidence = c.metrics.placement != null
          ? c.metrics.placement : placementEvidence(c.metrics);
        if (evidence >= EVIDENCE_CONTAMINANT && dX <= -0.2) add(mag.name, c.id);
      }
    }
  }

  return suggestion;
}

// ------------------------------------------------------------------ 导出

/**
 * 汇总当前工作状态,用于导出。
 * TSV 内容一律英文 + 机器可读的 key(便于下游脚本解析),不受界面语言影响。
 */
export function summarizeWork(ds) {
  const rows = [];
  for (const mag of ds.mags.values()) {
    const removed = mag.removedIds || new Set();
    const live = mag.livePrediction || mag.prediction.recalc;
    const klass = mimagClass(live.completeness, live.contamination);
    const orig = mag.summary || null;
    const now = mag.liveSummary || mag.summary || null;
    rows.push({
      mag: mag.name,
      contigsBefore: mag.contigList.length,
      contigsAfter: mag.contigList.length - removed.size,
      removedContigs: Array.from(removed).join(','),
      lengthBefore: orig ? orig.size : null,
      lengthAfter: now ? now.size : null,
      completenessBefore: mag.prediction.recalc.completeness,
      completenessAfter: live.completeness,
      contaminationBefore: mag.prediction.recalc.contamination,
      contaminationAfter: live.contamination,
      reportCompleteness: mag.report ? mag.report.completeness : null,
      reportContamination: mag.report ? mag.report.contamination : null,
      mimag: klass.label,
      mimagKey: klass.key,
    });
  }
  return rows;
}

export { VERDICTS, fmt, CheckM2Engine };
