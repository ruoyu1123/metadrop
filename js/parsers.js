/**
 * parsers.js — 输入数据解析。
 *
 * 支持四类输入:
 *   1. CheckM2 结果目录   quality_report.tsv + protein_files/*.faa + diamond_output/DIAMOND_RESULTS*.tsv
 *   2. MAG 组装文件        .fna/.fa/.fasta(核苷酸)或 .faa(蛋白,配 --genes 使用)
 *   3. Hi-C 信号表         三列边表(contigA contigB signal)或稠密矩阵
 *   4. 丰度表              contig/MAG × 样本 的数值表(coverM 等输出)
 */

import { t } from './i18n.js';

/** MAG 核苷酸序列:.fa / .fna / .fasta / .fas / .ffn,允许 .gz */
export const NUC_EXT = /\.(fna|fa|fasta|fas|ffn)(\.gz)?$/i;
/** 蛋白序列:.faa / .pep / .prot,允许 .gz */
export const PROT_EXT = /\.(faa|pep|prot)(\.gz)?$/i;
const TABULAR_EXT = /\.(tsv|txt|csv)$/i;

// ---------------------------------------------------------------------------- 基础工具

/**
 * 把拖拽/选择得到的文件整理成 {相对路径: File}。
 *
 * 入参可以是:
 *   - FileList / File 数组(选择文件夹或普通多选)
 *   - { entries, files }  —— 调用方在事件处理函数里同步提取好的快照(推荐用于拖放)
 *   - DataTransfer        —— 也能直接吃,但只建议在事件同步阶段立即调用
 *
 * ⚠️ 两个生命周期陷阱:
 *   1. `input.files` / `dataTransfer.files` 是**活的** FileList —— 给 `input.value`
 *      赋空值,内容立刻消失。调用方必须先 `Array.from()` 快照。
 *   2. `dataTransfer.items` 在事件处理函数返回后即失效 —— 目录拖放必须在事件里
 *      同步 `webkitGetAsEntry()`,把 entries 取出来再异步处理。
 */
export async function collectFiles(source) {
  const files = new Map();

  // 1) 优先使用调用方同步提取好的 FileSystemEntry(可递归目录)
  let entries = [];
  if (source && Array.isArray(source.entries)) {
    entries = source.entries.filter(Boolean);
  } else if (source && source.items && !Array.isArray(source.items)) {
    entries = Array.from(source.items)
      .map((i) => (typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null))
      .filter(Boolean);
  }

  // 2) 普通文件列表
  const plain = Array.from(
    (source && source.files) ? source.files
      : (Array.isArray(source) ? source : (source ? Array.from(source) : [])),
  );

  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej));
      files.set((prefix ? prefix + '/' : '') + f.name, f);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const entries2 = await new Promise((res) => reader.readEntries(res, () => res([])));
      for (const e of entries2) await walk(e, (prefix ? prefix + '/' : '') + entry.name);
    }
  };

  if (entries.length) {
    for (const e of entries) await walk(e, '');
  } else {
    for (const f of plain) files.set(f.webkitRelativePath || f.name, f);
  }
  return files;
}

export function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () => resolve(r.result);
    r.readAsText(file);
  });
}

/** 大文件按块读取为字符串,避免一次性占用过多内存 */
export async function readTextStream(file, onProgress) {
  const chunkSize = 1 << 20;
  let text = '';
  let offset = 0;
  while (offset < file.size) {
    const slice = file.slice(offset, Math.min(offset + chunkSize, file.size));
    // eslint-disable-next-line no-await-in-loop
    text += await readTextFile(slice);
    offset += chunkSize;
    if (onProgress) onProgress(Math.min(1, offset / file.size));
  }
  return text;
}

/** 逐块按行解析,避免把整个文件读成一个大字符串。自动识别 .gz。 */
export async function streamLines(file, onLine, onProgress) {
  if (isGzip(file)) return gzipLines(file, onLine);
  const chunkSize = 4 << 20;
  let offset = 0;
  let rest = '';
  while (offset < file.size) {
    const slice = file.slice(offset, Math.min(offset + chunkSize, file.size));
    // eslint-disable-next-line no-await-in-loop
    rest += await readTextFile(slice);
    let nl = rest.lastIndexOf('\n');
    if (nl >= 0) {
      const head = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      for (const line of head.split('\n')) onLine(line);
    }
    offset += chunkSize;
    if (onProgress) onProgress(Math.min(1, offset / file.size));
  }
  if (rest.length) onLine(rest);
}

/** 兼容 File 与内联数据构造出的 Blob(后者没有 name,由加载器补到 _name 上) */
export function fileNameOf(file) {
  if (!file) return '';
  return file.name || file._name || '';
}

function isGzip(file) {
  return /\.gz$/i.test(fileNameOf(file));
}

/** gzip 输入:交给浏览器原生 DecompressionStream,不额外依赖库 */
async function gzipLines(file, onLine) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error(t('err.noGz'));
  }
  const reader = file.stream()
    .pipeThrough(new DecompressionStream('gzip'))
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let rest = '';
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    rest += value;
    const nl = rest.lastIndexOf('\n');
    if (nl >= 0) {
      const head = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      for (const line of head.split('\n')) onLine(line);
    }
  }
  if (rest.length) onLine(rest);
}

export function basename(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

export function stripExt(name) {
  return name.replace(/\.[^.]+$/, '');
}

/** 去掉所有压缩/序列扩展名:MAG_A.fna.gz -> MAG_A */
export function stripAllExt(name) {
  let s = name;
  for (let i = 0; i < 3; i++) {
    const next = s.replace(/\.(gz|fna|fa|fasta|fas|ffn|faa|pep|prot)$/i, '');
    if (next === s) break;
    s = next;
  }
  return s;
}

/** 从路径推出 MAG 名:mag 序列文件与 checkm2 蛋白文件都用它对齐 */
export function magNameFromPath(p) {
  return stripAllExt(basename(p));
}

/** 按第一行自动判定分隔符 */
function detectDelimiter(firstLine) {
  const cands = ['\t', ',', ';', ' '];
  let best = '\t';
  let bestN = -1;
  for (const d of cands) {
    const n = firstLine.split(d).length;
    if (n > bestN) { bestN = n; best = d; }
  }
  return best;
}

function splitLine(line, delim) {
  if (delim === ' ') return line.trim().split(/\s+/);
  return line.split(delim);
}

const isNumeric = (s) => s !== '' && s !== 'NA' && s !== 'NaN' && Number.isFinite(Number(s));

// ---------------------------------------------------------------------------- FASTA

/**
 * 逐块解析 FASTA。返回 { sequences: Map<id, {length, gc}>, order: [id...] }
 * 只保留统计量,不保留序列本身 —— 一个 MAG 的序列可能有几 MB。
 */
export async function parseFastaStats(file, { wantGc = true, onProgress } = {}) {
  const seqs = new Map();
  const order = [];
  let curId = null;
  let len = 0;
  let gc = 0;
  let at = 0;
  let atgc = 0;

  const flush = () => {
    if (curId == null) return;
    seqs.set(curId, { length: len, gc, atgc, at, gcContent: at ? (gc / at) * 100 : 0 });
  };

  await streamLines(file, (line) => {
    if (!line) return;
    if (line.charCodeAt(0) === 62) { // '>'
      flush();
      const header = line.slice(1).trim();
      // contig id = 第一个空白前的部分(容忍名字里含 '#' 的情况)
      let id = header.split(/\s+/)[0];
      if (id.endsWith('|')) id = id.slice(0, -1);
      curId = id;
      order.push(id);
      len = 0; gc = 0; at = 0; atgc = 0;
      return;
    }
    len += line.length;
    if (wantGc) {
      for (let i = 0; i < line.length; i++) {
        const c = line.charCodeAt(i);
        // A=65 C=67 G=71 T=84  小写 a=97 c=99 g=103 t=116
        if (c === 65 || c === 84 || c === 97 || c === 116) at++;
        else if (c === 67 || c === 71 || c === 99 || c === 103) { gc++; at++; atgc++; }
      }
    }
  }, onProgress);
  flush();

  return { sequences: seqs, order };
}

/** 蛋白 FASTA:既需要统计量,也需要按 contig 聚合 */
export async function parseProteinFile(file, { aaList, onProgress, onProtein } = {}) {
  const idx = new Map(aaList.map((a, i) => [a, i]));
  const perContig = new Map(); // contigId -> {aa, aalength, cds, proteins:[]}
  let curHeader = null;
  let curSeq = '';

  const flush = () => {
    if (curHeader == null) return;
    if (onProtein) onProtein(curHeader, curSeq);
  };

  await streamLines(file, (line) => {
    if (!line) return;
    if (line.charCodeAt(0) === 62) {
      flush();
      curHeader = line.slice(1).trim();
      curSeq = '';
      return;
    }
    curSeq += line.trim();
  }, onProgress);
  flush();

  return { perContig, aaIndex: idx };
}

/** 解析单个蛋白序列的氨基酸组成 */
export function countAminoAcids(seq, aaIndex, aaOut) {
  let n = 0;
  for (let i = 0; i < seq.length; i++) {
    const p = aaIndex.get(seq[i]);
    if (p !== undefined) { aaOut[p]++; n++; }
  }
  return n;
}

// ---------------------------------------------------------------------------- checkm2 输出

/** quality_report.tsv → Map<name, row> */
export async function parseQualityReport(file) {
  const text = await readTextFile(file);
  const lines = text.split('\n').filter((l) => l.trim().length);
  if (!lines.length) return new Map();
  const delim = detectDelimiter(lines[0]);
  const header = splitLine(lines[0], delim);
  const rows = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], delim);
    const obj = {};
    header.forEach((h, j) => { obj[h] = cells[j]; });
    const name = obj.Name ?? cells[0];
    if (!name) continue;
    rows.set(name, {
      name,
      completeness: Number(obj.Completeness),
      contamination: Number(obj.Contamination),
      modelUsed: obj.Completeness_Model_Used || '',
      general: Number(obj.Completeness_General),
      specific: Number(obj.Completeness_Specific),
      codingDensity: Number(obj.Coding_Density),
      contigN50: Number(obj.Contig_N50),
      avgGeneLength: Number(obj.Average_Gene_Length),
      genomeSize: Number(obj.Genome_Size),
      gcContent: Number(obj.GC_Content),
      totalCodingSequences: Number(obj.Total_Coding_Sequences),
      totalContigs: Number(obj.Total_Contigs),
      maxContigLength: Number(obj.Max_Contig_Length),
      translationTable: Number(obj.Translation_Table_Used),
      notes: obj.Additional_Notes,
      raw: obj,
    });
  }
  return rows;
}

/**
 * DIAMOND 输出解析。每行: {binname}{sep}{proteinId}\t{Ref100}~{KO}\t...
 * 返回 { hits: Map<binname, Array<[proteinId, koId]>>, separator, dropped }
 */
export async function parseDiamondOutput(files, magNames, { onProgress } = {}) {
  const hits = new Map();
  const nameList = Array.from(magNames).sort((a, b) => b.length - a.length);
  let separatorVotes = new Map();
  let total = 0;
  let dropped = 0;

  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi];
    // eslint-disable-next-line no-await-in-loop
    await streamLines(file, (line) => {
      if (!line) return;
      const tab = line.indexOf('\t');
      if (tab <= 0) return;
      const header = line.slice(0, tab);
      const rest = line.slice(tab + 1);
      const tab2 = rest.indexOf('\t');
      const annotation = tab2 >= 0 ? rest.slice(0, tab2) : rest;
      const tilde = annotation.indexOf('~');
      if (tilde < 0) { dropped++; return; }
      const ko = annotation.slice(tilde + 1).trim();
      if (!ko || ko === 'nan') { dropped++; return; }

      let bin = null;
      let protein = null;
      // 先按官方分隔符 Ω 拆
      const omega = header.indexOf('\u03a9');
      if (omega > 0) {
        bin = header.slice(0, omega);
        protein = header.slice(omega + 1);
        separatorVotes.set('\u03a9', (separatorVotes.get('\u03a9') || 0) + 1);
      } else {
        // 否则用已知 bin 名做最长前缀匹配
        for (const nm of nameList) {
          if (header.length > nm.length + 1 && header.startsWith(nm)) {
            bin = nm;
            protein = header.slice(nm.length + 1);
            separatorVotes.set('prefix', (separatorVotes.get('prefix') || 0) + 1);
            break;
          }
        }
      }
      if (!bin) { dropped++; return; }
      total++;
      let arr = hits.get(bin);
      if (!arr) { arr = []; hits.set(bin, arr); }
      arr.push(protein, ko);
    }, onProgress);
  }

  let separator = '\u03a9';
  let bestVote = -1;
  for (const [k, v] of separatorVotes) if (v > bestVote) { bestVote = v; separator = k; }
  return { hits, separator, total, dropped };
}

// ---------------------------------------------------------------------------- Hi-C

/**
 * Hi-C 信号表。支持:
 *   - 三列边表: contigA \t contigB \t signal
 *   - 稠密矩阵: 第一行是列标签,第一列是行标签
 * 返回 { format, edges: Map<'a\u0000b', number>, partners: Map<contig, [{id, signal}]> }
 */
export async function parseHic(file, { topPartners = 20, onProgress } = {}) {
  const text = await readTextFile(file);
  const lines = text.split('\n').filter((l) => l.trim().length);
  if (!lines.length) return { format: 'empty', edges: new Map(), partners: new Map() };

  const delim = detectDelimiter(lines[0]);
  const head = splitLine(lines[0], delim);

  // 判定: 第一行第一个字段是否数字 —— 数字说明是矩阵(左上角为空或 0)
  const firstIsNum = isNumeric(head[1] ?? '');
  const colCells = head.slice(1);
  const looksMatrix = colCells.length > 2 && colCells.every((c) => !isNumeric(c));

  const edges = new Map();
  const partners = new Map();
  const key = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

  const addEdge = (a, b, v) => {
    if (a === b || !(v > 0)) return;
    const k = key(a, b);
    edges.set(k, (edges.get(k) || 0) + v);
    let pa = partners.get(a);
    if (!pa) { pa = []; partners.set(a, pa); }
    pa.push({ id: b, signal: v });
    let pb = partners.get(b);
    if (!pb) { pb = []; partners.set(b, pb); }
    pb.push({ id: a, signal: v });
  };

  let format;
  if (looksMatrix && firstIsNum) {
    format = 'matrix';
    const cols = colCells;
    let rowIdx = 0;
    for (let i = 1; i < lines.length; i++) {
      const cells = splitLine(lines[i], delim);
      const rowId = cells[0];
      if (!rowId) continue;
      for (let j = 0; j < cols.length; j++) {
        const v = Number(cells[j + 1]);
        if (Number.isFinite(v) && v > 0 && cols[j]) addEdge(rowId, cols[j], v);
      }
      rowIdx++;
      if (onProgress && (rowIdx & 255) === 0) onProgress(i / lines.length);
    }
  } else {
    format = 'edge-list';
    for (let i = 0; i < lines.length; i++) {
      const cells = splitLine(lines[i], delim);
      if (cells.length < 3) continue;
      const a = cells[0];
      const b = cells[1];
      if (i === 0 && (!isNumeric(cells[2]) || /contig|bin|mag|a\b/i.test(a))) continue; // 表头
      const v = Number(cells[2]);
      if (!isNumeric(cells[2])) continue;
      addEdge(a, b, v);
    }
  }

  // 每个 contig 只保留最强的 N 个伙伴
  for (const [id, list] of partners) {
    list.sort((x, y) => y.signal - x.signal);
    if (list.length > topPartners) partners.set(id, list.slice(0, topPartners));
  }

  return { format, edges, partners };
}

// ---------------------------------------------------------------------------- 丰度

/**
 * 丰度表: 第一列是 contig/MAG 标识,其余数值列是样本。
 * 返回 { format, samples: [名称], rows: Map<id, number[]> }
 */
export async function parseAbundance(file) {
  const text = await readTextFile(file);
  const lines = text.split('\n').filter((l) => l.trim().length);
  if (!lines.length) return { samples: [], rows: new Map(), noteKey: '' };

  const delim = detectDelimiter(lines[0]);
  let header = splitLine(lines[0], delim);
  let hasHeader = header.slice(1).some((h) => !isNumeric(h));
  let start = 0;
  if (!hasHeader) {
    header = ['id', ...header.slice(1).map((_, i) => `sample${i + 1}`)];
    start = 0;
  } else {
    start = 1;
  }
  // 只要数值列;coverM 之类会输出 '<sample> Coverage' / '<sample> Mean',
  // 有 Mean 时优先取 Mean,否则取 Coverage
  const cols = [];
  header.forEach((h, j) => { if (j > 0) cols.push({ j, name: h }); });
  const meanCols = cols.filter((c) => /\bmean\b/i.test(c.name));
  let useCols = cols;
  let noteKey = '';
  if (meanCols.length >= 2) {
    useCols = meanCols;
    noteKey = 'abund.note.coverm';
  } else {
    const covCols = cols.filter((c) => /coverage|\bcov\b/i.test(c.name) === false);
    if (covCols.length) useCols = covCols;
    if (useCols !== cols) noteKey = 'abund.note.excludeCov';
  }

  const samples = useCols.map((c) => c.name.replace(/\s+(Mean|Coverage)$/i, '').trim());
  const rows = new Map();
  for (let i = start; i < lines.length; i++) {
    const cells = splitLine(lines[i], delim);
    const id = cells[0];
    if (!id) continue;
    const vals = useCols.map((c) => {
      const v = Number(cells[c.j]);
      return Number.isFinite(v) ? v : NaN;
    });
    rows.set(id, vals);
  }
  return { samples, rows, noteKey };
}

// ---------------------------------------------------------------------------- 数据发现

/**
 * 从拖进来的文件集合里识别各类输入。
 *
 * 关于 MAG 序列:`.fa / .fna / .fasta / .fas / .ffn`(含 `.gz`)都算,
 * 且**以这些文件里的 contig 为准** —— 蛋白文件与 DIAMOND 输出只用来提供
 * 基因层面的信息(氨基酸组成、KO 计数),不参与决定"有哪些 contig"。
 */
export function discoverInputs(files) {
  const paths = Array.from(files.keys());
  const out = {
    qualityReport: [],
    proteinFiles: [],
    diamondFiles: [],
    fasta: [],        // MAG 核苷酸序列(权威来源)
    magProtein: [],   // MAG 蛋白序列
    hic: [],
    abundance: [],
    contigMaps: [],
    other: [],
  };

  for (const p of paths) {
    const low = p.toLowerCase();
    const base = basename(p).toLowerCase();
    const inProteinDir = /(^|\/)protein_files\//.test(low);
    if (/quality_report.*\.(tsv|csv|txt)$/.test(base)) out.qualityReport.push(p);
    else if (inProteinDir && PROT_EXT.test(base)) out.proteinFiles.push(p);
    else if (inProteinDir && NUC_EXT.test(base)) out.proteinFiles.push(p);
    else if (/diamond/.test(low) && TABULAR_EXT.test(base)) out.diamondFiles.push(p);
    else if (/(contig_map|protein_contig|protein2contig|\.map\.tsv)/.test(base)) out.contigMaps.push(p);
    else if (/(hic|contact|links?)/.test(base) && /\.(tsv|txt|csv|matrix)$/.test(base)) out.hic.push(p);
    else if (/(abund|coverage|coverm|tpm|rpkm|counts?)/.test(base) && TABULAR_EXT.test(base)) out.abundance.push(p);
    else if (NUC_EXT.test(base)) out.fasta.push(p);
    else if (PROT_EXT.test(base)) out.magProtein.push(p);
    else out.other.push(p);
  }
  // 兜底:容器目录名暗示这是 bin/MAG 序列
  if (!out.fasta.length) {
    out.fasta = paths.filter((p) => NUC_EXT.test(p)
      && /(^|\/)(mags?|bins?|genomes?|assembl\w*)\//i.test(p));
  }
  return out;
}

/** 解析自定义的 protein→contig 映射表 */
export async function parseContigMap(file) {
  const text = await readTextFile(file);
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const cells = line.split(/\s+/);
    if (cells.length >= 2) map.set(cells[0], cells[1]);
  }
  return map;
}
