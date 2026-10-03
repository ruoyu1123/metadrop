/**
 * app.js — 界面主控。
 *
 * 职责:加载资产与数据 → 组装 Dataset → 打标注 → 渲染三栏界面 →
 *       处理"勾选/取消 contig"、"悬停预览"、"自动建议"、"导出到输出文件夹"。
 *
 * 两条硬性约束:
 *   1. 全部计算在本机浏览器内完成(WebAssembly / 纯 JS 回退),不发任何网络请求,
 *      也不上传任何文件。唯一会用到 fetch 的场景是"开发版"从同目录读模型资产;
 *      离线单文件版把资产内联进页面,连这一次请求都没有。
 *   2. 界面文案一律走 i18n(t()),语言可随时切换,切换后所有动态内容立即重渲染。
 */

import { CheckM2Engine, mimagClass } from './engine.js';
import { Dataset } from './dataset.js';
import {
  annotateDataset, suggestRemovals, summarizeWork, fmtBytes, reasonText, verdictLabel, VERDICTS,
} from './analyze.js';
import { collectFiles, streamLines } from './parsers.js';
import { applyStatic, getLang, onLangChange, setLang, t } from './i18n.js';
import { buildZip, zipFileName } from './zip.js';
import {
  localApi, markLocalGone, pickLocalFolder, probeLocal, revealLocal,
  resetProbe, setLocalOutput, stageZip, writeLocalFile,
} from './localio.js';

// ------------------------------------------------------------------ 离线内联资源

/**
 * 离线单文件版(build_offline.mjs 产出)会把模型与演示数据塞进
 *   script[type="application/octet-stream"][data-md-asset="名字"] 的标签体里
 * 这里做一个惰性索引,让 fetchBinary / loadDemo 优先走内联数据。
 * 注意:注释里别写出字面量 "<\/script>",否则内联进 HTML 时会被当成脚本结束。
 */
const INLINE = (typeof window !== 'undefined' && window.__METADROP_EMBEDDED__) || null;
let inlineIndex = null;

function inlineNode(name) {
  if (!INLINE) return null;
  if (!inlineIndex) {
    inlineIndex = new Map();
    for (const node of document.querySelectorAll('script[data-md-asset]')) {
      inlineIndex.set(node.getAttribute('data-md-asset'), node.textContent.trim());
    }
  }
  return inlineIndex.get(name) || null;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function gunzipBytes(bytes) {
  if (typeof DecompressionStream !== 'function') return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 取内联资源;不存在返回 null(表示"该走网络/文件") */
async function inlineBytes(name) {
  const b64 = inlineNode(name);
  if (!b64) return null;
  const raw = base64ToBytes(b64);
  return INLINE.encoding === 'gzip' ? gunzipBytes(raw) : raw;
}

/** 给内联构造出的 Blob 补上文件名 —— .gz 自动解压依赖它 */
function namedBlob(text, name, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type });
  try { Object.defineProperty(blob, '_name', { value: name }); } catch { /* ignore */ }
  return blob;
}

// ------------------------------------------------------------------ DOM

const $ = (id) => document.getElementById(id);
const el = {
  main: $('main'),
  backendBadge: $('backend-badge'),
  localBadge: $('local-badge'),
  btnDemo: $('btn-demo'),
  btnOpen: $('btn-open'),
  btnOutdir: $('btn-outdir'),
  outdirInput: $('outdir-input'),
  btnOutput: $('btn-output'),
  btnExport: $('btn-export'),
  btnReveal: $('btn-reveal'),
  localioBadge: $('localio-badge'),
  fileInput: $('file-input'),
  langToggle: $('lang-toggle'),

  magList: $('mag-list'),
  magCount: $('mag-count'),
  magFilter: $('mag-filter'),

  centerTitle: $('center-title'),
  btnSuggest: $('btn-suggest'),
  btnReset: $('btn-reset'),
  btnResetAll: $('btn-reset-all'),
  qualityStrip: $('quality-strip'),
  qsCompleteness: $('qs-completeness'),
  qsCompletenessDelta: $('qs-completeness-delta'),
  qsContamination: $('qs-contamination'),
  qsContaminationDelta: $('qs-contamination-delta'),
  qsClass: $('qs-class'),
  qsContigs: $('qs-contigs'),
  qsSize: $('qs-size'),
  qsReport: $('qs-report'),

  contigFilter: $('contig-filter'),
  onlyFlagged: $('only-flagged'),
  contigCount: $('contig-count'),
  contigBody: $('contig-body'),
  contigTable: $('contig-table'),
  emptyHint: $('empty-hint'),

  detail: $('detail'),
  statusText: $('status-text'),
  progress: $('progress'),
  progressBar: $('progress-bar'),
  warnToggle: $('warn-toggle'),
  warnCount: $('warn-count'),
  warnPanel: $('warn-panel'),
  warnList: $('warn-list'),
  warnClose: $('warn-close'),

  dropOverlay: $('drop-overlay'),
  hoverCard: $('hover-card'),
};

// ------------------------------------------------------------------ 状态

const state = {
  engine: null,
  ds: null,
  activeMag: null,
  hoverContigId: null,
  sortKey: 'length',
  sortDir: 'desc',
  magFilter: '',
  contigFilter: '',
  onlyFlagged: false,
  hoverCache: new Map(),
  busy: false,
  outDir: null,       // FileSystemDirectoryHandle(浏览器直写那条路)
  localOutPath: '',   // 本地服务那条路:用户指定的绝对路径
  lastOutputDir: '',  // 最近一次真正写出文件的位置,给「打开文件夹」用
  statusRef: { key: 'status.ready' },
};

const ASSET_BASE = 'assets/';
const WASM_URL = 'wasm/checkm2_core.wasm';
const DEMO_BASE = 'samples/demo/';

// ------------------------------------------------------------------ 状态栏

function setStatus(v) {
  state.statusRef = typeof v === 'string' ? { text: v } : v;
  el.statusText.textContent = typeof v === 'string' ? v : t(v.key, v.vars);
}

function refreshStatus() { setStatus(state.statusRef); }

function setProgress(frac, text) {
  if (frac == null) { el.progress.hidden = true; return; }
  el.progress.hidden = false;
  el.progressBar.style.width = `${Math.round(frac * 100)}%`;
  if (text) setStatus(text);
}

/** 警告可能是 {key, vars}(可重译),也可能是历史遗留的字符串 */
function warningText(w) {
  return typeof w === 'string' ? w : t(w.key, w.vars);
}

function showWarnings(list) {
  if (!list || !list.length) { el.warnToggle.hidden = true; return; }
  el.warnToggle.hidden = false;
  el.warnCount.textContent = list.length;
  el.warnToggle.title = t('warn.count', { n: list.length });
  el.warnList.innerHTML = list.map((w) => `<li>${escapeHtml(warningText(w))}</li>`).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ------------------------------------------------------------------ 引擎

async function ensureEngine() {
  if (state.engine) return state.engine;
  setProgress(0.05, { key: 'status.loadingAssets' });

  // 内联优先 → 否则从同目录读(开发版)。两条路都不会把数据发出去。
  const fetchBinary = async (name) => {
    const inline = await inlineBytes(name);
    if (inline) return inline.buffer.slice(inline.byteOffset, inline.byteOffset + inline.byteLength);
    const res = await fetch(ASSET_BASE + name);
    if (!res.ok) throw new Error(t('status.assetFailed', { name, status: res.status }));
    return res.arrayBuffer();
  };

  let wasmBinary = null;
  const inlineWasm = await inlineBytes('checkm2_core.wasm');
  if (inlineWasm) {
    wasmBinary = inlineWasm.buffer.slice(inlineWasm.byteOffset, inlineWasm.byteOffset + inlineWasm.byteLength);
  } else {
    try {
      const res = await fetch(WASM_URL);
      if (res.ok) wasmBinary = await res.arrayBuffer();
    } catch { /* 回退到纯 JS */ }
  }

  state.engine = await CheckM2Engine.create({ fetchBinary, wasmBinary });
  el.backendBadge.textContent = state.engine.backendLabel;
  el.backendBadge.className = 'badge badge-accent';
  el.backendBadge.title = t('badge.backend.title', {
    n: state.engine.manifest.layout?.n_features ?? 0,
    trees: state.engine.gbmComp.nTrees,
  });
  return state.engine;
}

// ------------------------------------------------------------------ 数据加载

async function buildFromFiles(fileMap, label) {
  const engine = await ensureEngine();
  el.emptyHint.classList.add('hidden');

  const ds = await Dataset.build(engine, fileMap, {
    onProgress: (f, msg) => setProgress(0.1 + f * 0.5, msg),
  });

  setProgress(0.6, { key: 'status.annotate' });
  await annotateDataset(ds, {
    onProgress: (f, msg) => setProgress(0.6 + f * 0.35, msg),
  });

  // 工作副本:每个 MAG 一份"已移除 contig"集合
  for (const mag of ds.mags.values()) {
    mag.removedIds = new Set();
    mag.liveCounts = Float64Array.from(mag.baseCounts);
    mag.livePrediction = mag.prediction.recalc;
    mag.liveSummary = mag.summary;
  }

  state.ds = ds;
  state.hoverCache.clear();

  showWarnings(ds.warnings);
  setStatus({
    key: 'status.built',
    vars: {
      label,
      mags: ds.mags.size,
      fasta: ds.stats.nFasta,
      protein: ds.stats.nProtein,
      ko: ds.stats.diamondLines || 0,
      dup: ds.duplicates.size ? t('status.built.dup', { n: ds.duplicates.size }) : '',
    },
  });
  setProgress(null);

  el.btnExport.disabled = false;
  el.btnOutput.disabled = false;
  el.btnResetAll.disabled = false;

  const first = ds.magOrder[0];
  if (first) selectMag(first);
  renderMagList();
}

async function loadDemo() {
  if (state.busy) return;
  state.busy = true;
  try {
    setStatus({ key: 'status.demo.loading' });
    setProgress(0.02, { key: 'status.demo.loading' });

    const files = new Map();
    const inlineDemo = await inlineBytes('demo.json');
    if (inlineDemo) {
      // 离线版:演示数据内联,不碰网络
      const payload = JSON.parse(new TextDecoder().decode(inlineDemo));
      const rels = Object.keys(payload);
      rels.forEach((rel, i) => {
        files.set(rel, namedBlob(payload[rel], rel));
        if ((i & 7) === 0) {
          setProgress(0.02 + 0.08 * ((i + 1) / rels.length),
            { key: 'status.demo.progress', vars: { i: i + 1, n: rels.length } });
        }
      });
    } else {
      const res = await fetch(`${DEMO_BASE}manifest.json`);
      if (!res.ok) throw new Error(t('status.demo.missing'));
      const manifest = await res.json();
      let i = 0;
      for (const rel of manifest.files) {
        if (rel === 'manifest.json') continue;
        // eslint-disable-next-line no-await-in-loop
        const r = await fetch(DEMO_BASE + rel);
        if (!r.ok) continue;
        // eslint-disable-next-line no-await-in-loop
        const blob = await r.blob();
        try { Object.defineProperty(blob, '_name', { value: rel }); } catch { /* ignore */ }
        files.set(rel, blob);
        i++;
        setProgress(0.02 + 0.08 * (i / manifest.files.length),
          { key: 'status.demo.progress', vars: { i, n: manifest.files.length } });
      }
    }
    await buildFromFiles(files, t('btn.demo'));
  } catch (err) {
    console.error(err);
    setStatus({ key: 'status.demo.failed', vars: { msg: err.message } });
  } finally {
    state.busy = false;
  }
}

async function loadFromFileList(source) {
  if (state.busy) return;
  state.busy = true;
  try {
    setStatus({ key: 'status.files.collecting' });
    setProgress(0.02, { key: 'status.files.collecting' });
    const map = await collectFiles(source);
    if (!map.size) {
      setStatus({ key: 'status.files.none' });
      return;
    }
    await buildFromFiles(map, t('btn.open'));
  } catch (err) {
    console.error(err);
    setStatus({ key: 'status.files.failed', vars: { msg: err.message } });
  } finally {
    state.busy = false;
  }
}

// ------------------------------------------------------------------ 选择与移除

function selectMag(name) {
  state.activeMag = name;
  state.hoverContigId = null;
  state.contigFilter = '';
  el.contigFilter.value = '';
  renderMagList();
  renderCenter();
}

/** 切换某个 contig 的保留状态 */
function toggleContig(cid) {
  const mag = currentMag();
  if (!mag) return;
  if (mag.removedIds.has(cid)) mag.removedIds.delete(cid);
  else mag.removedIds.add(cid);
  recomputeLive(mag);
  state.hoverCache.clear();
  renderMagList();
  renderRows();
  renderQualityStrip();
  const c = mag.contigs.get(cid);
  if (c) renderDetail(c, true);
}

/** 用"当前保留的 contig"重算 counts 与预测 */
function recomputeLive(mag) {
  const counts = Float64Array.from(mag.baseCounts);
  const contribs = mag.contributions;
  for (let i = 0; i < mag.contigList.length; i++) {
    if (mag.removedIds.has(mag.contigList[i].id)) {
      CheckM2Engine.applyContribution(counts, contribs[i], -1);
    }
  }
  mag.liveCounts = counts;
  mag.livePrediction = state.engine.predict(counts, {
    nn: mag.forcedModel !== 'general',
    forcedModel: mag.forcedModel,
  });
  mag.liveSummary = state.ds.summarize(mag, mag.removedIds);
}

function currentMag() {
  return state.activeMag ? state.ds.mags.get(state.activeMag) : null;
}

function resetMag() {
  const mag = currentMag();
  if (!mag) return;
  mag.removedIds.clear();
  recomputeLive(mag);
  state.hoverCache.clear();
  renderMagList();
  renderCenter();
}

function resetAll() {
  if (!state.ds) return;
  for (const mag of state.ds.mags.values()) {
    mag.removedIds.clear();
    recomputeLive(mag);
  }
  state.hoverCache.clear();
  renderMagList();
  renderCenter();
  setStatus({ key: 'status.resetAll' });
}

function applySuggestion() {
  if (!state.ds) return;
  const suggestion = suggestRemovals(state.ds);
  for (const mag of state.ds.mags.values()) mag.removedIds.clear();
  for (const [magName, ids] of suggestion) {
    const mag = state.ds.mags.get(magName);
    if (!mag) continue;
    for (const id of ids) if (mag.contigs.has(id)) mag.removedIds.add(id);
  }
  for (const mag of state.ds.mags.values()) recomputeLive(mag);
  state.hoverCache.clear();

  const n = Array.from(suggestion.values()).reduce((a, s) => a + s.size, 0);
  setStatus(n ? { key: 'status.suggest.n', vars: { n } } : { key: 'status.suggest.none' });
  renderMagList();
  renderCenter();
}

// ------------------------------------------------------------------ 悬停预测

/** contig 被移除后(在"当前已移除集合"基础上)的预测 */
function hoverPrediction(mag, c) {
  if (mag.removedIds.has(c.id)) return mag.livePrediction;
  const key = `${mag.name}|${c.id}|${mag.removedIds.size}`;
  const hit = state.hoverCache.get(key);
  if (hit) return hit;

  const scratch = Float64Array.from(mag.liveCounts);
  CheckM2Engine.applyContribution(scratch, c.contribution, -1);
  const pred = state.engine.predict(scratch, {
    nn: mag.forcedModel !== 'general',
    forcedModel: mag.forcedModel,
  });
  if (state.hoverCache.size > 400) state.hoverCache.clear();
  state.hoverCache.set(key, pred);
  return pred;
}

// ------------------------------------------------------------------ 渲染:MAG 列表

function magVerdictCounts(mag) {
  let core = 0; let dup = 0; let bad = 0; let removed = 0;
  for (const c of mag.contigList) {
    if (mag.removedIds && mag.removedIds.has(c.id)) removed++;
    const k = c.verdict ? c.verdict.key : 'neutral';
    if (k === 'duplicate') dup++;
    else if (k === 'contaminant' || k === 'misfit') bad++;
    else core++;
  }
  return { core, dup, bad, removed };
}

const classCls = (key) => (key === 'high' ? 'badge-good' : key === 'medium' ? 'badge-warn' : 'badge-bad');

function renderMagList() {
  const ds = state.ds;
  if (!ds) return;
  const filt = state.magFilter.toLowerCase();
  const names = ds.magOrder.filter((n) => !filt || n.toLowerCase().includes(filt));
  el.magCount.textContent = `${names.length}/${ds.magOrder.length}`;

  el.magList.innerHTML = names.map((name) => {
    const mag = ds.mags.get(name);
    const live = mag.livePrediction || mag.prediction.recalc;
    const rep = mag.prediction.report;
    const cls = mimagClass(live.completeness, live.contamination);
    const v = magVerdictCounts(mag);
    const total = v.core + v.dup + v.bad || 1;
    const isActive = name === state.activeMag;
    const dirty = mag.removedIds && mag.removedIds.size > 0;
    const dC = rep ? live.completeness - rep.completeness : null;
    const dX = rep ? live.contamination - rep.contamination : null;

    const deltaTxt = (d, invert) => {
      if (d == null || Math.abs(d) < 0.01) return '';
      const good = invert ? d < 0 : d > 0;
      return `<span class="delta ${good ? 'up' : 'down'}">${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(2)}</span>`;
    };

    return `
      <button class="mag-card${isActive ? ' is-active' : ''}${dirty ? ' is-dirty' : ''}" data-mag="${escapeHtml(name)}" type="button">
        <div class="mag-card-top">
          <span class="mag-name">${escapeHtml(name)}</span>
          <span class="badge ${classCls(cls.key)}">${escapeHtml(t(cls.labelKey))}</span>
        </div>
        <div class="mag-metrics">
          <div class="mag-metric">
            <label>${escapeHtml(t('qs.completeness'))}</label>
            <b>${live.completeness.toFixed(2)}</b>
            ${deltaTxt(dC, false)}
          </div>
          <div class="mag-metric">
            <label>${escapeHtml(t('qs.contamination'))}</label>
            <b class="${live.contamination > 5 ? 'is-bad' : 'is-good'}">${live.contamination.toFixed(2)}</b>
            ${deltaTxt(dX, true)}
          </div>
        </div>
        <div class="mag-bar">
          <i class="seg-clean" style="width:${(v.core / total) * 100}%"></i>
          <i class="seg-dup" style="width:${(v.dup / total) * 100}%"></i>
          <i class="seg-contam" style="width:${(v.bad / total) * 100}%"></i>
        </div>
        <div class="mag-foot">
          <span class="muted" style="font-size:10.5px">${mag.contigList.length - v.removed} contig</span>
          ${v.dup ? `<span class="badge badge-purple">${escapeHtml(t('verdict.duplicate'))} ${v.dup}</span>` : ''}
          ${v.bad ? `<span class="badge badge-bad">${escapeHtml(t('verdict.misfit'))} ${v.bad}</span>` : ''}
          ${v.removed ? `<span class="mini-note">${escapeHtml(t('hc.removed'))} ${v.removed}</span>` : ''}
          ${rep ? `<span class="muted" style="font-size:10.5px;margin-left:auto">${rep.completeness.toFixed(1)}/${rep.contamination.toFixed(1)}</span>` : ''}
        </div>
      </button>`;
  }).join('');

  for (const node of el.magList.querySelectorAll('.mag-card')) {
    node.addEventListener('click', () => selectMag(node.dataset.mag));
  }
}

// ------------------------------------------------------------------ 渲染:中栏

function renderCenter() {
  const mag = currentMag();
  const has = !!mag;
  el.btnSuggest.disabled = !has;
  el.btnReset.disabled = !has;
  el.contigFilter.disabled = !has;
  el.onlyFlagged.disabled = !has;

  if (!mag) {
    el.contigBody.innerHTML = '';
    el.emptyHint.classList.remove('hidden');
    el.centerTitle.textContent = t('panel.contigs');
    return;
  }
  el.emptyHint.classList.add('hidden');
  el.centerTitle.textContent = mag.name;
  el.qualityStrip.hidden = false;
  renderQualityStrip();
  renderRows();
}

function renderQualityStrip() {
  const mag = currentMag();
  if (!mag) return;
  const live = mag.livePrediction || mag.prediction.recalc;
  const rep = mag.prediction.report;
  const base = mag.prediction.recalc;
  const cls = mimagClass(live.completeness, live.contamination);

  el.qsCompleteness.textContent = live.completeness.toFixed(2);
  el.qsContamination.textContent = live.contamination.toFixed(2);
  el.qsClass.textContent = t(cls.labelKey);
  el.qsClass.className = `badge ${classCls(cls.key)}`;

  const s = mag.liveSummary || mag.summary;
  el.qsContigs.textContent = `${s.contigs}`;
  el.qsSize.textContent = fmtBytes(s.size);
  el.qsReport.textContent = rep
    ? `${rep.completeness.toFixed(2)} / ${rep.contamination.toFixed(2)}`
    : t('qs.noReport');

  const setDelta = (node, value, invert) => {
    if (value == null || Math.abs(value) < 0.01) { node.textContent = ''; node.className = 'delta none'; return; }
    const good = invert ? value < 0 : value > 0;
    node.textContent = `${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`;
    node.className = `delta ${good ? 'up' : 'down'}`;
  };
  setDelta(el.qsCompletenessDelta, live.completeness - base.completeness, false);
  setDelta(el.qsContaminationDelta, live.contamination - base.contamination, true);
}

function visibleContigs(mag) {
  const filt = state.contigFilter.toLowerCase();
  let list = mag.contigList;
  if (filt) list = list.filter((c) => c.id.toLowerCase().includes(filt));
  if (state.onlyFlagged) {
    list = list.filter((c) => c.verdict && (c.verdict.key === 'duplicate'
      || c.verdict.key === 'contaminant' || c.verdict.key === 'misfit'));
  }
  const dir = state.sortDir === 'asc' ? 1 : -1;
  const key = state.sortKey;
  const val = (c) => {
    switch (key) {
      case 'id': return c.id;
      case 'length': return c.length;
      case 'cds': return c.contribution.cds;
      case 'gc': return c.gcContent ?? -1;
      case 'ko': return c.contribution.koIdx.length;
      case 'unique': return c.metrics ? c.metrics.uniqueKo : 0;
      case 'hicIntra': return c.metrics && c.metrics.intra != null ? c.metrics.intra : -1;
      case 'hicInter': return c.metrics && c.metrics.inter != null ? c.metrics.inter : -1;
      case 'abundRatio': return c.metrics && c.metrics.abundCos != null ? c.metrics.abundCos : -1;
      case 'impact': return c.suspicion || 0;
      default: return 0;
    }
  };
  list = list.slice().sort((a, b) => {
    const va = val(a); const vb = val(b);
    if (typeof va === 'string') return dir * va.localeCompare(vb);
    return dir * (va - vb);
  });
  return list;
}

function renderRows() {
  const mag = currentMag();
  if (!mag) return;
  const list = visibleContigs(mag);
  el.contigCount.textContent = `${list.length}/${mag.contigList.length}`;

  const base = mag.prediction.recalc;
  // 百分比以"该 MAG 的原始总长(全部 contig)"为分母 —— 恒定合计 100%,
  // 勾选/取消时每行的数值不会跳动,便于横向比较各 contig 的份量。
  const totalLen = (mag.summary && mag.summary.size) || 0;

  el.contigBody.innerHTML = list.map((c) => {
    const m = c.metrics || {};
    const removed = mag.removedIds.has(c.id);
    const dup = (c.duplicateOf || []).length > 0;
    const v = c.verdict || VERDICTS.neutral;
    const ar = c.afterRemoval;

    let impact = '<span class="muted">–</span>';
    if (ar) {
      const dC = ar.completeness - base.completeness;
      const dX = ar.contamination - base.contamination;
      impact = `<span class="delta ${dX <= -0.01 ? 'up' : (dX >= 0.01 ? 'down' : 'none')}">${dX > 0 ? '+' : '−'}${Math.abs(dX).toFixed(2)}</span>`
        + ` <span class="delta ${dC >= 0.01 ? 'up' : (dC <= -0.01 ? 'down' : 'none')}">${dC > 0 ? '+' : '−'}${Math.abs(dC).toFixed(2)}</span>`;
    }

    const hicCell = (value, isInter) => {
      if (m.intra == null) return '<span class="muted">–</span>';
      const frac = m.outFrac == null ? 0 : m.outFrac;
      const pct = isInter ? frac : (1 - frac);
      const tone = isInter ? (frac >= 0.6 ? 'low' : '') : (pct >= 0.6 ? '' : 'mid');
      return `<span class="mini-bar" title="${isInter ? 'inter' : 'intra'} ${(pct * 100).toFixed(0)}%">`
        + `<span class="track"><i class="${tone}" style="width:${Math.round(pct * 100)}%"></i></span>`
        + `<span>${value >= 1000 ? (value / 1000).toFixed(1) + 'k' : Math.round(value)}</span></span>`;
    };

    const abundCell = m.abundCos == null
      ? '<span class="muted">–</span>'
      : `<span class="mini-bar" title="cos ${m.abundCos.toFixed(3)}">`
        + `<span class="track"><i class="${m.abundCos < 0.85 ? 'low' : (m.abundCos < 0.95 ? 'mid' : '')}" `
        + `style="width:${Math.round(Math.max(0, m.abundCos) * 100)}%"></i></span>`
        + `<span>${m.abundCos.toFixed(2)}</span></span>`;

    // 长度:定长 + 占当前 MAG 总长的百分比
    const sharePct = totalLen > 0 ? (c.length / totalLen) * 100 : 0;
    const lenCell = `${fmtBytes(c.length)}<span class="pct" title="${escapeHtml(t('th.length.title'))}">${
      sharePct >= 10 ? sharePct.toFixed(1) : sharePct.toFixed(2)}%</span>`;

    return `
      <tr data-cid="${escapeHtml(c.id)}" class="${removed ? 'is-removed' : ''}${dup ? ' is-dup' : ''}">
        <td class="col-keep">
          <input type="checkbox" ${removed ? '' : 'checked'} data-cid="${escapeHtml(c.id)}" title="${escapeHtml(t('th.keep.title'))}">
        </td>
        <td class="col-id">${escapeHtml(c.id)}${dup ? `<span class="dup-tag">${escapeHtml(t('verdict.duplicate'))} · ${escapeHtml(c.duplicateOf.join('/'))}</span>` : ''}</td>
        <td class="col-num col-len">${lenCell}</td>
        <td class="col-num">${c.contribution.cds}</td>
        <td class="col-num">${c.gcContent == null ? '–' : c.gcContent.toFixed(1)}</td>
        <td class="col-num">${c.contribution.koIdx.length}</td>
        <td class="col-num">${m.uniqueKo ?? '–'}</td>
        <td class="col-num">${hicCell(m.intra, false)}</td>
        <td class="col-num">${hicCell(m.inter, true)}</td>
        <td class="col-num">${abundCell}</td>
        <td class="col-flag"><span class="badge ${v.cls}">${escapeHtml(verdictLabel(v))}</span>${
    m.placement == null ? '' : `<span class="muted mono" style="font-size:10px;margin-left:5px" title="placement 0..1">${m.placement.toFixed(2)}</span>`}</td>
        <td class="col-impact">${impact}</td>
      </tr>`;
  }).join('');

  for (const tr of el.contigBody.querySelectorAll('tr')) {
    const cid = tr.dataset.cid;
    const c = mag.contigs.get(cid);

    tr.querySelector('input')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleContig(cid);
    });
    tr.addEventListener('click', () => toggleContig(cid));
    tr.addEventListener('mouseenter', (ev) => {
      state.hoverContigId = cid;
      tr.classList.add('is-hover');
      showHover(c, ev);
      renderDetail(c, false);
    });
    tr.addEventListener('mousemove', (ev) => positionHover(ev));
    tr.addEventListener('mouseleave', () => {
      state.hoverContigId = null;
      tr.classList.remove('is-hover');
      el.hoverCard.hidden = true;
    });
  }
}

// ------------------------------------------------------------------ 渲染:悬停卡片

function showHover(c, ev) {
  const mag = currentMag();
  if (!mag || !c) return;
  const pred = hoverPrediction(mag, c);
  const base = mag.prediction.recalc;
  const m = c.metrics || {};
  const v = c.verdict || VERDICTS.neutral;
  const removed = mag.removedIds.has(c.id);
  const totalLen = (mag.summary && mag.summary.size) || 0;

  const dC = pred.completeness - base.completeness;
  const dX = pred.contamination - base.contamination;
  const cls = mimagClass(pred.completeness, pred.contamination);

  const row = (label, value) => `<tr><td>${label}</td><td>${value}</td></tr>`;
  const deltaCell = (d, invert, unit = '') => {
    if (Math.abs(d) < 0.005) return '<span class="delta none">±0.00</span>';
    const good = invert ? d < 0 : d > 0;
    return `<span class="delta ${good ? 'up' : 'down'}">${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(2)}${unit}</span>`;
  };
  const share = totalLen > 0 ? (c.length / totalLen) * 100 : 0;

  el.hoverCard.innerHTML = `
    <div class="hc-head">
      <span class="hc-id">${escapeHtml(c.id)}</span>
      <span class="badge ${v.cls}">${escapeHtml(verdictLabel(v))}</span>
      ${removed ? `<span class="badge badge-warn">${escapeHtml(t('hc.removed'))}</span>` : ''}
    </div>
    <table class="delta-table">
      ${row(t('hc.length'), `${fmtBytes(c.length)} <span class="muted">(${share.toFixed(2)}%)</span> · GC ${c.gcContent == null ? '–' : c.gcContent.toFixed(1) + '%'}`)}
      ${row(t('hc.cdsKo'), `${c.contribution.cds} · ${c.contribution.koIdx.length} <span class="muted">${escapeHtml(t('hc.uniqueOf', { n: m.uniqueKo ?? '–' }))}</span>`)}
      ${row(t('hc.hic'), m.intra == null ? '–'
    : `${Math.round(m.intra)} / ${Math.round(m.inter)}`
      + (m.outFrac != null ? ` <span class="muted">${escapeHtml(t('hc.outFrac', { pct: (m.outFrac * 100).toFixed(0) }))}</span>` : ''))}
      ${row(t('hc.abund'), m.abundCos == null ? '–' : m.abundCos.toFixed(3))}
      ${row(t('hc.placement'), m.placement == null ? '–'
    : `<b>${m.placement.toFixed(3)}</b> <span class="muted">${
      escapeHtml(m.placement >= 0.6 ? t('hc.strength.strong')
        : m.placement >= 0.42 ? t('hc.strength.medium') : t('hc.strength.weak'))}</span>`)}
      <tr class="sep"><td colspan="2" style="padding-top:7px;color:var(--muted);font-size:10.5px;letter-spacing:.4px">${escapeHtml(t('hc.afterRemove'))}</td></tr>
      ${row(t('hc.completeness'), `<b>${pred.completeness.toFixed(2)}</b> ${deltaCell(dC, false)}`)}
      ${row(t('hc.contamination'), `<b>${pred.contamination.toFixed(2)}</b> ${deltaCell(dX, true)}`)}
      ${row(t('hc.class'), `<span class="badge ${classCls(cls.key)}">${escapeHtml(t(cls.labelKey))}</span>`)}
    </table>
    ${c.reasons.length ? `<div style="margin-top:8px;padding-top:7px;border-top:1px solid var(--border);font-size:11px;color:var(--text-2);line-height:1.7">
      ${c.reasons.map((r) => `· ${escapeHtml(reasonText(r))}`).join('<br>')}</div>` : ''}
    <div style="margin-top:7px;font-size:10.5px;color:var(--muted)">${escapeHtml(t(removed ? 'hc.clickRestore' : 'hc.clickRemove'))}</div>
  `;
  el.hoverCard.hidden = false;
  positionHover(ev);
}

function positionHover(ev) {
  if (el.hoverCard.hidden) return;
  const pad = 14;
  const rect = el.hoverCard.getBoundingClientRect();
  let x = ev.clientX + pad;
  let y = ev.clientY + pad;
  if (x + rect.width > window.innerWidth - 8) x = ev.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = Math.max(8, ev.clientY - rect.height - pad);
  el.hoverCard.style.left = `${Math.max(8, x)}px`;
  el.hoverCard.style.top = `${Math.max(8, y)}px`;
}

// ------------------------------------------------------------------ 渲染:详情面板

let detailContigId = null;

function renderDetail(c, pinned) {
  detailContigId = c ? c.id : null;
  if (!c) {
    el.detail.innerHTML = `<p class="muted hint">${escapeHtml(t('detail.hint'))}</p>`;
    return;
  }
  const mag = currentMag();
  if (!mag) return;
  const pred = hoverPrediction(mag, c);
  const base = mag.prediction.recalc;
  const m = c.metrics || {};
  const v = c.verdict || VERDICTS.neutral;
  const cls = mimagClass(pred.completeness, pred.contamination);
  const removed = mag.removedIds.has(c.id);
  const totalLen = (mag.summary && mag.summary.size) || 0;
  const share = totalLen > 0 ? (c.length / totalLen) * 100 : 0;

  const verdictText = t(`body.${v.key}`, { mag: mag.name });

  // 丢失的 KEGG 通路 / 模块
  let lost = [];
  try {
    const idx = mag.contigList.indexOf(c);
    if (idx >= 0) lost = state.engine.explainRemoval(mag.baseCounts, mag.contributions, [idx], 7);
  } catch { /* 忽略 */ }

  const partners = (m.top || []).slice(0, 8);

  let abundanceHtml = '';
  if (Array.isArray(c.abundance)) {
    const max = Math.max(...c.abundance.map((x) => (Number.isFinite(x) ? x : 0)), 1e-9);
    const labels = state.ds.abundance.samples;
    abundanceHtml = `<div class="spark-wrap"><div class="spark">${
      c.abundance.map((x, i) => `<div class="bar" style="height:${Math.max(3, (x / max) * 100)}%"><span>${escapeHtml(labels[i] || i + 1)}</span></div>`).join('')
    }</div></div>`;
  }

  el.detail.innerHTML = `
    <div class="title">${escapeHtml(c.id)}</div>
    <div class="subtitle">${escapeHtml(t('detail.belongs', { mag: mag.name }))} · ${removed ? `<b>${escapeHtml(t('detail.removedNow'))}</b>` : escapeHtml(t('detail.kept'))}</div>

    <br>
    <div class="verdict ${v.tone}">
      <div class="verdict-head"><span class="badge ${v.cls}">${escapeHtml(verdictLabel(v))}</span><b>${escapeHtml(t('detail.reasonTitle'))}</b></div>
      <p>${escapeHtml(verdictText)}</p>
      ${c.reasons.length ? `<p style="margin-top:6px">${
        c.reasons.map((r) => `· ${escapeHtml(reasonText(r))}`).join('<br>')}</p>` : ''}
    </div>

    <h3>${escapeHtml(t('detail.serialTitle'))}</h3>
    <dl class="kv">
      <dt>${escapeHtml(t('detail.length'))}</dt><dd>${fmtBytes(c.length)}</dd>
      <dt>${escapeHtml(t('detail.lengthShare'))}</dt><dd>${share.toFixed(2)}%</dd>
      <dt>${escapeHtml(t('detail.gc'))}</dt><dd>${c.gcContent == null ? '–' : c.gcContent.toFixed(2) + '%'}</dd>
      <dt>${escapeHtml(t('detail.cds'))}</dt><dd>${c.contribution.cds}</dd>
      <dt>${escapeHtml(t('detail.aa'))}</dt><dd>${c.contribution.aalength.toLocaleString()}</dd>
      <dt>${escapeHtml(t('detail.ko'))}</dt><dd>${c.contribution.koIdx.length}</dd>
      <dt>${escapeHtml(t('detail.uniqueKo'))}</dt><dd>${m.uniqueKo ?? '–'}</dd>
      <dt>${escapeHtml(t('detail.placement'))}</dt><dd>${m.placement == null ? '–' : m.placement.toFixed(3)}</dd>
    </dl>

    <h3>${escapeHtml(t('detail.removeTitle'))}</h3>
    <table class="delta-table">
      <tr><td>${escapeHtml(t('hc.completeness'))}</td><td>${pred.completeness.toFixed(2)} <span class="muted">${escapeHtml(t('detail.orig', { v: base.completeness.toFixed(2) }))}</span></td></tr>
      <tr><td>${escapeHtml(t('hc.contamination'))}</td><td>${pred.contamination.toFixed(2)} <span class="muted">${escapeHtml(t('detail.orig', { v: base.contamination.toFixed(2) }))}</span></td></tr>
      <tr><td>${escapeHtml(t('hc.class'))}</td><td><span class="badge ${classCls(cls.key)}">${escapeHtml(t(cls.labelKey))}</span></td></tr>
      ${pred.completenessGeneral != null ? `<tr><td>${escapeHtml(t('detail.generalModel'))}</td><td>${pred.completenessGeneral.toFixed(2)}</td></tr>` : ''}
      ${pred.completenessSpecific != null ? `<tr><td>${escapeHtml(t('detail.specificModel'))}</td><td>${pred.completenessSpecific.toFixed(2)}</td></tr>` : ''}
    </table>

    ${m.intra != null ? `
    <h3>${escapeHtml(t('detail.hicTitle'))}</h3>
    <div style="font-size:11.5px;color:var(--text-2);margin-bottom:5px">
      ${escapeHtml(m.outFrac != null
    ? t('detail.hicSummary', { intra: Math.round(m.intra), inter: Math.round(m.inter), pct: (m.outFrac * 100).toFixed(0) })
    : t('detail.hicSummaryNoFrac', { intra: Math.round(m.intra), inter: Math.round(m.inter) }))}
      ${m.home ? `<br>${t('detail.hicHome', { mag: escapeHtml(m.home) })}` : ''}
    </div>
    <div class="partner-list">
      ${partners.map((p) => `<div class="partner-row ${p.inside ? 'inside' : 'outside'}">
        <span class="swatch" style="background:${p.inside ? 'var(--good)' : 'var(--bad)'}"></span>
        <span class="pid">${escapeHtml(p.id)}</span>
        <span class="psig">${Math.round(p.signal)}</span>
        ${p.inside ? '' : `<span class="muted" style="font-size:10px">${escapeHtml((p.mags || []).join('/'))}</span>`}
      </div>`).join('')}
    </div>` : ''}

    ${abundanceHtml ? `<h3>${escapeHtml(t('detail.abundTitle'))}</h3>${abundanceHtml}` : ''}

    ${lost.length ? `
    <h3>${escapeHtml(t('detail.lostTitle'))}</h3>
    <div class="lost-list">
      ${lost.slice().sort((a, b) => b.delta - a.delta).map((x) => `<div class="lost-row">
        <span class="lname" title="${escapeHtml(x.name)}">${escapeHtml(x.name)}</span>
        <span class="ldelta">${x.delta > 0 ? '−' : '+'}${Math.abs(x.delta)}</span>
      </div>`).join('')}
    </div>` : ''}

    <h3>${escapeHtml(t('detail.actionTitle'))}</h3>
    <button class="btn btn-sm ${removed ? '' : 'btn-primary'}" data-action="toggle" type="button">
      ${escapeHtml(removed ? t('detail.doRestore') : t('detail.doRemove', { mag: mag.name }))}
    </button>
  `;

  el.detail.querySelector('[data-action="toggle"]')?.addEventListener('click', () => toggleContig(c.id));
  void pinned;
}

// ------------------------------------------------------------------ 输出位置

const supportsDirPicker = () => typeof window !== 'undefined'
  && (typeof window.showDirectoryPicker === 'function' || typeof window.__METADROP_PICK_DIR__ === 'function');

/**
 * 输出位置有两条互斥的路子,优先级从高到低:
 *   local   —— 本地服务在线,用户给的是一个真实的绝对路径,字节直落磁盘;
 *   browser —— File System Access 目录手柄,只拿得到目录名,但也写的是本机磁盘。
 * 都没有就返回 null,调用方应退化成"打包成 ZIP 下载"。
 */
function outputTarget() {
  if (localApi.available && state.localOutPath) return { kind: 'local', path: state.localOutPath };
  if (state.outDir) return { kind: 'browser', handle: state.outDir };
  return null;
}

/** 把输出区所有视觉状态收敛到一处 —— 状态一变就整块刷新,省得东补一处西补一处 */
function refreshOutputUi() {
  const hasData = !!state.ds;
  el.btnOutput.disabled = !hasData;
  el.btnExport.disabled = !hasData;

  if (localApi.available) {
    // 本地服务在线:输入框可编辑,填的是绝对路径
    el.outdirInput.readOnly = false;
    el.outdirInput.classList.add('is-local');
    el.outdirInput.classList.toggle('is-set', !!state.localOutPath);
    el.outdirInput.title = state.localOutPath;
    el.outdirInput.placeholder = t('outdir.placeholder');
    el.localioBadge.hidden = false;
    el.localioBadge.textContent = t('badge.localio');
    el.localioBadge.title = t('badge.localio.title');
  } else {
    // 只有浏览器目录手柄:输入框是只读的,显示目录名而不是路径(浏览器拿不到路径)
    el.outdirInput.readOnly = true;
    el.outdirInput.classList.remove('is-local');
    el.outdirInput.value = state.outDir ? state.outDir.name : '';
    el.outdirInput.title = state.outDir ? state.outDir.name : t('btn.outdir.none');
    el.outdirInput.placeholder = t('outdir.placeholder');
    el.outdirInput.classList.toggle('is-set', !!state.outDir);
    el.localioBadge.hidden = true;
  }

  el.btnReveal.hidden = !(localApi.available && (state.lastOutputDir || state.localOutPath));
}

/**
 * 「选择…」按钮:
 *   本地服务在线 → 让**服务进程**弹操作系统原生选择框(只有它拿得到绝对路径);
 *   否则         → 浏览器的 File System Access 目录选择器。
 */
async function pickOutputDir() {
  if (localApi.available) {
    try {
      setStatus({ key: 'status.output.picking' });
      const r = await pickLocalFolder();
      if (r.cancelled || !r.output) {
        setStatus({ key: 'status.output.pickCancelled' });
        return null;
      }
      state.localOutPath = r.output.dir;
      localApi.output = r.output;
      el.outdirInput.value = r.output.dir;
      refreshOutputUi();
      setStatus({ key: 'status.export.dirSet', vars: { name: r.output.dir } });
      return r.output;
    } catch (err) {
      // 弹不出原生对话框(无图形界面等)就退化成"手填路径",功能不丢
      setStatus({ key: 'status.output.typePath', vars: { dir: state.localOutPath } });
      el.outdirInput.focus();
      el.outdirInput.select();
      return null;
    }
  }

  if (!supportsDirPicker()) {
    setStatus({ key: 'status.export.dirUnsupported' });
    return null;
  }
  try {
    // 测试/嵌入时可以用 __METADROP_PICK_DIR__ 注入一个手柄,避免弹原生选择框
    const handle = typeof window.__METADROP_PICK_DIR__ === 'function'
      ? await window.__METADROP_PICK_DIR__()
      : await window.showDirectoryPicker({ id: 'metadrop-output', mode: 'readwrite' });
    if (!handle) return null;
    state.outDir = handle;
    refreshOutputUi();
    setStatus({ key: 'status.export.dirSet', vars: { name: handle.name } });
    return handle;
  } catch (err) {
    if (err && err.name === 'AbortError') return null;
    // file:// 下浏览器一律拒绝目录选择(不透明源),这不是"失败"而是"这条路走不通",
    // 该提示用户改用手填路径或「导出 ZIP」,别甩一个 SecurityError 出来吓人。
    const unsupported = (typeof location !== 'undefined' && location.protocol === 'file:')
      || (err && (err.name === 'SecurityError' || err.name === 'NotAllowedError'));
    setStatus(unsupported
      ? { key: 'status.export.dirUnsupported' }
      : { key: 'status.export.dirFail', vars: { msg: err.message } });
    return null;
  }
}

/** 用户在路径框里敲完之后生效(回车或失焦都算) */
async function applyOutdirInput() {
  if (!localApi.available) return;
  const v = el.outdirInput.value.trim();
  if (v === state.localOutPath) return;
  if (!v) { el.outdirInput.value = state.localOutPath; return; }
  try {
    const out = await setLocalOutput(v);
    state.localOutPath = out.dir;
    el.outdirInput.value = out.dir;
    refreshOutputUi();
    setStatus({ key: 'status.export.dirSet', vars: { name: out.dir } });
  } catch (err) {
    setStatus({ key: 'status.export.dirFail', vars: { msg: err.message } });
    el.outdirInput.value = state.localOutPath;   // 回滚,别让框里留着一个不存在的路径
  }
}

// ------------------------------------------------------------------ 导出

const wrap = (s, w) => {
  if (!s) return '';
  const out = s.match(new RegExp(`.{1,${w}}`, 'g'));
  return out ? out.join('\n') : '';
};

async function filterFasta(file, keepSet) {
  const parts = [];
  let cur = null;
  let buf = [];
  const flush = () => {
    if (cur && keepSet.has(cur) && buf.length) parts.push(`>${cur}\n${wrap(buf.join(''), 70)}`);
    cur = null; buf = [];
  };
  await streamLines(file, (line) => {
    if (!line) return;
    if (line.charCodeAt(0) === 62) {
      flush();
      let id = line.slice(1).trim().split(/\s+/)[0];
      if (id.endsWith('|')) id = id.slice(0, -1);
      cur = id;
    } else if (cur) buf.push(line.trim());
  });
  flush();
  return parts.join('\n') + (parts.length ? '\n' : '');
}

/**
 * 触发一次下载。落盘的节奏交给浏览器,它会先写进系统临时目录再移到你的下载目录,
 * 所以"从本地临时文件夹下载到下载文件夹"这件事是浏览器本来就有的行为。
 */
function saveBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  // 别在 click() 之后立刻摘掉节点并回收 URL —— 部分浏览器会因此取消下载。
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 5000);
}

/** 从一个 http 地址下载(本地服务把压缩包暂存在本机临时目录时走这条) */
function saveUrl(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 5000);
}

/** 浏览器的目录手柄:一次写一个文件 */
async function writeTextToDir(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  await w.close();
}

function summaryTsv(ds) {
  const rows = summarizeWork(ds);
  const cols = ['mag', 'contigsBefore', 'contigsAfter', 'removedContigs',
    'lengthBefore', 'lengthAfter',
    'reportCompleteness', 'reportContamination',
    'completenessBefore', 'completenessAfter', 'contaminationBefore', 'contaminationAfter',
    'mimag', 'mimagKey'];
  const head = ['MAG', 'Contigs_Original', 'Contigs_Kept', 'Removed_Contigs',
    'Length_Before_bp', 'Length_After_bp',
    'Report_Completeness', 'Report_Contamination',
    'Recalc_Completeness_Original', 'Recalc_Completeness_Cleaned',
    'Recalc_Contamination_Original', 'Recalc_Contamination_Cleaned',
    'Quality_Class', 'Quality_Class_Key'];
  let tsv = `${head.join('\t')}\n`;
  for (const r of rows) {
    tsv += `${cols.map((c) => {
      const v = r[c];
      if (v == null || v === '') return '';
      return typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v);
    }).join('\t')}\n`;
  }
  return tsv;
}

function contigsTsv(ds) {
  let detail = 'MAG\tContig\tKept\tVerdict\tVerdict_Key\tLength\tLength_Share\tCDS\tKO\tUniqueKO\tHiC_Intra\tHiC_Inter\tHiC_OutFrac\tAbundance_Cos\tPlacement\tPred_Completeness_AfterRemoval\tPred_Contamination_AfterRemoval\tDuplicateOf\n';
  for (const mag of ds.mags.values()) {
    const totalLen = (mag.summary && mag.summary.size) || 0;
    for (const c of mag.contigList) {
      const m = c.metrics || {};
      detail += [
        mag.name, c.id, mag.removedIds.has(c.id) ? 'no' : 'yes',
        c.verdict ? c.verdict.key : '', c.verdict ? c.verdict.key : '', c.length,
        totalLen > 0 ? ((c.length / totalLen) * 100).toFixed(3) : '',
        c.contribution.cds,
        c.contribution.koIdx.length, m.uniqueKo ?? '',
        m.intra == null ? '' : Math.round(m.intra),
        m.inter == null ? '' : Math.round(m.inter),
        m.outFrac == null ? '' : m.outFrac.toFixed(3),
        m.abundCos == null ? '' : m.abundCos.toFixed(4),
        m.placement == null ? '' : m.placement.toFixed(4),
        c.afterRemoval ? c.afterRemoval.completeness.toFixed(2) : '',
        c.afterRemoval ? c.afterRemoval.contamination.toFixed(2) : '',
        (c.duplicateOf || []).join(','),
      ].join('\t') + '\n';
    }
  }
  return detail;
}

// ------------------------------------------------------------------ 输出 / 打包

const SUMMARY_FILE = 'checkm2_web_summary.tsv';
const CONTIGS_FILE = 'checkm2_web_contigs.tsv';

/** 打包成 ZIP 时数据要整体进内存,到这个量级就该劝用户改用输出文件夹直写 */
const ZIP_MEMORY_LIMIT = 1500 * 1024 * 1024;

/**
 * 逐个"产出"要写出的文件,并交给 consume 处理。
 *
 * 做成边生成边消费、而不是先攒成一个数组,是因为清理后的 MAG 序列可能上百 MB:
 * 直写磁盘时峰值内存只有**单个**文件,攒数组则要整份常驻。
 *
 * @param {(name:string, text:string)=>Promise<void>|void} consume
 * @returns {Promise<{count:number, bytes:number, emptyMags:number}>}
 */
async function forEachOutputFile(ds, consume) {
  const mags = Array.from(ds.mags.values()).filter((m) => m.fastaFile);
  const total = 2 + mags.length;
  let count = 0;
  let bytes = 0;
  let emptyMags = 0;

  const put = async (name, text) => {
    bytes += new Blob([text]).size;
    setProgress(0.05 + 0.9 * (count / total), { key: 'status.output.file', vars: { name } });
    await consume(name, text);
    count++;
  };

  await put(SUMMARY_FILE, summaryTsv(ds));
  await put(CONTIGS_FILE, contigsTsv(ds));

  for (let i = 0; i < mags.length; i++) {
    const mag = mags[i];
    const keep = new Set(mag.contigList
      .filter((c) => !mag.removedIds.has(c.id)).map((c) => c.id));
    if (!keep.size) emptyMags++;
    setProgress(0.05 + 0.9 * ((2 + i) / total), { key: 'status.export.mag', vars: { mag: mag.name } });
    // eslint-disable-next-line no-await-in-loop
    const text = await filterFasta(mag.fastaFile, keep);
    // eslint-disable-next-line no-await-in-loop
    await put(`${mag.name}.cleaned.fa`, text);
  }
  return { count, bytes, emptyMags };
}

/**
 * 「完成输出」——把结果写进输出文件夹。
 *
 * 输出文件夹有两种来源,都写的是本机磁盘:
 *   · 本地服务在线 → 用户给的绝对路径,POST 给服务进程落盘(不经过浏览器下载);
 *   · 否则         → File System Access 目录手柄。
 * 一个都没设时,按约定退化成「导出 ZIP」,并在状态栏说清楚为什么。
 */
async function writeToOutput() {
  const ds = state.ds;
  if (!ds || state.busy) return;

  const target = outputTarget();
  if (!target) {
    // 没设输出文件夹就按约定退化成打包下载。注意交给 exportZip 去写状态栏 ——
    // 这里先写一句"为什么"会立刻被打包流程覆盖掉,用户根本看不见。
    return exportZip({ reason: 'noDir' });
  }

  state.busy = true;
  try {
    setStatus({ key: 'status.exporting' });
    setProgress(0.05, { key: 'status.export.genSummary' });

    const r = await forEachOutputFile(ds, async (name, text) => {
      if (target.kind === 'local') await writeLocalFile(name, text);
      else await writeTextToDir(target.handle, name, text);
    });
    setProgress(null);

    if (target.kind === 'local') {
      state.lastOutputDir = target.path;
      setStatus({ key: 'status.output.doneLocal', vars: { dir: target.path, n: r.count } });
    } else {
      state.lastOutputDir = '';
      setStatus({ key: 'status.output.doneBrowser', vars: { name: target.handle.name, n: r.count } });
    }
    if (r.emptyMags) {
      showWarnings((ds.warnings || []).concat([t('warn.emptyMagOutput', { n: r.emptyMags })]));
    }
    refreshOutputUi();
  } catch (err) {
    console.error(err);
    // 中途连不上本地服务:退回浏览器方式并说清楚,别留下"看起来成功了"的假象
    if (localApi.available && err && err.message === 'LOCAL_NOT_AVAILABLE') {
      markLocalGone();
      refreshOutputUi();
      setStatus({ key: 'status.local.lost' });
    } else {
      setStatus({ key: 'status.export.failed', vars: { msg: err.message } });
    }
  } finally {
    state.busy = false;
  }
}

/**
 * 「导出 ZIP」——把全部结果打成一个压缩包。
 *
 * 若本地服务在线,先让服务把包写到本机临时目录再取回下载:这样浏览器不用把
 * 整包常驻内存,用户也能看到包实际落在哪。服务不在线就纯浏览器打包 + 下载。
 *
 * @param {{reason?: 'noDir'}} [opts] reason='noDir' 表示这次是"没设输出文件夹"触发的,
 *        状态栏要顺带把原因说清楚(否则用户会奇怪为什么不按「完成输出」的语义走)。
 */
async function exportZip(opts = {}) {
  const ds = state.ds;
  if (!ds || state.busy) return;
  state.busy = true;
  try {
    setStatus({ key: 'status.zip.started' });
    setProgress(0.05, { key: 'status.export.genSummary' });

    const entries = [];
    let total = 0;
    const r = await forEachOutputFile(ds, (name, text) => {
      total += new Blob([text]).size;
      entries.push({ name, data: text });
    });

    if (total > ZIP_MEMORY_LIMIT) {
      setProgress(null);
      setStatus({
        key: 'status.zip.tooBig',
        vars: { size: fmtBytes(total) },
      });
      return;
    }

    const blob = await buildZip(entries, {
      onProgress: (ratio, name) => setProgress(
        0.2 + 0.75 * ratio,
        { key: 'status.output.file', vars: { name } },
      ),
    });
    setProgress(null);

    const name = zipFileName('metadrop_results');
    let stagedPath = '';
    if (localApi.available) {
      try {
        const st = await stageZip(name, blob);
        stagedPath = st.path;
        saveUrl(st.downloadUrl, name);
      } catch (err) {
        stagedPath = '';
      }
    }
    if (!stagedPath) saveBlob(name, blob);

    setStatus({
      key: opts.reason === 'noDir' ? 'status.zip.doneNoDir' : 'status.zip.done',
      vars: {
        n: r.count,
        name,
        extra: stagedPath ? t('status.zip.staged', { path: stagedPath }) : '',
      },
    });
    if (r.emptyMags) {
      showWarnings((ds.warnings || []).concat([t('warn.emptyMagOutput', { n: r.emptyMags })]));
    }
  } catch (err) {
    console.error(err);
    setProgress(null);
    setStatus({ key: 'status.zip.failed', vars: { msg: err.message } });
  } finally {
    state.busy = false;
  }
}

/** 在资源管理器 / 访达里定位到输出文件夹(只有本地服务在做得到) */
async function revealOutput() {
  if (!localApi.available) return;
  const dir = state.lastOutputDir || state.localOutPath || (localApi.output && localApi.output.dir) || '';
  try {
    await revealLocal(dir);
  } catch (err) {
    setStatus({ key: 'status.reveal.fail', vars: { msg: err.message } });
  }
}

// ------------------------------------------------------------------ 事件绑定

function bindEvents() {
  el.btnDemo.addEventListener('click', loadDemo);
  el.btnOpen.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => {
    const picked = el.fileInput.files;
    if (picked?.length) {
      // 必须先快照:input.value 一旦被清空,这个活 FileList 就空了
      const snapshot = Array.from(picked);
      el.fileInput.value = '';
      loadFromFileList(snapshot);
    } else {
      el.fileInput.value = '';
    }
  });
  el.btnOutdir.addEventListener('click', pickOutputDir);
  el.btnOutput.addEventListener('click', writeToOutput);
  el.btnExport.addEventListener('click', exportZip);
  el.btnReveal.addEventListener('click', revealOutput);

  // 路径框:回车生效,失焦也生效(本地服务在线时才是可编辑的)
  el.outdirInput.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    void applyOutdirInput();
    el.outdirInput.blur();
  });
  el.outdirInput.addEventListener('blur', () => { void applyOutdirInput(); });

  // 语言切换
  el.langToggle?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-lang]');
    if (!btn) return;
    setLang(btn.dataset.lang);
  });

  el.magFilter.addEventListener('input', () => {
    state.magFilter = el.magFilter.value.trim();
    renderMagList();
  });
  el.contigFilter.addEventListener('input', () => {
    state.contigFilter = el.contigFilter.value.trim();
    renderRows();
  });
  el.onlyFlagged.addEventListener('change', () => {
    state.onlyFlagged = el.onlyFlagged.checked;
    renderRows();
  });

  el.btnSuggest.addEventListener('click', applySuggestion);
  el.btnReset.addEventListener('click', resetMag);
  el.btnResetAll.addEventListener('click', resetAll);

  for (const th of el.contigTable.querySelectorAll('th.sortable')) {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      else { state.sortKey = key; state.sortDir = key === 'id' ? 'asc' : 'desc'; }
      for (const o of el.contigTable.querySelectorAll('th.sortable')) {
        o.classList.remove('sort-asc', 'sort-desc');
      }
      th.classList.add(state.sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
      renderRows();
    });
  }
  el.contigTable.querySelector('th[data-sort="length"]')?.classList.add('sort-desc');

  el.warnToggle.addEventListener('click', () => { el.warnPanel.hidden = !el.warnPanel.hidden; });
  el.warnClose.addEventListener('click', () => { el.warnPanel.hidden = true; });

  // 拖放
  let dragDepth = 0;
  window.addEventListener('dragenter', (ev) => {
    if (!ev.dataTransfer?.types?.includes('Files')) return;
    ev.preventDefault();
    dragDepth++;
    el.dropOverlay.classList.add('active');
  });
  window.addEventListener('dragover', (ev) => { ev.preventDefault(); });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) el.dropOverlay.classList.remove('active');
  });
  window.addEventListener('drop', (ev) => {
    ev.preventDefault();
    dragDepth = 0;
    el.dropOverlay.classList.remove('active');
    const dt = ev.dataTransfer;
    if (!dt) return;
    // 必须在事件同步阶段把 entries / files 取出来:
    // dataTransfer 在事件处理函数返回后就失效了,异步再去读会拿到空列表。
    const entries = dt.items
      ? Array.from(dt.items)
        .map((i) => (typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null))
        .filter(Boolean)
      : [];
    const fs = dt.files ? Array.from(dt.files) : [];
    if (entries.length || fs.length) loadFromFileList({ entries, files: fs });
  });

  // 快捷键:R 还原本 MAG,S 自动建议,E 完成输出,Z 导出 ZIP,L 切语言
  window.addEventListener('keydown', (ev) => {
    if (ev.target instanceof HTMLInputElement) return;
    const k = ev.key.toLowerCase();
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (k === 'r') resetMag();
    else if (k === 's') applySuggestion();
    else if (k === 'e') writeToOutput();
    else if (k === 'z') exportZip();
    else if (k === 'l') setLang(getLang() === 'zh' ? 'en' : 'zh');
  });

  // 语言变化:静态文案由 i18n 刷新,动态内容在这里整体重渲染
  onLangChange(() => {
    refreshStatus();
    refreshOutputUi();
    if (state.ds) {
      renderMagList();
      renderCenter();
      showWarnings(state.ds.warnings);
      if (state.hoverContigId) {
        const mag = currentMag();
        const c = mag && mag.contigs.get(state.hoverContigId);
        if (c) renderDetail(c, true);
      }
    } else {
      el.centerTitle.textContent = t('panel.contigs');
    }
  });
}

// ------------------------------------------------------------------ 启动

function init() {
  // 先按当前语言把静态文案与 <html lang> 对齐(语言取自 localStorage 或浏览器)
  applyStatic();
  document.documentElement.lang = getLang() === 'zh' ? 'zh-CN' : 'en';
  document.title = t('app.docTitle');
  if (INLINE) {
    const b = document.createElement('span');
    b.className = 'badge badge-quiet badge-offline';
    b.textContent = t('badge.offline');
    b.title = t('badge.offline.title');
    el.localBadge.after(b);
  }
  el.localBadge.title = t('badge.local.title');

  bindEvents();
  el.centerTitle.textContent = t('panel.contigs');
  refreshOutputUi();

  // 探测本机是否跑着 metadrop 的本地服务。探到了就把输出方式切成"直写磁盘",
  // 探不到就维持浏览器那套(目录手柄 / 打包下载),用户完全不用管这个区别。
  probeLocal().then(() => {
    if (localApi.available) {
      state.localOutPath = (localApi.output && localApi.output.dir) || '';
      el.outdirInput.value = state.localOutPath;
      refreshOutputUi();
      setStatus({
        key: 'status.local.on',
        vars: { version: localApi.version, dir: state.localOutPath },
      });
    } else {
      refreshOutputUi();
    }
  });

  // 预热引擎(不阻塞界面),用户点"载入演示数据"时就不用等太久
  ensureEngine().then(() => {
    // 本地服务已经把状态栏写成"已连上本机服务"了,别覆盖掉
    if (!localApi.available) setStatus({ key: 'status.readyHint' });
  }).catch((err) => {
    console.error(err);
    el.backendBadge.textContent = t('badge.backend.failed');
    el.backendBadge.className = 'badge badge-bad';
    setStatus({ key: 'status.engineFailed', vars: { msg: err.message } });
  });
}

init();

// 便于自动化测试与二次开发直接拿到内部对象
if (typeof window !== 'undefined') {
  window.MetaDrop = {
    state,
    localApi,
    get engine() { return state.engine; },
    get dataset() { return state.ds; },
    writeToOutput,
    exportZip,
    pickOutputDir,
    applyOutdirInput,
    revealOutput,
    outputTarget,
    forEachOutputFile,
    refreshOutputUi,
    resetLocalProbe: resetProbe,
    selectMag,
    toggleContig,
    applySuggestion,
    summaryTsv,
    contigsTsv,
    filterFasta,
    t,
    setLang,
    getLang,
  };
}
