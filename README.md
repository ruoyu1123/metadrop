# Metadrop

**Local, offline recalculation and decontamination of metagenome-assembled genomes (MAGs).**

Metadrop imports one or more MAGs together with their CheckM2 output and, **without
re-running CheckM2**, recomputes completeness and contamination in the browser with
numerical fidelity to the reference implementation. It then uses Hi-C linkage and
abundance profiles as independent evidence to identify duplicated bin members and
contaminating contigs, which can be removed one at a time with immediate feedback on
the recomputed quality of the affected MAG.

The computation core is written in Rust and compiled to WebAssembly. Both models
(gradient-boosted trees and a convolutional network) are bundled in `assets/`
(6.8 MB); after the first load the application runs entirely offline.

Results go wherever you choose. With the bundled local helper (`tools/serve.mjs`)
they are **written directly to a directory you specify**; without it they are
**packaged into a single ZIP download**. Neither route uploads any data.

---

## Table of contents

1. [Overview](#1-overview)
2. [Quick start](#2-quick-start)
3. [Input data contract](#3-input-data-contract)
4. [Numerical agreement with CheckM2](#4-numerical-agreement-with-checkm2)
5. [Decision logic](#5-decision-logic)
6. [Output files](#6-output-files)
7. [Repository layout](#7-repository-layout)
8. [Demonstration dataset](#8-demonstration-dataset)
9. [Security and privacy](#9-security-and-privacy)
10. [Testing](#10-testing)
11. [Rebuilding from source](#11-rebuilding-from-source)
12. [Known limitations](#12-known-limitations)
13. [Citation](#13-citation)

---

## 1. Overview

CheckM2 reports completeness and contamination for a MAG, but not for its individual
contigs. Deciding *which contig to remove* is therefore the practical problem, and the
obvious signal is the wrong one: **the change in completeness caused by a deletion**.
A contaminating contig frequently carries single-copy genes that the model credits to
the host, so removing it removes both the foreign sequence and the borrowed credit, and
completeness can *fall*. In one of our demonstration bins, removing a known contaminant
lowers completeness by 1.6 percentage points.

Metadrop addresses both halves of the problem separately:

| Goal | Approach |
| --- | --- |
| Recompute quality after any set of contig removals | Port CheckM2's feature construction and both models to WebAssembly; reproduce the reference implementation exactly |
| Decide *which* contigs to remove | Model-independent evidence: Hi-C linkage consistency and abundance-profile similarity, plus the objective fact of bin-level duplication |

The two are deliberately kept apart. Every number reported as "CheckM2 completeness"
is a faithful reimplementation; every verdict about *membership* comes from evidence
that does not depend on the completeness model at all.

### Design constraints

- **Entirely local.** No backend, no upload, no telemetry, no CDN, no external request of
  any kind. The offline build is asserted to make zero HTTP(S) requests.
- **No runtime dependencies.** `package.json` declares no `dependencies` and no
  `devDependencies`; there is no `node_modules`. The application is plain ES modules
  plus one WebAssembly module.
- **Exact reproduction, not approximation.** Agreement with the reference
  implementation is element-wise (Section 4).

---

## 2. Quick start

Three ways to run it, all of which keep data on the local machine. They differ only in
how results reach the filesystem.

### 2.1 Local helper (recommended — results are written to disk)

```bash
cd app
node tools/serve.mjs --out "D:/metadrop_out"     # --out is optional; defaults to ./metadrop_out
# open http://127.0.0.1:8788/
```

`serve.mjs` is a dependency-free Node script that does two things:

1. serves the application to the browser, replacing `python -m http.server`;
2. because the process already runs on this machine, writes results **directly into the
   output directory you specified**.

This adds a **Write results** button to the interface. Clicking it places
`checkm2_web_summary.tsv`, `checkm2_web_contigs.tsv` and one `<name>.cleaned.fa` per
modified MAG directly into the directory given by `--out`, with no browser download step.

```
   ┌──────────────┐   GET /               ┌───────────────────────────┐
   │   Browser    │ ────────────────────▶ │ serve.mjs (127.0.0.1)     │
   │  ← compute   │ ◀──────────────────── │  ① static hosting of app/  │
   └───────┬──────┘  POST /__local__/write └───────────┬───────────────┘
           │                                          │  write files
           └────── results land in out/ on this host ◀┘
```

The output directory can be changed without restarting: when the local helper is
running, the field next to **Output** accepts an absolute path, applied on Enter.
**Browse…** opens the operating system's native folder picker — only the helper process
can obtain an absolute path, since browsers deliberately withhold it. **Open folder**
then reveals the destination in Explorer or Finder.

### 2.2 Single offline file (no server, double-click to run)

```bash
node tools/build_offline.mjs      # → dist/metadrop-offline.html (11.2 MB)
```

Copy `dist/metadrop-offline.html` anywhere and open it. Model weights and the
demonstration dataset are inlined into that single file; the full pipeline runs with the
network disconnected, which `tools/check_offline.mjs` asserts explicitly.

Without the local helper, output degrades in one of two ways: a directory handle via the
File System Access API (Chrome, Edge), or a single ZIP download.

### 2.3 Development server (use this when editing `js/`)

```bash
cd app
python -m http.server 8765        # WebAssembly and fetch() do not work over file://
# then open http://127.0.0.1:8765/
```

Any static server will do. When the local helper is absent the application performs one
probe at start-up, which appears in the console as a failed `/__local__/ping` request.
This is expected and does not affect operation.

### 2.4 Interface

| Action | Description |
| --- | --- |
| **Load demo data** | Reads `samples/demo/` (three MAGs containing duplication and contamination, with Hi-C and abundance tables) |
| **Open folder / drag-and-drop** | Select or drop your own CheckM2 output directory, MAG sequences, Hi-C table and abundance table |
| **Output** | Chooses where results go: absolute path (local helper), directory handle (browser), or a packaged download |

Keyboard shortcuts: `S` auto-suggest · `R` restore original MAG · `E` write results ·
`Z` export ZIP · `L` toggle Chinese/English.

Hovering a contig opens a card showing its annotations together with the completeness and
contamination that **the whole MAG would have after that contig is removed** — the
pre-computed single-deletion result, produced on hover. Clicking a contig removes or
restores it, and the readouts refresh immediately. The **Length** column reports an
absolute length and a percentage of the MAG's **original** total length (all contigs);
using the original total as the denominator keeps the column summing to 100 %, so
percentages do not drift upward as rows are removed.

**Auto-suggest** flags all suspicious contigs (duplicated plus contaminating) at once and
produces a proposed cleaned state.

> The interface is available in Chinese and English; the toggle is at the top right and
> the choice persists in `localStorage`. All text lives in `js/i18n.js`; the computation
> layer emits language-neutral keys only, and `tools/check_i18n.mjs` verifies that the two
> dictionaries agree exactly and that no untranslated string remains in the source.

---

## 3. Input data contract

Files are classified by name automatically; no configuration is required. If a category
is missing, the corresponding capability degrades gracefully with an explicit notice.

### 3.1 CheckM2 output directory (required)

```
checkm2_out/
├── quality_report.tsv                    # official report, used as the comparison baseline
├── protein_files/<MAG>.faa               # Prodigal-predicted proteins
└── diamond_output/DIAMOND_RESULTS*.tsv   # DIAMOND alignment (KO annotation)
```

- **`quality_report.tsv`** — the default output of `checkm2 predict`. Column names must
  include `Name`, `Completeness`, `Contamination` and `Completeness_Model_Used`. Remaining
  columns (`Contig_N50`, `Genome_Size`, `GC_Content`, …) are surfaced in the interface.
- **`DIAMOND_RESULTS.tsv`** — one row per hit, `{bin}Ω{protein id}\t{UniRef}~{KO}\t…`.
  CheckM2 separates bin and protein with `Ω` (U+03A9). If that separator has been altered,
  the parser falls back to longest-prefix matching against the known bin names. Custom
  mapping tables such as `protein2contig.map.tsv` (two columns: protein id, contig) are
  also accepted.
- If CheckM2 was run with `--remove_intermediates`, `diamond_output/` will have been
  deleted. Only metadata can then be recovered; completeness cannot be recomputed.

### 3.2 MAG assembly files (required)

Extensions `.fna`, `.fa`, `.fasta`, `.fas`, `.ffn` (optionally gzip-compressed). The file
name without extension is the MAG name and must match `Name` in `quality_report.tsv`.

**The sequence files are the sole authority on the contig set.** Contigs listed in the
interface, and the `<MAG>.cleaned.fa` files written on export, both derive from this
source:

- protein files (`.faa`) and DIAMOND results only contribute gene-level information
  (CDS and KO counts) and never introduce contigs that are absent from the sequences;
- a protein pointing at a contig that does not appear in the sequence file is recorded as
  an orphan and ignored, with a notice in the status bar;
- a bin present in the report but lacking any sequence file is skipped with a warning
  rather than presented as a bin with zero contigs;
- if not a single MAG sequence can be read, the application reports an error instead of
  producing an empty but plausible-looking result.

Only per-sequence statistics (length, GC) are held in memory; the full sequences are
re-read as a stream when cleaned files are written.

### 3.3 Hi-C linkage table (strongly recommended)

`hic/*.tsv`, or any file whose name contains `hic`, `contact` or `link`. Two layouts are
supported:

```tsv
# edge list (preferred)
contig_a	contig_b	signal
k141_51	k141_88	412
```

```tsv
# dense matrix (rows and columns are contig names)
        k141_51  k141_88  k141_93
k141_51     0       412      18
```

### 3.4 Abundance table (strongly recommended)

Any file whose name contains `abund`, `coverage`, `coverm`, `tpm`, `rpkm` or `count`.
The first column is the contig identifier; the remaining columns are samples. Columns in
coverM style (`*.Mean`, `*.Coverage`) are recognised automatically, with `Mean` preferred.

---

## 4. Numerical agreement with CheckM2

CheckM2 is not a marker-gene counter in the manner of CheckM1; completeness and
contamination are produced by machine-learned models. Metadrop mirrors the model files
of the official distribution into the browser and reproduces them with an equivalent
numerical implementation.

| Stage | Reference implementation | This project |
| --- | --- | --- |
| Feature vector | 21,241 dimensions: 20 amino-acid counts + AALength + CDS, then 19,999 KO counts, then 416 pathway + 757 module + 47 category completeness groups | `js/engine.js` → `fillFeatures()` |
| Completeness, general | LightGBM `general_model_COMP.gbm` (450 trees, objective `regression sqrt`, prediction = `raw · |raw|`) | `wasm-core/src/lib.rs` → `c2_gbm_predict` |
| Completeness, specific | Keras CNN `specific_model_COMP.keras` (4 × Conv1D + BatchNorm + Dense) | `c2_nn_forward` |
| Contamination | LightGBM `model_CONT.gbm` | `c2_gbm_predict` |
| Normalisation | scikit-learn `MinMaxScaler` | `c2_minmax_transform` |
| Model selection | Maximum cosine similarity against 5,300 reference genomes, then `cosine_decider` | **Not reimplemented** (Section 4.1): the model recorded in the report is reused; without a report the choice degrades, and the 47 MB reference matrix is not shipped |

### 4.1 Measured agreement

Every figure below is asserted by an automated test.

| Comparison | Discrepancy |
| --- | --- |
| GBDT vs. official LightGBM | `0` (element-wise) |
| CNN vs. official Keras | `< 1e-10` |
| WebAssembly vs. pure JavaScript | `0` (GBDT, grouping), `2.5e-11` (CNN) |
| End-to-end on real training genomes | `0` |

### 4.2 Omitted capability: cosine-based model selection

CheckM2 first compares the query genome with 5,300 training genomes by cosine similarity
and then decides between the general and specific completeness models using
`novelty_ratio = general / cosine²` (`modelPostprocessing.cosine_decider`). This requires
a 47 MB reference matrix (`ref_csr.bin`) that **this project does not ship**, so:

- **When `quality_report.tsv` is available**, the model named in its
  `Completeness_Model_Used` column is used. CheckM2 itself reports values under that
  model, so the pre-cleaning recomputation is bit-for-bit comparable with the report.
  This is the primary path.
- **When the report is missing**, novelty cannot be computed. The engine falls back to
  `CheckM2Engine.pickModelFallback()`, which retains the half of the official rule that
  does not require cosine similarity (mean completeness below 55 with an
  amino-acid-to-completeness ratio below 1500 selects the general model, the same branch
  and the same conclusion as upstream) and otherwise averages the two models, marking
  `modelSource` as `no-report` rather than presenting the result as official behaviour.

The benefit is a 47 MB reduction in both download and resident memory; the single-file
offline build is 11.2 MB rather than 21.4 MB. To restore the capability, re-export the
matrix with `python tools/export_assets.py` (which regenerates `assets/ref_csr.bin`) and
restore the loading path in `engine.js` and `c2_cosine_max`.

### 4.3 Incremental recomputation

Each contig stores a sparse contribution (amino-acid counts, AALength, CDS, KO counts), so
removing any set of contigs requires only `counts = baseCounts − Σ contributions`
followed by one model evaluation. A removal-and-recompute including the CNN takes
roughly **9–12 ms**; pre-computing all 200 contigs takes about 2.4 s.

---

## 5. Decision logic

### 5.1 Placement evidence score (0–1)

```
placement = 0.55 × (outward Hi-C fraction) + 0.45 × (1 − abundance cosine similarity)
```

The score **deliberately excludes the change in completeness**. Contaminants frequently
share single-copy genes with their host, so removing one can lower completeness — an
artefact of credit the contaminant was itself supplying. A criterion based on
Δcompleteness would systematically miss exactly the contigs it should flag.

When Hi-C data are absent a neutral default of 0.35 is used, and 0.15 when abundance data
are absent, so that missing tables cannot produce confident misjudgements.

### 5.2 Verdicts

| Verdict | Trigger | Meaning |
| --- | --- | --- |
| **Duplicated bin member** | the same contig identifier occurs in ≥ 2 MAGs | must be removed from one side; which side is decided by a placement vote |
| **Likely contaminant** | `placement ≥ 0.60` | Hi-C and abundance both indicate it does not belong here |
| **Uncertain** | `0.42 ≤ placement < 0.60` | manual review recommended |
| **Core member** | `placement < 0.42` and removing it would cost ≥ 0.2 completeness | retain |
| Neutral | otherwise | no clear signal |

### 5.3 Resolving duplicated contigs

For each duplicated contig, a fit score is computed across all MAGs hosting it:

```
fit = (1 − outward Hi-C fraction) × 0.5 + abundance cosine similarity × 0.5 + (0.15 if it holds unique KOs)
```

The MAG with the highest `fit` retains the contig; the others are marked for removal.

---

## 6. Output files

**Write results** produces:

- `checkm2_web_summary.tsv` — one row per MAG;
- `checkm2_web_contigs.tsv` — per-contig detail: retained or removed, verdict, length,
  length share, CDS count, KO counts, intra/inter Hi-C signal, abundance cosine,
  predicted values after removal, and the MAGs it duplicates in;
- `<MAG>.cleaned.fa` — one FASTA per modified MAG, containing exactly the retained
  contigs, with headers and sequences preserved byte-for-byte from the input.

Cleaned sequence names are `<MAG name>.cleaned.fa`, and their content is taken from the
MAG sequence files you supplied: only removed contigs are dropped.

The summary table reports both the official values and the locally recomputed values,
together with before/after comparison and the exact list of removed contigs:

```
MAG    Contigs_Original  Contigs_Kept  Removed_Contigs          Report_Completeness  Report_Contamination  Recalc_Completeness_Original  Recalc_Completeness_Cleaned  Recalc_Contamination_Original  Recalc_Contamination_Cleaned  Length_Before_bp  Length_After_bp  Quality_Class
MAG_A  30                28            Z19,Z20                  95.15                6.56                  95.15                         92.87                        6.56                           0                             3712056           3532039          High quality (HQ)
MAG_B  18                18                                     99.85                0.71                  99.85                         99.85                        0.71                           0.71                          2439648           2439648          High quality (HQ)
MAG_C  20                14            X01,X03,X05,X07,X09,X11  71.1                 6.96                  71.1                          63.99                        6.96                           0                             2287152           1581221          Medium quality (MQ)
```

All exported values are machine-readable: quality classes use English labels, lengths are
integer bp, and a `Length_Share` percentage column is included.

**Export ZIP** produces the same content as a single timestamped archive
(`metadrop_results_YYYYMMDD-HHMMSS.zip`) and never touches the output directory. When the
local helper is running, the archive is staged in the system temporary directory
(`%TEMP%/metadrop-export/<token>/`) and fetched from there; the status bar reports the
true path. Staging directories require no manual cleanup — on start-up the helper deletes
staging directories older than 24 hours, touching only its own subdirectories under
`metadrop-export`.

Archives are produced by a dependency-free ZIP writer (`js/zip.js`, using `deflate-raw`
with a `store` fallback). `tools/test_zip.mjs` validates the byte stream independently by
unpacking it with Python's standard-library `zipfile`.

> **Where results are written.** The output destination is resolved in three tiers, in
> descending order of preference:
>
> | Situation | "Write results" performs | How to set the destination |
> | --- | --- | --- |
> | Local helper running (`node tools/serve.mjs`) | POSTs to the helper process and writes to an **absolute path on this host** | Type a path and press Enter, or use **Browse…** for the native folder dialog |
> | Browser only | Writes through a File System Access directory handle | Use **Browse…** to select a directory |
> | Neither | **Packages a single ZIP download** and states the reason in the status bar | — |
>
> The status bar always reports where output actually went, and a **Local write** badge is
> shown while the helper is available, so the destination can never appear to be set when
> it is not.

For large results prefer the output-directory route: ZIP building requires the whole
result in memory, and above approximately 1.5 GB the application advises switching to
direct writing rather than letting the browser fail silently. Direct writing is
**streaming** — output is produced and sent file by file, so peak memory is that of a
single file.

---

## 7. Repository layout

```
app/
├── index.html            three-pane interface
├── css/app.css           light theme
├── js/
│   ├── app.js            controller: loading, rendering, interaction, output
│   ├── analyze.js        placement evidence, verdicts, auto-suggestion
│   ├── dataset.js        assembles parsed input into a MAG/contig data model
│   ├── engine.js         CheckM2 recomputation engine (WASM first, pure-JS fallback)
│   ├── localio.js        local helper client: probe, direct write, ZIP staging, open folder
│   ├── parsers.js        parsers for the four input categories
│   ├── packed.js         compact binary asset decoding and WASM loading
│   └── zip.js            dependency-free ZIP writer (deflate-raw with store fallback)
├── wasm-core/src/lib.rs  Rust computation core (GBDT, CNN, grouping, MinMax)
├── assets/               model assets (6.8 MB)
├── samples/demo/         demonstration dataset (synthetic duplication and contamination)
├── dist/                 single-file build output (generated; git-ignored)
└── tools/
    ├── serve.mjs             local helper: static hosting, direct-write API, start-up cleanup
    ├── build_offline.mjs     single-file build (with output self-check)
    ├── check_offline.mjs     offline single-file end-to-end verification (21 assertions)
    ├── check_i18n.mjs        dictionary consistency, missing-translation and attribute-key checks (8)
    ├── test_engine.mjs       engine regression against reference models (24)
    ├── test_pipeline.mjs     headless end-to-end pipeline (32)
    ├── test_zip.mjs          ZIP writer, cross-checked with Python zipfile (19)
    ├── test_local_api.mjs    local helper end-to-end and security boundaries (39)
    ├── browser_check.mjs     real-Chromium interface regression (17 sections, 153)
    ├── export_assets.py      official model files → browser binaries
    ├── validate_engine.py    numerical comparison against LightGBM/Keras
    ├── validate_end2end.py   end-to-end benchmark on real training genomes
    ├── make_demo_data.py     regenerates the demonstration dataset
    └── make_demo_report.mjs  regenerates quality_report.tsv using the engine
```

---

## 8. Demonstration dataset

The counts in `samples/demo/` are **not random**. They are derived from CheckM2's own
training genomes by de-scaling `assets/ref_csr.bin` to recover genuine amino-acid
compositions and KO counts. Because that matrix is no longer distributed with the
application (Section 4.2), regenerating the dataset requires first re-exporting it with
`python tools/export_assets.py`; the existing `samples/demo/` is unaffected.

Three situations are constructed deliberately:

| MAG | Composition | Official report | Expected action | After cleaning |
| --- | --- | --- | --- | --- |
| `MAG_A` | 28 contigs of genome X + **2 contaminating contigs of Z** | 95.15 / 6.56 | remove Z19, Z20 | **92.87 / 0.00** |
| `MAG_B` | genome Y, complete | 99.85 / 0.71 | no action | 99.85 / 0.71 |
| `MAG_C` | 14 contigs of Z + **6 contigs of X (duplicated with MAG_A)** | 71.10 / 6.96 | remove the 6 X contigs | **63.99 / 0.00** |

The Hi-C table is generated to be strong within a genome and weak across genomes, and
each genome is given a distinct abundance profile, so the Z-derived contaminants
linkage strongly toward MAG_C and deviate markedly from MAG_A's profile.

> The fall in `MAG_C` completeness from 71.10 to 63.99 is **correct**. 63.99 is its true
> completeness as a Z-only bin; part of the original 71.10 was inflated by the six
> foreign X contigs.

---

## 9. Security and privacy

- All computation happens in the browser (WebAssembly core with a JavaScript fallback);
  there is no server-side computation.
- The local helper binds `127.0.0.1` only, validates the `Host` header to mitigate DNS
  rebinding, and admits cross-origin requests solely from localhost origins. It is not
  reachable from other machines on the network.
- Even with the helper in use, bytes move between a browser and another process **on the
  same machine** and do not leave the host.
- The interface contains no telemetry, no CDN and no external request. The offline build
  is asserted to make zero HTTP(S) requests.
- Output filenames are sanitised server-side and flattened with `path.basename`, so path
  traversal sequences such as `../` cannot escape the output directory. These boundaries
  are asserted in `tools/test_local_api.mjs`.

---

## 10. Testing

Six suites run without any server (143 assertions total; the offline suite contributes 21
per run because two mutually exclusive output paths are covered):

```bash
node tools/test_engine.mjs       # 24 — model outputs against the reference implementations
node tools/test_pipeline.mjs     # 32 — parsing → annotation → suggestion → cleaning
node tools/test_zip.mjs          # 19 — archive byte stream, unpacked by Python zipfile
node tools/test_local_api.mjs    # 39 — direct writing, Host/origin/traversal boundaries, probe self-heal
node tools/check_i18n.mjs        #  8 — dictionary alignment, translation coverage, attribute keys
node tools/check_offline.mjs     # 21 — single-file full pipeline over file://, zero network
```

An interface regression suite drives a real browser through the complete workflow
(17 sections, 153 assertions):

```bash
python -m http.server 8765 &
node tools/browser_check.mjs
```

`browser_check.mjs` and `check_offline.mjs` require `playwright-core` and a Chrome
installation. Both locate them automatically via the `CHROME_PATH` environment variable,
`~/.agent-browser/browsers/chrome-<version>/chrome.exe`, or the chromium bundled with
`playwright-core`. Screenshots are written to `tools/browser_shots/`. Use `--headful` to
watch the run and `--skip-offline` to omit the single-file section.

**What the assertions actually check.** Section 17 of `browser_check.mjs` exercises the
local helper: it starts a `serve.mjs` on a random port, tears it down afterwards, and
verifies that **Write results** places the five expected files on the disk directory you
specified, comparing their contents and confirming that no download event occurred. It
also asserts that changing the path takes effect immediately, that **Browse…** degrades
gracefully to a typed-path prompt (focusing the input) when a native dialog cannot be
shown, that **Open folder** appears only once output exists, and that the workflow
produces no uncaught exceptions.

The engine comparisons are the foundation of the project: GBDT outputs must match official
LightGBM exactly, and CNN outputs must match Keras to better than 1e-10.

---

## 11. Rebuilding from source

```bash
# 1) Export model assets (requires a local CheckM2 checkout and a Python environment).
#    This step also exports assets/ref_csr.bin (47 MB). That matrix does not take part in
#    running the application; it is used only by make_demo_data.py and validate_end2end.py
#    to regenerate the demonstration data and the end-to-end benchmark. Pass --skip-ref
#    to omit it if you do not intend to regenerate them.
python tools/export_assets.py
python tools/validate_engine.py
python tools/validate_end2end.py

# 2) Build the WebAssembly core
cd wasm-core
RUSTFLAGS="-C target-feature=+simd128" cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/checkm2_core.wasm ../wasm/

# 3) Demonstration data (requires ref_csr.bin from step 1, which is its count source)
cd .. && python tools/make_demo_data.py && node tools/make_demo_report.mjs

# 4) Single-file build
node tools/build_offline.mjs

# 5) Tests — none of the following require a server
node tools/test_engine.mjs
node tools/test_pipeline.mjs
node tools/test_zip.mjs
node tools/test_local_api.mjs
node tools/check_i18n.mjs
node tools/check_offline.mjs

# 6) Interface regression (requires a static server to be running first)
python -m http.server 8765 &
node tools/browser_check.mjs
```

A Rust toolchain is required only for step 2. The compiled
`wasm/checkm2_core.wasm` is committed, so step 2 is necessary only when modifying
`wasm-core/src/lib.rs`.

---

## 12. Known limitations

- **No contig-level CheckM2.** CheckM2 itself reports completeness and contamination only
  at bin level. The figures shown on hover are the predicted quality of **the whole MAG
  after that contig is removed**, which is the only meaningful interpretation available.
- **`diamond_output/` is required.** If CheckM2 was run with `--remove_intermediates`,
  KO counts cannot be reconstructed and the application asks for a re-run.
- **Model selection excludes the cosine criterion.** Upstream, this step compares the
  query against 5,300 training genomes and requires the 47 MB reference matrix, which is
  not shipped here (Section 4.2). With a report the recorded model is reused; without one,
  the two models are averaged and `modelSource` is set to `no-report`.
- **Contig N50 and coding density use CheckM2's own definitions.** Its N50 is a
  length-weighted median, which differs from the common assembly N50; the report generator
  matches the official implementation.
- **Hi-C is truncated to the 20 strongest partners per contig** (`topPartners` in
  `parseHic`) to keep dense matrices from exhausting memory.
- **The single-file build is 11.2 MB.** The demonstration dataset accounts for about
  3.7 MB of this and must be decompressed in the browser, so the first load is slightly
  slower than in the development build.
- **No output-directory handle is available over `file://`.** Opaque origins expose no
  usable directory handle, so **Browse…** states plainly that this route is unavailable
  and recommends **Export ZIP** instead. To write to disk from `file://`, run
  `serve.mjs` separately; the application will discover it automatically.
- **Without the local helper, the console records one failed `/__local__/ping` request.**
  This is the cost of probing whether a helper is running — a web page cannot learn what
  occupies a local port without sending a request. It does not affect functionality.
- **ZIP building requires the entire result in memory.** Above roughly 1.5 GB the
  application advises the output-directory route; direct writing is streaming, so its peak
  memory is that of a single file.
- **The output path can only be typed when the local helper is running.** Browsers
  deliberately do not expose a directory's absolute path, so without the helper only the
  directory name is displayed.

---

## 13. Citation

If you use Metadrop in published work, please cite the CheckM2 paper for the models it
reimplements, and the Metadrop application note for the software itself.

Metadrop reproduces the numerical output of CheckM2; the completeness and contamination
values it reports are the output of the models described in:

> Parks, S. A., Chen, J., Hung, S., & Wu, Z. (2022). CheckM2: assessing the quality of
> predicted gene contents in metagenomes. *Nature Methods*, 19(3), 320–328.
> https://doi.org/10.1038/s41592-021-01340-2

A citation for Metadrop itself will be added here on publication.
