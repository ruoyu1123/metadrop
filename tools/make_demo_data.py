#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
make_demo_data.py — 生成一套自洽的演示数据(不含 quality_report.tsv,那一份由
tools/make_demo_report.mjs 用本项目的引擎生成,模拟 checkm2 的真实输出)。

数据来源:assets/ref_csr.bin 里 5300 个**真实训练基因组**的特征向量。反缩放即得到
真实的"氨基酸组成 + KO 计数",据此拆分 contig 并生成序列/蛋白/DIAMOND 命中。

⚠️ 前置条件:该参考矩阵已不再随应用分发(应用的余弦模型选择已移除,见 README),
   重跑本脚本前须先执行 `python tools/export_assets.py` 把它导回 assets/。
   已经生成的 samples/demo 不受影响,只是缺了它就无法重造。

刻意构造的场景(演示"去重"):
  MAG_A  接近完整的基因组 X + 2 条其实属于基因组 Z 的污染 contig(X 里混入 Z)
  MAG_B  独立的基因组 Y
  MAG_C  骨架是基因组 Z,但混入 6 条属于 X 的 contig(与 MAG_A 重复)
  Hi-C   同基因组内信号强,跨基因组弱 —— 于是 Z 污染 contig 会强烈指向 MAG_C
  丰度   基因组 Z 的丰度谱与 X 明显不同,污染 contig 一眼可辨

用法: python tools/make_demo_data.py [--out samples/demo] [--seed 20240915]
"""
from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
APP = HERE.parent
ASSETS = APP / "assets"

N_METADATA = 22
N_KO = 19999
N_COUNTS = N_METADATA + N_KO

AA_LIST = ['A', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'K', 'L',
           'M', 'N', 'P', 'Q', 'R', 'S', 'T', 'V', 'W', 'Y']

# 参考数据行号 / GC / contig 数 / 四个样本的丰度谱
GENOMES = {
    'X': dict(row=512,  gc=0.618, n_contigs=30, abun=[12.5, 3.2, 8.0, 1.1]),
    'Y': dict(row=0,    gc=0.408, n_contigs=18, abun=[0.5, 9.8, 2.2, 6.4]),
    'Z': dict(row=5299, gc=0.552, n_contigs=20, abun=[2.1, 18.0, 0.9, 12.0]),
}

MAG_CONTIGS = {
    'MAG_A': [('X', i) for i in range(1, 29)] + [('Z', 19), ('Z', 20)],
    'MAG_B': [('Y', i) for i in range(1, 19)],
    'MAG_C': [('X', i) for i in (1, 3, 5, 7, 9, 11)] + [('Z', i) for i in range(1, 15)],
}

BP_PER_CDS = 1020       # 每个 CDS 分摊的碱基数(含基因间隔)
MEAN_PROT_LEN = 300


# --------------------------------------------------------------------------- 读参考数据

def load_scaler():
    buf = (ASSETS / "scaler.bin").read_bytes()
    n = struct.unpack_from("<I", buf, 4)[0]
    min_ = np.frombuffer(buf, dtype=np.float64, count=n, offset=12).copy()
    scale_ = np.frombuffer(buf, dtype=np.float64, count=n, offset=12 + n * 8).copy()
    return min_, scale_


def load_ref_row(row: int) -> np.ndarray:
    # 演示数据的计数来自 5300 个真实训练基因组,存在 ref_csr.bin 里;该文件已不再随
    # 应用分发(应用的余弦模型选择已移除)。要重造演示数据,先从官方数据把它导出来。
    ref_path = ASSETS / "ref_csr.bin"
    if not ref_path.exists():
        raise SystemExit(
            "缺少 assets/ref_csr.bin —— 它是演示数据计数的来源。\n"
            "该文件已不再随应用分发,请先重新导出:\n"
            "  python tools/export_assets.py\n"
            "(导出后它只供本脚本与 validate_end2end.py 使用,应用运行时不再读它)"
        )
    buf = ref_path.read_bytes()
    n_rows, n_cols, nnz = struct.unpack_from("<III", buf, 4)
    off = 16
    indptr = np.frombuffer(buf, dtype=np.int32, count=n_rows + 1, offset=off)
    off += (n_rows + 1) * 4
    indices = np.frombuffer(buf, dtype=np.uint16, count=nnz, offset=off)
    off += nnz * 2
    data = np.frombuffer(buf, dtype=np.float32, count=nnz, offset=off)
    dense = np.zeros(n_cols, dtype=np.float64)
    dense[indices[indptr[row]:indptr[row + 1]]] = data[indptr[row]:indptr[row + 1]]
    return dense


def recover_counts(row: int, min_, scale_) -> np.ndarray:
    dense = load_ref_row(row)
    counts = np.zeros(N_COUNTS, dtype=np.float64)
    nz = dense[:N_COUNTS] != 0
    counts[nz] = (dense[:N_COUNTS][nz] - min_[:N_COUNTS][nz]) / scale_[:N_COUNTS][nz]
    return np.round(counts)


# --------------------------------------------------------------------------- 拆分 contig

def split_contigs(counts: np.ndarray, n_contigs: int, rng) -> list[dict]:
    """把基因组计数拆到 n_contigs 个 contig(氨基酸与 KO 命中数都严格求和相等)"""
    aa_totals = counts[0:20].astype(np.int64)
    cds_total = int(counts[21])
    ko_counts = counts[N_METADATA:].astype(np.int64)
    ko_present = np.nonzero(ko_counts)[0]
    ko_copies = ko_counts[ko_present]

    w = rng.lognormal(0.0, 0.7, size=n_contigs)
    w = w / w.sum()

    cds_parts = np.maximum(1, np.round(w * cds_total).astype(np.int64))
    cds_parts[-1] += cds_total - cds_parts.sum()

    frac = cds_parts / cds_parts.sum()
    aa_parts = np.round(np.outer(frac, aa_totals)).astype(np.int64)
    aa_parts[-1] += aa_totals - aa_parts.sum(axis=0)

    assign = rng.choice(n_contigs, size=int(ko_copies.sum()), p=w)
    per_ko = [dict() for _ in range(n_contigs)]
    pos = 0
    for ko_idx, n_copy in zip(ko_present, ko_copies):
        for a in assign[pos:pos + n_copy]:
            per_ko[a][int(ko_idx)] = per_ko[a].get(int(ko_idx), 0) + 1
        pos += n_copy

    return [dict(index=i + 1, aa=aa_parts[i].copy(), cds=int(cds_parts[i]), ko=per_ko[i])
            for i in range(n_contigs)]


def random_dna(n: int, gc: float, rng) -> str:
    is_gc = rng.random(n) < gc
    second = rng.random(n) < 0.5
    codes = np.where(is_gc,
                     np.where(second, ord('G'), ord('C')),
                     np.where(second, ord('A'), ord('T')))
    return codes.astype(np.uint8).tobytes().decode('ascii')


def wrap(seq: str, width: int) -> str:
    return '\n'.join(seq[i:i + width] for i in range(0, len(seq), width))


def make_proteins(contig: dict, rng) -> list[tuple[str, str]]:
    """按 contig 的氨基酸计数精确生成蛋白序列(多重集合抽样保证总数一致)"""
    aa_counts = contig['aa'].copy()
    total_aa = int(aa_counts.sum())
    cds = int(contig['cds'])

    lens = rng.normal(MEAN_PROT_LEN, 55, size=cds).clip(60, 900)
    lens = np.maximum(1, np.round(lens * total_aa / lens.sum()).astype(np.int64))
    lens[0] += total_aa - int(lens.sum())
    if lens[0] < 1:
        lens[1] -= 1 - lens[0]
        lens[0] = 1

    pool = np.repeat(np.arange(20), aa_counts).astype(np.uint8)
    rng.shuffle(pool)
    out = []
    off = 0
    for i, L in enumerate(lens):
        chunk = pool[off:off + L]
        off += int(L)
        out.append((f"{contig['name']}_{i + 1}", ''.join(AA_LIST[x] for x in chunk)))
    return out


# --------------------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(APP / "samples" / "demo"))
    ap.add_argument("--seed", type=int, default=20240915)
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)

    out = Path(args.out)
    for sub in ("mags", "checkm2_out/protein_files", "checkm2_out/diamond_output",
                "hic", "abundance"):
        (out / sub).mkdir(parents=True, exist_ok=True)

    ko_ids = json.loads((ASSETS / "feature_names.json").read_text())["ko_ids"]
    min_, scale_ = load_scaler()

    print("=== 1. 从真实训练基因组还原计数并拆分 contig ===")
    by_genome = {}
    for gname, g in GENOMES.items():
        counts = recover_counts(g['row'], min_, scale_)
        contigs = split_contigs(counts, g['n_contigs'], rng)
        for c in contigs:
            c['name'] = f"{gname}{c['index']:02d}"
            c['genome'] = gname
            c['gc'] = float(np.clip(g['gc'] + rng.normal(0, 0.012), 0.25, 0.75))
        by_genome[gname] = contigs
        print(f"  基因组 {gname}: CDS={int(counts[21])} AA={int(counts[20])} "
              f"KO 种类={int((counts[N_METADATA:] > 0).sum())} -> {len(contigs)} contig")

    print("\n=== 2. 生成序列与蛋白 ===")
    for gname, contigs in by_genome.items():
        for c in contigs:
            c['nt'] = random_dna(max(1500, int(c['cds'] * BP_PER_CDS)), c['gc'], rng)
            c['proteins'] = make_proteins(c, rng)
        print(f"  基因组 {gname}: {sum(len(c['nt']) for c in contigs) / 1e6:.2f} Mb, "
              f"蛋白 {sum(c['cds'] for c in contigs)} 条")

    print("\n=== 3. 按 MAG 写出 fasta / 蛋白 / DIAMOND 命中 ===")
    index = {(g, c['index']): c for g, cs in by_genome.items() for c in cs}
    diamond_rows = []
    summary = {}
    for mag, spec in MAG_CONTIGS.items():
        nuc_parts = []
        prot_parts = []
        cds_sum = 0
        for gname, idx in spec:
            c = index[(gname, idx)]
            cds_sum += c['cds']
            nuc_parts.append('>' + c['name'] + '\n' + wrap(c['nt'], 70))

            # 把该 contig 的 KO 命中拷贝随机分配给蛋白
            copies = []
            for ko_i, n in c['ko'].items():
                copies.extend([ko_i] * n)
            rng.shuffle(copies)
            order = rng.permutation(len(c['proteins']))
            ko_of = {int(pi): copies[i] for i, pi in enumerate(order[:len(copies)])}

            for pi, (token, seq) in enumerate(c['proteins']):
                prot_parts.append(
                    f">{token} # 1 # {len(seq) * 3} # {1 if pi % 2 == 0 else -1} # "
                    f"ID={token};partial=00;start_type=ATG;gc_cont={c['gc']:.3f}")
                prot_parts.append(wrap(seq, 60))
                if pi in ko_of:
                    ko = ko_ids[ko_of[pi]]
                    L = len(seq)
                    diamond_rows.append(
                        f"{mag}\u03a9{token}\tUniRef100_{token}~{ko}\t96.4\t{L}\t{L}\t"
                        f"100.0\t{L}\t0.0\t2e-104\t{L * 3}\t98\t{L}\t{L}\t2e-104")
        (out / "mags" / f"{mag}.fa").write_text('\n'.join(nuc_parts) + '\n', encoding='utf-8')
        (out / "checkm2_out" / "protein_files" / f"{mag}.faa").write_text(
            '\n'.join(prot_parts) + '\n', encoding='utf-8')
        summary[mag] = dict(contigs=len(spec), cds=cds_sum)
        print(f"  {mag}: {len(spec)} contig, CDS={cds_sum}")

    (out / "checkm2_out" / "diamond_output" / "DIAMOND_RESULTS.tsv").write_text(
        '\n'.join(diamond_rows) + '\n', encoding='utf-8')
    print(f"  DIAMOND 命中 {len(diamond_rows)} 条")

    print("\n=== 4. Hi-C 信号表 ===")
    # 同基因组内: 强信号;跨基因组: 弱信号(体现物理接触)
    all_contigs = [c for cs in by_genome.values() for c in cs]
    edges = []
    for gname, cs in by_genome.items():
        names = [c['name'] for c in cs]
        for _ in range(len(names) * 14):
            a, b = rng.choice(len(names), size=2, replace=False)
            edges.append((names[a], names[b], int(rng.exponential(150)) + 8))
    for _ in range(120):
        a, b = rng.choice(len(all_contigs), size=2, replace=False)
        ca, cb = all_contigs[a], all_contigs[b]
        if ca['genome'] == cb['genome']:
            continue
        edges.append((ca['name'], cb['name'], int(rng.exponential(4)) + 1))
    seen = set()
    uniq = []
    for a, b, v in edges:
        if a == b:
            continue
        k = tuple(sorted((a, b)))
        if k in seen:
            continue
        seen.add(k)
        uniq.append((a, b, v))
    (out / "hic" / "contig_hic.tsv").write_text(
        "contig_a\tcontig_b\tsignal\n"
        + "\n".join(f"{a}\t{b}\t{v}" for a, b, v in uniq) + "\n", encoding="utf-8")
    print(f"  {len(uniq)} 条边")

    print("\n=== 5. 丰度表 ===")
    samples = [f"S{i + 1}" for i in range(4)]
    rows = []
    for gname, cs in by_genome.items():
        base = np.array(GENOMES[gname]['abun'])
        for c in cs:
            vals = np.maximum(0.0, base * (1 + rng.normal(0, 0.08, size=4)))
            rows.append((c['name'], vals))
    rows.sort(key=lambda x: x[0])
    (out / "abundance" / "abundance.tsv").write_text(
        "Contig\t" + "\t".join(samples) + "\n"
        + "\n".join(f"{n}\t" + "\t".join(f"{v:.3f}" for v in vals) for n, vals in rows) + "\n",
        encoding="utf-8")
    print(f"  {len(rows)} 个 contig × {len(samples)} 个样本")

    manifest = {
        "name": "checkm2-web 演示数据",
        "description": "3 个 MAG(含重复 bin 与污染 contig)+ Hi-C + 丰度,"
                       "所有计数来自 CheckM2 官方训练基因组",
        "genomes": {g: dict(row=v['row'], gc=v['gc'], abundance=v['abun'])
                    for g, v in GENOMES.items()},
        "magComposition": {m: [f"{g}{i:02d}" for g, i in spec] for m, spec in MAG_CONTIGS.items()},
        "summary": summary,
        "files": sorted(set(
            [str(p.relative_to(out)).replace('\\', '/') for p in out.rglob('*') if p.is_file()]
            # quality_report.tsv 由 tools/make_demo_report.mjs 随后生成,这里先登记进清单,
            # 网页端加载演示数据时会一并把它取回来(模拟真实的 checkm2 输出目录)
            + ["checkm2_out/quality_report.tsv", "manifest.json"])),
    }
    (out / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")

    total = sum(p.stat().st_size for p in out.rglob('*') if p.is_file())
    print(f"\n演示数据已写入 {out}  合计 {total / 2 ** 20:.1f} MB")
    print("下一步: node tools/make_demo_report.mjs   # 生成 quality_report.tsv")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
