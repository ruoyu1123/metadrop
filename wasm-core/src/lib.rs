//! checkm2-core — CheckM2 推理内核的 WebAssembly 实现。
//!
//! 纯计算,不依赖第三方 crate。所有资产以打包好的小端序二进制传入
//! (见 tools/export_assets.py),JS 侧负责文件读取与内存搬运。
//!
//! 导出函数:
//!   c2_alloc / c2_free      线性内存分配(JS 用来放输入数据)
//!   c2_gbm_predict          LightGBM 预测(返回原始累加值)
//!   c2_minmax_transform     MinMaxScaler: x * scale + min
//!   c2_group_ratios         KO 二值化 -> 通路/模块/类别 完整度比率
//!   c2_nn_forward           specific 完整度 CNN 前向传播(输出 sigmoid)
//!   c2_version              内核版本

#![allow(clippy::missing_safety_doc)]
#![allow(dead_code)]

use std::alloc::{alloc as rust_alloc, dealloc as rust_dealloc, Layout};

// ----------------------------------------------------------------------------- 内存

/// 分配 `size` 字节(8 字节对齐)。返回空指针表示失败。
#[no_mangle]
pub extern "C" fn c2_alloc(size: usize) -> *mut u8 {
    if size == 0 {
        return std::ptr::null_mut();
    }
    unsafe { rust_alloc(Layout::from_size_align_unchecked(size, 8)) }
}

/// 释放 `c2_alloc` 分配的内存。
#[no_mangle]
pub unsafe extern "C" fn c2_free(ptr: *mut u8, size: usize) {
    if ptr.is_null() || size == 0 {
        return;
    }
    rust_dealloc(ptr, Layout::from_size_align_unchecked(size, 8));
}

#[no_mangle]
pub extern "C" fn c2_version() -> u32 {
    0x0001_0002
}

// ----------------------------------------------------------------------------- 读取工具

#[inline(always)]
unsafe fn u32_at(buf: *const u8, off: usize) -> u32 {
    u32::from_le_bytes([
        *buf.add(off),
        *buf.add(off + 1),
        *buf.add(off + 2),
        *buf.add(off + 3),
    ])
}

#[inline(always)]
unsafe fn i32_at(buf: *const u8, off: usize) -> i32 {
    i32::from_le_bytes([
        *buf.add(off),
        *buf.add(off + 1),
        *buf.add(off + 2),
        *buf.add(off + 3),
    ])
}

#[inline(always)]
unsafe fn f64_at(buf: *const u8, off: usize) -> f64 {
    let mut b = [0u8; 8];
    std::ptr::copy_nonoverlapping(buf.add(off), b.as_mut_ptr(), 8);
    f64::from_le_bytes(b)
}

#[inline(always)]
unsafe fn f32_at(buf: *const u8, off: usize) -> f32 {
    f32::from_le_bytes([
        *buf.add(off),
        *buf.add(off + 1),
        *buf.add(off + 2),
        *buf.add(off + 3),
    ])
}

/// f64 数组视图(不要求 8 字节对齐,wasm 允许非对齐访问)。
#[inline(always)]
unsafe fn f64_slice(buf: *const u8, off: usize, n: usize) -> &'static [f64] {
    std::slice::from_raw_parts(buf.add(off) as *const f64, n)
}

#[inline(always)]
unsafe fn f32_slice(buf: *const u8, off: usize, n: usize) -> &'static [f32] {
    std::slice::from_raw_parts(buf.add(off) as *const f32, n)
}

// ----------------------------------------------------------------------------- GBDT

/// 累加一棵树的值。`node_off`/`leaf_off` 为该树的内部节点与叶子起始下标。
#[inline(always)]
unsafe fn tree_sum(
    m: *const u8,
    o: &Layout2,
    n0: usize,
    l0: usize,
    feat: *const f64,
    n_features: usize,
) -> f64 {
    let mut node = 0usize;
    loop {
        let g = n0 + node;
        let fi = i32_at(m, o.split_feature + g * 4) as usize;
        // 模型不应引用越界特征;越界时按缺失(0)处理并跳过阈值比较
        if fi >= n_features {
            return 0.0;
        }
        let fval = *feat.add(fi);
        let thr = f64_at(m, o.threshold + g * 8);
        // LightGBM 数值分支:fval <= threshold 走左子树
        let nxt = if fval <= thr {
            i32_at(m, o.left + g * 4)
        } else {
            i32_at(m, o.right + g * 4)
        };
        if nxt < 0 {
            return f64_at(m, o.leaf_value + (l0 + (-nxt - 1) as usize) * 8);
        }
        node = nxt as usize;
    }
}

struct Layout2 {
    node_off: usize,
    leaf_off: usize,
    split_feature: usize,
    threshold: usize,
    left: usize,
    right: usize,
    decision_type: usize,
    leaf_value: usize,
}

/// 解析 C2GB 头与各段偏移。
unsafe fn gbm_layout(m: *const u8) -> (usize, Layout2) {
    let n_trees = u32_at(m, 8) as usize;
    let total_nodes = u32_at(m, 12) as usize;
    let n_leaves = u32_at(m, 16) as usize;
    let mut off = 32usize;
    let l = Layout2 {
        node_off: {
            let v = off;
            off += (n_trees + 1) * 4;
            v
        },
        leaf_off: {
            let v = off;
            off += (n_trees + 1) * 4;
            v
        },
        split_feature: {
            let v = off;
            off += total_nodes * 4;
            v
        },
        threshold: {
            let v = off;
            off += total_nodes * 8;
            v
        },
        left: {
            let v = off;
            off += total_nodes * 4;
            v
        },
        right: {
            let v = off;
            off += total_nodes * 4;
            v
        },
        decision_type: {
            let v = off;
            off += total_nodes;
            v
        },
        leaf_value: {
            let v = off;
            off += n_leaves * 8;
            v
        },
    };
    (n_trees, l)
}

/// LightGBM 预测。`model` 为 C2GB 打包数据,`feat` 为 n_features 维特征向量。
/// 返回原始累加值(CheckM2 之后做 x*|x| 与 [0,100] 截断)。
/// `max_trees` 传 0 表示用全部树。
#[no_mangle]
pub unsafe extern "C" fn c2_gbm_predict(
    model: *const u8,
    feat: *const f64,
    max_trees: u32,
) -> f64 {
    let (n_trees, o) = gbm_layout(model);
    let n_features = u32_at(model, 20) as usize;
    let trees = if max_trees == 0 || max_trees as usize > n_trees {
        n_trees
    } else {
        max_trees as usize
    };

    let mut acc = 0.0f64;
    let mut t = 0usize;
    while t < trees {
        let n0 = i32_at(model, o.node_off + t * 4) as usize;
        let l0 = i32_at(model, o.leaf_off + t * 4) as usize;
        acc += tree_sum(model, &o, n0, l0, feat, n_features);
        t += 1;
    }
    acc
}

/// 逐棵树输出累加值(用于 SHAP 风格的贡献分析),写入 `out`(长度 n_trees)。
#[no_mangle]
pub unsafe extern "C" fn c2_gbm_tree_values(
    model: *const u8,
    feat: *const f64,
    out: *mut f64,
) {
    let (n_trees, o) = gbm_layout(model);
    let n_features = u32_at(model, 20) as usize;
    for t in 0..n_trees {
        let n0 = i32_at(model, o.node_off + t * 4) as usize;
        let l0 = i32_at(model, o.leaf_off + t * 4) as usize;
        *out.add(t) = tree_sum(model, &o, n0, l0, feat, n_features);
    }
}

// ----------------------------------------------------------------------------- MinMaxScaler

/// out = x * scale + min
#[no_mangle]
pub unsafe extern "C" fn c2_minmax_transform(
    x: *const f64,
    min_: *const f64,
    scale: *const f64,
    out: *mut f64,
    n: usize,
) {
    let mut i = 0usize;
    while i < n {
        *out.add(i) = *x.add(i) * *scale.add(i) + *min_.add(i);
        i += 1;
    }
}

// ----------------------------------------------------------------------------- 通路 / 模块 / 类别

/// C2GR 各段偏移。
unsafe fn group_layout(g: *const u8) -> (usize, usize, usize, GroupLayout) {
    let n_pw = u32_at(g, 4) as usize;
    let n_md = u32_at(g, 8) as usize;
    let n_ct = u32_at(g, 12) as usize;
    let mut off = 20usize;

    let pw_off = off;
    off += (n_pw + 1) * 4;
    let pw_nnz = i32_at(g, pw_off + n_pw * 4) as usize;
    let pw_idx = off;
    off += pw_nnz * 4;

    let md_off = off;
    off += (n_md + 1) * 4;
    let md_nnz = i32_at(g, md_off + n_md * 4) as usize;
    let md_idx = off;
    off += md_nnz * 4;
    let md_denom = off;
    off += n_md * 4;

    let ct_off = off;
    off += (n_ct + 1) * 4;
    let ct_nnz = i32_at(g, ct_off + n_ct * 4) as usize;
    let ct_idx = off;
    #[allow(unused_assignments)]
    {
        off += ct_nnz * 4;
    }

    (
        n_pw,
        n_md,
        n_ct,
        GroupLayout { pw_off, pw_idx, md_off, md_idx, md_denom, ct_off, ct_idx },
    )
}

struct GroupLayout {
    pw_off: usize,
    pw_idx: usize,
    md_off: usize,
    md_idx: usize,
    md_denom: usize,
    ct_off: usize,
    ct_idx: usize,
}

/// 把 KO 计数折成通路/模块/类别比率,写入 `out`(长度 n_pw + n_md + n_ct)。
/// `ko` 指向 KO_Genes 段(19999 个计数),分子按 CheckM2 的方式先二值化。
#[no_mangle]
pub unsafe extern "C" fn c2_group_ratios(
    groups: *const u8,
    ko: *const f64,
    out: *mut f64,
) {
    let (n_pw, n_md, n_ct, o) = group_layout(groups);

    // 通路
    for gidx in 0..n_pw {
        let s = i32_at(groups, o.pw_off + gidx * 4) as usize;
        let e = i32_at(groups, o.pw_off + (gidx + 1) * 4) as usize;
        let mut num = 0.0f64;
        for j in s..e {
            let k = i32_at(groups, o.pw_idx + j * 4) as usize;
            if *ko.add(k) > 0.0 {
                num += 1.0;
            }
        }
        *out.add(gidx) = num / (e - s) as f64;
    }

    // 模块:分母取定义长度(CheckM2 在过滤前先取 len)
    for gidx in 0..n_md {
        let s = i32_at(groups, o.md_off + gidx * 4) as usize;
        let e = i32_at(groups, o.md_off + (gidx + 1) * 4) as usize;
        let denom = i32_at(groups, o.md_denom + gidx * 4) as f64;
        let mut num = 0.0f64;
        for j in s..e {
            let k = i32_at(groups, o.md_idx + j * 4) as usize;
            if *ko.add(k) > 0.0 {
                num += 1.0;
            }
        }
        *out.add(n_pw + gidx) = num / denom;
    }

    // 类别
    for gidx in 0..n_ct {
        let s = i32_at(groups, o.ct_off + gidx * 4) as usize;
        let e = i32_at(groups, o.ct_off + (gidx + 1) * 4) as usize;
        let mut num = 0.0f64;
        for j in s..e {
            let k = i32_at(groups, o.ct_idx + j * 4) as usize;
            if *ko.add(k) > 0.0 {
                num += 1.0;
            }
        }
        *out.add(n_pw + n_md + gidx) = num / (e - s) as f64;
    }
}

// ----------------------------------------------------------------------------- CNN

/// Keras Sequential:
///   Conv1D(180,k10,s10,linear) BN
///   Conv1D(180,k10,s10,relu)   BN
///   Conv1D(180,k10,s10,relu)   BN
///   Conv1D(100,k10,s10,relu)   BN
///   Flatten -> Dense(100,relu) -> Dense(1,sigmoid)
/// 输入 `len` 个 f32(已缩放),返回 sigmoid 输出。
#[no_mangle]
pub unsafe extern "C" fn c2_nn_forward(model: *const u8, input: *const f32, len: usize) -> f32 {
    let n_layers = u32_at(model, 4) as usize;
    let mut off = 12usize;

    let mut a: Vec<f32> = vec![0.0; len];
    std::ptr::copy_nonoverlapping(input, a.as_mut_ptr(), len);
    let mut b: Vec<f32> = Vec::new();
    let mut cur_len = len; // 当前缓冲当前长度
    let mut cur_ch = 1usize; // 当前缓冲通道数
    let mut use_a = true;

    for _ in 0..n_layers {
        let kind = u32_at(model, off);
        off += 4;
        match kind {
            // ---------------------------------------------------------- Conv1D
            1 => {
                let cout = u32_at(model, off) as usize;
                let cin = u32_at(model, off + 4) as usize;
                let k = u32_at(model, off + 8) as usize;
                let stride = u32_at(model, off + 12) as usize;
                let act = u32_at(model, off + 16);
                off += 20;
                let w_off = off;
                off += k * cin * cout * 4;
                let b_off = off;
                off += cout * 4;

                if cin != cur_ch || cur_len < k {
                    return f32::NAN;
                }
                let t_out = (cur_len - k) / stride + 1;
                let need = t_out * cout;
                // 先扩容目标缓冲,再取指针(扩容可能导致重分配)
                if use_a {
                    if b.len() < need {
                        b.resize(need, 0.0);
                    }
                } else if a.len() < need {
                    a.resize(need, 0.0);
                }
                let src: *const f32 = if use_a { a.as_ptr() } else { b.as_ptr() };
                let dst: *mut f32 = if use_a { b.as_mut_ptr() } else { a.as_mut_ptr() };
                let w = f32_slice(model, w_off, k * cin * cout);
                let bias = f32_slice(model, b_off, cout);

                let mut tmp: Vec<f32> = vec![0.0; cout];
                for p in 0..t_out {
                    for v in tmp.iter_mut() {
                        *v = 0.0;
                    }
                    for kk in 0..k {
                        let row = src.add((p * stride + kk) * cin);
                        let wrow = w.as_ptr().add(kk * cin * cout);
                        for ci in 0..cin {
                            let v = *row.add(ci);
                            // 特征向量里 0 占比很高(稀疏 KO),跳过可显著加速
                            if v != 0.0 {
                                let wr = wrow.add(ci * cout);
                                for f in 0..cout {
                                    *tmp.get_unchecked_mut(f) += v * *wr.add(f);
                                }
                            }
                        }
                    }
                    let out_row = dst.add(p * cout);
                    for f in 0..cout {
                        let mut val = *tmp.get_unchecked(f) + *bias.get_unchecked(f);
                        if act == 1 && val < 0.0 {
                            val = 0.0;
                        }
                        *out_row.add(f) = val;
                    }
                }
                cur_len = t_out;
                cur_ch = cout;
                use_a = !use_a;
            }
            // ------------------------------------------------------ BatchNorm
            2 => {
                let n = u32_at(model, off) as usize;
                off += 4;
                let eps = f32_at(model, off);
                off += 4;
                let g_off = off;
                off += n * 4;
                let be_off = off;
                off += n * 4;
                let mn_off = off;
                off += n * 4;
                let va_off = off;
                off += n * 4;

                if n != cur_ch {
                    return f32::NAN;
                }
                let g = f32_slice(model, g_off, n);
                let be = f32_slice(model, be_off, n);
                let mn = f32_slice(model, mn_off, n);
                let va = f32_slice(model, va_off, n);
                let total = cur_len * cur_ch;
                let buf: *mut f32 = if use_a { a.as_mut_ptr() } else { b.as_mut_ptr() };
                for i in 0..total {
                    let c = i % cur_ch;
                    let x = *buf.add(i);
                    *buf.add(i) = *g.get_unchecked(c) * (x - *mn.get_unchecked(c))
                        / (*va.get_unchecked(c) + eps).sqrt()
                        + *be.get_unchecked(c);
                }
            }
            // --------------------------------------------------------- Flatten
            3 => {
                cur_len *= cur_ch;
                cur_ch = 1;
            }
            // ----------------------------------------------------------- Dense
            4 => {
                let nin = u32_at(model, off) as usize;
                let nout = u32_at(model, off + 4) as usize;
                let act = u32_at(model, off + 8);
                off += 12;
                let w_off = off;
                off += nin * nout * 4;
                let b_off = off;
                off += nout * 4;

                if cur_len != nin {
                    return f32::NAN; // 维度不符说明资产损坏
                }
                if use_a {
                    if b.len() < nout {
                        b.resize(nout, 0.0);
                    }
                } else if a.len() < nout {
                    a.resize(nout, 0.0);
                }
                let src: *const f32 = if use_a { a.as_ptr() } else { b.as_ptr() };
                let dst: *mut f32 = if use_a { b.as_mut_ptr() } else { a.as_mut_ptr() };
                let w = f32_slice(model, w_off, nin * nout);
                let bias = f32_slice(model, b_off, nout);

                for j in 0..nout {
                    let mut acc = *bias.get_unchecked(j);
                    for i in 0..nin {
                        acc += *src.add(i) * *w.get_unchecked(i * nout + j);
                    }
                    if act == 1 {
                        if acc < 0.0 {
                            acc = 0.0;
                        }
                    } else if act == 2 {
                        acc = 1.0 / (1.0 + (-acc).exp().min(f32::MAX));
                    }
                    *dst.add(j) = acc;
                }
                cur_len = nout;
                cur_ch = 1;
                use_a = !use_a;
            }
            _ => return f32::NAN,
        }
    }

    if use_a {
        *a.get_unchecked(0)
    } else {
        *b.get_unchecked(0)
    }
}
