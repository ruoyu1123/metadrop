/**
 * i18n.js — 中英文双语词典与切换。
 *
 * 设计要点:
 *   - 纯函数式取词:t(key, vars) 用 {name} 占位符做插值,不做复数变体(中英都不需要)。
 *   - 计算层(engine.js)不引用本模块,只返回 labelKey;由 UI 层翻译。
 *     这样 Node 测试里跑纯计算不会碰到 localStorage / document。
 *   - 语言选择写进 localStorage;取不到时按浏览器语言猜(zh* → 中文,其余 → 英文)。
 *   - 静态文案靠 data-i18n / data-i18n-title / data-i18n-placeholder / data-i18n-html 标注,
 *     动态文案由各处渲染函数调用 t()。
 */

export const LANGS = ['zh', 'en'];
export const LANG_LABELS = { zh: '中文', en: 'EN' };

const STORAGE_KEY = 'metadrop.lang';

// ---------------------------------------------------------------------------- 词典

const DICT = {
  zh: {
    'app.title': 'Metadrop',
    'app.subtitle': 'CheckM2 结果全解析 · 单拷贝基因重算',
    'app.docTitle': 'Metadrop · MAG 去重与质量复算',

    'badge.local': '本地运行',
    'badge.local.title': '全部计算在本机浏览器里完成(WebAssembly)。模型、数据都不出本机,不发任何网络请求,也不上传任何文件。',
    'badge.offline': '离线单文件',
    'badge.offline.title': '当前是内联了模型与数据的离线单文件版,直接在 file:// 下运行。',
    'badge.localio': '本地直写',
    'badge.localio.title': '已连上本机服务:点「完成输出」会把结果直接写到你指定的磁盘目录,不经过浏览器下载。服务只监听 127.0.0.1,数据不出本机。',
    'badge.backend.loading': '正在加载模型',
    'badge.backend.failed': '模型加载失败',
    'badge.backend.title': '特征 {n} 维 · 完整度模型 {trees} 棵树',

    'btn.demo': '载入演示数据',
    'btn.open': '打开文件夹…',
    'btn.open.title': '选择包含 MAG 序列(.fa/.fna)与 CheckM2 结果目录的文件夹',
    'outdir.caption': '输出',
    'outdir.placeholder': '选择或输入输出文件夹…',
    'btn.outdir': '选择…',
    'btn.outdir.title': '选择输出目录。若本地服务在线,也可以直接在左边的框里填本机绝对路径。',
    'btn.outdir.none': '未设置输出目录',
    'btn.output': '完成输出',
    'btn.output.title': '把汇总表、逐 contig 明细和清理后的 MAG 序列直接写进输出文件夹(需要先设置输出文件夹)',
    'btn.export': '导出 ZIP',
    'btn.export.title': '把全部结果打包成一个 ZIP 下载,不写入输出文件夹',
    'btn.reveal': '打开文件夹',
    'btn.reveal.title': '在资源管理器 / 访达里打开最近一次的输出目录',

    'lang.toggle.title': '切换界面语言 / Switch language',

    'panel.mags': 'MAG 列表',
    'panel.mags.filter': '过滤 MAG 名…',
    'panel.mags.empty': '还没有载入数据。',
    'panel.contigs': '选择左侧的 MAG',
    'panel.detail': 'Contig 详情',
    'btn.suggest': '自动建议',
    'btn.suggest.title': '按重复 / Hi-C / 丰度信号一次性标出所有可疑 contig',
    'btn.reset': '还原本 MAG',
    'btn.reset.title': '把当前 MAG 恢复为全部保留',
    'btn.resetAll': '全部还原',
    'btn.resetAll.title': '把所有 MAG 恢复为全部保留',

    'qs.completeness': '完整度',
    'qs.contamination': '污染度',
    'qs.class': '质量等级',
    'qs.contigs': 'contig',
    'qs.size': '基因组大小',
    'qs.report': '官方报告',
    'qs.noReport': '无报告',

    'filter.contig': '过滤 contig…',
    'filter.onlyFlagged': '只看可疑',
    'th.keep': '保留',
    'th.keep.title': '取消勾选即从 MAG 中移除',
    'th.contig': 'Contig',
    'th.length': '长度',
    'th.cds': 'CDS',
    'th.gc': 'GC%',
    'th.ko': 'KO',
    'th.unique': '独有 KO',
    'th.hicIntra': 'Hi-C 内部',
    'th.hicIntra.title': '与该 MAG 内其他 contig 的 Hi-C 信号',
    'th.hicInter': 'Hi-C 外部',
    'th.hicInter.title': '与该 MAG 外 contig 的 Hi-C 信号',
    'th.abund': '丰度一致',
    'th.abund.title': '该 contig 丰度谱与 MAG 平均谱的余弦相似度',
    'th.verdict': '判断',
    'th.impact': '移除影响',
    'th.impact.title': '移除该 contig 后完整度 / 污染度的变化',
    'th.length.title': '占该 MAG 原始总长(全部 contig)的比例',

    'verdict.duplicate': '重复 bin',
    'verdict.contaminant': '疑似污染',
    'verdict.misfit': '归属存疑',
    'verdict.core': '核心成员',
    'verdict.neutral': '中性',

    'cls.high': '高质量 (HQ)',
    'cls.medium': '中等质量 (MQ)',
    'cls.partial': '低完整度',
    'cls.contaminated': '污染超标',

    'hc.removed': '已移除',
    'hc.length': '长度',
    'hc.cdsKo': 'CDS / KO',
    'hc.uniqueOf': '(独有 {n})',
    'hc.hic': 'Hi-C 内部 / 外部',
    'hc.outFrac': '(外向 {pct}%)',
    'hc.abund': '丰度一致性',
    'hc.placement': '归属证据',
    'hc.afterRemove': '移除该 CONTIG 后',
    'hc.completeness': '完整度',
    'hc.contamination': '污染度',
    'hc.class': '质量等级',
    'hc.clickRemove': '点击该行即可移除',
    'hc.clickRestore': '点击该行即可恢复',
    'hc.strength.strong': '(强,疑似外来)',
    'hc.strength.medium': '(中等)',
    'hc.strength.weak': '(弱)',

    'detail.hint': '把鼠标移到中间表格的任意 contig 上,这里会显示它的完整信息、去除后的预测质量,以及判断依据。',
    'detail.belongs': '属于 {mag}',
    'detail.kept': '当前保留',
    'detail.removedNow': '当前已移除',
    'detail.reasonTitle': '判断依据',
    'detail.serialTitle': '序列指标',
    'detail.length': '长度',
    'detail.lengthShare': '占总长',
    'detail.gc': 'GC 含量',
    'detail.cds': '蛋白 (CDS)',
    'detail.aa': '氨基酸总数',
    'detail.ko': 'KO 命中',
    'detail.uniqueKo': '仅由它贡献的 KO',
    'detail.placement': '归属证据',
    'detail.removeTitle': '移除后预测',
    'detail.orig': '原 {v}',
    'detail.generalModel': '通用模型',
    'detail.specificModel': '特定模型',
    'detail.hicTitle': 'Hi-C 邻接',
    'detail.hicSummary': '内部信号 {intra} · 外部信号 {inter} · 外向 {pct}%',
    'detail.hicSummaryNoFrac': '内部信号 {intra} · 外部信号 {inter}',
    'detail.hicHome': '外部信号最集中的 MAG:<b>{mag}</b>',
    'detail.abundTitle': '丰度谱',
    'detail.lostTitle': '移除后丢失的通路 / 模块',
    'detail.actionTitle': '操作',
    'detail.doRemove': '从 {mag} 移除该 contig',
    'detail.doRestore': '恢复该 contig',

    'body.duplicate': '这个 contig 同时出现在其他 MAG 里 —— 属于重复 bin 成员,通常只需保留在"最贴合"的那个 MAG 中。',
    'body.contaminant': '多种证据都指向它不属于 {mag}:Hi-C 外部信号偏高、丰度谱不匹配,且移除后污染度下降。',
    'body.misfit': '它的 Hi-C 信号或丰度谱与 {mag} 的其余 contig 不太一致,归属存疑,建议结合人工判断。',
    'body.core': '它是 {mag} 的核心成员,移除会明显损失完整度。',
    'body.neutral': '没有发现明显异常信号。',

    'reason.dup': '同时出现在 {mags}',
    'reason.hicOut': 'Hi-C 外部信号占 {pct}%',
    'reason.hicOutHome': 'Hi-C 外部信号占 {pct}%,主要指向 {home}',
    'reason.abundMismatch': '丰度谱与本 MAG 不匹配(余弦 {cos})',
    'reason.contamDown': '移除后污染度下降 {d}',
    'reason.compUp': '移除后完整度上升 {d}',
    'reason.compDown': '移除后完整度下降 {d}',
    'reason.uniqueKo': '本 MAG 中 {n} 个 KO 仅由它贡献',
    'reason.noCds': '没有任何 CDS',
    'tag.dup': '重复',
    'tag.hicOut': 'Hi-C 外向',
    'tag.abund': '丰度不符',
    'tag.contamDown': '降污染',
    'tag.compUp': '升完整度',
    'tag.compDown': '丢完整度',
    'tag.uniqueKo': '{n} 独有 KO',
    'tag.noGene': '无基因',

    'status.ready': '就绪',
    'status.done': '完成',
    'status.loadingAssets': '加载 CheckM2 模型与数据库…',
    'status.readyHint': '模型已就绪 —— 点击「载入演示数据」或拖入你的 CheckM2 结果目录',
    'status.engineFailed': '模型加载失败:{msg} —— 请用静态服务器打开本页面,或改用离线单文件版',
    'status.assetFailed': '读取 {name} 失败 ({status})',

    'status.demo.loading': '读取演示数据…',
    'status.demo.progress': '读取演示数据 {i}/{n}',
    'status.demo.missing': '找不到演示数据(离线版已内联,开发版请先运行 make_demo_data.py)',
    'status.demo.failed': '载入演示数据失败:{msg}',

    'status.files.collecting': '整理文件…',
    'status.files.none': '没有读到文件 —— 请确认选择了包含 MAG 序列(.fa/.fna)与 checkm2 输出目录的文件夹',
    'status.files.failed': '载入失败:{msg}',

    'status.built': '{label}:{mags} 个 MAG,{fasta} 份序列,{protein} 份蛋白,{ko} 条 KO 命中{dup}',
    'status.built.dup': ',{n} 个重复 contig',

    'status.annotate': '计算 Hi-C / 丰度 / 重复指标…',
    'status.exporting': '正在写入输出文件夹…',
    'status.export.genSummary': '生成汇总表…',
    'status.export.mag': '写出 {mag} 清理后的序列…',
    'status.output.file': '写出 {name}…',
    'status.output.doneLocal': '已直写磁盘:{dir}({n} 个文件)',
    'status.output.doneBrowser': '已写入所选文件夹「{name}」({n} 个文件)',
    'status.output.picking': '请在弹出的窗口里选择输出文件夹…',
    'status.output.pickCancelled': '已取消选择,输出文件夹保持不变',
    'status.output.typePath': '可以在「输出」框里直接填本机绝对路径(例如 D:\\结果),回车生效',
    'status.local.on': '已连上本机服务 {version}:结果将直写磁盘,当前输出目录 {dir}',
    'status.local.lost': '本地服务已断开,已切换回浏览器方式',
    'status.zip.started': '正在打包 ZIP…',
    'status.zip.done': '已打包 {n} 个文件 → {name}{extra}',
    'status.zip.doneNoDir': '未设置输出文件夹,已改为打包下载:共 {n} 个文件 → {name}{extra}',
    'status.zip.staged': '(压缩包先落在本机临时目录 {path})',
    'status.zip.tooBig': '结果共 {size},打包成 ZIP 需要整体进内存,可能失败;建议改设输出文件夹直写磁盘',
    'status.zip.failed': '打包失败:{msg}',
    'status.export.dirFail': '设置输出文件夹失败:{msg}',
    'status.export.dirSet': '输出文件夹已设为 {name}',
    'status.export.dirUnsupported': '当前浏览器不支持直接写目录,请改输入本机路径或使用「导出 ZIP」',
    'status.export.failed': '输出失败:{msg}',
    'status.reveal.fail': '打开文件夹失败:{msg}',
    'status.resetAll': '已把所有 MAG 恢复为全部保留',
    'status.suggest.n': '自动建议:共标出 {n} 个 contig(重复优先保留最贴合的 MAG)',
    'status.suggest.none': '自动建议:未发现明显需要移除的 contig',
    'status.progress.removeImpact': '预计算移除影响 {done}/{total}',
    'status.progress.hicAbund': '计算 Hi-C 与丰度指标',
    'prog.report': '解析 checkm2 报告',
    'prog.magSeq': '读取 MAG 序列与蛋白',
    'prog.magSeqOne': '解析 {mag} 序列',
    'prog.magProteinOne': '解析 {mag} 蛋白',
    'prog.amino': '统计氨基酸组成',
    'prog.diamond': '解析 DIAMOND 命中',
    'prog.ko': '汇总 KO 计数',
    'prog.features': '汇总特征向量',
    'prog.hic': '解析 Hi-C',
    'prog.aux': '解析 Hi-C 与丰度',
    'prog.dupIndex': '建立重复 contig 索引',

    'warn.title': '解析提示',
    'warn.close': '关闭',
    'warn.count': '{n} 条提示',

    'drop.title': '松开即可载入',
    'drop.desc': '支持整个文件夹:CheckM2 输出目录、MAG 序列(.fa/.fna)、Hi-C 表、丰度表',

    'land.title': '拖入数据开始',
    'land.desc': '把 CheckM2 结果目录、MAG 序列(.fa/.fna)、Hi-C 信号表、丰度表一起拖到这里;或点击右上角「载入演示数据」先看效果。',
    'land.sub': '全部计算在本机浏览器内完成,数据不会上传到任何地方。',

    'list.sep': '、',

    'err.noGz': '当前浏览器不支持解压 .gz(缺少 DecompressionStream),请先手动解压。',
    'err.noMagSeq': '没有读到任何 MAG 序列 —— 请选择包含 .fa / .fna / .fasta(或 .faa)文件的目录。',
    'warn.reportRead': '读取到 checkm2 报告:{n} 个 bin',
    'warn.noReport': '未找到 quality_report.tsv,将无法与官方结果对比基线',
    'warn.contigMap': '读取到蛋白→contig 映射表:{n} 条',
    'warn.reportOnly': '报告里有 {n} 个 bin 没有任何序列文件,已跳过(无法复算):{names}',
    'warn.noFasta': '{n} 个 MAG 缺少核酸序列文件(.fa/.fna),其 contig 由蛋白 id 反推:{names}',
    'warn.orphanProtein': '{mag}:{n} 条蛋白指向的 contig 不在 fa 文件里,已忽略',
    'warn.unknownProtein': '{mag}:{n} 条蛋白无法归属到 contig',
    'warn.diamondDropped': 'DIAMOND 行被丢弃(无 KO 注释或无法归属 bin):{n}',
    'warn.koUnmatched': '有 {n} 个 KO 注释不在 CheckM2 特征表里(官方实现同样会丢弃)',
    'warn.noDiamond': '未找到 DIAMOND 输出(diamond_output/DIAMOND_RESULTS*.tsv),只能算元数据部分,无法复算完整度。若曾用 --remove_intermediates 需重新运行 checkm2。',
    'warn.hic.edge-list': 'Hi-C 表格式:边表,共 {n} 条边',
    'warn.hic.matrix': 'Hi-C 表格式:稠密矩阵,共 {n} 条边',
    'warn.hic.empty': 'Hi-C 表是空的,未得到任何边',
    'warn.hic.none': 'Hi-C 表格式未识别',
    'warn.emptyMagOutput': '{n} 个 MAG 的 contig 全部被移除,写出的 fa 是空文件',
    'abund.note.coverm': '检测到 coverM 风格表,取 * Mean 列',
    'abund.note.excludeCov': '已排除 Coverage 列,保留数值列',

    'foot.design': 'Design by yangjinbao',
    'foot.cite': '使用本程序请引用文章:',
    'foot.ref': '待发表',
  },

  en: {
    'app.title': 'Metadrop',
    'app.subtitle': 'Full CheckM2 result parsing · single-copy gene recomputation',
    'app.docTitle': 'Metadrop · MAG decontamination & quality recalculation',

    'badge.local': 'Runs locally',
    'badge.local.title': 'Every calculation happens in this browser via WebAssembly. No model, data or file ever leaves your machine — no network requests, no uploads.',
    'badge.offline': 'Offline single file',
    'badge.offline.title': 'This is the single-file build with models and data inlined; it runs straight from file://.',
    'badge.localio': 'Direct disk write',
    'badge.localio.title': 'The local service is connected: "Write output" saves results straight to the folder you specify on this machine, with no browser download. The service only listens on 127.0.0.1, so nothing leaves your machine.',
    'badge.backend.loading': 'Loading models',
    'badge.backend.failed': 'Model load failed',
    'badge.backend.title': '{n}-dim features · {trees} trees in the completeness model',

    'btn.demo': 'Load demo data',
    'btn.open': 'Open folder…',
    'btn.open.title': 'Pick the folder holding your MAG sequences (.fa/.fna) and CheckM2 output',
    'outdir.caption': 'Output',
    'outdir.placeholder': 'Choose or type an output folder…',
    'btn.outdir': 'Choose…',
    'btn.outdir.title': 'Pick an output folder. When the local service is running you can also type an absolute path in the box on the left.',
    'btn.outdir.none': 'No output folder',
    'btn.output': 'Write output',
    'btn.output.title': 'Write the summary table, per-contig details and cleaned MAG sequences straight into the output folder (set one first)',
    'btn.export': 'Export ZIP',
    'btn.export.title': 'Bundle every result into a single ZIP download; the output folder is left untouched',
    'btn.reveal': 'Open folder',
    'btn.reveal.title': 'Reveal the most recent output folder in Explorer / Finder',

    'lang.toggle.title': 'Switch language / 切换界面语言',

    'panel.mags': 'MAG list',
    'panel.mags.filter': 'Filter MAG names…',
    'panel.mags.empty': 'No data loaded yet.',
    'panel.contigs': 'Select a MAG on the left',
    'panel.detail': 'Contig details',
    'btn.suggest': 'Auto-suggest',
    'btn.suggest.title': 'Flag every suspicious contig at once using duplicate / Hi-C / abundance signals',
    'btn.reset': 'Reset this MAG',
    'btn.reset.title': 'Restore all contigs of the current MAG',
    'btn.resetAll': 'Reset all',
    'btn.resetAll.title': 'Restore all contigs of every MAG',

    'qs.completeness': 'Completeness',
    'qs.contamination': 'Contamination',
    'qs.class': 'Quality class',
    'qs.contigs': 'contigs',
    'qs.size': 'Assembly size',
    'qs.report': 'Reported',
    'qs.noReport': 'no report',

    'filter.contig': 'Filter contigs…',
    'filter.onlyFlagged': 'Suspicious only',
    'th.keep': 'Keep',
    'th.keep.title': 'Uncheck to drop this contig from the MAG',
    'th.contig': 'Contig',
    'th.length': 'Length',
    'th.cds': 'CDS',
    'th.gc': 'GC%',
    'th.ko': 'KO',
    'th.unique': 'Unique KO',
    'th.hicIntra': 'Hi-C intra',
    'th.hicIntra.title': 'Hi-C signal shared with other contigs of this MAG',
    'th.hicInter': 'Hi-C inter',
    'th.hicInter.title': 'Hi-C signal pointing outside this MAG',
    'th.abund': 'Abund. fit',
    'th.abund.title': 'Cosine similarity between this contig abundance profile and the MAG mean profile',
    'th.verdict': 'Verdict',
    'th.impact': 'Impact',
    'th.impact.title': 'Change in completeness / contamination when this contig is removed',
    'th.length.title': 'Share of the MAG total length (all contigs)',

    'verdict.duplicate': 'Duplicate bin',
    'verdict.contaminant': 'Likely contaminant',
    'verdict.misfit': 'Questionable',
    'verdict.core': 'Core member',
    'verdict.neutral': 'Neutral',

    'cls.high': 'High quality (HQ)',
    'cls.medium': 'Medium quality (MQ)',
    'cls.partial': 'Low completeness',
    'cls.contaminated': 'Too contaminated',

    'hc.removed': 'Removed',
    'hc.length': 'Length',
    'hc.cdsKo': 'CDS / KO',
    'hc.uniqueOf': '({n} unique)',
    'hc.hic': 'Hi-C intra / inter',
    'hc.outFrac': '({pct}% outward)',
    'hc.abund': 'Abundance fit',
    'hc.placement': 'Placement evidence',
    'hc.afterRemove': 'AFTER REMOVING THIS CONTIG',
    'hc.completeness': 'Completeness',
    'hc.contamination': 'Contamination',
    'hc.class': 'Quality class',
    'hc.clickRemove': 'Click the row to remove it',
    'hc.clickRestore': 'Click the row to restore it',
    'hc.strength.strong': '(strong — likely foreign)',
    'hc.strength.medium': '(moderate)',
    'hc.strength.weak': '(weak)',

    'detail.hint': 'Hover any contig in the table to see its full profile, the predicted quality after removal, and the reasoning behind the verdict.',
    'detail.belongs': 'in {mag}',
    'detail.kept': 'currently kept',
    'detail.removedNow': 'currently removed',
    'detail.reasonTitle': 'Why',
    'detail.serialTitle': 'Sequence metrics',
    'detail.length': 'Length',
    'detail.lengthShare': 'Share of total',
    'detail.gc': 'GC content',
    'detail.cds': 'Proteins (CDS)',
    'detail.aa': 'Amino acids',
    'detail.ko': 'KO hits',
    'detail.uniqueKo': 'KO contributed only here',
    'detail.placement': 'Placement evidence',
    'detail.removeTitle': 'Prediction after removal',
    'detail.orig': 'was {v}',
    'detail.generalModel': 'General model',
    'detail.specificModel': 'Specific model',
    'detail.hicTitle': 'Hi-C adjacency',
    'detail.hicSummary': 'Intra {intra} · Inter {inter} · {pct}% outward',
    'detail.hicSummaryNoFrac': 'Intra {intra} · Inter {inter}',
    'detail.hicHome': 'MAG with the strongest external signal: <b>{mag}</b>',
    'detail.abundTitle': 'Abundance profile',
    'detail.lostTitle': 'Pathways / modules lost after removal',
    'detail.actionTitle': 'Action',
    'detail.doRemove': 'Remove from {mag}',
    'detail.doRestore': 'Restore this contig',

    'body.duplicate': 'This contig also appears in another MAG — it is a duplicate bin member, so it should normally be kept only in the best-fitting MAG.',
    'body.contaminant': 'Several lines of evidence say it does not belong to {mag}: high outward Hi-C signal, mismatching abundance profile, and contamination drops once it is removed.',
    'body.misfit': 'Its Hi-C signal or abundance profile disagrees with the rest of {mag}. Placement is uncertain — review manually.',
    'body.core': 'It is a core member of {mag}; removing it would clearly lose completeness.',
    'body.neutral': 'No obvious anomaly detected.',

    'reason.dup': 'Also present in {mags}',
    'reason.hicOut': '{pct}% of Hi-C signal points outside',
    'reason.hicOutHome': '{pct}% of Hi-C signal points outside, mostly to {home}',
    'reason.abundMismatch': 'Abundance profile does not match this MAG (cosine {cos})',
    'reason.contamDown': 'Contamination drops by {d} after removal',
    'reason.compUp': 'Completeness rises by {d} after removal',
    'reason.compDown': 'Completeness drops by {d} after removal',
    'reason.uniqueKo': '{n} KO in this MAG are contributed only by it',
    'reason.noCds': 'No CDS at all',
    'tag.dup': 'Duplicate',
    'tag.hicOut': 'Hi-C outward',
    'tag.abund': 'Abundance mismatch',
    'tag.contamDown': 'Less contamination',
    'tag.compUp': 'More completeness',
    'tag.compDown': 'Loses completeness',
    'tag.uniqueKo': '{n} unique KO',
    'tag.noGene': 'No genes',

    'status.ready': 'Ready',
    'status.done': 'Done',
    'status.loadingAssets': 'Loading CheckM2 models and database…',
    'status.readyHint': 'Models ready — click "Load demo data" or drop your CheckM2 output folder here',
    'status.engineFailed': 'Model load failed: {msg} — serve the page over HTTP, or use the offline single-file build',
    'status.assetFailed': 'Failed to read {name} ({status})',

    'status.demo.loading': 'Reading demo data…',
    'status.demo.progress': 'Reading demo data {i}/{n}',
    'status.demo.missing': 'Demo data not found (inlined in the offline build; for the dev build run make_demo_data.py first)',
    'status.demo.failed': 'Failed to load demo data: {msg}',

    'status.files.collecting': 'Collecting files…',
    'status.files.none': 'No files read — make sure the folder contains MAG sequences (.fa/.fna) and CheckM2 output',
    'status.files.failed': 'Load failed: {msg}',

    'status.built': '{label}: {mags} MAGs, {fasta} sequence files, {protein} protein files, {ko} KO hits{dup}',
    'status.built.dup': ', {n} duplicate contigs',

    'status.annotate': 'Computing Hi-C / abundance / duplicate metrics…',
    'status.exporting': 'Writing into the output folder…',
    'status.export.genSummary': 'Building summary table…',
    'status.export.mag': 'Writing cleaned sequence for {mag}…',
    'status.output.file': 'Writing {name}…',
    'status.output.doneLocal': 'Written straight to disk: {dir} ({n} files)',
    'status.output.doneBrowser': 'Written into "{name}" ({n} files)',
    'status.output.picking': 'Pick an output folder in the dialog that just opened…',
    'status.output.pickCancelled': 'Selection cancelled; the output folder is unchanged',
    'status.output.typePath': 'You can type an absolute path (e.g. D:\\results) into the "Output" box and press Enter',
    'status.local.on': 'Local service {version} connected: results go straight to disk, current output folder {dir}',
    'status.local.lost': 'The local service went away; switched back to the browser path',
    'status.zip.started': 'Building the ZIP…',
    'status.zip.done': 'Bundled {n} files → {name}{extra}',
    'status.zip.doneNoDir': 'No output folder set — bundled into a download instead: {n} files → {name}{extra}',
    'status.zip.staged': ' (the ZIP was staged in your local temp folder {path})',
    'status.zip.tooBig': 'The results total {size}; zipping needs all of it in memory and may fail — set an output folder to write straight to disk instead',
    'status.zip.failed': 'Packaging failed: {msg}',
    'status.export.dirFail': 'Could not set the output folder: {msg}',
    'status.export.dirSet': 'Output folder set to {name}',
    'status.export.dirUnsupported': 'This browser cannot write to directories directly; type a local path instead, or use "Export ZIP"',
    'status.export.failed': 'Output failed: {msg}',
    'status.reveal.fail': 'Could not open the folder: {msg}',
    'status.resetAll': 'All MAGs restored to fully kept',
    'status.suggest.n': 'Auto-suggest: flagged {n} contigs (duplicates keep the best-fitting MAG)',
    'status.suggest.none': 'Auto-suggest: nothing obviously worth removing',
    'status.progress.removeImpact': 'Precomputing removal impact {done}/{total}',
    'status.progress.hicAbund': 'Computing Hi-C and abundance metrics',
    'prog.report': 'Parsing the CheckM2 report',
    'prog.magSeq': 'Reading MAG sequences and proteins',
    'prog.magSeqOne': 'Parsing {mag} sequences',
    'prog.magProteinOne': 'Parsing {mag} proteins',
    'prog.amino': 'Counting amino acids',
    'prog.diamond': 'Parsing DIAMOND hits',
    'prog.ko': 'Aggregating KO counts',
    'prog.features': 'Building feature vectors',
    'prog.hic': 'Parsing Hi-C',
    'prog.aux': 'Parsing Hi-C and abundance',
    'prog.dupIndex': 'Indexing duplicate contigs',

    'warn.title': 'Parsing notes',
    'warn.close': 'Close',
    'warn.count': '{n} notes',

    'drop.title': 'Drop to load',
    'drop.desc': 'Whole folders work: CheckM2 output, MAG sequences (.fa/.fna), Hi-C table, abundance table',

    'land.title': 'Drop data to begin',
    'land.desc': 'Drag your CheckM2 output folder, MAG sequences (.fa/.fna), Hi-C signal table and abundance table here — or click "Load demo data" in the top-right corner.',
    'land.sub': 'Everything runs inside this browser. Nothing is uploaded anywhere.',

    'list.sep': ', ',

    'err.noGz': 'This browser cannot decompress .gz (no DecompressionStream); please decompress it first.',
    'err.noMagSeq': 'No MAG sequence found — please pick a directory containing .fa / .fna / .fasta (or .faa) files.',
    'warn.reportRead': 'Read the CheckM2 report: {n} bins',
    'warn.noReport': 'quality_report.tsv not found — no baseline to compare against the official run',
    'warn.contigMap': 'Read a protein→contig map: {n} entries',
    'warn.reportOnly': '{n} bins appear in the report but have no sequence file; skipped (cannot be recalculated): {names}',
    'warn.noFasta': '{n} MAG(s) have no nucleotide file (.fa/.fna); their contigs were inferred from protein IDs: {names}',
    'warn.orphanProtein': '{mag}: {n} proteins point to contigs absent from the FASTA — ignored',
    'warn.unknownProtein': '{mag}: {n} proteins could not be assigned to a contig',
    'warn.diamondDropped': 'DIAMOND lines dropped (no KO annotation or unknown bin): {n}',
    'warn.koUnmatched': '{n} KO annotations are not in the CheckM2 feature table (the official implementation drops these too)',
    'warn.noDiamond': 'No DIAMOND output found (diamond_output/DIAMOND_RESULTS*.tsv). Only metadata can be computed, so completeness cannot be recalculated. If you used --remove_intermediates you need to re-run CheckM2.',
    'warn.hic.edge-list': 'Hi-C table: edge list, {n} edges',
    'warn.hic.matrix': 'Hi-C table: dense matrix, {n} edges',
    'warn.hic.empty': 'Hi-C table is empty; no edges were read',
    'warn.hic.none': 'Unrecognised Hi-C table format',
    'warn.emptyMagOutput': '{n} MAG(s) had every contig removed — the exported FASTA is empty',
    'abund.note.coverm': 'coverM-style table detected, using the * Mean columns',
    'abund.note.excludeCov': 'Coverage columns excluded, numeric columns kept',

    'foot.design': 'Design by yangjinbao',
    'foot.cite': 'If you use the program, please cite the article:',
    'foot.ref': 'to be published',
  },
};

// ---------------------------------------------------------------------------- 状态

function detectLang() {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (saved && LANGS.includes(saved)) return saved;
  } catch { /* 隐私模式等 */ }
  try {
    const nav = globalThis.navigator?.language || '';
    if (/^zh/i.test(nav)) return 'zh';
    if (nav) return 'en';
  } catch { /* ignore */ }
  return 'zh';
}

let current = detectLang();
const listeners = new Set();

export function getLang() { return current; }

export function setLang(lang, { silent = false } = {}) {
  if (!LANGS.includes(lang) || lang === current) {
    if (!silent) applyStatic();
    return current;
  }
  current = lang;
  try { globalThis.localStorage?.setItem(STORAGE_KEY, lang); } catch { /* ignore */ }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.title = t('app.docTitle');
  }
  applyStatic();
  if (!silent) for (const fn of listeners) fn(lang);
  return current;
}

/** 语言变化时回调(用于重渲染动态内容) */
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------------------- 取词

/**
 * 取词 + {name} 插值。
 * 找不到 key 时返回 key 本身(方便发现漏翻),而不是抛错。
 */
export function t(key, vars) {
  const table = DICT[current] || DICT.zh;
  let s = table[key];
  if (s === undefined) s = DICT.zh[key] !== undefined ? DICT.zh[key] : key;
  if (vars && s.indexOf('{') >= 0) {
    s = s.replace(/\{(\w+)\}/g, (m, name) => (
      vars[name] === undefined || vars[name] === null ? m : String(vars[name])));
  }
  return s;
}

/** 是否有该词条(测试用) */
export function hasKey(key) { return DICT[current][key] !== undefined; }

/** 列出某个语言的全部 key(测试用,检查两种语言是否对齐) */
export function keysOf(lang = current) { return Object.keys(DICT[lang] || {}); }

// ---------------------------------------------------------------------------- 静态文案

const ATTRS = [
  ['data-i18n', 'textContent'],
  ['data-i18n-html', 'innerHTML'],
  ['data-i18n-title', 'title'],
  ['data-i18n-placeholder', 'placeholder'],
];

/** 把 DOM 里带 data-i18n* 标注的元素刷新为当前语言 */
export function applyStatic(root) {
  if (typeof document === 'undefined') return;
  const scope = root || document;
  for (const [attr, prop] of ATTRS) {
    for (const node of scope.querySelectorAll(`[${attr}]`)) {
      const key = node.getAttribute(attr);
      if (!key) continue;
      const value = t(key);
      if (prop === 'placeholder' || prop === 'title') node.setAttribute(prop, value);
      else node[prop] = value;
    }
  }
  for (const node of scope.querySelectorAll('[data-i18n-vars]')) {
    // 可选:在 data-i18n 基础上做一次插值
    try {
      const vars = JSON.parse(node.getAttribute('data-i18n-vars'));
      const key = node.getAttribute('data-i18n');
      if (key) node.textContent = t(key, vars);
    } catch { /* ignore */ }
  }
  const toggle = scope.querySelector('#lang-toggle');
  if (toggle) {
    for (const b of toggle.querySelectorAll('button')) {
      b.classList.toggle('is-on', b.dataset.lang === current);
      b.setAttribute('aria-pressed', String(b.dataset.lang === current));
    }
  }
}
