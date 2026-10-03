/**
 * dataset.js — 把解析后的原始输入组装成应用的数据模型。
 *
 * 核心产出:
 *   mags: Map<name, {
 *     name, report(官方 quality_report 行),
 *     contigs: [{ id, length, gcContent, contribution, nProteins, nKo, hic, abundance }],
 *     baseCounts,  // 20021 维计数(所有 contig 之和)
 *     prediction,  // 官方基线 + 本地复算结果
 *   }>
 *   duplicates: Map<contigId, [magName...]>  —— 出现在多个 MAG 里的重复 contig
 *
 * 关键点:每个 contig 的 contribution 是"从特征向量里减掉它"所需的全部信息
 * (氨基酸计数 / 总长 / CDS / KO 计数),因此任何移除组合都能 O(该 contig 的 KO 数) 重算。
 */

import {
  collectFiles, discoverInputs, parseContigMap, parseDiamondOutput, parseFastaStats,
  parseHic, parseAbundance, parseProteinFile, parseQualityReport,
  magNameFromPath, PROT_EXT, readTextFile,
} from './parsers.js';
import { AA_LIST, CheckM2Engine, N_COUNTS } from './engine.js';
import { t } from './i18n.js';

const AA_INDEX = new Map(AA_LIST.map((a, i) => [a, i]));

/**
 * 从蛋白 header 解析出所属 contig。
 * 优先用 contig id 集合做前缀匹配(能正确处理 k141_51_1 -> k141_51),
 * 否则退化为"去掉末尾 _数字"。
 */
function makeContigResolver(contigIds) {
  const ids = Array.from(contigIds).sort((a, b) => b.length - a.length);
  const cache = new Map();
  return (token) => {
    const hit = cache.get(token);
    if (hit !== undefined) return hit;
    let result = null;
    if (contigIds.has(token)) {
      result = token;
    } else {
      for (const id of ids) {
        if (token.length > id.length + 1 && token.startsWith(id) && token[id.length] === '_') {
          const rest = token.slice(id.length + 1);
          if (/^\d+$/.test(rest)) { result = id; break; }
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

export class Dataset {
  constructor(engine) {
    this.engine = engine;
    this.mags = new Map();
    this.duplicates = new Map();
    this.hic = { format: 'none', edges: new Map(), partners: new Map() };
    this.abundance = { samples: [], rows: new Map(), noteKey: '' };
    this.warnings = [];
    this.stats = {};
    this.countsScratch = null;
  }

  static async build(engine, fileList, { onProgress = () => {}, engineOptions = {} } = {}) {
    const ds = new Dataset(engine);
    const files = fileList instanceof Map ? fileList : await collectFiles(fileList);
    ds.files = files;
    const inv = discoverInputs(files);
    ds.inventory = inv;

    // 警告统一以 {key, vars} 形式保留:界面语言可以随时切换,文案必须能重译
    const warn = (key, vars) => ds.warnings.push({ key, vars });

    const total = 8;
    let step = 0;
    const tick = (msg) => { step++; onProgress(step / total, msg); };
    const prog = (msg) => (p) => onProgress((step + p) / total, msg);

    // ---------------------------------------------------------------- 1. 官方报告
    let report = new Map();
    if (inv.qualityReport.length) {
      report = await parseQualityReport(files.get(inv.qualityReport[0]));
      warn('warn.reportRead', { n: report.size });
    } else {
      warn('warn.noReport');
    }
    tick(t('prog.report'));

    // ---------------------------------------------------------------- 2. 自定义映射
    const contigMap = new Map();
    if (inv.contigMaps.length) {
      const m = await parseContigMap(files.get(inv.contigMaps[0]));
      for (const [k, v] of m) contigMap.set(k, v);
      warn('warn.contigMap', { n: contigMap.size });
    }

    // ---------------------------------------------------------------- 3. MAG 序列文件
    // 以 MAG 的核苷酸序列(.fa/.fna/...)为准:它决定"这个 MAG 有哪些 contig"。
    // 蛋白文件(.faa)只负责提供每个 contig 的基因层面信息。
    const magFasta = new Map();   // magName -> files 里的路径 key
    const magProtein = new Map(); // magName -> File
    for (const p of inv.fasta) magFasta.set(magNameFromPath(p), p);
    for (const p of inv.magProtein) {
      const name = magNameFromPath(p);
      if (!magProtein.has(name)) magProtein.set(name, files.get(p));
    }
    for (const p of inv.proteinFiles) {
      const name = magNameFromPath(p);
      if (!magProtein.has(name)) magProtein.set(name, files.get(p));
    }

    const withData = new Set([...magFasta.keys(), ...magProtein.keys()]);
    if (!withData.size) throw new Error(t('err.noMagSeq'));

    // 报告里有、但没有任何序列文件的 MAG:拿不到特征向量,复算没有意义 —— 明确剔除并提示
    const reportOnly = Array.from(report.keys()).filter((n) => !withData.has(n));
    if (reportOnly.length) {
      warn('warn.reportOnly', { n: reportOnly.length, names: reportOnly.slice(0, 8).join(', ') });
    }
    const noFasta = Array.from(withData).filter((n) => !magFasta.has(n));
    if (noFasta.length) {
      warn('warn.noFasta', { n: noFasta.length, names: noFasta.slice(0, 8).join(', ') });
    }

    ds.magOrder = Array.from(withData).sort();
    ds.stats.nFasta = magFasta.size;
    ds.stats.nProtein = magProtein.size;
    ds.stats.reportOnly = reportOnly.length;

    // ---------------------------------------------------------------- 4. 逐 MAG 解析
    const proteinToContig = new Map(); // magName -> Map<proteinToken, contigId>
    const perMagProteins = new Map();  // magName -> [{token, contig, aa, length}]

    for (const name of ds.magOrder) {
      const contigIds = new Set();
      let nuc = null;
      if (magFasta.has(name)) {
        // eslint-disable-next-line no-await-in-loop
        const stats = await parseFastaStats(files.get(magFasta.get(name)), {
          wantGc: true, onProgress: prog(t('prog.magSeqOne', { mag: name })),
        });
        nuc = stats;
        for (const id of stats.order) contigIds.add(id);
      }
      // 有 fa 就以 fa 为准;没有 fa 时才允许由蛋白 id 反推 contig 集合
      const authoritative = !!nuc;

      const proteins = [];
      if (magProtein.has(name)) {
        // eslint-disable-next-line no-await-in-loop
        await parseProteinFile(
          magProtein.get(name),
          {
            aaList: AA_LIST,
            onProgress: prog(t('prog.magProteinOne', { mag: name })),
            onProtein: (header, seq) => {
              const token = header.split(/\s+/)[0];
              proteins.push({ header, token, seq });
            },
          },
        );
      }

      const resolver = makeContigResolver(contigIds);
      const map = new Map();
      let orphan = 0;
      for (const pr of proteins) {
        let cid = null;
        if (contigMap.has(pr.token)) {
          const mapped = contigMap.get(pr.token);
          cid = authoritative ? (contigIds.has(mapped) ? mapped : null) : mapped;
        }
        if (cid == null) cid = resolver(pr.token);
        // fa 为准:蛋白指向 fa 里没有的 contig 时,不新建 contig,只记数提示
        if (authoritative && !contigIds.has(cid)) { orphan++; cid = null; }
        map.set(pr.token, cid);
        if (!authoritative) contigIds.add(cid);
      }
      if (orphan) {
        warn('warn.orphanProtein', { mag: name, n: orphan });
      }
      proteinToContig.set(name, map);
      perMagProteins.set(name, proteins);

      const mag = {
        name,
        report: report.get(name) || null,
        contigIds,
        nucleotide: nuc,
        hasFasta: !!(nuc && nuc.order.length),
        contigs: new Map(),
        baseCounts: null,
        prediction: null,
        // 保留原始文件句柄,导出"清理后的 MAG"时按需重新流式解析(不占常驻内存)
        fastaFile: magFasta.has(name) ? files.get(magFasta.get(name)) : null,
        fastaPath: magFasta.get(name) || null,
        proteinFile: magProtein.has(name) ? magProtein.get(name) : null,
      };
      for (const cid of contigIds) {
        mag.contigs.set(cid, {
          id: cid,
          mag: name,
          length: nuc && nuc.sequences.has(cid) ? nuc.sequences.get(cid).length : 0,
          gcContent: nuc && nuc.sequences.has(cid) ? nuc.sequences.get(cid).gcContent : null,
          contribution: CheckM2Engine.newContribution(),
          nProteins: 0,
          nKo: 0,
          hic: null,
          abundance: null,
        });
      }
      ds.mags.set(name, mag);
    }
    tick(t('prog.magSeq'));

    // ---------------------------------------------------------------- 5. 汇总氨基酸/CDS
    // contig 集合在第 4 步就定好了(fa 为准),这里只往已有 contig 上累加,不新建。
    for (const name of ds.magOrder) {
      const mag = ds.mags.get(name);
      const map = proteinToContig.get(name) || new Map();
      let unknown = 0;
      for (const pr of perMagProteins.get(name) || []) {
        const cid = map.get(pr.token);
        const contig = cid == null ? null : mag.contigs.get(cid);
        if (!contig) { unknown++; continue; }
        const c = contig.contribution;
        // 注意:同一个 contig 会有多条蛋白,这里必须累加而不是赋值
        c.aalength += pr.seq.length;
        for (let i = 0; i < pr.seq.length; i++) {
          const p = AA_INDEX.get(pr.seq[i]);
          if (p !== undefined) c.aa[p]++;
        }
        c.cds += 1;
        c.nProteins += 1;
        contig.nProteins++;
      }
      mag.nProteins = (perMagProteins.get(name) || []).length;
      if (unknown) warn('warn.unknownProtein', { mag: name, n: unknown });
      // 清掉序列,释放内存
      perMagProteins.set(name, null);
    }
    tick(t('prog.amino'));

    // ---------------------------------------------------------------- 6. KO 计数
    if (inv.diamondFiles.length) {
      const { hits, separator, total: nHit, dropped } = await parseDiamondOutput(
        inv.diamondFiles.map((p) => files.get(p)),
        new Set(ds.magOrder),
        { onProgress: prog(t('prog.diamond')) },
      );
      ds.stats.diamondLines = nHit;
      ds.stats.diamondSeparator = separator;
      if (dropped) warn('warn.diamondDropped', { n: dropped });
      let unmatchedKo = 0;
      for (const [magName, arr] of hits) {
        const mag = ds.mags.get(magName);
        if (!mag) continue;
        const map = proteinToContig.get(magName) || new Map();
        const buffers = new Map(); // contigId -> Map<koIdx, count>
        for (let i = 0; i < arr.length; i += 2) {
          const token = arr[i];
          const ko = arr[i + 1];
          const pos = engine.koPosition(ko);
          if (pos < 0) { unmatchedKo++; continue; }
          const cid = map.get(token);
          if (cid === undefined) continue;
          let b = buffers.get(cid);
          if (!b) { b = new Map(); buffers.set(cid, b); }
          b.set(pos, (b.get(pos) || 0) + 1);
        }
        for (const [cid, b] of buffers) {
          const contig = mag.contigs.get(cid);
          if (!contig) continue;
          const idx = new Int32Array(b.size);
          const cnt = new Float64Array(b.size);
          let k = 0;
          for (const [p, v] of b) { idx[k] = p; cnt[k] = v; k++; }
          contig.contribution.koIdx = idx;
          contig.contribution.koCnt = cnt;
          contig.nKo = b.size;
        }
      }
      if (unmatchedKo) {
        warn('warn.koUnmatched', { n: unmatchedKo });
      }
    } else {
      warn('warn.noDiamond');
    }
    tick(t('prog.ko'));

    // ---------------------------------------------------------------- 7. 求和 + 基线复算
    for (const name of ds.magOrder) {
      const mag = ds.mags.get(name);
      const contribs = Array.from(mag.contigs.values()).map((c) => c.contribution);
      mag.baseCounts = engine.sumContributions(contribs);
      mag.contigList = Array.from(mag.contigs.values());
      // contig 排序:长的在前,便于查看
      mag.contigList.sort((a, b) => b.contribution.aalength - a.contribution.aalength
        || b.length - a.length);
    }
    tick(t('prog.features'));

    // ---------------------------------------------------------------- 8. Hi-C + 丰度
    if (inv.hic.length) {
      ds.hic = await parseHic(files.get(inv.hic[0]), { onProgress: prog(t('prog.hic')) });
      warn(`warn.hic.${ds.hic.format}`, { n: ds.hic.edges.size });
    }
    if (inv.abundance.length) {
      ds.abundance = await parseAbundance(files.get(inv.abundance[0]));
      if (ds.abundance.noteKey) warn(ds.abundance.noteKey);
    }
    tick(t('prog.aux'));

    ds.sampleCount = ds.abundance.samples.length;
    ds.attachAuxiliary();
    ds.buildDuplicateIndex();
    ds.computeBaselines(engineOptions);
    tick(t('prog.dupIndex'));
    return ds;
  }

  // ------------------------------------------------------------------ 辅助数据挂接

  attachAuxiliary() {
    const { hic, abundance } = this;
    for (const mag of this.mags.values()) {
      for (const c of mag.contigList) {
        // Hi-C
        const partners = hic.partners.get(c.id);
        if (partners) {
          let intra = 0;
          let inter = 0;
          const top = [];
          for (const p of partners) {
            const other = this.mags.get(c.mag);
            const inside = other && other.contigs.has(p.id);
            if (inside) intra += p.signal; else inter += p.signal;
            top.push({ id: p.id, signal: p.signal, inside, mags: this.contigOwners(p.id) });
          }
          c.hic = { intra, inter, top };
        }
        // 丰度
        if (abundance.rows.has(c.id)) c.abundance = abundance.rows.get(c.id);
      }
      // MAG 级别的丰度(所有 contig 之和)
      if (abundance.samples.length) {
        const n = abundance.samples.length;
        const sum = new Float64Array(n);
        let any = false;
        for (const c of mag.contigList) {
          if (!c.abundance) continue;
          any = true;
          for (let i = 0; i < n; i++) sum[i] += Number.isFinite(c.abundance[i]) ? c.abundance[i] : 0;
        }
        mag.abundance = any ? Array.from(sum) : null;
      }
    }
  }

  contigOwners(contigId) {
    if (!this._ownersIndex) {
      const idx = new Map();
      for (const mag of this.mags.values()) {
        for (const cid of mag.contigs.keys()) {
          let a = idx.get(cid);
          if (!a) { a = []; idx.set(cid, a); }
          a.push(mag.name);
        }
      }
      this._ownersIndex = idx;
    }
    return this._ownersIndex.get(contigId) || [];
  }

  buildDuplicateIndex() {
    this.duplicates = new Map();
    for (const [cid, owners] of this._ownersIndex || []) {
      if (owners.length > 1) this.duplicates.set(cid, owners);
    }
    // contig 名出现在多个 MAG 时,标记出来供 UI 使用
    for (const mag of this.mags.values()) {
      for (const c of mag.contigList) {
        c.duplicateOf = (this.duplicates.get(c.id) || []).filter((m) => m !== mag.name);
      }
    }
  }

  // ------------------------------------------------------------------ 基线复算

  computeBaselines(engineOptions = {}) {
    const { engine } = this;
    for (const mag of this.mags.values()) {
      const forcedModel = mag.report && /specific/i.test(mag.report.modelUsed || '')
        ? 'specific' : (mag.report && /general/i.test(mag.report.modelUsed || '') ? 'general' : 'auto');
      // 官方报告用的是哪个模型,就沿用哪个 —— 保证"移除前"与报告一致、可比较
      const recalc = engine.predict(mag.baseCounts, {
        nn: forcedModel !== 'general' || engineOptions.alwaysNn,
        forcedModel,
      });
      mag.prediction = {
        report: mag.report ? {
          completeness: mag.report.completeness,
          contamination: mag.report.contamination,
          model: mag.report.modelUsed,
        } : null,
        recalc,
        delta: mag.report ? {
          completeness: recalc.completeness - mag.report.completeness,
          contamination: recalc.contamination - mag.report.contamination,
        } : null,
      };
      mag.forcedModel = forcedModel;
      mag.summary = this.summarize(mag);
    }
    this.countsScratch = new Float64Array(N_COUNTS);
  }

  /** 统计一个 MAG 的核苷酸层面信息(去掉若干 contig 后可重算) */
  summarize(mag, removed = null) {
    const removedSet = removed instanceof Set ? removed : null;
    let size = 0;
    let gc = 0;
    let atgc = 0;
    let at = 0;
    let cds = 0;
    let aalength = 0;
    const lengths = [];
    // KO 存在数(用来算"单拷贝基因"层面的概览)
    const koPresence = new Set();
    let nKoTotal = 0;
    for (const c of mag.contigList) {
      if (removedSet && removedSet.has(c.id)) continue;
      size += c.length;
      if (c.gcContent != null) { gc += (c.gcContent / 100) * c.length; atgc += c.length; at += c.length; }
      cds += c.contribution.cds;
      aalength += c.contribution.aalength;
      if (c.length) lengths.push(c.length);
      for (const p of c.contribution.koIdx) { koPresence.add(p); nKoTotal += c.contribution.koCnt ? 1 : 1; }
      void nKoTotal;
    }
    lengths.sort((a, b) => b - a);
    let acc = 0;
    let n50 = 0;
    for (const l of lengths) { acc += l; if (acc >= size / 2) { n50 = l; break; } }
    const totalKoCopies = [];
    void totalKoCopies;
    return {
      size,
      contigs: removedSet ? mag.contigList.length - removedSet.size : mag.contigList.length,
      gcContent: at ? (gc / at) * 100 : null,
      n50,
      cds,
      aalength,
      koPresence: koPresence.size,
      maxContig: lengths.length ? lengths[0] : 0,
      koPresenceSet: koPresence,
    };
  }

  /** 判断 contig 的"单拷贝基因"角色:它贡献了哪些 KO,这些 KO 在 MAG 里是否唯一 */
  singleCopyInfo(mag, contig) {
    const counts = mag.baseCounts;
    let unique = 0;
    let shared = 0;
    for (let i = 0; i < contig.contribution.koIdx.length; i++) {
      const p = contig.contribution.koIdx[i];
      const total = counts[22 + p];
      const own = contig.contribution.koCnt[i];
      if (own >= 1 && total === own) unique++; else shared++;
    }
    return { unique, shared };
  }
}
