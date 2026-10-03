/**
 * make_demo_report.mjs — 用本项目的引擎,为演示数据生成一份
 * "和 checkm2 predict 输出格式完全一致" 的 quality_report.tsv。
 *
 * 之所以要生成它:演示数据里只有组装序列 / 蛋白 / DIAMOND 命中,
 * 缺 CheckM2 的官方报告。真实使用时这份报告由 checkm2 产出;这里用引擎
 * 复算出同样的结果并写成同样的列,于是网页端的"报告 vs 复算"对比路径
 * 会被真实地走一遍。
 *
 * 输出列(与 checkm2 predict 默认 mode=auto 一致):
 *   Name  Completeness  Contamination  Completeness_Model_Used
 *   Translation_Table_Used  Coding_Density  Contig_N50  Average_Gene_Length
 *   Genome_Size  GC_Content  Total_Coding_Sequences  Total_Contigs
 *   Max_Contig_Length  Additional_Notes
 *
 * 用法: node tools/make_demo_report.mjs [--dir samples/demo]
 *
 * 注意: 生成时显式固定用 specific 模型(见下方 forcedModel),不依赖任何"模型选择"步骤
 *      —— 本项目已去掉余弦参考库,模拟报告时直接锁定官方报告里实际用的那个模型。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CheckM2Engine, AA_LIST, N_COUNTS, N_METADATA } from '../js/engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const ASSETS = path.join(APP, 'assets');
const WASM_PATH = path.join(APP, 'wasm', 'checkm2_core.wasm');

const DIVERGENCE_THRESHOLD = 25; // DefaultValues.MODEL_DIVERGENCE_WARNING_THRESHOLD

// ------------------------------------------------------------------ CLI

function parseArgs(argv) {
  const out = { dir: path.join(APP, 'samples', 'demo') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') out.dir = path.resolve(argv[++i]);
  }
  return out;
}

// ------------------------------------------------------------------ 工具

const fileBuf = (p) => {
  const b = fs.readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

const readText = (p) => fs.readFileSync(p, 'utf8');

const AA_INDEX = new Map(AA_LIST.map((a, i) => [a, i]));

/**
 * 蛋白 token 归属 contig:
 *   优先按已知 contig id 做「前缀 + 下划线 + 数字」匹配(正确处理 k141_51_1 → k141_51),
 *   否则退化为去掉末尾的 _数字。
 */
function makeContigResolver(contigIds) {
  const ids = Array.from(contigIds).sort((a, b) => b.length - a.length);
  const cache = new Map();
  return (token) => {
    if (cache.has(token)) return cache.get(token);
    let result = null;
    if (contigIds.has(token)) {
      result = token;
    } else {
      for (const id of ids) {
        if (token.length > id.length + 1 && token.startsWith(id) && token[id.length] === '_') {
          if (/^\d+$/.test(token.slice(id.length + 1))) { result = id; break; }
        }
      }
      if (!result) {
        const m = token.match(/^(.*)_(\d+)$/);
        result = m ? m[1] : token;
      }
    }
    cache.set(token, result);
    return result;
  };
}

/** CheckM2 自己的 N50:把每个长度 L 重复 L 次后取中位数 */
function contigN50FromLengths(lengths) {
  if (!lengths.length) return 0;
  if (lengths.reduce((a, b) => a + b, 0) / lengths.length === 0) return 0;
  const weighted = [];
  for (const L of lengths) for (let i = 0; i < L; i++) weighted.push(L);
  weighted.sort((a, b) => a - b);
  const n = weighted.length;
  return n % 2 === 0 ? (weighted[n / 2 - 1] + weighted[n / 2]) / 2 : weighted[(n - 1) / 2];
}

/** 读 FASTA,返回 [{id, length, gc}] —— 只留统计量 */
function readFastaStats(file) {
  const out = [];
  let cur = null;
  for (const raw of readText(file).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] === '>') {
      let id = line.slice(1).trim().split(/\s+/)[0];
      if (id.endsWith('|')) id = id.slice(0, -1);
      cur = { id, length: 0, gc: 0, at: 0, gcContent: 0 };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.length += line.length;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c === 65 || c === 84 || c === 97 || c === 116) cur.at++;
      else if (c === 67 || c === 71 || c === 99 || c === 103) { cur.gc++; cur.at++; }
    }
  }
  for (const c of out) c.gcContent = c.at ? (c.gc / c.at) * 100 : 0;
  return out;
}

/** 读蛋白 FASTA,按 contig 聚合氨基酸组成 / CDS / 总长 */
function readProteinStats(file, resolver) {
  const perContig = new Map();
  const geneLengths = [];
  let curToken = null;
  let len = 0;
  const aaCounts = new Float64Array(20);
  const flush = () => {
    if (curToken == null) return;
    geneLengths.push(len);
    const cid = resolver(curToken);
    let rec = perContig.get(cid);
    if (!rec) {
      rec = { aa: new Float64Array(20), aalength: 0, cds: 0, nProteins: 0 };
      perContig.set(cid, rec);
    }
    for (let i = 0; i < 20; i++) rec.aa[i] += aaCounts[i];
    rec.aalength += len;
    rec.cds += 1;
    rec.nProteins += 1;
  };
  for (const raw of readText(file).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] === '>') {
      flush();
      curToken = line.slice(1).trim().split(/\s+/)[0];
      len = 0;
      aaCounts.fill(0);
      continue;
    }
    if (curToken == null) continue;
    len += line.length;
    for (let i = 0; i < line.length; i++) {
      const p = AA_INDEX.get(line[i]);
      if (p !== undefined) aaCounts[p]++;
    }
  }
  flush();
  return { perContig, geneLengths };
}

/** DIAMOND 命中 → Map<contigId, Map<koIdx, count>> */
function readDiamondHits(file, magName, engine, resolver) {
  const perContig = new Map();
  let total = 0;
  let unmatched = 0;
  for (const raw of readText(file).split('\n')) {
    if (!raw) continue;
    const tab = raw.indexOf('\t');
    if (tab <= 0) continue;
    const header = raw.slice(0, tab);
    const rest = raw.slice(tab + 1);
    const tab2 = rest.indexOf('\t');
    const ann = tab2 >= 0 ? rest.slice(0, tab2) : rest;
    const tilde = ann.indexOf('~');
    if (tilde < 0) continue;
    const ko = ann.slice(tilde + 1).trim();
    if (!ko || ko === 'nan') continue;

    let bin = null;
    let token = null;
    const omega = header.indexOf('\u03a9');
    if (omega > 0) {
      bin = header.slice(0, omega);
      token = header.slice(omega + 1);
    }
    if (bin !== magName) continue;

    const pos = engine.koPosition(ko);
    if (pos < 0) { unmatched++; continue; }
    total++;
    const cid = resolver(token);
    let m = perContig.get(cid);
    if (!m) { m = new Map(); perContig.set(cid, m); }
    m.set(pos, (m.get(pos) || 0) + 1);
  }
  return { perContig, total, unmatched };
}

// ------------------------------------------------------------------ 主流程

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const magDir = path.join(args.dir, 'mags');
  const protDir = path.join(args.dir, 'checkm2_out', 'protein_files');
  const diamondDir = path.join(args.dir, 'checkm2_out', 'diamond_output');
  const outFile = path.join(args.dir, 'checkm2_out', 'quality_report.tsv');

  if (!fs.existsSync(magDir)) {
    console.error(`找不到 ${magDir},请先运行 tools/make_demo_data.py`);
    return 1;
  }

  console.log('加载引擎 ...');
  const wasmBinary = fs.existsSync(WASM_PATH) ? fileBuf(WASM_PATH) : null;
  const engine = await CheckM2Engine.create({
    fetchBinary: async (name) => {
      const p = path.join(ASSETS, name);
      return fs.existsSync(p) ? fileBuf(p) : null;
    },
    wasmBinary,
  });
  console.log(`  后端: ${engine.backendLabel}`);

  const diamondFiles = fs.existsSync(diamondDir)
    ? fs.readdirSync(diamondDir).filter((f) => /\.(tsv|txt)$/i.test(f))
      .map((f) => path.join(diamondDir, f))
    : [];

  const mags = fs.readdirSync(magDir)
    .filter((f) => /\.(fna|fa|fasta|fas|ffn)$/i.test(f))
    .map((f) => f.replace(/\.[^.]+$/, ''))
    .sort();

  const rows = [];
  for (const mag of mags) {
    const nucFile = fs.readdirSync(magDir)
      .find((f) => f.replace(/\.[^.]+$/, '') === mag && /\.(fna|fa|fasta|fas|ffn)$/i.test(f));
    const contigs = readFastaStats(path.join(magDir, nucFile));
    const contigIds = new Set(contigs.map((c) => c.id));
    const resolver = makeContigResolver(contigIds);

    const protFile = fs.existsSync(path.join(protDir, `${mag}.faa`))
      ? path.join(protDir, `${mag}.faa`)
      : null;
    const prot = protFile
      ? readProteinStats(protFile, resolver)
      : { perContig: new Map(), geneLengths: [] };

    // 组装 20021 维计数
    const counts = new Float64Array(N_COUNTS);
    for (const rec of prot.perContig.values()) {
      for (let i = 0; i < 20; i++) counts[i] += rec.aa[i];
      counts[20] += rec.aalength;
      counts[21] += rec.cds;
    }
    for (const f of diamondFiles) {
      const { perContig } = readDiamondHits(f, mag, engine, resolver);
      for (const m of perContig.values()) {
        for (const [pos, v] of m) counts[N_METADATA + pos] += v;
      }
    }

    // 官方报告里这三个 MAG 用的都是 specific 模型,这里显式锁定,免得依赖已经去掉的模型选择
    const pred = engine.predict(counts, { forcedModel: 'specific' });

    // 核苷酸层面统计
    const lengths = contigs.map((c) => c.length);
    const totalBases = lengths.reduce((a, b) => a + b, 0);
    const maxContigLen = lengths.length ? Math.max(...lengths) : 0;
    let gc = 0;
    let at = 0;
    for (const c of contigs) { gc += c.gc; at += c.at; }
    const codingBases = prot.geneLengths.reduce((a, L) => a + L * 3 + 3, 0);

    const gen = pred.completenessGeneral;
    const spe = pred.completenessSpecific;
    const diff = (gen != null && spe != null) ? Math.abs(gen - spe) : 0;
    const note = (spe != null && spe < 50) || diff < DIVERGENCE_THRESHOLD
      ? 'None'
      : `Low confidence prediction - substantial (${Math.round(diff)}%) disagreement between completeness prediction models`;

    rows.push({
      Name: mag,
      Completeness: pred.completeness.toFixed(2),
      Contamination: pred.contamination.toFixed(2),
      'Completeness_Model_Used': pred.model,
      Translation_Table_Used: 11,
      Coding_Density: totalBases ? (codingBases / totalBases).toFixed(3) : '0.000',
      Contig_N50: Math.round(contigN50FromLengths(lengths)),
      Average_Gene_Length: prot.geneLengths.length
        ? (prot.geneLengths.reduce((a, b) => a + b, 0) / prot.geneLengths.length).toFixed(1)
        : '0.0',
      Genome_Size: totalBases,
      GC_Content: at ? ((gc / at) * 100).toFixed(2) : '0.00',
      Total_Coding_Sequences: prot.geneLengths.length,
      Total_Contigs: contigs.length,
      Max_Contig_Length: maxContigLen,
      Additional_Notes: note,
    });

    console.log(`  ${mag}: 完整度 ${pred.completeness.toFixed(2)}  污染度 ${pred.contamination.toFixed(2)}`
      + `  [${pred.model}]  contig=${contigs.length}  CDS=${prot.geneLengths.length}`);
  }

  const columns = ['Name', 'Completeness', 'Contamination', 'Completeness_Model_Used',
    'Translation_Table_Used', 'Coding_Density', 'Contig_N50', 'Average_Gene_Length',
    'Genome_Size', 'GC_Content', 'Total_Coding_Sequences', 'Total_Contigs',
    'Max_Contig_Length', 'Additional_Notes'];

  const tsv = [columns.join('\t')]
    .concat(rows.map((r) => columns.map((c) => r[c]).join('\t')))
    .join('\n') + '\n';
  fs.writeFileSync(outFile, tsv, 'utf8');

  console.log(`\n已写入 ${outFile}  (${rows.length} 个 bin)`);
  return 0;
}

main().then((c) => process.exit(c)).catch((err) => {
  console.error(err);
  process.exit(1);
});
