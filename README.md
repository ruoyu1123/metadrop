<div align="center">

# Metadrop

**Decontaminate MAGs and recompute their quality — entirely in your local browser.**

[中文](README_zh.md) · Interface language: 中文 / English

</div>

---

## Description

Metadrop imports MAGs together with their CheckM2 output and, without re-running
CheckM2, recomputes completeness / contamination in the browser with bit-for-bit
fidelity to the official implementation. It then uses Hi-C linkage and abundance
profiles — evidence that is independent of the model — to identify the contigs that
should be removed, with a live preview of the recomputed quality after each removal.

All computation happens in your browser. No backend, no upload, no telemetry.

## Getting Started

### Prerequisites

- Any modern browser
- Python 3 (only to serve the files — nothing is executed server-side)

### Installing

```bash
git clone https://github.com/ruoyu1123/metadrop.git
cd metadrop
```

That's it — no `npm install`, no build step. Model weights (6.8 MB) and the demo
dataset are already in the repository.

### Deployment

To run it on your own server, or just locally, any static file server works.
With Python:

```bash
python -m http.server 8000
# then open http://localhost:8000/
```

Click **Load demo data** to see it working immediately:

![Metadrop main interface](docs/screenshots/01-overview.png)

Three MAGs are loaded; the contaminating contig `Z19` is flagged, with its evidence
shown in the right panel. Results are exported with **Export ZIP** — the archive is
packaged inside your browser and downloaded locally; nothing is sent to the server.

A single-file build (11.2 MB, double-click to run, works offline) is also available:

```bash
node tools/build_offline.mjs        # → dist/metadrop-offline.html
```

## Usage

**Try it online:** a public instance is already deployed at
<https://metadrop.panlab2020.cn> — ready to use, no installation needed.

- **Hover any contig** to preview the completeness / contamination the whole MAG
  *would have after that contig is removed* — computed on the fly. Removing a known
  contaminant can *lower* the score (see below); this preview makes that visible
  before you commit.
- **Click** to remove or restore a contig; all readouts update immediately.
- **Auto-suggest** flags every suspicious contig (duplicated + contaminating) and
  proposes a cleaned state in one click.

Keyboard shortcuts: `S` auto-suggest · `R` restore · `E` write results ·
`Z` export ZIP · `L` 中文 / English.

### Input data

Click **Open folder**, or drag a folder in. Files are recognised by name; nothing
to configure:

```
checkm2_out/          CheckM2 output (required)
├── quality_report.tsv
├── protein_files/*.faa
└── diamond_output/DIAMOND_RESULTS.tsv
mags/*.fa             your bin sequences (required)
hic/*.tsv             Hi-C contact table (strongly recommended)
abundance.tsv         abundance table (strongly recommended)
```

Hi-C and abundance tables are optional, but without them the evidence for removal
decisions is much weaker. **The sequence files are the sole authority on the contig
set** — protein and DIAMOND results only add gene-level information and never
invent contigs.

## How it works

CheckM2 tells you a bin's quality, but not **which contig to remove** — and the
obvious signal is the wrong one: deleting a contaminating contig often *lowers*
completeness, because the single-copy genes it carries were credited to the host.
In the demo data, removing one confirmed contaminant drops completeness by
**1.58 percentage points**.

Metadrop therefore keeps two concerns separate:

| | Approach |
| --- | --- |
| **Recompute quality** | CheckM2's models (GBDT + CNN) ported to WebAssembly, numerically identical to the official implementation |
| **Decide what to remove** | Only model-independent evidence: Hi-C linkage consistency, abundance-profile similarity, and objective duplication across bins |

## Performance

Measured locally (demo dataset: 3 MAGs, 68 contigs, 3,770 KO hits):

| Metric | Value |
| --- | --- |
| One removal-and-recompute (completeness / contamination) | **7.7 ms** |
| Precompute "after removal" for all 200 contigs | 1.5 s (7.4 ms each) |
| Single GBDT prediction (contamination) | WASM **0.11 ms** / JS 0.04 ms |
| Single CNN prediction | WASM **9.8 ms** / JS 78.5 ms |
| Engine load (models ready) | 329 ms |
| Demo data load to interactive | 927 ms |

**Agreement with the official implementation:** GBDT **0** (element-wise) ·
CNN **< 1e-10** · end-to-end on real training genomes **0**. Not "approximately" —
bit-for-bit identical, enforced by tests.

## FAQ

**Is any data uploaded?**
No. All computation runs in the browser. Results are packaged into a ZIP inside
your browser and downloaded locally; nothing is sent to the server.

**Why does completeness drop when I remove a contaminant?**
The single-copy genes it carries were counted toward the host's completeness.
This is exactly why Δcompleteness must **not** be used to detect contamination —
Metadrop uses Hi-C and abundance instead, which are model-independent.

**I ran CheckM2 with `--remove_intermediates`. Does that work?**
No. That deletes `diamond_output/`, so KO counts cannot be rebuilt. Re-run CheckM2
keeping the intermediates.

**Is model selection identical to CheckM2's?**
Yes when `quality_report.tsv` is present (the model recorded there is reused).
Without a report, the official 47 MB cosine-similarity step cannot be computed;
the engine averages the two models and marks `modelSource = no-report` rather
than pretending to be official behaviour.

## Running the tests

```bash
node tools/test_engine.mjs       # 24 — numerical agreement with official models
node tools/test_pipeline.mjs     # 32 — parsing → annotation → suggestion → cleaning
node tools/test_zip.mjs          # 19 — ZIP byte stream (cross-checked with Python zipfile)
node tools/test_local_api.mjs    # 39 — direct disk write + security boundaries
node tools/check_i18n.mjs        #  8 — zh/en dictionary consistency
node tools/check_offline.mjs     # 21 — single-file full pipeline
```

Six suites, 143 assertions in total, all server-less. A separate browser regression
suite drives a real Chromium through the complete workflow (148 assertions, needs
`playwright-core`).

The WebAssembly core only needs recompiling if you change `wasm-core/src/lib.rs`:

```bash
cd wasm-core
RUSTFLAGS="-C target-feature=+simd128" cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/checkm2_core.wasm ../wasm/
```

## Support

If you run into a problem or the input contract doesn't match your CheckM2 output,
please open an issue.

## Citation

> Citation information will be added here after publication.
