#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
validate_end2end.py — 端到端基准:从 KO 计数一路算到完整性/污染度。

与 validate_engine.py 的区别:
  * validate_engine.py 验证的是"给定 21241 维特征向量时的模型推理"(用官方
    LightGBM/Keras 比对),已通过,误差 0 / 1e-11。
  * 本脚本验证"从计数组装特征向量"这一步,也就是通路/模块/类别完整度的计算、
    Metadata 顺序、以及 assets/groups.bin 的导出是否正确。

做法:
  1. 纯 Python 独立实现一遍 CheckM2 的 KeggCalculator 语义(直接读官方 JSON)
  2. 与导出的 assets/groups.bin 逐组比对索引,确认导出无损
  3. 组装 21241 维特征向量,用官方 LightGBM 与 numpy 版 CNN 推理
  4. 结果写入 tools/e2e_vectors.json,供 JS/WASM 引擎做端到端回归

用法: python tools/validate_end2end.py [--n 4]
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
APP = HERE.parent
ASSETS = APP / "assets"
CK2 = APP.parent / "reference" / "CheckM2" / "checkm2"

N_METADATA = 22
N_KO = 19999
N_COUNTS = N_METADATA + N_KO
N_FEATURES = 21241


# --------------------------------------------------------------------- 官方语义(纯 Python)

def build_group_indices():
    """独立实现 CheckM2 KeggCalculator 的分组,返回 (通路, 模块, 模块分母, 类别)。"""
    feature_order = json.loads((CK2 / "data" / "feature_ordering.json").read_text())
    mapping = json.loads((CK2 / "data" / "kegg_path_category_mapping.json").read_text())
    modules_def = json.loads((CK2 / "data" / "module_definitions.json").read_text())

    ko_list = feature_order["KO_Genes"]
    pos = {ko: i for i, ko in enumerate(ko_list)}

    pw_names = feature_order["KO_Pathways"]
    ct_names = feature_order["KO_Categories"]
    pw = {n: [] for n in pw_names}
    ct = {n: [] for n in ct_names}
    for slot, ko in mapping["Kegg_ID"].items():
        p = mapping["KO_Pathways"].get(slot)
        c = mapping["KO_Categories"].get(slot)
        if p in pw:
            pw[p].append(pos[ko])
        if c in ct:
            ct[c].append(pos[ko])

    md_names = feature_order["KO_Modules"]
    md, md_denom = [], []
    for mn in md_names:
        kos = modules_def.get(mn, [])
        md_denom.append(len(kos))
        md.append(sorted({pos[k] for k in kos if k in pos}))

    return (
        feature_order,
        [sorted(pw[n]) for n in pw_names],
        [sorted(g) for g in md],
        md_denom,
        [sorted(ct[n]) for n in ct_names],
    )


def parse_exported_groups(path: Path):
    """解析 assets/groups.bin,还原每个分组的 KO 下标列表。"""
    buf = path.read_bytes()
    magic = buf[0:4]
    assert magic == b"C2GR", magic
    n_pw, n_md, n_ct, ko_off = struct.unpack_from("<IIII", buf, 4)
    off = 20

    def take_arr(dtype, count):
        nonlocal off
        arr = np.frombuffer(buf, dtype=dtype, count=count, offset=off)
        off += arr.nbytes
        return arr

    def groups_from(offsets, indices, n):
        return [sorted(int(x) for x in indices[offsets[i]:offsets[i + 1]]) for i in range(n)]

    pw_offs = take_arr(np.int32, n_pw + 1)
    pw_idx = take_arr(np.int32, int(pw_offs[-1]))
    md_offs = take_arr(np.int32, n_md + 1)
    md_idx = take_arr(np.int32, int(md_offs[-1]))
    md_denom = take_arr(np.int32, n_md)
    ct_offs = take_arr(np.int32, n_ct + 1)
    ct_idx = take_arr(np.int32, int(ct_offs[-1]))

    return (ko_off,
            groups_from(pw_offs, pw_idx, n_pw),
            groups_from(md_offs, md_idx, n_md),
            [int(x) for x in md_denom],
            groups_from(ct_offs, ct_idx, n_ct))


# ---------------------------------------------------------------- 参考数据(真实训练基因组)

def load_ref(sample_rows=None):
    """读取 assets/ref_csr.bin(CSR)以及若干行的稠密视图。"""
    buf = (ASSETS / "ref_csr.bin").read_bytes()
    n_rows, n_cols, nnz = struct.unpack_from("<III", buf, 4)
    off = 16
    indptr = np.frombuffer(buf, dtype=np.int32, count=n_rows + 1, offset=off).copy()
    off += (n_rows + 1) * 4
    indices = np.frombuffer(buf, dtype=np.uint16, count=nnz, offset=off).copy()
    off += nnz * 2
    data = np.frombuffer(buf, dtype=np.float32, count=nnz, offset=off).copy()
    off += nnz * 4
    norms = np.frombuffer(buf, dtype=np.float32, count=n_rows, offset=off).copy()
    ref = {"n_rows": n_rows, "n_cols": n_cols, "nnz": nnz,
           "indptr": indptr, "indices": indices, "data": data, "norms": norms}

    if sample_rows is None:
        return ref
    dense = []
    for r in sample_rows:
        row = np.zeros(n_cols, dtype=np.float64)
        row[indices[indptr[r]:indptr[r + 1]]] = data[indptr[r]:indptr[r + 1]]
        dense.append(row)
    ref["dense"] = dense
    return ref


def max_cosine(query_scaled, ref):
    """查询向量(已缩放,前 20021 维)与参考矩阵的最大余弦相似度。"""
    qn = float(np.sqrt((query_scaled ** 2).sum()))
    if qn == 0:
        return 0.0
    best = 0.0
    for r in range(ref["n_rows"]):
        s, e = ref["indptr"][r], ref["indptr"][r + 1]
        dot = float((ref["data"][s:e].astype(np.float64)
                     * query_scaled[ref["indices"][s:e]]).sum())
        nr = float(ref["norms"][r])
        if nr == 0:
            continue
        sim = dot / (qn * nr)
        if sim > best:
            best = sim
    return best


def unscale_to_counts(dense_rows, min_, scale_):
    """把缩放后的特征还原成计数(KO 段应当还原为整数)。"""
    out = []
    for row in dense_rows:
        counts = np.zeros(N_COUNTS, dtype=np.float64)
        nz = row[:N_COUNTS] != 0
        counts[nz] = (row[:N_COUNTS][nz] - min_[:N_COUNTS][nz]) / scale_[:N_COUNTS][nz]
        out.append(counts)
    return out


def scale_vector(counts, min_, scale_):
    v = np.zeros(N_COUNTS, dtype=np.float64)
    nz = counts != 0
    v[nz] = counts[nz] * scale_[:N_COUNTS][nz] + min_[:N_COUNTS][nz]
    return v


def make_counts(rng, n_ko_present: int, aa_total: float, cds: int) -> np.ndarray:
    """造一个"像真实 MAG"的计数向量(20021 维)"""
    counts = np.zeros(N_COUNTS, dtype=np.float64)
    # 20 种氨基酸:总量为 aa_total,按真实蛋白组的近似比例分配
    frac = np.array([0.090, 0.013, 0.053, 0.062, 0.040, 0.073, 0.023, 0.056, 0.058,
                     0.100, 0.024, 0.041, 0.047, 0.039, 0.056, 0.066, 0.055, 0.070,
                     0.012, 0.031])
    frac = frac / frac.sum()
    counts[0:20] = np.round(aa_total * frac)
    counts[20] = counts[0:20].sum()
    counts[21] = cds
    ko_pos = rng.choice(N_KO, size=n_ko_present, replace=False)
    counts[22 + ko_pos] = rng.choice([1, 1, 1, 2, 2, 3], size=n_ko_present)
    return counts


def features_from_counts(counts, groups):
    _, pw, md, md_denom, ct = groups
    ko = counts[22:N_COUNTS]
    presence = ko > 0

    def ratio(idxs, denom):
        return (presence[idxs].sum() / denom) if denom else 0.0

    vec = np.zeros(N_FEATURES, dtype=np.float64)
    vec[:N_COUNTS] = counts
    off = N_COUNTS
    for idxs in pw:
        vec[off] = ratio(idxs, len(idxs)); off += 1
    for i, idxs in enumerate(md):
        vec[off] = ratio(idxs, md_denom[i]); off += 1
    for idxs in ct:
        vec[off] = ratio(idxs, len(idxs)); off += 1
    assert off == N_FEATURES
    return vec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=4)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    print("=== 1. 独立复现分组,并与 assets/groups.bin 对比 ===")
    groups = build_group_indices()
    feature_order = groups[0]
    exported = parse_exported_groups(ASSETS / "groups.bin")
    ko_off = exported[0]
    print(f"  KO 段偏移: 导出={ko_off} (期望 {N_METADATA})")
    assert ko_off == N_METADATA
    for name, mine, theirs in (("通路", groups[1], exported[1]),
                               ("模块", groups[2], exported[2]),
                               ("类别", groups[4], exported[4])):
        same = len(mine) == len(theirs) and all(a == b for a, b in zip(mine, theirs))
        n_idx = sum(len(g) for g in mine)
        print(f"  {name}: {len(mine)} 组 / {n_idx} 个 KO 引用 -> {'一致 ✓' if same else '不一致 ✗'}")
        assert same, f"{name} 分组与导出一致性校验失败"
    assert groups[3] == exported[3], "模块分母与导出不一致"
    print("  模块分母: 一致 ✓")

    print("\n=== 2. 组装特征向量并推理 ===")
    from validate_engine import load_gbm, gbm_predict, load_scaler, load_nn, nn_forward

    rng = np.random.RandomState(args.seed)
    manifest = json.loads((ASSETS / "manifest.json").read_text())
    n_features = manifest["layout"]["n_features"]
    spec_len = manifest["layout"]["specific_model_vector_len"]
    assert n_features == N_FEATURES and spec_len == N_COUNTS

    gbm_comp = load_gbm(ASSETS / "general_comp.gbm.bin")
    gbm_cont = load_gbm(ASSETS / "cont.gbm.bin")
    min_, scale_ = load_scaler(ASSETS / "scaler.bin")
    layers, weights = load_nn(ASSETS / "nn_comp.bin")

    # 真实 MAG 的量级参考: 平均蛋白长度约 320 aa,约 1 个基因/1000 bp
    #   E. coli(4.6 Mb, 完整): CDS≈4300, AALength≈1.4M
    #   沙漏型/缩减基因组(1 Mb): CDS≈1000, AALength≈320k
    cases = [
        (3500, 1_400_000, 4300),     # 接近完整的 4.6 Mb 基因组
        (2100, 930_000, 2900),       # 典型 3 Mb MAG
        (1500, 640_000, 2000),       # 中等 2 Mb
        (900, 320_000, 1000),        # 基因组缩减
        (2600, 1_950_000, 6100),     # KO 偏多
    ][:args.n]
    counts_list, vecs = [], []
    for (n_ko, aa_total, cds) in cases:
        c = make_counts(rng, n_ko, aa_total, cds)
        counts_list.append(c)
        vecs.append(features_from_counts(c, groups))

    X = np.vstack(vecs)
    print(f"  通路完整度均值 {X[:, 20021:20437].mean():.4f} | "
          f"模块 {X[:, 20437:21194].mean():.4f} | 类别 {X[:, 21194:].mean():.4f}")

    import lightgbm as lgb
    import tempfile
    tmp = Path(tempfile.mkdtemp(prefix="gbmfix_"))

    def lf_copy(p):
        d = tmp / p.name
        d.write_bytes(p.read_bytes().replace(b"\r\n", b"\n"))
        return d

    booster_comp = lgb.Booster(model_file=str(lf_copy(
        CK2 / "models" / "general_model_COMP.gbm")))
    booster_cont = lgb.Booster(model_file=str(lf_copy(
        CK2 / "models" / "model_CONT.gbm")))
    # CheckM2 在 run_prediction_general 里把完整度截断到 [0,100],污染度只截断下界
    official_comp = np.clip(booster_comp.predict(X), 0, 100)
    official_cont = np.maximum(booster_cont.predict(X), 0)

    Xs = X[:, :spec_len] * scale_[:spec_len] + min_[:spec_len]
    nn_pred = np.array([nn_forward(layers, weights, Xs[i]) * 100 for i in range(X.shape[0])])

    # 与自实现推理交叉核对
    mine_comp = gbm_predict(gbm_comp, X)
    mine_cont = gbm_predict(gbm_cont, X)
    print(f"  自实现 GBDT vs 官方 LightGBM: maxErr="
          f"{np.abs(mine_comp - official_comp).max():.3e} / "
          f"{np.abs(mine_cont - official_cont).max():.3e}")
    assert np.abs(mine_comp - official_comp).max() < 1e-9
    assert np.abs(mine_cont - official_cont).max() < 1e-9

    for i in range(X.shape[0]):
        print(f"  #{i}: 完整度(通用)={official_comp[i]:6.2f}  污染度={official_cont[i]:6.2f}"
              f"  完整度(CNN)={nn_pred[i]:6.2f}")

    out = {
        "n_features": N_FEATURES,
        "n_counts": N_COUNTS,
        "synthetic": {
            "counts": [[float(x) for x in c] for c in counts_list],
            "vectors": [[float(x) for x in v] for v in vecs],
            "general": [float(x) for x in official_comp],
            "contamination": [float(x) for x in official_cont],
            "specific": [float(x) for x in nn_pred],
        },
    }

    # ---------------------------------------------------------------- 3. 真实训练基因组
    #   assets/ref_csr.bin 里是 5300 个真实训练基因组(已 min-max 缩放)的前 20021 维。
    #   反缩放即可还原 KO 计数 —— 若 scaler 提取有误,还原出来就不会是整数。
    print("\n=== 3. 用真实训练基因组做端到端基准 ===")
    rows_to_take = [0, 137, 512, 1500, 2600, 3900, 5299]
    ref = load_ref(sample_rows=rows_to_take)
    ref_rows = ref["dense"]
    kr = unscale_to_counts(ref_rows, min_, scale_)
    # KO 段(下标 22..)的原始值就是整数计数,反缩放必须精确还原整数。
    # 元数据段(AALength 等)数值很大,缩放后存成 float32 时精度上限约 0.3,故不参与该判定。
    dev_ko = max(np.abs(k[22:N_COUNTS] - np.round(k[22:N_COUNTS])).max() for k in kr)
    dev_meta = max(np.abs(k[:22] - np.round(k[:22])).max() for k in kr)
    print(f"  KO 段反缩放与整数最大偏差 {dev_ko:.3e} -> "
          f"{'整数 ✓(scaler 提取正确)' if dev_ko < 1e-3 else '非整数 ✗'}")
    print(f"  元数据段最大偏差 {dev_meta:.3e}(float32 存储精度所致,可忽略)")
    assert dev_ko < 1e-3, "KO 计数无法还原为整数,min_/scale_ 提取可能有误"

    real_counts = [np.round(c) for c in kr]
    real_vecs, real_csm = [], []
    for c in real_counts:
        v = features_from_counts(c, groups)
        real_vecs.append(v)
        real_csm.append(max_cosine(scale_vector(c[:N_COUNTS], min_, scale_), ref))
    Xr = np.vstack(real_vecs)
    real_comp = np.clip(booster_comp.predict(Xr), 0, 100)
    real_cont = np.maximum(booster_cont.predict(Xr), 0)
    Xrs = Xr[:, :spec_len] * scale_[:spec_len] + min_[:spec_len]
    real_nn = np.array([nn_forward(layers, weights, Xrs[i]) * 100 for i in range(Xr.shape[0])])
    for i in range(Xr.shape[0]):
        c = real_counts[i]
        print(f"  #{i}: KO {int((c[22:]>0).sum())} 个 / CDS {int(c[21])} / AA {int(c[20])}"
              f"  -> 完整度(通用)={real_comp[i]:6.2f} 污染度={real_cont[i]:6.2f}"
              f" CNN={real_nn[i]:6.2f} 余弦={real_csm[i]:.4f}")
    assert min(real_csm) > 0.99, f"自相似余弦应接近 1,实际 {min(real_csm)}"

    out["reference"] = {
        "counts": [[float(x) for x in c] for c in real_counts],
        "vectors": [[float(x) for x in v] for v in real_vecs],
        "general": [float(x) for x in real_comp],
        "contamination": [float(x) for x in real_cont],
        "specific": [float(x) for x in real_nn],
        "cosine": [float(x) for x in real_csm],
    }

    (HERE / "e2e_vectors.json").write_text(json.dumps(out), encoding="utf-8")
    size_mb = (HERE / "e2e_vectors.json").stat().st_size / 2 ** 20
    print(f"\n端到端基准已写入 tools/e2e_vectors.json ({size_mb:.1f} MB)")
    print("校验通过 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main())
