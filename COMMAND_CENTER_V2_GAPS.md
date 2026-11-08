# Command center v2: gap analysis

Working list, addressed one item at a time. Started 2026-11-08 from a review of the side-by-side scene against v1.

- Layout: **side-by-side only** (owner, 2026-11-08). The flat, nested and split pages are not run or reviewed.
- Dev server: `docker start ie-devtools-v2scene` → http://127.0.0.1:7710/static/prototypes/D5v2/side/index.html
  (devtools and `src` from this worktree; run folders from the main checkout). Runner: `make runner` in main (:7701).
- v2 store: `/mnt/ie-data/cc-v2-proto/store_v2` (9 hand-imported I02A runs).
- Method: freeze one decision, demo its options, then the next. Status per item: open / in progress / frozen / done.

## Order of decisions

| # | Decision | Status |
| --- | --- | --- |
| 0 | Owner's item to address before the layout (to come) | open |
| D1 | Layout skeleton (section 5) | open |
| D2 | Every run written to the v2 store automatically (changes the run pipeline) | open |
| D3 | NVML hardware collector for streaming samples | in progress (V3 step 5: NVML GPM sampler at 100 ms) |
| D4 | Levels 1–3 rebuilt in three.js; v1 views move into inspector tabs | open |

## 1. Timeline and data

| # | Gap | Evidence | Status |
| --- | --- | --- | --- |
| T1 | Two data stores. Levels 1–3 are v1 views in the scene reading v1 data (live feed, `run.json` via `/api/runs`); levels 4–7 read the v2 Parquet store. The v1 Trace panel has its own run picker, step and play controls; the Components panel follows the global cursor only through `PanelLevel.cursor()`. | `base/levels.js`, `base/model.js` `build()` | open |
| T2 | Events loaded as separate sets: stamps up front (`D.trace`), kernels and NVTX per iteration (`iterDetail`), samples separately. Step size is two fixed tiers (stamps or kernels), picked by camera depth. Target: one ordered event list, each event with its level; stepping at level L jumps to the next event at level ≤ L. | `base/app.js` `go()`, `deepest()` | open |
| T3 | Timeline has no zoom; it always shows the whole request window. | `base/app.js` `timeline()` | open |
| T4 | New runs never reach v2: the store is filled by hand with a prototype importer that has hard-coded paths (`DEVQUERY` points into the fundamentals repo) and imports from `prototypes/D1`, `prototypes/D2`. No I02C run is in the store. | `prototypes/D5v2/store/import_v2.py` | open |
| T5 | One request only: `client/request/measured` is required and `-measured` is filtered everywhere. I02C (two overlapping requests) cannot be shown; I04 batching will need many. | `base/model.js` `load()`, `atCursor()` | open |
| T6 | No live mode in the scene; replay only. Live data is only inside the v1 panels. | `base/app.js` | open |
| T7 | Bug: a click on the timeline, or a pick of a scene item (`app.js` pointerup), sets a fractional cursor (`t=84185084530118.5` ns); `/api/v2/.../state` and `/samples` parse it with `int()` and return HTTP 500, so the Summary panel stops updating (page error in `atCursor`). Found by `ccv` 2026-11-08. | `base/app.js` `setT`; `backend/store_v2.py` `_ints`; evidence `/mnt/ie-data/cc-v2-verify/evidence/timeline-proof/console.jsonl` | open |
| T8 | No keyboard stepping: ArrowLeft/ArrowRight do nothing; stepping needs the ◀ and ▶| buttons. | `ccv key ArrowRight` | open |

## 2. Hardware monitoring

| # | Gap | Evidence | Status |
| --- | --- | --- | --- |
| H1 | No persistent hardware view; live GPU only in the v1 Infrastructure panel and flyout tabs. | screenshots | open |
| H2 | Every live source samples at 1 Hz: `nvidia-smi -lms 1000`, `dmon -d 1`, DCGM `-c 1000`. Transport is already push (SSE); the delay is the sample rate. | `backend/collectors/gpu.py`, `deploy/devtools.yaml` | open |
| H3 | DCGM on this GeForce card exposes 8 device fields only (no SM-active, tensor-active or DRAM-active profiling counters). Checked 2026-11-08 on :7794. Narrower than first stated: NVML GPM on the same card reads SM utilization, SM occupancy, tensor utilization and DRAM bandwidth about every 100 ms with no profiler (measured 2026-11-08). | `monitoring/dcgm.csv`; GPM test scripts | in progress (V3 step 5) |
| H4 | Chosen (owner, 2026-11-08): live = NVML GPM at 100 ms (faster reads mostly return zeros: 195 of 244 at 20 ms) plus the other NVML counters at their measured refresh interval (probe in V3 step 5); replay = the 10 kHz nsys GPU metrics traced runs already store. nsys is not used live (2 s windows arrive ~3 s late with gaps). | `COMMAND_CENTER_V3_DESIGN.md` step 5 | in progress |
| H5 | Engine iteration stats arrive in ~2 s batches (TensorRT-LLM drains on read); label this in the view. | `backend/collectors/engine.py` | open |

## 3. Presentation

| # | Gap | Evidence | Status |
| --- | --- | --- | --- |
| P1 | Zoomed out, the side layout is a dot: columns are 11,500 units apart, so there is no overall picture. | `layouts.js` `side.place`; `side-out.png` | open |
| P2 | Levels 1–3 are v1 web pages placed in 3D (CSS3D): tiny text, duplicate controls inside each panel, no data movement. | `side-L2.png` | open |
| P3 | Levels 4–5 are Gantt bars drawn in 3D; no bytes, tokens or tensors moving between components. | `side-L4.png` | open |
| P4 | Level 5 groups kernels poorly (one large "Kernel2" block); group by layer (v1 has the layer index). PyTorch ops Unavailable at the timeline trace level. | `split-L5.png` | open |
| P5 | Level 6 shows "replay 2.176 ns" for a kernel: likely a unit bug (not verified). | `model.js` L6, `gpu__time_duration.sum` | open |
| P6 | Level 7 lit "0 of 36 SMs" during decode; board and GPU labels overlap; flows only for the one Nsight Compute-replayed iteration. | `model.js` `hardware()`, `app.js` `light()` | open |
| P7 | The inspector is mostly a ~40-row lane dump ("poll (active)"). Missing: selected item's raw record, parents and links, metric formulas with inputs lit, evidence labels (v1 Trace had these). | `app.js` `summary()` | open |
| P8 | Missing from the scene: rep results (TTFT, ITL, segment table from the v1 Run tab), the workload (requests, request settings, model, engine config), and "run finished → open it here". | v1 `run.js`, `requests.js` | open |

## 4. Code quality (SOLID)

| # | Gap | Evidence | Status |
| --- | --- | --- | --- |
| C1 | Production code lives in `prototypes/`: hard-coded `DEFAULT_RUN`, `window.*` globals (`SC`, `LEVELS`, `FLY_OUT`, `PLAY`), benchmark hooks mixed into `app.js`. | `base/app.js` | open |
| C2 | `model.build()` builds all 7 levels and mixes data queries with drawing coordinates. Target: one module per level behind one interface; one timeline service that levels, inspector and hardware sidebar subscribe to. | `base/model.js` | open |
| C3 | v1 views are changed from outside (`view.runId = …`, `built = null`, `cursor = -1`): tight coupling. | `base/levels.js` `loadRun()` | open |
| C4 | Very long one-line functions; hard to read and change. | `base/*.js` | open |

## 5. Proposed layout (D1, not frozen)

```
┌ header: run picker · live/replay · rep launcher ───────────────┬──────────┐
│                                                                │ HARDWARE │
│   3D side-by-side scene: native three.js levels,               │ GPU/CPU/ │
│   packets animated along edges by the cursor                   │ PCIe/mem │
│                                                                │ live or  │
│                                                                │ at cursor│
├ timeline: zoomable; step at the current level ─────────────────┴──────────┤
│ INSPECTOR flyout: selected item · raw record · formula · parents/links    │
└───────────────────────────────────────────────────────────────────────────┘
```

## Log

- 2026-11-08: review done; devtools started; doc created. Waiting on the owner's item 0 before D1.
- 2026-11-08: `ccv` verification CLI and `verify-command-center` skill added; it found T7 (timeline scrub → HTTP 500) and T8 (no keyboard stepping).
- 2026-11-08: option B designed (`COMMAND_CENTER_V3_DESIGN.md`). Owner: the command center is for learning and intuition across granularities; nsys and ncu are first-class links for targeted inspection; ncu link-only, nsys event rows stay imported; live GPU load from NVML GPM.
