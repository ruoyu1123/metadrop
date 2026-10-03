#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
export_assets.py — 把官方 CheckM2 的模型/映射数据导出为浏览器可直接读取的资产。

输入: CheckM2 安装目录(默认 ../reference/CheckM2)
输出: app/assets/ 下的 .bin / .json

产物:
  manifest.json          资产清单 + 特征布局说明
  feature_names.json     KO / 通路 / 模块 / 类别 / 元数据 的列名(顺序即特征顺序)
  groups.bin             通路(416) + 模块(757) + 类别(47) 的 KO 索引分组
  general_comp.gbm.bin   完整度 GBDT(LightGBM 文本模型解析后转二进制)
  cont.gbm.bin           污染度 GBDT
  scaler.bin             MinMaxScaler(min_, scale_)
  nn_comp.bin            specific 完整度 CNN 权重
  ref_csr.bin            (可选, 大文件) 余弦相似度参考数据 CSR

所有二进制一律小端序,JS 侧用 DataView / TypedArray 零拷贝读取。
"""
from __future__ import annotations

import argparse
import io
import json
import os
import struct
import sys
import zipfile
from pathlib import Path

import numpy as np

# --------------------------------------------------------------------------------------
# 常量:与 CheckM2 源码保持一致(见 checkm2/defaultValues.py, keggData.py, predictQuality.py)
# --------------------------------------------------------------------------------------
N_METADATA = 22          # AALength, CDS + 20 种氨基酸
KO_OFFSET = 22           # KO_Genes 起始下标
S_SCALE = 1e-3           # Keras BatchNormalization 默认 epsilon


def read_lightgbm_text(path: Path):
    """解析 LightGBM 文本模型文件(.gbm),返回逐棵树的数组。"""
    n_trees = 0
    trees = []
    cur = {}
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if line.startswith("Tree="):
                if cur:
                    trees.append(cur)
                n_trees += 1
                cur = {"idx": int(line.split("=", 1)[1])}
                continue
            if not cur or "=" not in line:
                continue
            key, val = line.split("=", 1)
            if key in ("num_leaves", "num_cat"):
                cur[key] = int(val)
            elif key in ("split_feature", "decision_type", "left_child", "right_child"):
                cur[key] = np.fromstring(val, dtype=np.int32, sep=" ")
            elif key in ("threshold", "split_gain"):
                cur[key] = np.fromstring(val, dtype=np.float64, sep=" ")
            elif key in ("leaf_value", "leaf_weight", "leaf_count", "internal_value",
                         "internal_weight", "internal_count", "shrinkage"):
                cur[key] = np.fromstring(val, dtype=np.float64, sep=" ")
    if cur:
        trees.append(cur)

    if not trees:
        raise RuntimeError(f"no trees parsed from {path}")
    return trees


def pack_gbm(trees, n_features: int) -> tuple[bytes, dict]:
    """把树打包成连续内存块,便于 JS 直接建 TypedArray 视图。

    LightGBM 文本格式里,一棵 num_leaves=L 的树有 L-1 个内部节点
    (split_feature/threshold/decision_type/left_child/right_child 长度均为 L-1),
    却有 L 个 leaf_value。left_child/right_child 中:
        >= 0  -> 该树内部节点下标
        <  0  -> 叶子, 叶子下标 = -value - 1
    """
    node_offsets = [0]
    leaf_offsets = [0]
    for t in trees:
        n_split = len(t["split_feature"])
        n_leaf = len(t["leaf_value"])
        if n_leaf != n_split + 1:
            raise RuntimeError(
                f"tree {t.get('idx')}: split={n_split} leaf={n_leaf} 不满足 leaf = split + 1")
        if t.get("num_leaves") is not None and int(t["num_leaves"]) != n_leaf:
            raise RuntimeError(f"tree {t.get('idx')}: num_leaves 与 leaf_value 数量不一致")
        node_offsets.append(node_offsets[-1] + n_split)
        leaf_offsets.append(leaf_offsets[-1] + n_leaf)
    total_nodes = node_offsets[-1]
    total_leaves = leaf_offsets[-1]

    split_feature = np.empty(total_nodes, dtype=np.int32)
    threshold = np.empty(total_nodes, dtype=np.float64)
    left = np.empty(total_nodes, dtype=np.int32)
    right = np.empty(total_nodes, dtype=np.int32)
    dtype_arr = np.empty(total_nodes, dtype=np.uint8)
    leaf_value = np.empty(total_leaves, dtype=np.float64)

    npos = lpos = 0
    for t in trees:
        n = len(t["split_feature"])
        nl = len(t["leaf_value"])
        sl = slice(npos, npos + n)
        split_feature[sl] = t["split_feature"]
        threshold[sl] = t["threshold"]
        left[sl] = t["left_child"]
        right[sl] = t["right_child"]
        dtype_arr[sl] = t["decision_type"].astype(np.uint8)
        leaf_value[lpos:lpos + nl] = t["leaf_value"]
        npos += n
        lpos += nl

    if total_nodes and int(split_feature.max()) >= n_features:
        raise RuntimeError(f"split_feature max {split_feature.max()} >= n_features {n_features}")
    if total_nodes and int(left.min()) < -total_leaves + 1:
        raise RuntimeError("left_child 叶子索引越界")
    # 分类特征的分支在 CheckM2 模型中不应出现
    if total_nodes and int(np.bitwise_and(dtype_arr, 1).max()) != 0:
        print("  ! 警告: 检测到可能为分类特征的分支(decision_type bit0=1)")

    header = struct.pack("<4sIIIIIII", b"C2GB", 1, len(trees), total_nodes, total_leaves,
                         n_features, int(dtype_arr.max()) if total_nodes else 0, 0)
    blobs = [
        ("node_offsets", np.asarray(node_offsets, dtype=np.int32).tobytes()),
        ("leaf_offsets", np.asarray(leaf_offsets, dtype=np.int32).tobytes()),
        ("split_feature", split_feature.tobytes()),
        ("threshold", threshold.tobytes()),
        ("left_child", left.tobytes()),
        ("right_child", right.tobytes()),
        ("decision_type", dtype_arr.tobytes()),
        ("leaf_value", leaf_value.tobytes()),
    ]
    body = bytearray()
    layout = {}
    cur = len(header)
    for name, raw in blobs:
        layout[name] = [cur, len(raw)]
        body += raw
        cur += len(raw)
    info = {
        "n_trees": len(trees),
        "total_nodes": int(total_nodes),
        "total_leaves": int(total_leaves),
        "n_features": n_features,
        "data_offset": len(header),
        "layout": layout,
        "bytes": cur,
    }
    return header + bytes(body), info


def pack_generic(sections: list[tuple[str, bytes]], magic: bytes, header_fmt: str,
                 header_vals: tuple) -> tuple[bytes, dict]:
    """通用打包:固定头 + 各段连续排布。"""
    header = struct.pack("<4s" + header_fmt, magic, *header_vals)
    body = bytearray()
    layout = {}
    cur = len(header)
    for name, raw in sections:
        layout[name] = [cur, len(raw)]
        body += raw
        cur += len(raw)
    return header + bytes(body), {"layout": layout, "bytes": cur}


def export_gbm(src: Path, dst: Path, n_features: int) -> dict:
    trees = read_lightgbm_text(src)
    raw, info = pack_gbm(trees, n_features)
    dst.write_bytes(raw)
    info["file"] = dst.name
    info["source"] = src.name
    return info


def export_scaler(ckpt: Path, dst: Path, n_features: int) -> dict:
    """min_ / scale_ 直接按 float64 导出: transform = X * scale_ + min_

    scaler.sav 是 sklearn MinMaxScaler 的 pickle。这里用自定义 Unpickler 取出
    数组字段,避免依赖 sklearn 本体。
    """
    import pickle

    class _Dummy:
        """任意未知类的占位符,只保留 __dict__ 状态。"""

        def __init__(self, *a, **k):
            pass

        def __setstate__(self, state):
            if isinstance(state, dict):
                self.__dict__.update(state)

    class _MinMaxScaler(_Dummy):
        pass

    class _Loader(pickle.Unpickler):
        def find_class(self, module, name):
            if module.startswith("numpy"):
                return super().find_class(module, name)
            if name == "MinMaxScaler":
                return _MinMaxScaler
            return _Dummy

    scaler = _Loader(io.BytesIO(ckpt.read_bytes())).load()
    min_ = np.asarray(scaler.min_, dtype=np.float64)
    scale_ = np.asarray(scaler.scale_, dtype=np.float64)
    if min_.shape[0] != n_features or scale_.shape[0] != n_features:
        raise RuntimeError(f"scaler size {min_.shape} != n_features {n_features}")
    raw, info = pack_generic(
        [("min", min_.tobytes()), ("scale", scale_.tobytes())],
        b"C2SC", "II", (n_features, 0),
    )
    dst.write_bytes(raw)
    info.update({"file": dst.name, "n_features": int(n_features),
                 "feature_range": [float(x) for x in getattr(scaler, "feature_range", (0, 1))]})
    return info


def export_nn(keras_path: Path, dst: Path) -> dict:
    """导出 Keras Sequential(Conv1D x4 + BN + Flatten + Dense x2) 的权重。"""
    import h5py

    zf = zipfile.ZipFile(keras_path)
    cfg = json.loads(zf.read("config.json"))["config"]
    f5 = h5py.File(io.BytesIO(zf.open("model.weights.h5").read()), "r")

    def arr(layer: str, i: int) -> np.ndarray:
        return np.asarray(f5[f"layers/{layer}/vars/{str(i)}"], dtype=np.float32)

    out = bytearray()
    layers_meta = []

    def w32(a):
        return np.ascontiguousarray(a, dtype=np.float32).tobytes()

    def u32(*vals):
        return struct.pack("<" + "I" * len(vals), *vals)

    def f32(v):
        return struct.pack("<f", float(v))

    conv_i = bn_i = dense_i = 0
    for layer in cfg["layers"]:
        cls = layer["class_name"]
        name = layer["config"]["name"]
        lc = layer["config"]
        if cls == "InputLayer":
            continue
        if cls == "Conv1D":
            kernel_i, bias_i = f"conv1d_{conv_i}" if conv_i else "conv1d", None
            layer_name = name
            w = arr(layer_name, 0)      # (k, in_ch, filters)
            b = arr(layer_name, 1)
            act = {"linear": 0, "relu": 1}.get(lc.get("activation", "linear"), 0)
            k, cin, cout = w.shape
            stride = int(lc["strides"][0]) if isinstance(lc["strides"], list) else int(lc["strides"])
            out += u32(1, cout, cin, k, stride, act)
            out += w32(w)
            out += w32(b)
            layers_meta.append({"type": "conv1d", "name": layer_name, "filters": cout,
                                "kernel": k, "stride": stride, "activation": lc.get("activation"),
                                "in_channels": cin})
            conv_i += 1
        elif cls == "BatchNormalization":
            g = arr(name, 0); be = arr(name, 1); mn = arr(name, 2); va = arr(name, 3)
            n = g.shape[0]
            out += u32(2, n)
            out += f32(S_SCALE)
            out += w32(g) + w32(be) + w32(mn) + w32(va)
            layers_meta.append({"type": "bn", "name": name, "size": int(n),
                                "epsilon": S_SCALE})
            bn_i += 1
        elif cls == "Flatten":
            out += u32(3)
            layers_meta.append({"type": "flatten", "name": name})
        elif cls == "Dense":
            w = arr(name, 0)   # (n_in, n_out)
            b = arr(name, 1)
            nin, nout = w.shape
            act = {"linear": 0, "relu": 1, "sigmoid": 2}.get(lc.get("activation", "linear"), 0)
            out += u32(4, nin, nout, act)
            out += w32(w)
            out += w32(b)
            layers_meta.append({"type": "dense", "name": name, "in": int(nin),
                                "out": int(nout), "activation": lc.get("activation")})
            dense_i += 1
        else:
            raise RuntimeError(f"unsupported layer {cls}")

    head = struct.pack("<4sII", b"C2NN", len(layers_meta), 0)
    dst.write_bytes(head + bytes(out))
    return {"file": dst.name, "layers": layers_meta, "n_layers": len(layers_meta),
            "source": keras_path.name}


def export_groups(ck2: Path, dst_bin: Path, dst_names: Path, feature_order: dict) -> dict:
    """把 KO->通路/类别映射与模块定义转成 KO 特征下标分组。

    对应 CheckM2 的 KeggCalculator.calculate_KO_group / calculate_module_completeness:
      * KO 计数先二值化(>1 记 1)
      * 通路/类别: 分子 = 该组内"存在"的 KO 数, 分母 = 该组定义的 KO 数
      * 模块: 分母取定义长度(过滤前!), 分子为映射到的 KO 数
    """
    KO_LIST = feature_order["KO_Genes"]
    ko_pos = {ko: i for i, ko in enumerate(KO_LIST)}

    mapping = json.loads(
        (ck2 / "checkm2" / "data" / "kegg_path_category_mapping.json").read_text())

    # JSON 是按列存放的字典(slot -> 值), 含 1382 个被 dropna 掉的空槽, 这里按 KO id 归组
    kegg_ids = list(mapping["Kegg_ID"].values())
    unknown = [k for k in kegg_ids if k not in ko_pos]
    if unknown:
        raise RuntimeError(
            f"映射表里有 {len(unknown)} 个 KO 不在特征列表中(CheckM2 自身也会报错), 例: {unknown[:5]}")

    def build_groups(col: str, names: list[str]) -> tuple[list[list[int]], int]:
        by_name: dict[str, list[int]] = {}
        for ko, nm in zip(kegg_ids, mapping[col].values()):
            if nm is None:
                continue
            by_name.setdefault(nm, []).append(ko_pos[ko])
        groups = [by_name.get(nm, []) for nm in names]
        missing_names = [nm for nm in names if nm not in by_name]
        return groups, len(missing_names)

    pathways, pw_missing = build_groups("KO_Pathways", feature_order["KO_Pathways"])
    categories, ct_missing = build_groups("KO_Categories", feature_order["KO_Categories"])
    if pw_missing:
        print(f"  · {pw_missing} 个通路在映射表中没有 KO(分子恒为 0)")
    if ct_missing:
        print(f"  · {ct_missing} 个类别在映射表中没有 KO")

    modules_def = json.loads(
        (ck2 / "checkm2" / "data" / "module_definitions.json").read_text())
    modules, modules_denom = [], []
    for mn in feature_order["KO_Modules"]:
        kos = modules_def.get(mn, [])
        modules_denom.append(len(kos))                    # 分母 = 定义长度(未过滤)
        modules.append(sorted({ko_pos[k] for k in kos if k in ko_pos}))
    n_zero_denom = sum(1 for d in modules_denom if d == 0)
    if n_zero_denom:
        print(f"  · {n_zero_denom} 个模块定义为空(CheckM2 中会产生 0/0 -> NaN)")

    names_meta = {"pathways": feature_order["KO_Pathways"],
                  "modules": feature_order["KO_Modules"],
                  "categories": feature_order["KO_Categories"]}
    sections = []
    for key, groups, denom in (("pathways", pathways, None),
                               ("modules", modules, modules_denom),
                               ("categories", categories, None)):
        idx = np.concatenate([np.asarray(g, dtype=np.int32) for g in groups]) \
            if groups else np.zeros(0, dtype=np.int32)
        offs = np.cumsum([0] + [len(g) for g in groups]).astype(np.int32)
        sections.append((f"{key}_offsets", offs.tobytes()))
        sections.append((f"{key}_indices", np.ascontiguousarray(idx, dtype=np.int32).tobytes()))
        if denom is not None:
            sections.append((f"{key}_denom", np.asarray(denom, dtype=np.int32).tobytes()))

    raw, info = pack_generic(sections, b"C2GR", "IIII",
                             (len(pathways), len(modules), len(categories), KO_OFFSET))
    dst_bin.write_bytes(raw)

    names_meta["ko_ids"] = KO_LIST
    names_meta["metadata"] = feature_order["Metadata"]
    dst_names.write_text(json.dumps(names_meta, ensure_ascii=False), encoding="utf-8")
    info.update({"file": dst_bin.name, "n_pathways": len(pathways),
                 "n_modules": len(modules), "n_categories": len(categories),
                 "n_group_ko_refs": int(sum(len(g) for g in pathways)
                                        + sum(len(g) for g in modules)
                                        + sum(len(g) for g in categories))})
    return info


def export_ref_csr(npz: Path, dst: Path, n_cols_keep: int = 20021) -> dict:
    """导出余弦相似度参考数据(仅前 20021 列被使用)。"""
    z = np.load(npz)
    indices = z["indices"].astype(np.int64)
    indptr = z["indptr"].astype(np.int64)
    data = z["data"].astype(np.float64)
    shape = tuple(int(x) for x in z["shape"])
    n_rows = shape[0]

    keep_rows, keep_idx, keep_val = [], [], []
    out_indptr = np.zeros(n_rows + 1, dtype=np.int64)
    total = 0
    for r in range(n_rows):
        s, e = indptr[r], indptr[r + 1]
        mask = indices[s:e] < n_cols_keep
        ki = indices[s:e][mask]
        kv = data[s:e][mask]
        keep_idx.append(ki.astype(np.uint16))
        keep_val.append(kv.astype(np.float32))
        total += ki.shape[0]
        out_indptr[r + 1] = total

    idx_all = np.concatenate(keep_idx) if keep_idx else np.zeros(0, np.uint16)
    val_all = np.concatenate(keep_val) if keep_val else np.zeros(0, np.float32)
    norms = np.zeros(n_rows, dtype=np.float32)
    for r in range(n_rows):
        s, e = out_indptr[r], out_indptr[r + 1]
        norms[r] = float(np.sqrt((val_all[s:e].astype(np.float64) ** 2).sum()))

    sections = [
        ("indptr", out_indptr.astype(np.int32).tobytes()),
        ("indices", idx_all.tobytes()),
        ("data", val_all.tobytes()),
        ("norms", norms.tobytes()),
    ]
    raw, info = pack_generic(sections, b"C2RF", "III", (n_rows, n_cols_keep, int(total)))
    dst.write_bytes(raw)
    info.update({"file": dst.name, "n_rows": n_rows, "n_cols": n_cols_keep,
                 "nnz": int(total), "nnz_before": int(data.shape[0])})
    return info


def main():
    ap = argparse.ArgumentParser()
    here = Path(__file__).resolve().parent
    ap.add_argument("--checkm2", default=str(here.parent.parent / "reference" / "CheckM2"))
    ap.add_argument("--out", default=str(here.parent / "assets"))
    ap.add_argument("--skip-ref", action="store_true", help="不导出 5400 万行的参考数据")
    args = ap.parse_args()

    ck2 = Path(args.checkm2)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    if not (ck2 / "checkm2" / "models").is_dir():
        sys.exit(f"找不到 CheckM2 目录: {ck2}")

    feature_order = json.loads((ck2 / "checkm2" / "data" / "feature_ordering.json").read_text())
    n_metadata = len(feature_order["Metadata"])
    n_ko = len(feature_order["KO_Genes"])
    n_pw = len(feature_order["KO_Pathways"])
    n_md = len(feature_order["KO_Modules"])
    n_ct = len(feature_order["KO_Categories"])
    n_features = n_metadata + n_ko + n_pw + n_md + n_ct
    ko_offset = n_metadata
    assert ko_offset == KO_OFFSET and n_metadata == N_METADATA

    manifest = {
        "generated_from": str(ck2),
        "layout": {
            "n_features": n_features,
            "metadata": {"offset": 0, "count": n_metadata},
            "ko_genes": {"offset": ko_offset, "count": n_ko},
            "ko_pathways": {"offset": ko_offset + n_ko, "count": n_pw},
            "ko_modules": {"offset": ko_offset + n_ko + n_pw, "count": n_md},
            "ko_categories": {"offset": ko_offset + n_ko + n_pw + n_md, "count": n_ct},
            "specific_model_vector_len": n_metadata + n_ko,
            "metadata_order": feature_order["Metadata"],
        },
        "assets": {},
    }

    print("[1/7] GBDT 完整度模型 …")
    manifest["assets"]["general_comp"] = export_gbm(
        ck2 / "checkm2" / "models" / "general_model_COMP.gbm", out / "general_comp.gbm.bin",
        n_features)
    print("[2/7] GBDT 污染度模型 …")
    manifest["assets"]["cont"] = export_gbm(
        ck2 / "checkm2" / "models" / "model_CONT.gbm", out / "cont.gbm.bin", n_features)
    print("[3/7] MinMaxScaler …")
    manifest["assets"]["scaler"] = export_scaler(
        ck2 / "checkm2" / "models" / "scaler.sav", out / "scaler.bin", n_features)
    print("[4/7] CNN(specific 完整度)…")
    manifest["assets"]["nn_comp"] = export_nn(
        ck2 / "checkm2" / "models" / "specific_model_COMP.keras", out / "nn_comp.bin")
    print("[5/7] KO -> 通路/模块/类别 分组 …")
    manifest["assets"]["groups"] = export_groups(
        ck2, out / "groups.bin", out / "feature_names.json", feature_order)
    if not args.skip_ref:
        print("[6/7] 余弦相似度参考数据(较大)…")
        manifest["assets"]["ref"] = export_ref_csr(
            ck2 / "checkm2" / "data" / "min_ref_rsdata_v1.npz", out / "ref_csr.bin")
    else:
        print("[6/7] 跳过参考数据")

    print("[7/7] 写入 manifest …")
    (out / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")

    print("\n导出完成 -> %s" % out)
    for k, v in manifest["assets"].items():
        f = out / v["file"]
        print("  %-14s %-18s %8.2f MB" % (k, v["file"], f.stat().st_size / 2 ** 20))
    print("  特征维度: %d (metadata %d + KO %d + pathway %d + module %d + category %d)"
          % (n_features, n_metadata, n_ko, n_pw, n_md, n_ct))


if __name__ == "__main__":
    main()
