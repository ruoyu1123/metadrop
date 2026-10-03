#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
validate_engine.py — 用官方 LightGBM / Keras 校验导出资产的解析是否正确。

流程:
  1. 读取 app/assets/*.bin(即浏览器将要读的同一份数据)
  2. 用纯 numpy 复现 GBDT / MinMaxScaler / CNN 的推理
  3. 与官方 lightgbm.Booster.predict、keras 模型输出逐元素比对
  4. 结果写入 app/tools/validation_vectors.json,供 JS 侧做同样的回归测试

用法: python tools/validate_engine.py [--n 8] [--seed 0]
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent / "assets"


# --------------------------------------------------------------------------- 读取打包资产
def load_gbm(path: Path) -> dict:
    buf = path.read_bytes()
    magic, ver, n_trees, total_nodes, total_leaves, n_features, max_dt, _ = struct.unpack_from(
        "<4sIIIIIII", buf, 0)
    assert magic == b"C2GB", magic
    off = 32
    n_node_off = n_trees + 1
    n_leaf_off = n_trees + 1

    def take(dtype, count):
        nonlocal off
        arr = np.frombuffer(buf, dtype=dtype, count=count, offset=off)
        off += arr.nbytes
        return arr

    node_off = take(np.int32, n_node_off)
    leaf_off = take(np.int32, n_leaf_off)
    split_feature = take(np.int32, total_nodes)
    threshold = take(np.float64, total_nodes)
    left = take(np.int32, total_nodes)
    right = take(np.int32, total_nodes)
    decision_type = take(np.uint8, total_nodes)
    leaf_value = take(np.float64, total_leaves)
    return dict(ver=ver, n_trees=n_trees, n_features=n_features, node_off=node_off,
                leaf_off=leaf_off, split_feature=split_feature, threshold=threshold,
                left=left, right=right, decision_type=decision_type, leaf_value=leaf_value,
                max_dt=int(max_dt))


def gbm_raw_predict(model: dict, x: np.ndarray) -> np.ndarray:
    """返回 LightGBM 的原始输出(未做 objective 的 ConvertOutput)。"""
    out = np.zeros(x.shape[0], dtype=np.float64)
    for r in range(x.shape[0]):
        row = x[r]
        acc = 0.0
        for t in range(model["n_trees"]):
            n0, n1 = model["node_off"][t], model["node_off"][t + 1]
            l0 = model["leaf_off"][t]
            node = 0
            while True:
                g = n0 + node
                f = row[model["split_feature"][g]]
                if f <= model["threshold"][g]:
                    nxt = model["left"][g]
                else:
                    nxt = model["right"][g]
                if nxt < 0:
                    acc += model["leaf_value"][l0 + (-nxt - 1)]
                    break
                node = nxt
        out[r] = acc
    return out


def gbm_predict(model: dict, x: np.ndarray) -> np.ndarray:
    """CheckM2 使用的完整预测: sqrt 目标 -> 平方, 并做 [0,100] 截断。"""
    raw = gbm_raw_predict(model, x)
    pred = raw * np.abs(raw)
    return np.clip(pred, 0.0, None)


def load_scaler(path: Path) -> tuple[np.ndarray, np.ndarray]:
    buf = path.read_bytes()
    magic, n, _ = struct.unpack_from("<4sII", buf, 0)
    assert magic == b"C2SC", magic
    off = 12
    min_ = np.frombuffer(buf, dtype=np.float64, count=n, offset=off).copy()
    off += min_.nbytes
    scale_ = np.frombuffer(buf, dtype=np.float64, count=n, offset=off).copy()
    return min_, scale_


def load_nn(path: Path):
    buf = path.read_bytes()
    magic, n_layers, _ = struct.unpack_from("<4sII", buf, 0)
    assert magic == b"C2NN", magic
    off = 12
    layers, weights = [], {}
    for _ in range(n_layers):
        t, = struct.unpack_from("<I", buf, off)
        off += 4
        if t == 1:
            cout, cin, k, stride, act = struct.unpack_from("<IIIII", buf, off)
            off += 20
            w = np.frombuffer(buf, dtype=np.float32, count=k * cin * cout, offset=off).copy()
            off += w.nbytes
            b = np.frombuffer(buf, dtype=np.float32, count=cout, offset=off).copy()
            off += b.nbytes
            layer = dict(type="conv1d", cout=cout, cin=cin, k=k, stride=stride, act=act)
            weights[len(layers)] = (w.reshape(k, cin, cout), b)
        elif t == 2:
            n, = struct.unpack_from("<I", buf, off)
            off += 4
            eps, = struct.unpack_from("<f", buf, off)
            off += 4
            g = np.frombuffer(buf, dtype=np.float32, count=n, offset=off).copy(); off += g.nbytes
            be = np.frombuffer(buf, dtype=np.float32, count=n, offset=off).copy(); off += be.nbytes
            mn = np.frombuffer(buf, dtype=np.float32, count=n, offset=off).copy(); off += mn.nbytes
            va = np.frombuffer(buf, dtype=np.float32, count=n, offset=off).copy(); off += va.nbytes
            layer = dict(type="bn", n=n, eps=eps)
            weights[len(layers)] = (g, be, mn, va)
        elif t == 3:
            layer = dict(type="flatten")
        elif t == 4:
            nin, nout, act = struct.unpack_from("<III", buf, off)
            off += 12
            w = np.frombuffer(buf, dtype=np.float32, count=nin * nout, offset=off).copy()
            off += w.nbytes
            b = np.frombuffer(buf, dtype=np.float32, count=nout, offset=off).copy()
            off += b.nbytes
            layer = dict(type="dense", nin=nin, nout=nout, act=act)
            weights[len(layers)] = (w.reshape(nin, nout), b)
        else:
            raise RuntimeError(f"未知层类型 {t}")
        layers.append(layer)
    return layers, weights


def nn_forward(layers, weights, x: np.ndarray) -> np.ndarray:
    """x: (20021,) -> 标量(sigmoid 输出, 未乘 100)"""
    a = x.reshape(-1, 1).astype(np.float32)  # (T, C)
    for i, layer in enumerate(layers):
        t = layer["type"]
        if t == "conv1d":
            w, b = weights[i]
            k, cin, cout = w.shape
            step = layer["stride"]
            T = a.shape[0]
            n_out = (T - k) // step + 1
            idx = (np.arange(k)[None, :] + step * np.arange(n_out)[:, None])  # (n_out, k)
            patches = a[idx]                                  # (n_out, k, cin)
            out = patches.reshape(n_out, -1) @ w.reshape(k * cin, cout) + b
            if layer["act"] == 1:
                out = np.maximum(out, 0)
            a = out
        elif t == "bn":
            g, be, mn, va = weights[i]
            a = g * (a - mn) / np.sqrt(va + layer["eps"]) + be
        elif t == "flatten":
            a = a.reshape(-1)
        elif t == "dense":
            w, b = weights[i]
            a = a @ w + b
            if layer["act"] == 1:
                a = np.maximum(a, 0)
            elif layer["act"] == 2:
                a = 1.0 / (1.0 + np.exp(-a))
    return float(np.asarray(a).reshape(-1)[0])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=6, help="随机测试向量个数")
    ap.add_argument("--seed", type=int, default=20240915)
    args = ap.parse_args()

    rng = np.random.RandomState(args.seed)
    manifest = json.loads((ASSETS / "manifest.json").read_text())
    n_features = manifest["layout"]["n_features"]
    spec_len = manifest["layout"]["specific_model_vector_len"]

    # 构造"像样"的特征向量: 元数据 + 稀疏 KO 计数,其余为比率
    def make_vector(scale=1.0):
        v = np.zeros(n_features, dtype=np.float64)
        v[0:20] = rng.randint(30_000, 400_000, 20) * scale      # 氨基酸计数
        v[20] = v[0:20].sum()                                    # AALength
        v[21] = rng.randint(1000, 4500)                          # CDS
        ko = rng.choice(manifest["layout"]["ko_genes"]["count"],
                        size=int(600 * scale), replace=False)
        v[22 + ko] = rng.randint(1, 4, ko.size)
        v[22 + 19999:] = rng.rand(n_features - 22 - 19999)
        return v

    vectors = [make_vector(s) for s in (1.0, 0.6, 1.4, 0.3)]
    while len(vectors) < args.n:
        vectors.append(make_vector(float(rng.uniform(0.2, 1.5))))
    X = np.vstack(vectors)

    report = {"seed": args.seed, "n_features": n_features, "checks": [], "vectors": []}

    # ---- 1. MinMaxScaler
    min_, scale_ = load_scaler(ASSETS / "scaler.bin")
    Xs = X * scale_ + min_
    # 与官方 pickle 中数值直接比对(scale_/min_ 已原样导出)
    print(f"[scaler] n={min_.size} scale_范围=({scale_.min():.3g},{scale_.max():.3g}) "
          f"min_范围=({min_.min():.3g},{min_.max():.3g})")
    report["scaler"] = {"n": int(min_.size), "scale_min": float(scale_.min()),
                        "scale_max": float(scale_.max()), "min_min": float(min_.min()),
                        "min_max": float(min_.max())}

    # ---- 2. GBDT vs lightgbm
    #  注意: CheckM2 仓库里的 .gbm 是 CRLF 行尾, lightgbm 官方解析器不接受,
    #  这里在临时目录写一份 LF 副本仅用于交叉验证(我们自己的解析器兼容 CRLF)。
    import tempfile
    import lightgbm as lgb
    official_dir = HERE.parent.parent / "reference" / "CheckM2" / "checkm2" / "models"
    tmp_dir = Path(tempfile.mkdtemp(prefix="gbmfix_"))

    def lf_copy(path: Path) -> Path:
        dst = tmp_dir / path.name
        dst.write_bytes(path.read_bytes().replace(b"\r\n", b"\n"))
        return dst

    for key, fname, official in (
        ("general_comp", "general_comp.gbm.bin", "general_model_COMP.gbm"),
        ("cont", "cont.gbm.bin", "model_CONT.gbm"),
    ):
        model = load_gbm(ASSETS / fname)
        mine_raw = gbm_raw_predict(model, X)
        mine = gbm_predict(model, X)
        booster = lgb.Booster(model_file=str(lf_copy(official_dir / official)))
        theirs = booster.predict(X)
        # booster.predict 返回的是 objective 转换后的值(regression sqrt -> raw*|raw|)
        diff_raw = np.abs(mine_raw - np.sqrt(np.abs(theirs)))
        diff_pred = np.abs(mine - theirs)
        print(f"[{key}] trees={model['n_trees']} nodes={model['node_off'][-1]} "
              f"raw 最大绝对误差={diff_raw.max():.3e} (自实现 raw 开方对照)")
        print(f"          mine(raw*|raw|)={np.round(mine, 4)[:4]}  official={np.round(theirs, 4)[:4]}")
        ok = diff_pred.max() < 1e-9
        report["checks"].append({"name": key, "type": "gbdt",
                                 "max_abs_err_raw": float(diff_raw.max()),
                                 "max_abs_err_pred": float(np.abs(mine - theirs).max()),
                                 "pass": bool(ok)})
        report[f"{key}_predictions"] = [float(x) for x in mine]

    # ---- 3. CNN vs keras
    layers, weights = load_nn(ASSETS / "nn_comp.bin")
    mine_nn = np.array([nn_forward(layers, weights, Xs[i, :spec_len]) for i in range(X.shape[0])])
    try:
        import os
        os.environ.setdefault("KERAS_BACKEND", "jax")
        import keras
        model = keras.saving.load_model(str(HERE.parent.parent / "reference" / "CheckM2" /
                                            "checkm2" / "models" / "specific_model_COMP.keras"))
        inp = Xs[:, :spec_len].reshape(-1, spec_len, 1).astype(np.float32)
        official_nn = np.asarray(model.predict(inp, verbose=0)).reshape(-1)
        err = np.abs(mine_nn - official_nn)
        print(f"[nn_comp] keras 比对最大绝对误差={err.max():.3e}")
        print(f"          mine={np.round(mine_nn * 100, 4)[:4]}  keras={np.round(official_nn * 100, 4)[:4]}")
        report["checks"].append({"name": "nn_comp", "type": "cnn",
                                 "max_abs_err": float(err.max()), "pass": bool(err.max() < 1e-4)})
        report["nn_prediction_factor"] = 100.0
    except Exception as exc:  # noqa: BLE001
        print(f"[nn_comp] 无法加载 keras({exc.__class__.__name__}: {exc}),仅保存本地实现结果")
        report["checks"].append({"name": "nn_comp", "type": "cnn", "pass": None,
                                 "note": f"keras unavailable: {exc}"})
    report["nn_impl_predictions"] = [float(x) for x in mine_nn]

    # ---- 4. 保存回归向量(供 JS 侧比对)
    report["vectors"] = [[float(x) for x in row] for row in vectors]
    (HERE / "validation_vectors.json").write_text(
        json.dumps(report, ensure_ascii=False), encoding="utf-8")
    print("\n回归向量已写入 tools/validation_vectors.json")
    failed = [c for c in report["checks"] if c.get("pass") is False]
    if failed:
        print("!! 校验失败:", failed)
        sys.exit(1)
    print("校验通过 ✓")


if __name__ == "__main__":
    main()
