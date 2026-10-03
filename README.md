<div align="center">

# Metadrop

**MAG 去污与质量复算,完全跑在本地浏览器里**

不重跑 CheckM2,就能复算完整度 / 污染度,并找出该删掉的 contig

界面语言:中文 / English

</div>

---

## 这是什么

CheckM2 只告诉你一个 bin 好不好,不告诉你**哪条 contig 该删**。

而最直观的判断依据是错的:删掉一条污染 contig,完整度往往会**下降** ——
因为污染物自己带的单拷贝基因也被算进了宿主的账里,删它等于连同那份"虚高的分数"一起删。
Metadrop 的演示数据里就有一条确定是污染的 contig,删掉后完整度掉了 **1.58 个百分点**。

所以 Metadrop 把两件事分开做:

| | 怎么做 |
| --- | --- |
| **复算质量** | 把 CheckM2 的模型(GBDT + CNN)搬进 WebAssembly,数值与官方一致 |
| **判断该删谁** | 只用与模型无关的客观证据:Hi-C 连接是否吻合、丰度谱是否一致、是否在多个 bin 里重复出现 |

**全部计算在你的浏览器里完成。** 没有后端、没有上传、没有埋点,数据一个字节都不出本机。

---

## 三十秒上手

不需要安装任何依赖,不需要 `npm install`。

```bash
git clone git@github.com:ruoyu1123/metadrop.git
cd metadrop
node tools/serve.mjs --out "D:/结果"
```

浏览器打开 <http://127.0.0.1:8788/>,点 **载入演示数据**。

![Metadrop 主界面](docs/screenshots/01-overview.png)

三个 MAG 已载入,污染 contig `Z19` 被标红,右侧是它的判断依据。

### 想直接写到硬盘?

上面的 `serve.mjs` 就是为此存在的:它除了递网页,还顺手把结果**直接写进 `--out` 指定的目录**,
不用经过浏览器下载。不想用它,页面右上角 **导出 ZIP** 也能把结果打包下下来。

### 用自己的数据

点 **打开文件夹** 或直接把文件夹拖进去,需要:

```
checkm2_out/          CheckM2 的输出(必需)
├── quality_report.tsv
├── protein_files/*.faa
└── diamond_output/DIAMOND_RESULTS.tsv
mags/*.fa             你的 bin 序列(必需)
hic/*.tsv             Hi-C 连接表(强烈建议)
abundance.tsv         丰度表(强烈建议)
```

文件按名字自动识别,不用配置。缺 Hi-C 或丰度表也能跑,只是判断依据会少一半。
**序列文件是 contig 列表的唯一来源** —— 蛋白和 DIAMOND 结果只补充基因层信息,不会凭空造 contig。

---

## 怎么用

### 悬停,看删掉会怎样

鼠标停在任意 contig 上,立刻看到**删掉它之后整个 MAG 的完整度 / 污染度**:

![悬停预览](docs/screenshots/02-hover.png)

`Z19` 的完整度预测 **93.57 ↓ -1.58** —— 删掉一条确定的污染物,分数反而掉了。这就是开头说的那个坑。

### 自动建议,一键清理

点 **自动建议**,应用会标出所有可疑 contig(重复 + 污染)并给出清理后的方案:

![自动建议](docs/screenshots/03-suggested.png)

`MAG_A` 从 `95.15 / 6.56` 变成 `92.87 / 0.00` —— 污染度清零。
`MAG_C` 的完整度从 `71.10` 降到 `63.99`,**这是对的**:那 6 条外来 contig 本来就在虚高它的分数。

### 逐条查看判断依据

点击 contig,右侧面板给出完整证据链:

![判断依据](docs/screenshots/04-evidence.png)

`Z19` 的 Hi-C 有 97% 的信号指向 MAG_C 而非它现在所在的 MAG_A,丰度一致性只有 0.414,
两条独立证据都指向同一个结论。

### 快捷键

`S` 自动建议 · `R` 还原 · `E` 输出 · `Z` 导出 ZIP · `L` 中英切换

---

## 性能

在本机实测(演示数据:3 个 MAG,共 68 条 contig、3770 条 KO 命中):

| 指标 | 数值 |
| --- | --- |
| 复算一次完整度 / 污染度 | **7.7 ms** |
| 预计算全部 200 条 contig 的"删除后"结果 | 1.5 s(7.4 ms/条) |
| GBDT 单次预测(污染度) | WASM **0.11 ms** / JS 0.04 ms |
| CNN 单次预测 | WASM **9.8 ms** / JS 78.5 ms |
| 引擎加载(模型就绪) | 329 ms |
| 载入演示数据到可操作 | 927 ms |

**与官方实现的差异**:

| 对比项 | 差异 |
| --- | --- |
| GBDT vs 官方 LightGBM | **0**(逐元素) |
| CNN vs 官方 Keras | **< 1e-10** |
| 端到端(真实训练基因组) | **0** |

不是"近似",是逐位一致。测试会强制这一点。

体积:模型资产 6.8 MB,单文件离线版 11.2 MB(双击即用,零服务器)。
代码 4,700 行 JS + 535 行 Rust,运行时**零依赖**。

---

## 常见问题

**Q:数据会上传吗?**
不会。计算在浏览器里,连本地服务也只监听 `127.0.0.1`。离线单文件版被测试断言"零网络请求"。
注意:如果用 `serve.mjs`,数据是从浏览器走到**同一台机器上的另一个进程**,仍然不出本机。

**Q:为什么删掉污染物完整度反而降?**
因为污染物带的单拷贝基因被算进了宿主完整度。删掉它,那部分分数也一起没了。
这正是**不能**用 Δ完整度 判断污染的原因。Metadrop 用 Hi-C 和丰度,这两者与模型无关。

**Q:CheckM2 跑的时候加了 `--remove_intermediates` 还能用吗?**
不能。那会删掉 `diamond_output/`,KO 计数无从重建。需要重跑一次并保留中间文件。

**Q:模型选择和官方一致吗?**
有 `quality_report.tsv` 时完全一致(沿用报告里写明的模型)。
没有报告时无法计算官方那个 47 MB 的余弦相似度步骤,会退化为两模型均值并标记 `modelSource = no-report`,
不会冒充官方行为。

**Q:需要联网吗?**
完全不需要。构建离线单文件版后,断网也能跑通整条流程。

---

## 开发

```bash
node tools/test_engine.mjs       # 24 项:与官方模型的数值一致性
node tools/test_pipeline.mjs     # 32 项:解析 → 标注 → 建议 → 清理
node tools/test_zip.mjs          # 19 项:ZIP 字节流(Python zipfile 交叉校验)
node tools/test_local_api.mjs    # 39 项:直写落盘 + 安全边界
node tools/check_i18n.mjs        #  8 项:中英词典一致性
node tools/check_offline.mjs     # 21 项:单文件版全流程
```

六套共 143 项,都**不需要起服务器**。另有界面回归 153 项(需 `playwright-core`)。

重新生成上面那些截图:

```bash
python -m http.server 8765 &
node tools/make_readme_shots.mjs    # → docs/screenshots/
```

重新构建单文件离线版:

```bash
node tools/build_offline.mjs        # → dist/metadrop-offline.html
```

改了 `wasm-core/src/lib.rs` 才需要重新编译内核:

```bash
cd wasm-core
RUSTFLAGS="-C target-feature=+simd128" cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/checkm2_core.wasm ../wasm/
```

---

## 引用

Metadrop 复算的是 CheckM2 的模型输出,引用它时请一并引用:

> Parks, S. A., Chen, J., Hung, S., & Wu, Z. (2022). CheckM2: assessing the quality of
> predicted gene contents in metagenomes. *Nature Methods*, 19(3), 320–328.
> <https://doi.org/10.1038/s41592-021-01340-2>

Metadrop 本身的引用信息待发表后补充。
