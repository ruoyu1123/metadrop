# Metadrop — MAG 去重与质量复算

一个**纯本地、离线**的网页应用:导入一个或多个 MAG 及其 CheckM2 结果,
在浏览器里**不重跑 CheckM2** 就精确复算完整度 / 污染度,并通过 Hi-C 信号与丰度谱
找出重复 bin 成员和污染 contig,支持逐个点击移除并实时看到质量变化。

计算核心用 **Rust 编译成 WebAssembly**,模型(GBDT + CNN)全部打包在 `assets/`
(约 7 MB)里,首次加载后完全离线运行。

结果落到哪里由你决定:配上附带的本地服务(`tools/serve.mjs`)就**直接写进你指定的
输出文件夹**;不配就**打包成一个 ZIP 下载**。两条路都不上传任何数据。

---

## 1. 快速开始

三种跑法,**都不需要上传任何数据**。区别只在"结果怎么落到磁盘"。

### 方式 A:本地服务(推荐 —— 结果直写磁盘)

```bash
cd app
node tools/serve.mjs --out "D:/metadrop_out"     # 可省略 --out,默认 ./metadrop_out
# 浏览器打开 http://127.0.0.1:8788/
```

`serve.mjs` 是一个**零依赖**的 Node 脚本,它同时干两件事:

1. 把网页递给浏览器(就是原来 `python -m http.server` 干的活);
2. 因为进程本来就在这台机器上,它顺手把结果**直接写进你指定的输出文件夹**。

于是页面上多了一个「**完成输出**」按钮:点一下,`checkm2_web_summary.tsv`、
`checkm2_web_contigs.tsv` 和每个 MAG 的 `<名字>.cleaned.fa` 就直接躺在
`--out` 指定的目录里了,**不经过浏览器下载**。

```
   ┌──────────────┐   GET /               ┌───────────────────────────┐
   │   浏览器      │ ────────────────────▶ │ serve.mjs (127.0.0.1)     │
   │  ← 计算在这里  │ ◀──────────────────── │  ① 静态托管 app/           │
   └───────┬──────┘  POST /__local__/write └───────────┬───────────────┘
           │                                          │ 写文件
           └────── 结果直接落到本机 out/ 目录 ◀─────────┘
```

换个输出目录不用重启:页面上「输出」右边的框在本地服务在线时**可以直接填绝对路径**,
回车生效;点「选择…」会弹出**操作系统的原生文件夹选择框**(只有服务进程要得到绝对路径,
浏览器拿不到)。输出完后「打开文件夹」能在资源管理器 / 访达里定位过去。

### 方式 B:离线单文件(零服务器,双击即用)

```bash
node tools/build_offline.mjs      # 产出 dist/metadrop-offline.html(约 20 MB)
```

把 `dist/metadrop-offline.html` 拷到任何地方,**双击**即可用。
模型权重、演示数据全部内联在这一个文件里,全程零网络请求,
断网也能跑通整条流程(`tools/check_offline.mjs` 会断言这一点)。
这条路径下没有本地服务,输出方式退化为:浏览器目录手柄(Chrome/Edge)
或直接把结果**打包成一个 ZIP 下载**。

### 方式 C:开发版(改动 `js/` 时用)

```bash
cd app
python -m http.server 8765        # WebAssembly / fetch 不能走 file://
# 然后浏览器打开 http://127.0.0.1:8765/
```

任何一个静态服务器都行。没接上本地服务时,页面启动会做一次探测,
控制台里会看到一条 `/__local__/ping` 的 404 —— 那是设计如此,不影响使用。

页面上有三种进入方式:

| 方式 | 说明 |
| --- | --- |
| **载入演示数据** | 直接读取 `samples/demo/`(3 个 MAG,含重复与污染,自带 Hi-C 与丰度表) |
| **打开文件夹 / 拖拽** | 选择或拖入你自己的 CheckM2 输出目录 + MAG 序列 + Hi-C 表 + 丰度表 |
| **输出** | 指定结果落到哪:本机绝对路径(本地服务)、目录手柄(浏览器)、或打包下载 |

快捷键:`S` 自动建议 · `R` 还原本 MAG · `E` 完成输出 · `Z` 导出 ZIP · `L` 中英切换。

### 纯本地保证

- 计算全部在浏览器里完成(WASM 内核 + JS 兜底),**没有后端计算**;
- `serve.mjs` 只监听 `127.0.0.1`,并且校验 `Host` 头(挡 DNS rebinding)、
  只放行 localhost 来源的跨域请求 —— 局域网里别的机器碰不到它;
- 即使用了本地服务,字节也只是在**同一台机器**上从浏览器走到另一个进程,**不出本机**;
- 页面里没有埋点、CDN 或任何外部请求,离线单文件版被测试断言"零 http(s) 请求";
- 输出文件名在服务端还会再做一次净化,`../` 之类的路径穿越会被拍平
  (`tools/test_local_api.mjs` 里对这几条边界都有断言)。

### 中英文切换

右上角 `中文 / EN` 按钮切换界面语言,选择记在 `localStorage`,刷新后保持;
首次访问按浏览器语言自动选择。计算层只产出语言无关的 `key`,
文案统一由 `js/i18n.js` 翻译;`tools/check_i18n.mjs` 会校验两个词典的
key 集合与占位符完全对齐,并扫描源码里有没有漏翻的硬编码中文。

---

## 2. 界面说明

```
┌──────────────┬───────────────────────────────────────────────┬──────────────┐
│  MAG 列表     │  contig 表格 + 实时质量读数                     │  Contig 详情  │
│  完整度/污染度 │  勾选框 = 保留 / 取消 = 移除                    │  判断依据     │
│  质量等级     │  悬停 → 浮动卡片:移除后的完整度与污染度          │  Hi-C 邻接    │
│  重复/可疑计数 │  Hi-C 内外信号条 · 丰度一致性                  │  丰度谱       │
│              │  归属证据分 · 移除影响 Δ                       │  丢失的通路   │
└──────────────┴───────────────────────────────────────────────┴──────────────┘
```

- **悬停任意 contig** → 浮动卡片显示它的信息 + **移除该 contig 后整个 MAG 的完整度/污染度**
  (单条移除的预计算结果,悬停即时出数;若已经移除了别的 contig,会在此基础上重算)。
- **点击任意 contig** → 立即从 MAG 中移除 / 恢复,左侧与顶部读数实时刷新。
- **长度列** → 定长之外再给一个百分比,表示**占该 MAG 原始总长(全部 contig)的比例**。
  分母取原始总长,是为了让整列合计恒为 100%:勾掉几行时,剩下的行百分比不会跟着往上跳。
  悬停卡片与右侧详情用同一个口径。
- **自动建议** → 一次性标出所有可疑 contig(重复 + 污染),生成"清理后"的方案。
- **完成输出** → 把汇总表 `checkm2_web_summary.tsv`、逐 contig 明细
  `checkm2_web_contigs.tsv`,以及每个被修改 MAG 的清理后序列 `*.cleaned.fa`
  **直接写进输出文件夹**(见下)。
- **导出 ZIP** → 同样这些内容,但打包成**一个** `.zip` 下载,不动输出文件夹。

### 输出:直写磁盘,还是打包下载

「输出」这一块是本次改造的重点 —— 输出位置一共有三种,优先级从高到低:

| 情况 | 「完成输出」做什么 | 怎么设置输出位置 |
| --- | --- | --- |
| **本地服务在线**(`node tools/serve.mjs`) | POST 给服务进程,**直写本机绝对路径** | 在输入框里填路径回车,或点「选择…」弹原生文件夹对话框 |
| 只有浏览器 | 写进 File System Access 目录手柄 | 点「选择…」,用浏览器的目录选择器 |
| 都没有 | **打包成一个 ZIP 下载**,并在状态栏说明原因 | —— |

几点值得说明:

- **输出位置只有一个按钮,不会"以为设了其实没用"。** 状态栏永远回显实际写到哪;
  接了本地服务时顶部还会亮一个**「本地直写」**徽章。
- **「导出 ZIP」是一条独立的路径**,永远只产出一个带时间戳的压缩包
  (`metadrop_results_YYYYMMDD-HHMMSS.zip`),不再散装下载 N 个文件。
  本地服务在线时,包会**先落在系统临时目录**(`%TEMP%/metadrop-export/<token>/`)
  再从这个地址取回下载 —— 状态栏会把真实路径告诉你。
  这些暂存目录**不需要你手动清**:本地服务**启动时会自动删掉超过 24 小时的旧暂存**
  (只动 `metadrop-export` 自己的子目录,不会误伤正在导出的包)。
- 打包用自己写的零依赖 ZIP 实现(`js/zip.js`,`deflate-raw` + `store` 兜底),
  `tools/test_zip.mjs` 会用 **Python 标准库 `zipfile` 独立解包**来交叉验证字节流。
- 结果很大时建议走"输出文件夹直写":ZIP 需要整份数据进内存,超过约 1.5 GB
  会提示你改用直写,而不是让浏览器默默崩掉。

清理后的序列命名为 `<MAG 名>.cleaned.fa`,内容以**你输入的 MAG 序列文件为准**:
只去掉被移除的 contig,头部与序列原样保留。

  汇总表同时保留**官方报告值**与**本地复算值**,以及清理前后的对比和具体移除了哪些
  contig,便于回溯和写进方法学描述:

```
MAG    Contigs_Original  Contigs_Kept  Removed_Contigs          Report_Completeness  Report_Contamination  Recalc_Completeness_Original  Recalc_Completeness_Cleaned  Recalc_Contamination_Original  Recalc_Contamination_Cleaned  Length_Before_bp  Length_After_bp  Quality_Class
MAG_A  30                28            Z19,Z20                  95.15                6.56                  95.15                         92.87                        6.56                           0                             3712056           3532039          High quality (HQ)
MAG_B  18                18                                     99.85                0.71                  99.85                         99.85                        0.71                           0.71                          2439648           2439648          High quality (HQ)
MAG_C  20                14            X01,X03,X05,X07,X09,X11  71.1                 6.96                  71.1                          63.99                        6.96                           0                             2287152           1581221          Medium quality (MQ)
```

导出表里的数值一律**机器可读**:质量等级用英文标签、长度用 bp 整数、另附 `Length_Share` 百分比列。

`checkm2_web_contigs.tsv` 是逐 contig 的完整明细(是否保留 / 判断结论 / 长度 / 长度占比 /
CDS / KO / Hi-C 内外信号 / 丰度余弦 / 移除后预测 / 重复于哪些 MAG)。

---

## 3. 输入数据契约

应用会按文件名自动归类,不需要配置。若某类缺失,对应功能自动降级并给出提示。

### 3.1 CheckM2 结果目录(**必需**)

```
checkm2_out/
├── quality_report.tsv                    # 官方报告,用作对比基线
├── protein_files/<MAG名>.faa             # Prodigal 预测的蛋白
└── diamond_output/DIAMOND_RESULTS*.tsv   # DIAMOND 比对结果(KO 注释)
```

- `quality_report.tsv`:`checkm2 predict` 默认输出,列名需含
  `Name / Completeness / Contamination / Completeness_Model_Used`,
  其余列(`Contig_N50 / Genome_Size / GC_Content / …`)会显示在界面上。
- `DIAMOND_RESULTS.tsv`:每行 `{bin}Ω{蛋白id}\t{UniRef}~{KO}\t...`。
  官方用 `Ω`(U+03A9)分隔 bin 与蛋白;若被替换成别的分隔符,程序会用已知 bin 名做
  最长前缀匹配兜底。也支持 `protein2contig.map.tsv` 之类的自定义映射表(两列:`蛋白id  contig`)。
- **若曾用 `--remove_intermediates` 运行 CheckM2,`diamond_output/` 已被删除**,
  此时只能算元数据部分,无法复算完整度 —— 需要重新跑一次 CheckM2 并保留中间文件。

### 3.2 MAG 组装文件(**必需**)

`.fna / .fa / .fasta / .fas / .ffn`(可用 gzip)。文件名(去扩展名)即 MAG 名,
需要与 `quality_report.tsv` 的 `Name` 对上。

**序列文件是 contig 集合的唯一权威来源。** 界面里列出的 contig、以及"清理后"写出的
`<MAG>.cleaned.fa`,都以这里记录的 contig 为准:

- 蛋白文件(`.faa`)与 DIAMOND 结果只用来补充基因层信息(CDS / KO 计数),
  不会凭空造出 contig;
- 某条蛋白指向了序列文件里不存在的 contig,会被记为孤儿并忽略(状态栏给出提示);
- 报告里有、但没有任何序列文件的 bin 会被跳过并提示,而不是伪装成 0 条 contig;
- 如果一个 MAG 序列都读不到,直接报错,不会给你一个看起来能用的空结果。

> 只读序列统计量(长度、GC),不把整条序列常驻内存;导出清理结果时才重新流式过滤。

### 3.3 Hi-C 信号表(强烈建议)

`hic/*.tsv` 或文件名含 `hic / contact / link`。两种格式都支持:

```tsv
# 边表(推荐)
contig_a	contig_b	signal
k141_51	k141_88	412
```
```tsv
# 稠密矩阵(行列为 contig 名)
        k141_51  k141_88  k141_93
k141_51     0       412      18
```

### 3.4 丰度表(强烈建议)

文件名含 `abund / coverage / coverm / tpm / rpkm / count`,第一列是 contig 标识、其余为样本。
coverM 风格的 `*.Mean` / `*.Coverage` 列会自动识别(优先取 `Mean`)。

---

## 4. 复算是怎么做到和官方一致的

CheckM2 并不是 CheckM1 那种"数标记基因",而是**机器学习模型**。
本应用把官方仓库里的全部模型文件镜像到浏览器,用等价的数值实现复现:

| 环节 | 官方实现 | 本项目 |
| --- | --- | --- |
| 特征向量 | 21241 维:`20 种氨基酸计数 + AALength + CDS` + `19999 KO 计数` + `416 通路 + 757 模块 + 47 类别` 完整度 | `js/engine.js` `fillFeatures()` |
| 完整度(通用) | LightGBM `general_model_COMP.gbm`(450 棵树,目标 `regression sqrt` → 预测值 = `raw·|raw|`) | `wasm-core/src/lib.rs` `c2_gbm_predict` |
| 完整度(特定) | Keras CNN `specific_model_COMP.keras`(4×Conv1D + BN + Dense) | `c2_nn_forward` |
| 污染度 | LightGBM `model_CONT.gbm` | `c2_gbm_predict` |
| 归一化 | sklearn `MinMaxScaler` | `c2_minmax_transform` |
| 模型选择 | 与 5300 个参考基因组做最大余弦相似度 → `cosine_decider` | **不实现**(见下):沿用报告写明的模型;报告缺失时退化,不打包那 47 MB 参考库 |

**数值一致性(全部有自动化测试覆盖)**

| 项目 | 误差 |
| --- | --- |
| GBDT vs 官方 LightGBM | `0`(逐元素) |
| CNN vs 官方 Keras | `< 1e-10` |
| WASM vs 纯 JS | `0`(GBDT/分组)、`2.5e-11`(CNN) |
| 真实训练基因组端到端 | `0` |

`tools/test_engine.mjs`(24 项)与 `tools/test_pipeline.mjs`(32 项)全部通过。

### 4.1 已移除的能力:余弦模型选择

官方 CheckM2 会先拿查询基因组与 5300 个训练基因组比余弦相似度,再按
`novelty_ratio = general / cosine²` 决定完整度取 general 还是 specific
(`modelPostprocessing.cosine_decider`)。这一步需要一份 47 MB 的参考矩阵
(`ref_csr.bin`),**本项目已不再打包它**,因此:

- **有** `quality_report.tsv` 时:沿用报告里 `Completeness_Model_Used` 写明的模型。
  官方也是这么取值的,所以"移除前"的复算与报告逐位一致、可比较 —— 这也是主流程。
- **缺**报告时:无从计算 novelty,退化为 `CheckM2Engine.pickModelFallback()`。
  它保留官方判断里不依赖余弦的那一半(平均完整度 < 55 且 AA/完整度比值 < 1500
  → 直接取 general,与官方同分支同结论),其余情况取两模型均值,
  并把 `modelSource` 标成 `no-report`,不冒充成官方行为。

换来的是:首屏少下 47 MB、内存少驻留 47 MB,离线单文件版从 21.4 MB 降到 11.7 MB。
需要把这份能力找回来时,`python tools/export_assets.py` 能从 CheckM2 官方数据
重新导出 `assets/ref_csr.bin`(开发脚本 `make_demo_data.py` / `validate_end2end.py`
正是靠它;要让运行时重新计算余弦,还得把 `engine.js` 的读取与 `c2_cosine_max` 加回来)。

**增量重算**:每个 contig 存一份稀疏贡献(氨基酸、AALength、CDS、KO 计数),
于是"去掉任意一批 contig"只需 `counts = baseCounts − Σ贡献`,再跑一次模型。
单次含 CNN 的"移除并重算"约 **9 ～ 12 ms**,200 个 contig 全量预计算约 2.4 s。

---

## 5. 判断逻辑

### 5.1 归属证据分 `placement`(0 ～ 1)

```
placement = 0.55 × Hi-C 外向占比 + 0.45 × (1 − 丰度余弦)
```

刻意**不使用完整度增量**。原因是污染物常与宿主共享部分单拷贝基因,
把它移掉时完整度看起来反而会掉 —— 那是被它自己"垫高"的假象,
只看 Δ完整度会系统性漏判。

缺 Hi-C 用 0.35、缺丰度用 0.15 作中性缺省,保证缺表时不会乱判。

### 5.2 结论

| 结论 | 触发条件 | 含义 |
| --- | --- | --- |
| **重复 bin** | 同名 contig 出现在 ≥ 2 个 MAG | 必须在其中一边删掉;保留哪边由贴合度投票决定 |
| **疑似污染** | `placement ≥ 0.60` | Hi-C 与丰度都指向"它不属于这里" |
| **归属存疑** | `0.42 ≤ placement < 0.60` | 建议人工复核 |
| **核心成员** | `placement < 0.42` 且移除掉完整度 ≥ 0.2 | 建议保留 |
| 中性 | 其余 | 无明显信号 |

### 5.3 自动建议如何决定"重复 contig 留在哪个 MAG"

对每个重复 contig,在它的所有宿主 MAG 中算贴合度:

```
fit = (1 − Hi-C 外向占比) × 0.5 + 丰度余弦 × 0.5 + (有独有 KO ? 0.15 : 0)
```

`fit` 最高者保留,其余 MAG 标为移除。

---

## 6. 目录结构

```
app/
├── index.html            三栏界面
├── css/app.css           浅色主题样式
├── js/
│   ├── app.js            主控:加载、渲染、交互、输出
│   ├── analyze.js        归属证据 / 结论 / 自动建议
│   ├── dataset.js        把解析结果组装成 MAG/contig 数据模型
│   ├── engine.js         CheckM2 复算引擎(WASM 优先,纯 JS 兜底)
│   ├── localio.js        对接本地服务:探测 / 直写文件 / 暂存 ZIP / 打开文件夹
│   ├── parsers.js        四类输入的解析
│   ├── packed.js         紧凑二进制资产解析 + WASM 装载
│   └── zip.js            零依赖 ZIP 打包器(deflate-raw + store 兜底)
├── wasm-core/src/lib.rs  Rust 计算内核(GBDT / CNN / 分组 / MinMax)
├── assets/               模型资产(~7 MB)
├── samples/demo/         演示数据(含自造的重复与污染)
├── dist/                 离线单文件产物(build_offline.mjs 生成,已在 .gitignore)
└── tools/
    ├── serve.mjs             本地服务:静态托管 + 直写磁盘 API + 启动清理旧暂存(零依赖)
    ├── export_assets.py      官方模型 → 浏览器二进制
    ├── validate_engine.py    与官方 LightGBM/Keras 数值对比
    ├── validate_end2end.py   端到端基准(真实训练基因组)
    ├── make_demo_data.py     生成演示数据
    ├── make_demo_report.mjs  用引擎生成 quality_report.tsv
    ├── test_engine.mjs       引擎回归(24 项)
    ├── test_pipeline.mjs     端到端无头测试(32 项)
    ├── test_zip.mjs          ZIP 打包器回归,用 Python zipfile 交叉校验(19 项)
    ├── test_local_api.mjs    本地服务端到端 + 安全边界(39 项)
    ├── check_i18n.mjs        中英词典一致性 + 漏翻扫描 + 属性 key 校验(8 项)
    ├── build_offline.mjs     打成单个 HTML(含产出自检)
    ├── check_offline.mjs     离线单文件全流程验证,不需服务器(24 项)
    └── browser_check.mjs     真实 Chromium 界面回归(需静态服务器;17 节 153 项)
```

### 重新构建

```bash
# 1) 导出模型资产(需要参考 CheckM2 仓库与 Python 环境)
#    这一步会顺带导出 assets/ref_csr.bin(47 MB 参考矩阵)。它不参与应用运行,
#    只被 make_demo_data.py / validate_end2end.py 用来重造演示数据与端到端基准;
#    不打算重造演示数据就加 --skip-ref 跳过它。
python tools/export_assets.py
python tools/validate_engine.py
python tools/validate_end2end.py

# 2) 编译 WASM 内核
cd wasm-core
RUSTFLAGS="-C target-feature=+simd128" cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/checkm2_core.wasm ../wasm/

# 3) 演示数据(需要第 1 步导出的 ref_csr.bin,它是计数来源)
cd .. && python tools/make_demo_data.py && node tools/make_demo_report.mjs

# 4) 离线单文件
node tools/build_offline.mjs

# 5) 测试 —— 以下六套都不需要起任何服务器(共 146 项断言)
node tools/test_engine.mjs                 # 24 项:模型数值与官方一致
node tools/test_pipeline.mjs               # 32 项:解析 → 标注 → 建议 → 清理
node tools/test_zip.mjs                    # 19 项:ZIP 字节流,Python zipfile 独立解包
node tools/test_local_api.mjs              # 39 项:直写落盘 + Host/跨域/穿越 边界 + 探针自愈
node tools/check_i18n.mjs                  #  8 项:中英词典对齐、无漏翻、属性 key 有效
node tools/check_offline.mjs               # 24 项:单文件版 file:// 全流程、零网络

# 6) 界面回归(需要先起任意静态服务器;17 节 153 项)
python -m http.server 8765 &
node tools/browser_check.mjs
```

`browser_check.mjs` 与 `check_offline.mjs` 都依赖 `playwright-core` 与一个 Chrome,
会自动探测 `CHROME_PATH` 环境变量、`~/.agent-browser/browsers/chrome-<版本>/chrome.exe`,
或 `playwright-core` 自带的 chromium;截图输出到 `tools/browser_shots/`。
`--headful` 可看着它跑,`--skip-offline` 可跳过单文件那一段。

界面回归的**第 17 节**专门走本地服务:自己起一个 `serve.mjs`(随机端口)、跑完收掉,
验证「完成输出」确实把 5 个结果文件**直写到你指定的磁盘目录**(含内容比对、无下载事件),
改路径即时生效,「选择…」在弹不出原生对话框时**优雅退化为手填提示**并聚焦输入框,
「打开文件夹」按钮有输出后才出现,以及全流程没有任何未捕获异常。

> 提示:`npm i -g agent-browser && agent-browser install` 会顺带装好一个 Chrome,
> 但本项目的测试只依赖 `playwright-core`,不依赖 agent-browser 的守护进程。

---

## 7. 演示数据构造

`samples/demo/` 的计数全部来自 CheckM2 官方训练基因组(从 `assets/ref_csr.bin`
反缩放还原出真实的氨基酸组成与 KO 计数),不是随机数。
⚠️ 该参考矩阵已不再随应用分发(见 §4.1);要重造演示数据,先跑
`python tools/export_assets.py` 把它导回来。已生成的 `samples/demo/` 不受影响。

刻意构造了三种情况:

| MAG | 组成 | 官方报告 | 期望操作 | 清理后 |
| --- | --- | --- | --- | --- |
| `MAG_A` | 基因组 X 的 28 条 + **Z 的 2 条污染** | 95.15 / 6.56 | 移除 Z19、Z20 | **92.87 / 0.00** |
| `MAG_B` | 基因组 Y 完整 | 99.85 / 0.71 | 无需操作 | 99.85 / 0.71 |
| `MAG_C` | Z 的 14 条 + **X 的 6 条(与 MAG_A 重复)** | 71.10 / 6.96 | 移除 6 条 X contig | **63.99 / 0.00** |

Hi-C 表按"同基因组内强、跨基因组弱"生成,丰度表给三个基因组不同的样本谱 ——
所以 Z 污染 contig 的 Hi-C 会强烈指向 MAG_C、丰度谱也明显偏离 MAG_A。

> `MAG_C` 完整度从 71.10 降到 63.99 是**正确**的:63.99 才是它真实的
> "只含 Z"的完整度,71.10 里有一部分是被那 6 条外来 X contig 垫高的。

---

## 8. 已知限制

- **不提供 contig 级 CheckM2**。CheckM2 本身只在 bin 层面给完整度/污染度;
  悬停卡片里的数字是"**移除该 contig 后整个 MAG 的**预测值",这是唯一有意义的解读。
- **需要 `diamond_output/`**。若 CheckM2 用了 `--remove_intermediates`,KO 计数无从重建,
  应用会提示重新运行。
- **模型选择不含余弦判定**。官方那一步要拿查询基因组和 5300 个训练基因组比余弦,
  需要 47 MB 参考矩阵,本项目不打包它(§4.1):有报告就沿用报告里的模型,
  缺报告时取两模型均值并把 `modelSource` 标成 `no-report`。
- **contig N50 / Coding Density** 用的是 CheckM2 自己的定义(N50 为"按长度加权后的中位数"),
  与常见的 N50 定义不同,报告生成器已对齐官方实现。
- Hi-C 每个 contig 只保留最强的 20 个伙伴(`parseHic` 的 `topPartners`),避免稠密矩阵撑爆内存。
- **离线单文件版约 11.7 MB**。其中演示数据 `demo.json` gzip 后占 ~3.7 MB,
  打开时要在浏览器里解压,首次加载比开发版略慢(实测约 0.3 s)。
- **`file://` 下拿不到"输出文件夹"手柄**。不透明源里没有可用的目录句柄,
  点「选择…」会明确说明这条路走不通并建议改用「导出 ZIP」。
  想在 `file://` 下直写磁盘,目前只有一条路:另外跑一个 `serve.mjs`
  (它会监听 `127.0.0.1:8788`,页面会自动探到)。
- **没起本地服务时,控制台会有一条 `/__local__/ping` 的失败请求**。
  这是"探测本机有没有 metadrop 服务"的代价 —— 网页无法在不发请求的情况下
  知道某个本地端口上跑着什么。它不影响功能,只是会在 DevTools 里留一条记录。
- **ZIP 打包需要整份结果进内存**。超过约 1.5 GB 会明确劝阻并建议改走输出文件夹直写;
  直写那条路是**边生成边发**的,峰值内存只有单个文件。
- **改输出路径只在本地服务在线时可用**。浏览器出于安全考虑不暴露目录的绝对路径,
  所以那一路只能显示目录名、不能用路径字符串指定。
#   m e t a d r o p  
 