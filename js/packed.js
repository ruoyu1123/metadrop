/**
 * packed.js — 读取 export_assets.py 生成的紧凑二进制资产。
 *
 * 约定:所有数组一律小端序。若某段在源缓冲里没有按元素大小对齐,则复制一份
 * 对齐副本,保证 TypedArray 视图永远合法(其余情况零拷贝)。
 */

const MAGIC = {
  gbm: 'C2GB',
  scaler: 'C2SC',
  nn: 'C2NN',
  groups: 'C2GR',
};

function magicOf(dv) {
  return String.fromCharCode(
    dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
}

/** 取一个 TypedArray 视图;未对齐时复制。 */
function view(buf, offset, Type, count) {
  const bpe = Type.BYTES_PER_ELEMENT;
  if (offset % bpe === 0) {
    return new Type(buf, offset, count);
  }
  const tmp = new ArrayBuffer(count * bpe);
  new Uint8Array(tmp).set(new Uint8Array(buf, offset, count * bpe));
  return new Type(tmp);
}

function readU32(dv, off) { return dv.getUint32(off, true); }

// --------------------------------------------------------------------------- GBDT

export function parseGbm(buf, label = 'gbm') {
  const dv = new DataView(buf);
  if (magicOf(dv) !== MAGIC.gbm) {
    throw new Error(`${label}: not a C2GB file`);
  }
  // 头部: magic(4) | version(4) | n_trees(4) | total_nodes(4) | total_leaves(4)
  //       | n_features(4) | max_decision_type(4) | reserved(4)
  const nTrees = readU32(dv, 8);
  const totalNodes = readU32(dv, 12);
  const totalLeaves = readU32(dv, 16);
  const nFeatures = readU32(dv, 20);

  let off = 32;
  const nodeOffsets = view(buf, off, Int32Array, nTrees + 1); off += (nTrees + 1) * 4;
  const leafOffsets = view(buf, off, Int32Array, nTrees + 1); off += (nTrees + 1) * 4;
  const splitFeature = view(buf, off, Int32Array, totalNodes); off += totalNodes * 4;
  const threshold = view(buf, off, Float64Array, totalNodes); off += totalNodes * 8;
  const leftChild = view(buf, off, Int32Array, totalNodes); off += totalNodes * 4;
  const rightChild = view(buf, off, Int32Array, totalNodes); off += totalNodes * 4;
  const decisionType = view(buf, off, Uint8Array, totalNodes); off += totalNodes;
  const leafValue = view(buf, off, Float64Array, totalLeaves); off += totalLeaves * 8;

  return {
    nTrees, totalNodes, totalLeaves, nFeatures, nodeOffsets, leafOffsets,
    splitFeature, threshold, leftChild, rightChild, decisionType, leafValue,
    byteLength: off,
  };
}

// --------------------------------------------------------------------------- MinMaxScaler

export function parseScaler(buf) {
  const dv = new DataView(buf);
  if (magicOf(dv) !== MAGIC.scaler) throw new Error('not a C2SC file');
  const n = readU32(dv, 4);
  const min = view(buf, 12, Float64Array, n);
  const scale = view(buf, 12 + n * 8, Float64Array, n);
  return { n, min, scale };
}

// --------------------------------------------------------------------------- CNN

export function parseNn(buf) {
  const dv = new DataView(buf);
  if (magicOf(dv) !== MAGIC.nn) throw new Error('not a C2NN file');
  const nLayers = readU32(dv, 4);
  let off = 12;
  const layers = [];
  for (let i = 0; i < nLayers; i++) {
    const kind = readU32(dv, off); off += 4;
    if (kind === 1) {
      const cout = readU32(dv, off);
      const cin = readU32(dv, off + 4);
      const k = readU32(dv, off + 8);
      const stride = readU32(dv, off + 12);
      const act = readU32(dv, off + 16);
      off += 20;
      const w = view(buf, off, Float32Array, k * cin * cout); off += k * cin * cout * 4;
      const b = view(buf, off, Float32Array, cout); off += cout * 4;
      layers.push({ kind: 'conv1d', cout, cin, k, stride, act, w, b });
    } else if (kind === 2) {
      const n = readU32(dv, off); off += 4;
      const eps = dv.getFloat32(off, true); off += 4;
      const gamma = view(buf, off, Float32Array, n); off += n * 4;
      const beta = view(buf, off, Float32Array, n); off += n * 4;
      const mean = view(buf, off, Float32Array, n); off += n * 4;
      const variance = view(buf, off, Float32Array, n); off += n * 4;
      layers.push({ kind: 'bn', n, eps, gamma, beta, mean, variance });
    } else if (kind === 3) {
      layers.push({ kind: 'flatten' });
    } else if (kind === 4) {
      const nin = readU32(dv, off);
      const nout = readU32(dv, off + 4);
      const act = readU32(dv, off + 8);
      off += 12;
      const w = view(buf, off, Float32Array, nin * nout); off += nin * nout * 4;
      const b = view(buf, off, Float32Array, nout); off += nout * 4;
      layers.push({ kind: 'dense', nin, nout, act, w, b });
    } else {
      throw new Error(`unknown layer type ${kind}`);
    }
  }
  return { nLayers, layers, byteLength: off };
}

// --------------------------------------------------------------------------- 分组

export function parseGroups(buf) {
  const dv = new DataView(buf);
  if (magicOf(dv) !== MAGIC.groups) throw new Error('not a C2GR file');
  const nPathways = readU32(dv, 4);
  const nModules = readU32(dv, 8);
  const nCategories = readU32(dv, 12);
  const koOffset = readU32(dv, 16);

  let off = 20;
  const pwOffsets = view(buf, off, Int32Array, nPathways + 1); off += (nPathways + 1) * 4;
  const pwNnz = pwOffsets[nPathways];
  const pwIndices = view(buf, off, Int32Array, pwNnz); off += pwNnz * 4;
  const mdOffsets = view(buf, off, Int32Array, nModules + 1); off += (nModules + 1) * 4;
  const mdNnz = mdOffsets[nModules];
  const mdIndices = view(buf, off, Int32Array, mdNnz); off += mdNnz * 4;
  const mdDenom = view(buf, off, Int32Array, nModules); off += nModules * 4;
  const ctOffsets = view(buf, off, Int32Array, nCategories + 1); off += (nCategories + 1) * 4;
  const ctNnz = ctOffsets[nCategories];
  const ctIndices = view(buf, off, Int32Array, ctNnz); off += ctNnz * 4;

  return {
    nPathways, nModules, nCategories, koOffset,
    pw: { offsets: pwOffsets, indices: pwIndices },
    md: { offsets: mdOffsets, indices: mdIndices, denom: mdDenom },
    ct: { offsets: ctOffsets, indices: ctIndices },
    byteLength: off,
  };
}

// --------------------------------------------------------------------------- WASM

/**
 * 实例化计算内核。传入 bytes 或 URL 都可以由调用方处理;
 * 这里只接受已就绪的 ArrayBuffer,失败返回 null(调用方回退到纯 JS)。
 */
export async function loadWasmCore(wasmBuffer) {
  if (typeof WebAssembly === 'undefined' || !wasmBuffer) return null;
  try {
    const { instance } = await WebAssembly.instantiate(wasmBuffer, {});
    const e = instance.exports;
    if (typeof e.c2_gbm_predict !== 'function') return null;
    return new WasmCore(e);
  } catch (err) {
    console.warn('[checkm2] WASM 内核加载失败,回退到 JS 实现:', err);
    return null;
  }
}

export class WasmCore {
  constructor(exports) {
    this.e = exports;
    this.mem = exports.memory;
    this._slots = new Map(); // name -> {ptr, size}
  }

  /**
   * 申请(或复用)一块线性内存。
   * 注意: 绝不缓存 TypedArray 视图 —— wasm 内存扩容后旧 ArrayBuffer 会 detach,
   * 因此所有读写都在调用时按当前 mem.buffer 新建视图。
   */
  slot(name, byteLength) {
    const cur = this._slots.get(name);
    if (cur && cur.size >= byteLength) return cur;
    if (cur) this.e.c2_free(cur.ptr, cur.size);
    const ptr = this.e.c2_alloc(byteLength);
    if (!ptr) throw new Error('WASM allocation failed');
    const s = { ptr, size: byteLength };
    this._slots.set(name, s);
    return s;
  }

  /** 把 ArrayBuffer 内容复制进线性内存,返回指针 */
  putBuffer(name, arrayBuffer) {
    const s = this.slot(name, arrayBuffer.byteLength);
    new Uint8Array(this.mem.buffer, s.ptr, arrayBuffer.byteLength)
      .set(new Uint8Array(arrayBuffer));
    return s.ptr;
  }

  writeF64(name, array) {
    const s = this.slot(name, array.length * 8);
    new Float64Array(this.mem.buffer, s.ptr, array.length).set(array);
    return s.ptr;
  }

  writeF32(name, array) {
    const s = this.slot(name, array.length * 4);
    new Float32Array(this.mem.buffer, s.ptr, array.length).set(array);
    return s.ptr;
  }

  /** 取当前有效的 f64 视图(仅用于读回结果,写完立即使用) */
  f64View(name, count) {
    const s = this._slots.get(name);
    return new Float64Array(this.mem.buffer, s.ptr, count);
  }

  ptr(name) {
    const s = this._slots.get(name);
    return s ? s.ptr : 0;
  }

  gbmPredict(modelPtr, featPtr, maxTrees = 0) {
    return this.e.c2_gbm_predict(modelPtr, featPtr, maxTrees);
  }

  groupRatios(groupsPtr, koPtr, outPtr) {
    this.e.c2_group_ratios(groupsPtr, koPtr, outPtr);
  }

  minmax(xPtr, minPtr, scalePtr, outPtr, n) {
    this.e.c2_minmax_transform(xPtr, minPtr, scalePtr, outPtr, n);
  }

  nnForward(modelPtr, inputPtr, len) {
    return this.e.c2_nn_forward(modelPtr, inputPtr, len);
  }
}
