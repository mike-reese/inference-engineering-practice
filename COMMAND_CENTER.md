# Command center: design and migration plan

Status: the one design doc for the devtools command center, 2026-11-08. It replaces `COMMAND_CENTER_DIMENSIONS.md`,
`COMMAND_CENTER_V3_DESIGN.md` and `COMMAND_CENTER_V2_GAPS.md` (deleted; their history is in git at `d639306`).
Change the design here first, then the code. Decisions go in the log at the end with the date and who made them.

The interface is frozen (owner, 2026-11-08). Its reference build is the prototype at
`devtools/frontend/prototypes/D13/` (served at `http://127.0.0.1:7710/static/prototypes/D13/index.html`), which runs on
made-up data. Production is `devtools/frontend/cc/` at `/static/cc/index.html` on the v3 store. Section 7 is the plan
that moves the first onto the second.

Sections 9 and 10 are generated from `design/dimensions/`. Rerun:

```
python3 design/dimensions/map_surfaces.py --write          # section 9; exits 1 if a surface is unmapped
uv run --no-project --with duckdb python design/dimensions/stop_counts.py --write   # section 10; exits 1 on a jump
```

## 1. Goal and role

An intuitive, working interface for a conceptual understanding of the inference stack (owner, 2026-11-08): what
runs, what calls what, how a serving engine behaves under different circumstances, and how the hardware is used while
it happens. Not every line of code. It grows with the reps still in the workbook.

It is for learning, validating and building intuition for each rep. It gives what Nsight Systems and Nsight Compute
cannot: one view that links request, kernel and hardware, live and in replay. nsys and ncu stay the tools for
targeted inspection and are first-class links, not things to rebuild:

- **nsys.** Kernel, memcpy, memset, CUDA API and NVTX rows are imported (kernel stepping needs them). Every imported
  row and iteration carries "open in Nsight Systems" at its report and time range.
- **ncu.** Link only, plus headline counters (duration, achieved occupancy, DRAM and L2 bytes, SM and memory
  throughput as % of peak). Sections, rule findings and source stay in ncu-ui. Links go through the host runner
  (`/runner/open`, commit 91c28c2).
- **Live GPU load** comes from NVML GPM, not a profiler (section 6.5).

One run can be seen three ways, each with its own zoom from coarse to fine:

- **Execution.** What is running: a request, an iteration, a phase, a layer, a module, a kernel.
- **Hardware.** Where it physically happens, from overall utilization to data moving inside the GPU.
- **Architecture.** Which software owns it: containers, processes, components, and the toolkit layer calling the
  runtime layer.

The store already holds both "where" trees, as one `things` tree per run (measured): hardware things (CPU, RAM,
chipset, PCIe and DMI links, GPU, 36 SMs, L2, 4 memory controllers, VRAM, 2 copy engines, NVMe) and architecture
things (containers, processes, threads, streams, 26 component boxes). Each row points at a lane and a component box.
The design separates what exists. It does not invent new trees.

## 2. The interface

### 2.1 Screen

| region | holds |
| --- | --- |
| header, row 1 (34 px) | world tabs (Rep, Stacked world, Execution spine, Architecture); the session block (rep, run, mode badge, Load, Launch, Compare; follow live in live; A / B in compare); position readout; `?` keys |
| header, row 2 | focus title and what the tier shows; Paired / Independent; the three tier ladders, compact; what is true now in each dimension |
| stage | the open world |
| right sidebar | hardware at the cursor, a sparkline over the window per metric, each with its source and period |
| bottom bar (or right, `D`) | back / forward; tabs Selected, At cursor, Metrics, Tokens, Kernels, Run; play, pace, rate; run overview strip and detail strip |

Header style and sizing follow D10: thin tabs and compact ladders, nothing stretched.

### 2.2 Worlds

| world | what it draws |
| --- | --- |
| Rep (opens first) | the session's front page: what the rep teaches, key moments with "show me", lessons, results on three clocks, TTFT segments, README results, pass checks and task |
| Stacked world | 3D: the board as floor, architecture standing on its hardware, execution as a moving pulse; a floating, collapsible architecture lens |
| Execution spine | 2D bands, one per execution tier, with sample and copy strips; a lens window on top (55% of the height, draggable) with Architecture, Hardware and Split (side by side, draggable divider) |
| Architecture | the v1 drawing full screen over a thin execution strip |

Selection, cursor and tiers carry over when the world changes.

### 2.3 Rules

- **Tiers.** Each dimension has its own tier. Default **Independent**: a tier change moves only that dimension.
  Paired (toggle or `P`) moves the other two to the aligned tier (section 3.4). The header ladder is the only tier
  control; lenses show the tier, they do not set it.
- **Clicks first.** Tiers, things, units, stops and metrics are all clickable. Keys are shortcuts (`?` lists them).
- **Architecture drawing.** v1's exact Infrastructure and Components styling, with sparklines and utilization bars,
  and all 26 component boxes. Rebuilt natively; no v1 module is imported, nothing merged or restyled.
- **Colour = logical flow.** Request in `#5aa9ff`, prefill `#ff7b72`, decode loop `#3fd0a0`, stream out `#f778ba`.
  Flows overlap in time (stream out runs beside the next decode pass). A box shows a stripe per flow it serves.
  Dimension colours: execution `#7cc4ff`, hardware `#f5a623`, architecture `#b58cff`.
- **Playback.** Plays every event of every tier inside the bounds and loops. The bounds are the execution unit at the
  cursor at the execution tier (between units, the nearest coarser unit holding the cursor). The tier limits
  playback; it never filters events. One animation frame moves the cursor and redraws every view. Time pace by
  default (the bounds play in 8 s at x1); events pace on request.
- **Zoom.** Each spine pane (architecture, hardware, execution bands) zooms and pans on its own: wheel to zoom
  (0.5x to 16x), drag to pan, double-click to reset. Each pane keeps its zoom across reloads.
- **History.** Back / forward in the bottom bar walk selections. Each step restores the selection, cursor and tab.
- **State in the URL.** Session, world, tiers, cursor, selection and dock live in the hash, written at most every
  150 ms, so a reload or a link keeps the view. A live session reloads as a replay.

### 2.4 Keys

| key | does |
| --- | --- |
| ← → | previous / next stop of the focused tier |
| Shift ← → | stop one tier coarser |
| ↑ ↓ | fly one tier coarser / finer |
| E H A | focus execution / hardware / architecture |
| 1-6 | tier n of the focused dimension |
| P | paired / independent tiers |
| W | next world |
| D | dock bottom / right |
| Space | play every event in the bounds, looping |
| T | pace: events / time |
| Alt ← → | back / forward through selections (conflict, open choice 4) |

One `keydown` listener owns the keymap, and the keymap table renders the help.

### 2.5 The shell: load, launch, compare

The command center is a shell around one behavior: open a session on a rep, then look at it through the worlds. The
worlds never pick a run; they draw the session's run.

| mode | how it opens | what the worlds show | ends |
| --- | --- | --- | --- |
| replay | Load: pick a rep, then one of its recorded runs | the whole run; cursor and playback anywhere | when another session opens |
| live | Launch: pick a registered rep's action and options | the run up to the head; past the head is masked "not recorded yet"; follow keeps the cursor at the head | at the run end it becomes a replay of that run |
| compare | Compare: pick run A and run B (same rep or another) | Rep world: A, B, B − A and % side by side; other worlds: one run at a time, A / B switch | when another session opens |

Load, Launch and Compare open one panel with three tabs and the reps on the left. Load groups a rep's runs by kind
(measured, trace: X) with a result marker. Launch lists the rep's `rep.toml` actions with their options; an option
that fails its pattern is refused. A rep without `rep.toml` is replay only. Load and Compare open on the Rep world;
Launch opens on the spine. A run without results says "results not computed"; it never shows a made-up value.

### 2.6 Key moments (`moments.toml`, one per rep)

Every rep has a `moments.toml` beside its README (owner). Each moment names where a lesson can be seen in a run:

| field | meaning |
| --- | --- |
| `id`, `title` | short key and a one-line claim |
| `lesson` | the Why It Matters bullet it proves (bold lead, verbatim) |
| `at` | the moment's time: a result path, e.g. `wire.headers_ms` |
| `event` | what happens there, in the spine's vocabulary (phase or kernel name) |
| `note` | why it matters, two sentences at most |
| `evidence` | result paths shown beside it, each with a label |

Paths read the run's result, so one file serves every run of the rep. A segment is picked by the start of its name
(`segments[first_scheduled_time].ms`), never by index: older I02A runs have 8 TTFT segments, newer runs 7 (measured).
`[[setup_lessons]]` holds lessons about the setup with no moment in a run. "Show me" moves the cursor to the
moment's event and opens the spine. Example: `reps/I02A-L1_streamed_latency/moments.toml`.

## 3. Dimensions, tiers and the fly model

Status words: **measured** (a tool recorded it), **inferred** (derived by a stated rule), **missing** (no source
today). Counts per iteration come from section 10.

### 3.1 Execution

| tier | what you see | source | resolution | status |
| --- | --- | --- | --- | --- |
| request | one request, send to last byte | client stamps, engine `/perf_metrics` | per request | measured |
| iteration | one scheduler step: which requests run, prefill or decode | scheduler stamps (derived span) | 3.4 ms median | measured |
| phase | executor phases (`_fetch_new_requests`, `_schedule`, `_sample_async`, `_handle_responses`), request hops | NVTX top-level ranges, component stamps | 13 to 26 per iteration | measured |
| layer | one decoder layer | `layer` column (RMSNorm rule in `trace/adapters/nsys.py`) | 25 per iteration (24 layers + final norm) | inferred |
| module | attention, MLP, linear, norm, with their ops | module `forward()` frames (code run) | 269 per iteration | measured in the code run only; missing elsewhere |
| kernel | one kernel, copy or memset, with the CPU call that launched it | nsys or PyTorch profiler | 2.3 µs median kernel | measured |

- Everything finer than a module is **detail**: built-ins, nn plumbing, nested aten ops, CUDA queries, syncs, OS
  calls and profiler rows. They stay in the store and open in the inspector. They are never stops.
- A launch call and its kernel are one stop, seen from the CPU and the GPU. The code run's 18,309 launch calls match
  its 18,309 device rows by correlation id (measured).
- Module is the gap. Graphs-on runs replay a captured graph, so they have no module frames. A module there must be
  inferred by matching the kernel sequence learned from the code run (rule not yet written).

### 3.2 Hardware

| tier | what you see | source | resolution | status |
| --- | --- | --- | --- | --- |
| system | utilization of every GPU and host: GPU %, VRAM, CPU %, RAM | `nvidia-smi` query; NVML GPM (live); Docker stats per container (live) | 100 ms; 100 ms; about 1 s | GPU measured; CPU and RAM live only, not stored |
| node | the board: CPU, RAM, chipset, PCIe and DMI links, GPU, NVMe, NIC | inventory probe (`registry/inventory.json`) | static | measured |
| device | bytes moving between devices: PCIe copies, network frames, NVMe reads | memcpy rows with bytes; nsys PCIe RX/TX %; tcpdump | per copy; 100 µs; per frame | PCIe and network measured; NVMe and RAM bandwidth missing |
| unit | parts inside a device: SMs active, tensor, warps in flight, DRAM read/write, copy engines; CPU cores, L3 | nsys GPU metrics | 100 µs | GPU measured; CPU cores and L3 missing |
| kernel traffic | one kernel's DRAM and L2 bytes, occupancy, throughput, grid over 36 SMs | ncu | per kernel, profiled iterations only | measured for 235 kernels of iteration 67; tie to the run inferred |
| SM internals | warps, shared memory, registers, source lines | ncu sections | per kernel | link only (open in Nsight Compute) |

- CPU-side counters are required (owner, 2026-11-08): CPU cores, L3 and RAM bandwidth, stored, not live only. The
  i9-9900K exposes uncore counters to `perf` (not yet tried). NVMe I/O is needed by I33. Work item M8.
- Board (probed 2026-11-08): MSI MPG Z390M GAMING EDGE AC; i9-9900K, 8 cores / 16 threads, L3 16 MiB; 62 GiB RAM;
  RTX 5060 Ti, 16 GiB, 36 SMs; PCIe max gen 3, gen 2 x8 at idle (the link trains down at idle); WD_BLACK SN7100.
- One metric sample (100 µs) covers dozens of 2.3 µs kernels. Hardware state follows an iteration (about 34 samples)
  or a long module. Per-kernel hardware data exists only where ncu profiled.
- Decode barely uses PCIe: 5,196 copies in the timeline run, none above 2,304 bytes, 7.0 MB total (measured). The
  large flow is VRAM to SMs (weights read every step), seen only as DRAM bandwidth.

### 3.3 Architecture

| tier | what you see | source | resolution | status |
| --- | --- | --- | --- | --- |
| fleet | cluster, control plane, nodes | Kubernetes API (from I27) | per object event | missing until I27 |
| node | one host (a Kubernetes node later) | inventory probe | static | measured |
| container | client, server, network sidecar; lifecycle | Docker events (`container event` kind) | per event | measured |
| process | `trtllm-serve` HTTP process, executor worker (MPI-spawned), `orted`, client | nsys pids, things tree | per process | measured in nsys runs |
| component | the 26 boxes in `registry/components.json` (ASGI, LLM API, ZMQ, scheduler, forward, sampler, ...) | component stamps | per stamp | measured in stamped runs |
| software layer | toolkit (Python, PyTorch ops) → runtime (CUDA runtime, driver) → device code (kernels) | row kind | per row | measured |

The worker's boxes (fetch, scheduler, forward, sampler, update, responses) are the execution phases. Components are
where execution and architecture join. A run's own service containers (Grafana, Prometheus, DCGM, node exporter)
belong in that run's world, as architecture / container.

### 3.4 Position, now, crossing and stepping

**Position.** A dimension and one of its tiers, plus one shared cursor (a time and, when something is selected, a
row). Flying changes the position. It never moves the cursor.

**Now.** Execution: the unit of the focused tier that contains the cursor. Hardware: the state of the focused tier's
parts over the sample window holding the cursor (100 µs replay, 100 ms live), plus transfers in flight; at kernel
traffic, the profiled kernel at the cursor. Architecture: the boxes holding work at the cursor, and the last hand-off
the request made at that tier.

**Moving between tiers.** Finer or coarser inside the focused dimension. The cursor stays. The window becomes the new
tier's natural window around the cursor.

**Crossing dimensions.** The cursor stays. In Paired, the target tier comes from the alignment table:

| execution | hardware | architecture |
| --- | --- | --- |
| request | system | container |
| iteration | device | process |
| phase | device | component |
| layer, module | unit | component |
| kernel | unit or kernel traffic | software layer |

**Stepping.** A step moves to the next stop of the focused position. Execution stops are its units. Hardware stops
are the events that move data at that tier: transfers at device, kernels at unit, profiled kernels at kernel
traffic; system and node step on the aligned execution tier. Architecture stops are hand-offs: the request moving to
another container, process or box. Samples are state, never stops. No stop budget: only real units are stops, and
the jump check (section 10) guards against a detail kind landing on a stop tier.

**Walking every row (owner).** Below the stop tiers, two modes: every row of the focused tier in time order across
every process, or only the rows of the selected process or object (about 64 detail rows per `linear` call).

**Process identity and branches (owner).** Every row maps to its process (a row's lane is a thread or stream under
its process in the things tree, measured). A process or thread that creates another shows the branch at the step
where it happens. Thread creation is recorded (42 `pthread_create` calls in the timeline run, measured). Process
creation (the MPI-spawned worker) is missing: it happens before the profiler's capture range. Candidate sources are
the nsys process table and the container log.

## 4. Fit test: future reps

A rep fits when it only adds registry entries.

| rep | adds | verdict |
| --- | --- | --- |
| I06, three engines and a hand-written kernel | containers `vllm`, `sglang`; process `double_kernel`; a component map per engine | structure change: `components.json` holds one map; it needs one per engine, keyed by the run's engine |
| I27, Kubernetes | kind `k8s event` (architecture / container stop); things cluster, control plane component, k8s node, pod | fits; apply-to-ready becomes the stops of architecture / container |
| I30, TP 8 on 8 GPUs | kind `nccl collective` (execution module, hardware device NVLink, architecture runtime); 8 GPUs, NVLink, 8 ranks | fits as entries; kernel stops grow about 8x, so stepping needs a rule: one GPU, or all ranks in time order |
| I33, Mooncake KV with NVMe spill | kind `kv transfer` naming source and destination things; container `mooncake_master`; component transfer engine | fits if the row names its things; needs NVMe and RAM bandwidth (M8) |

## 5. Walkthroughs (acceptance tests for the production build)

- **I02A, which client time is the first token?** Execution / phase: step the request's hops (headers sent by ASGI,
  role event, first token event). Cross to architecture / component: the ASGI box lights while the worker's forward
  box is still busy. Cross to hardware / device: the GPU is running prefill when the headers leave. One cursor, three
  answers. The Rep world's moments 1 to 4 jump to these points.
- **I03, is decode memory-bound?** Execution / iteration: a decode iteration. Hardware / unit: DRAM read % against
  SMs active over its 34 samples. Kernel traffic for iteration 67: DRAM bytes per kernel against FLOPs (the roofline
  point). Stated limit: per kernel only where ncu profiled.
- **I06, why do decode's projections leave SMs idle?** Execution / module: a `linear` forward (code run). Finer to
  its GEMM kernel. Hardware / kernel traffic: grid size against 36 SMs, waves, achieved occupancy. Architecture /
  software layer: TRT-LLM linear (toolkit) through `cudaLaunchKernel` (runtime) to the cuBLAS kernel (device code).

## 6. Data layer (built: ie-run/3 and `/api/v3`)

This is the contract the backend (`devtools/backend/store/`) and `cc/store/` implement. It stays as is; section 7
adds what the interface needs on top.

### 6.1 One row table, one total order

- Every source becomes rows of one event table: run.json spans, nsys, component and client stamps, pcap frames,
  engine stats, docker events. Samples are a separate table of clocked values, never stepped.
- Total order is `(start, id)`. `id` is dense `0..N-1`; in a final generation it follows `(start_ns, source order)`.
- Times are Float64 ns from the run's `t0_ns`. `seek` rounds the cursor once, so a fractional ns never exists.
- Hot columns (the browser holds these, 54 B per row):

| column | type | meaning |
| --- | --- | --- |
| `id` | `<u4` | dense row id |
| `start`, `end` | `<f8` | ns from `t0_ns`; `end == start` for an instant |
| `lane` | `<u2` | thing index of the thread, GPU stream, client or wire lane |
| `comp` | `<u2` | thing index of the component box, `0xFFFF` = none |
| `kind` | `\|u1` | kind code (`manifest.kinds`) |
| `tier` | `\|u1` | storage rank 0..6 (6.2) |
| `depth` | `<u2` | sub-row inside the lane; a lane past 65,535 stops the import |
| `req` | `<u2` | request index, `0xFFFF` = none |
| `iter` | `<i4` | engine iteration, `-1` = none; a device op takes its launching call's iteration |
| `parent` | `<i4` | parent row id, `-1` = none |
| `cause` | `<i4` | cross-lane origin: CUDA launch call for a device op, ZMQ send for a receive; `-1` = none |
| `name` | `<u4` | string index (`manifest.names`) |
| `bytes` | `<f8` | bytes moved, NaN if none |

- Cold columns stay in Parquet; the server answers them by id: `eid` (the stable URL key), `what`, `args`,
  `evidence`, `term`, `source`, `corr`, `quirk`, `parent_rule`, `raw_file`, `raw_ptr`, `code_origin`, `code_where`,
  `layer` (inferred by the RMSNorm rule of `trace/adapters/nsys.py` `layer_of`).
- `backend/store/schema.py` is the one column list; `frontend/cc/store/columns.js` mirrors it; `make store-check`
  fails when they differ.

### 6.2 Storage tiers (today) and the execution ladder (target)

The store ranks rows on a 7-tier ladder in `devtools/registry/kinds.json`: request, iteration, stage, op, call,
device, os. Its rungs mix the three dimensions. Tier 4 (call) holds 1,120,878 of 1,140,076 rows in the code run
(measured), so stepping on it walks about 17,500 rows per iteration. The interface steps on the per-dimension tiers
of section 3 instead. The storage tier stays as a column until nothing reads it (M10). Kind-by-kind placement is in
`design/dimensions/proposal.json` and section 9.

- `derive_tier`: the kind's tier; one finer when nested in the same kind (NVTX only). `tier(child) >= tier(parent)`
  must hold, or the import stops and names the row.
- The derived iteration (scheduler stamp to the next) has kind `iteration`. The executor's NVTX forward step covers
  only 0.92 ms of a 3.48 ms period (measured), so it is imported as an `nvtx range`. A run with no scheduler stamps
  has no derived iteration rows.

### 6.3 Storage: ie-run/3, one folder per run

Root `$CC_STORE` (default `/mnt/ie-data/cc/store`), layout `runs/<run>/`:

```
manifest.json                 schema "ie-run/3", run, generation, status (live|final), t0_ns, head_ns, tiers, kinds,
                              link_kinds, things (with pre/post), names, requests, metrics catalog, block list,
                              aux, source, tools, inputs_sig, import stats. Written by temp file + rename.
g<gen>/events-<block>.parquet hot + cold columns, sorted (start, id), zstd
g<gen>/links.parquet          every link (from, to, kind, weight, rule, evidence)
g<gen>/samples-<group>.parquet one group per source track and shared clock (ts_ns, one column per metric)
g<gen>/profiles.parquet       Nsight Compute headline counters per kernel, in the registry unit
g<gen>/aux.json               calculated metrics with their inputs (row ids, sample indexes), facts, measures
g<gen>/<block>.ccvb           binary twin of each hot block (typed arrays in the browser)
capture/<source>.jsonl        live-only sources: gpu (NVML), docker, docker-stats, engine, engine_iterations_raw
capture/clock.json            the run's t0_ns and wall offset, fixed when the live run opens
```

- `kinds`: `[{code, name, tier, nest_bump, derived, color, label, home}]`; `link_kinds`: `[{code, name, cause, label}]`.
- `metrics`, the catalog of the run's samples: `[{code, metric, label, unit, thing, group, sidebar, source,
  period_ms, period_ns_measured, evidence}]`.
- `blocks`: `[{name, table, band, rows, t, tier_counts, bytes, etag}]`. Bands: `spine` (tiers 0..2, resident) and
  `fine` (tiers 3..6, blocks of 32,768 rows). Every browser query merges across blocks.
- `tools`: `{nsys: {run, path, session_start_ns, evidence}, ncu: {run, path, kernels, counters}}`.
- CCVB: `"CCVB"`, u32 header length, header JSON `{schema:"ccvb/1", table, block, band, gen, rows, base_rows, t,
  tier_counts, dict_delta, metrics, columns:[{name,type,offset,length}]}`, then 8-byte-aligned column buffers.
- The previous generation stays until the next import; older ones are deleted.
- ncu prints display units (us, Mbyte); the import scales headline counters to the `registry/ncu.json` unit with its
  `scale` table and records the factor as `unit_rule`.

### 6.4 Retrieval

Server `backend/store/serve.py`:

- `GET /api/v3/runs`: `{runs: [{run, generation, status, t0_ns, head_ns, rows, tier_counts, bytes}]}`, newest first
- `GET /api/v3/runs/{run}/manifest` (ETag, no-cache, 304)
- `GET /api/v3/runs/{run}/blocks/{gen}/{name}` (a CCVB block or `aux.json`; immutable, ETag)
- `GET /api/v3/runs/{run}/detail?ids=` (at most 256; or `?eids=`): hot fields decoded, cold fields, `parents`,
  `cause`, `links`, `metrics`, `counters`, and `open: {nsys: {run, path, t}, ncu: {run, path, profile_row}}`
- `GET /api/v3/runs/{run}/raw?id=`: the raw record from the run folder
- `WS /api/v3/stream?run=&have=`: append deltas, seal (`derived: {ids, parent, cause, tier, depth}`), generation
  and status frames

Browser: one `RunStore` (`frontend/cc/store/run.js`) answers `step`, `grainFor`, `widthFor`, `chain`, `activeBy`,
`scan`, `count`, `row`, `children`, `linksOf`, `samplesAt`, `series`, `detail`, `resolve`, `subscribe`, `head`. It
hides blocks, CCVB, the socket, dictionaries, indexes, the id map and generations.

### 6.5 Live and replay are one path

- Live rows use the same adapter `parse()` as import, the same `RunWriter`, the same CCVB blocks, pushed over the
  stream socket. One parser per source (`backend/store/adapters/`), so a row gets the same eid live and final.
  `make store-check` fails when a live eid is missing from its final generation.
- `RunWatcher`: `labels.json` appears, a live run opens; `run.json` appears, the importer writes the next generation;
  browsers reload it (keep t, re-resolve the selection by eid).
- One t0: the live writer fixes `t0_ns` and the wall offset in `capture/clock.json`; the final import uses it, so
  cursor and URL carry across the reload. Rows before t0 have a negative `start`.
- Seal every ≤ 10 s: containment parents, causes, tiers and depths for held rows; until then a live row has no parent
  or cause and its kind's base tier.
- Live only: client records and stamps, server stamps, derived iterations, network frames, NVML, docker events and
  stats, engine scrape and iteration stats, inventory. Final import only: nsys, PyTorch profiler and ncu rows, engine
  records, run.json metrics and facts, `serves` links, layers.
- A rolling `host` run (30 min) holds machine samples and docker events between reps.
- Live GPU: NVML GPM (SM utilization, SM occupancy, tensor utilization, DRAM bandwidth) at 100 ms; faster reads mostly
  return empty windows (195 of 244 at 20 ms), so a zero or shorter-than-50-ms window is dropped and counted in
  `nvml_sampler.gpm_dropped`. Other NVML counters at their measured refresh (probe 2026-11-08, RTX 5060 Ti, driver
  615.78.08):

| counter | refresh ms (idle / load / churn) | read ms | period ms | clock |
| --- | --- | --- | --- | --- |
| GPM SM, occupancy, tensor, DRAM | 100.0 / 100.0 / 100.0 | 0.08 | 100 | `nvml-gpm` |
| memory used | none / none / 50.0 | 0.05 | 50 (chosen, owner) | `nvml-50ms` |
| power | 500.0 / 500.0 / 500.0 | 0.01 | 500 | `nvml-500ms` |
| SM clock | 500.0 / 500.0 / 500.0 | 0.01 | 500 | `nvml-500ms` |
| temperature | 500.0 / 500.0 / none | 0.01 | 500 | `nvml-500ms` |
| PCIe RX | 21.1 / 20.6 / 20.8 | 20.6 | 30 | `nvml-pcie-rx` |
| PCIe TX | 21.0 / 20.6 / 20.8 | 20.6 | 30 | `nvml-pcie-tx` |

- GPM and an nsys GPU-metrics capture do not conflict (70 GPM reads in 7.0 s, median gap 100.09 ms). GPM DRAM equals
  nsys DRAM read + write (69 windows, correlation 1.000) when each GPM window is moved about 165 ms earlier. Owner:
  keep GPM's read time and state the lag in each GPM metric's evidence line; do not shift timestamps.
- Engine iteration stats arrive in about 2 s batches (TensorRT-LLM drains on read). The view labels this.
- Replay hardware: nvidia-smi `gpu.csv` (100 ms) and nsys GPU metrics (0.1 ms) where the run has them.

### 6.6 Accepted tradeoffs

- Browser memory (10.9 MB for the timeline run, 64 MB budget) for no network on any step, scrub or zoom.
- Two encodings of the hot columns (Parquet canonical, CCVB derived) for zero-parse loads and DuckDB for agents.
- A reload (target 250 ms) when a new generation lands, for one id rule per generation.

## 7. Migration plan: prototype to production

Target: `/static/cc/index.html` is the command center of section 2, drawn from the v3 store. The prototype's files
move into `devtools/frontend/cc/`; the 3D side-by-side levels go. The verify skill stays where it is
(`.claude/skills/verify-command-center`, page `/static/cc/index.html`); its recipes change as each step lands.
`prototypes/D13/regress.sh` becomes the acceptance test, pointed at `/static/cc/index.html`.

### 7.1 What moves where

| prototype (`prototypes/D13/`) | production (`frontend/cc/`) | change |
| --- | --- | --- |
| `model.js` (state, frame loop, history, session, keys, hash) | `control/control.js`, `control/keys.js`, `control/url.js` | `Control` gains the D13 state (world, focus, tiers, paired, metric, bounds, playEvent, dock, nav, session, head, follow); one keymap (2.4); the hash of 2.3 replaces `#side?run=&t=…` |
| `data.js` (scratch units, boxes, samples, metrics) | `store/run.js` plus a per-dimension view of it | every scratch list becomes a `RunStore` query (7.2) |
| `session.js`, `tools/build_session.py` | `session.js` plus a backend route | the build script becomes `GET /api/v3/reps` (7.2) |
| `shell.js`, `chrome.js` | `chrome/` | as built |
| `stage.js`, `worlds/rep.js`, `worlds/stacked.js`, `worlds/spine.js`, `worlds/architecture.js` | `worlds/` | stand-in phase regexes for "show me" become `moments.toml` `event` lookups |
| `arch.js` | `arch.js` | box state from `activeBy("comp", t)` and things |
| `hwside.js` | `sidebar/sidebar.js` | rows from the manifest metric catalog (`sidebar: true`) |
| `bar.js` | `control/bar.js`, `inspector/` | tab list already matches `inspector/tabs.js`; keep `nsight.js` links |
| `zoom.js` | `zoom.js` | as built |
| (none) | `levels/*`, `scene/*` (3D side-by-side levels) | deleted once the worlds draw from the store; the Stacked world may keep `scene/` helpers it uses |

### 7.2 What the interface needs that the store does not give yet

| need | today | work |
| --- | --- | --- |
| stops per (dimension, tier) | `step` walks the 7-tier storage ladder | M2: placement per dimension in `kinds.json`; `step` by the focused position |
| layer for every kernel | cold column; the browser repeats the rule | open choice 6 |
| module in graphs-on runs | missing | M3: sequence-match rule from the code run |
| flow of each unit (in, prefill, decode, out) | not stored | M4: derive from iteration kind (prefill or decode) and the request's client and server stream rows; store as a hot column or aux |
| architecture hand-offs | counted ad hoc by `stop_counts.py` | M2 |
| rep catalog, runs with labels and result summary, moments | `build_session.py` reads the repo | M5: `GET /api/v3/reps` and a result summary per run |
| launch | runner `POST /runner/jobs` exists | M6: Launch calls it; the live run arrives through `RunWatcher` and the stream |
| live head and mask | `head_ns` and stream frames exist | M6 |
| compare | one `RunStore` per page | M7: two stores, A / B switch |
| CPU cores, L3, RAM bandwidth, NVMe | missing | M8 (owner: required) |
| more than one request | the v2 scene required one `measured` request; check v3 | M2 check with I02C (two overlapping requests) |

### 7.3 Steps (each ends in a check)

| step | change | check |
| --- | --- | --- |
| M1 shell on the store | `cc/` gets the D13 chrome, stage, worlds, bar and sidebar; Rep world reads results from the run folder; worlds still on scratch data | `regress.sh` passes on `/static/cc/index.html`; 0 console errors |
| M2 dimensions in the data | `kinds.json` gains each kind's place per dimension and the hand-off rule; `RunStore.step` steps by (dimension, tier) | `stop_counts.py` jump check passes; `ccv` steps a code-run iteration with no crawl; I02C shows both requests |
| M3 module inference | module rule for graphs-on runs | timeline run has module stops; counts match the code run's per-iteration pattern |
| M4 flows | flow per unit | flow colours on real runs; stream out overlaps the next decode pass |
| M5 real worlds | every world draws from `RunStore`; "show me" uses `moments.toml` `event`; scratch `data.js` deleted | walkthroughs of section 5 done in the interface |
| M6 launch and live | Launch posts `/runner/jobs`; live via `RunWatcher` and the stream; mask and follow | a launched I02A run is followed live and becomes a replay at its end with no command |
| M7 compare | two runs, A / B in replay worlds | Rep world deltas equal `latency.json` differences |
| M8 CPU-side counters | `perf` uncore (L3, RAM bandwidth), per-core CPU, Docker stats stored, NVMe I/O | values in the sidebar with source and period; stored in replay |
| M9 rep files | `moments.toml` and `rep.toml` for every rep | the Rep world lists moments for every rep with results |
| M10 retire | delete `levels/`, `scene/` remnants, `store_v2.py` and `/api/v2`, `prototypes/D1`, `D2`, `D5v2`, `D13`, the v2 collectors once unused, the storage `tier` column once nothing reads it; the v1 page stays until the owner retires it | no surface in section 9 points at a removed item; `make store-check` passes |

M10 also covers `/mnt/ie-data/cc-v2-proto` (29 GB, the v2 store). Deleting it is data deletion and waits for the
owner. `map_surfaces.py` reads `prototypes/D5v2/base/model.js`, so it changes before D5v2 goes.

## 8. Open choices (owner)

1. **v2 alongside during the migration.** The v2 store and D5v2 stay until M10; the verify skill opens D5v2 only for
   legacy recipes.
2. **Snap-to-tier zoom.** Each dimension keeps its own tier (settled). Open: semantic zoom that snaps to tier bounds.
3. **Compare as a split.** Initial layout: A / B switch. Open: a split into two full worlds once per-run events exist.
4. **Key for walking every row.** Alt ← → is given to walking every row (owner) and, in the prototype, to
   back / forward. Proposed: history on `[` and `]`.
5. **A derived iteration across an idle gap.** In the timeline run iteration 129 runs 12.55 s, across the gap between
   requests. End it at the request end, or at its last device work? (`derive.py`)
6. **`layer` hot or cold.** Make it a hot column (`<i2`, +2 B per row), or keep the browser copy of the rule?
7. **Kernel short names.** 12,096 of 39,768 device rows are named `kernel` (templated GEMMs). Carry a short name that
   tells GEMMs apart, full name cold?
8. **Stream id -1.** Lane `gpu0/stream 4294967295` (2,392 rows). Name it "no stream", or keep the raw id?
9. **Browser memory for the code run.** 120 MB against a 64 MB budget. Integer GPU attributes, fine blocks on
   demand, a run-size budget, or accept it?
10. **Kernel duration unit.** The v2 scene showed "replay 2.176 ns" for a kernel; likely a unit bug (not verified on
    v3, which scales ncu units on import).
11. **Merge into main.** Later (owner, 2026-11-08). `main` has one commit touching 10 of the same files.

## 9. Map of every current surface

Generated by `map_surfaces.py` from the registry, `cc/levels/index.js`, D5v2 `model.js`, the v1 `index.html`, the
panels and `cc/control/keys.js`. "owner" marks an open choice.

<!-- gen:surfaces -->
| type | current | new place |
| --- | --- | --- |
| tier | request | execution / request; container events move to architecture / container |
| tier | iteration | execution / iteration |
| tier | stage | execution / phase |
| tier | op | execution / module (nested NVTX); graph nodes to detail |
| tier | call | split: module forwards to execution / module, launches to the CPU side of execution / kernel, the rest to detail |
| tier | device | execution / kernel |
| tier | os | detail |
| kind | client request | execution: request; hardware: -; architecture: component (client boxes) |
| kind | container event | execution: detail; hardware: -; architecture: container (lifecycle stop) |
| kind | iteration | execution: iteration; hardware: -; architecture: component (worker) |
| kind | engine timestamp | execution: detail of request; hardware: -; architecture: component (worker) |
| kind | component stamp | execution: phase; hardware: -; architecture: component |
| kind | client event | execution: phase; hardware: -; architecture: component (client) |
| kind | client transport | execution: phase; hardware: -; architecture: component (client transport) |
| kind | network frame | execution: phase; hardware: device (NIC link); architecture: container (network) |
| kind | nvtx range | execution: phase if top-level, else detail; hardware: device (CPU); architecture: component (worker) |
| kind | cuda graph node | execution: detail; hardware: device (GPU); architecture: software layer (runtime) |
| kind | cuda runtime call | execution: kernel (CPU side) if a launch, else detail; hardware: device (CPU); architecture: software layer (runtime) |
| kind | cuda driver call | execution: kernel (CPU side) if a launch, else detail; hardware: device (CPU); architecture: software layer (runtime) |
| kind | cuda synchronization | execution: detail; hardware: device (CPU); architecture: software layer (runtime) |
| kind | cuda event record | execution: detail; hardware: device (CPU); architecture: software layer (runtime) |
| kind | cpu operator | execution: detail (under its module); hardware: device (CPU); architecture: software layer (toolkit) |
| kind | python call | execution: module if a module forward, else detail; hardware: device (CPU); architecture: software layer (toolkit) |
| kind | kernel | execution: kernel; hardware: unit (SMs); kernel traffic if profiled; architecture: software layer (device code) |
| kind | memcpy | execution: kernel; hardware: device (PCIe link, copy engine); architecture: software layer (device code) |
| kind | memset | execution: kernel; hardware: unit (copy engine, VRAM); architecture: software layer (device code) |
| kind | os runtime call | execution: detail; hardware: device (CPU); architecture: process (OS) |
| kind | profiler overhead | execution: detail; hardware: device (CPU); architecture: process (profiler) |
| kind | profiler message | execution: detail; hardware: -; architecture: process (profiler) |
| v3 level | Infra | architecture / container and process; hardware / node strip moves to the hardware dimension |
| v3 level | Components | architecture / component, with execution / phase lighting the boxes |
| v3 level | Trace | execution / request and phase |
| v3 level | Iteration | execution / iteration |
| v3 level | Model ops | execution / layer and module |
| v3 level | Kernel | execution / kernel, with hardware / kernel traffic beside it |
| v3 level | Hardware | hardware / device and unit |
| v2 level | Infrastructure | architecture / container and process, built natively from the v2-scene branch level (no v1 panel) |
| v2 level | Components | architecture / component, built natively from the v2-scene branch level (no v1 panel) |
| v2 level | Trace | execution / request and phase |
| v2 level | Iteration | execution / iteration |
| v2 level | Model ops | execution / layer and module |
| v2 level | Kernel | execution / kernel |
| v2 level | Hardware | hardware / unit and kernel traffic (the SM view) |
| v1 view | infra | architecture / container and process, hardware / system |
| v1 view | components | architecture / component |
| v1 view | run | header session shell: Launch (live); results in the Rep world |
| v1 view | engine | execution / iteration (live engine stats) |
| v1 view | lifecycle | control plane (bottom), outside the world; container events stay architecture / container stops |
| v1 view | requests | execution / request (list of stops) |
| v1 view | runs | header session shell: Load (replay a run) |
| v1 view | compare | header session shell: Compare; Rep world side by side, A / B switch in other worlds |
| v1 view | trace | execution / request and phase |
| v1 view | metrics | hardware / system (persistent sidebar) |
| v1 view | logs | control plane (bottom), outside the world |
| v1 view | tools | control plane (bottom); run-specific containers (Grafana, Prometheus, DCGM, node exporter) are in the run's world as architecture / container |
| panel | sidebar | hardware / system, persistent in every view |
| panel | inspector | detail of the selection in any dimension; holds every detail row |
| panel | bar | the timeline strip: ticks are the stops of the focused (dimension, tier) |
| control | next event at the grain | next stop at the focused (dimension, tier) |
| control | previous event at the grain | previous stop at the focused (dimension, tier) |
| control | next event one tier coarser | next stop one tier coarser in the same dimension |
| control | previous event one tier coarser | previous stop one tier coarser in the same dimension |
| control | next row of any tier (every row) | kept (owner): walk every row of the focused tier in time order, or only the rows of the selected process or object |
| control | previous row of any tier | kept (owner): same two modes as the forward walk |
| control | focus the next coarser level | fly one tier coarser in the focused dimension |
| control | focus the next finer level | fly one tier finer in the focused dimension |
| control | play / pause | unchanged: plays stops of the focused (dimension, tier) |
| control | zoom the window in around the cursor | unchanged |
| control | zoom the window out around the cursor | unchanged |
| control | natural window of the focused level | natural window of the focused (dimension, tier) |
| control | first event at the grain | first stop at the focused (dimension, tier) |
| control | last event at the grain | last stop at the focused (dimension, tier) |
| control | follow the live head (live runs only) | unchanged |
| control | close this help, else clear the selection | unchanged |
| control | show or hide this help | unchanged |
| control | focus <level> (keys 1-7) | fly to tier n of the focused dimension; a separate key picks the dimension (fly model, section 3.4) |
<!-- /gen:surfaces -->

## 10. Stop counts per run

Generated by `stop_counts.py` over every run in `/mnt/ie-data/cc/store/runs/`. The jump check flags a stop tier whose
stops per iteration exceed 3 times the largest earlier run of the same trace level: a detail kind probably mapped to
a stop tier.

<!-- gen:stops -->
Execution stops (own tier). Per iteration in brackets. `detail` rows are never stops.

| run | rows | iterations | request | iteration | phase | layer | module | kernel | detail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| I02A-TRACE-code_20261103T170709Z_0ac2db | 1,140,823 | 64 | 3 (0) | 0 (0) | 1,606 (25) | 1,600 (25) | 17,216 (269) | 18,309 (286) | 1,103,689 (17,245) |
| I02A-TRACE-components_20261104T142238Z_0b249c | 2,827 | 128 | 2 (0) | 128 (1) | 2,675 (21) | 0 (0) | 0 (0) | 0 (0) | 22 (0) |
| I02A-TRACE-components_20261108T195135Z_f32fab | 3,146 | 128 | 2 (0) | 128 (1) | 2,994 (23) | 0 (0) | 0 (0) | 0 (0) | 22 (0) |
| I02A-TRACE-components_20261108T195738Z_2a3785 | 3,020 | 128 | 2 (0) | 128 (1) | 2,868 (22) | 0 (0) | 0 (0) | 0 (0) | 22 (0) |
| I02A-TRACE-components_20261108T195912Z_b38a05 | 3,116 | 128 | 2 (0) | 128 (1) | 2,964 (23) | 0 (0) | 0 (0) | 0 (0) | 22 (0) |
| I02A-TRACE-components_20261108T201219Z_7ea831 | 3,099 | 128 | 2 (0) | 128 (1) | 2,947 (23) | 0 (0) | 0 (0) | 0 (0) | 22 (0) |
| I02A-TRACE-components_20261108T204131Z_8c3f47 | 3,155 | 128 | 2 (0) | 128 (1) | 3,003 (23) | 0 (0) | 0 (0) | 0 (0) | 22 (0) |
| I02A-TRACE-components_20261108T204441Z_dadcfe | 3,170 | 128 | 2 (0) | 128 (1) | 3,018 (24) | 0 (0) | 0 (0) | 0 (0) | 22 (0) |
| I02A-TRACE-components_20261108T204701Z_1b9632 | 3,164 | 128 | 2 (0) | 128 (1) | 3,012 (24) | 0 (0) | 0 (0) | 0 (0) | 22 (0) |
| I02A-TRACE-components_20261108T212815Z_ee256d | 3,163 | 128 | 2 (0) | 128 (1) | 2,979 (23) | 0 (0) | 0 (0) | 0 (0) | 54 (0) |
| I02A-TRACE-components_20261108T213518Z_289d7a | 3,124 | 128 | 2 (0) | 128 (1) | 2,938 (23) | 0 (0) | 0 (0) | 0 (0) | 56 (0) |
| I02A-TRACE-components_20261108T214523Z_1d27d0 | 3,208 | 128 | 2 (0) | 128 (1) | 3,022 (24) | 0 (0) | 0 (0) | 0 (0) | 56 (0) |
| I02A-TRACE-components_20261108T214816Z_2b7068 | 3,311 | 128 | 2 (0) | 128 (1) | 3,125 (24) | 0 (0) | 0 (0) | 0 (0) | 56 (0) |
| I02A-TRACE-components_20261108T215027Z_e1ce13 | 3,205 | 128 | 2 (0) | 128 (1) | 3,019 (24) | 0 (0) | 0 (0) | 0 (0) | 56 (0) |
| I02A-TRACE-components_20261108T215349Z_561bfe | 3,190 | 128 | 2 (0) | 128 (1) | 3,004 (23) | 0 (0) | 0 (0) | 0 (0) | 56 (0) |
| I02A-TRACE-kernels_20261103T181509Z_52744d | 11,698 | 0 | 3 | 0 | 11,673 | 0 | 0 | 0 | 22 |
| I02A-TRACE-live_20261103T185532Z_1c1629 | 1,471 | 0 | 2 | 0 | 1,447 | 0 | 0 | 0 | 22 |
| I02A-TRACE-timeline_20261103T185837Z_e08b8b | 90,952 | 128 | 3 (0) | 0 (0) | 3,508 (27) | 3,200 (25) | 0 (0) | 39,768 (311) | 47,673 (372) |
| I02A-TRACE-timeline_20261107T172848Z_f2ac52 | 93,163 | 192 | 3 (0) | 192 (1) | 6,224 (32) | 3,200 (17) | 0 (0) | 39,768 (207) | 46,976 (245) |
| I02A-TRACE-timeline_20261108T200246Z_764014 | 101,881 | 192 | 3 (0) | 192 (1) | 6,158 (32) | 3,200 (17) | 0 (0) | 39,768 (207) | 55,760 (290) |
| I02A-TRACE-timeline_20261108T213113Z_1d82c9 | 91,635 | 192 | 3 (0) | 192 (1) | 6,063 (32) | 3,200 (17) | 0 (0) | 39,768 (207) | 45,609 (238) |
| I02A_20261103T164324Z_348959 | 1,130 | 0 | 2 | 0 | 1,106 | 0 | 0 | 0 | 22 |
| I02A_20261103T172804Z_a3ca9a | 648 | 0 | 2 | 0 | 624 | 0 | 0 | 0 | 22 |
| I02A_20261103T172929Z_0e5d39 | 648 | 0 | 2 | 0 | 624 | 0 | 0 | 0 | 22 |

Jump check (a stop tier above 3 times its largest earlier run of the same trace level): no jumps.


Hardware and architecture stops.

| run | transfers | launches | container hand-offs | process hand-offs | component hand-offs | ncu-profiled |
| --- | --- | --- | --- | --- | --- | --- |
| I02A-TRACE-code_20261103T170709Z_0ac2db | 2,751 | 18,309 | 520 | 4,709 | 4,709 | 0 |
| I02A-TRACE-components_20261104T142238Z_0b249c | 0 | 0 | 575 | 1,323 | 1,788 | 0 |
| I02A-TRACE-components_20261108T195135Z_f32fab | 0 | 0 | 502 | 1,370 | 1,786 | 0 |
| I02A-TRACE-components_20261108T195738Z_2a3785 | 0 | 0 | 534 | 1,364 | 1,787 | 0 |
| I02A-TRACE-components_20261108T195912Z_b38a05 | 0 | 0 | 525 | 1,367 | 1,789 | 0 |
| I02A-TRACE-components_20261108T201219Z_7ea831 | 0 | 0 | 496 | 1,344 | 1,775 | 0 |
| I02A-TRACE-components_20261108T204131Z_8c3f47 | 0 | 0 | 509 | 1,390 | 1,797 | 0 |
| I02A-TRACE-components_20261108T204441Z_dadcfe | 0 | 0 | 521 | 1,411 | 1,778 | 0 |
| I02A-TRACE-components_20261108T204701Z_1b9632 | 0 | 0 | 536 | 1,396 | 1,786 | 0 |
| I02A-TRACE-components_20261108T212815Z_ee256d | 0 | 0 | 447 | 1,281 | 1,747 | 0 |
| I02A-TRACE-components_20261108T213518Z_289d7a | 0 | 0 | 523 | 1,380 | 1,799 | 0 |
| I02A-TRACE-components_20261108T214523Z_1d27d0 | 0 | 0 | 531 | 1,376 | 1,788 | 0 |
| I02A-TRACE-components_20261108T214816Z_2b7068 | 0 | 0 | 507 | 1,344 | 1,775 | 0 |
| I02A-TRACE-components_20261108T215027Z_e1ce13 | 0 | 0 | 553 | 1,379 | 1,794 | 0 |
| I02A-TRACE-components_20261108T215349Z_561bfe | 0 | 0 | 514 | 1,385 | 1,793 | 0 |
| I02A-TRACE-kernels_20261103T181509Z_52744d | 0 | 0 | 428 | 638 | 638 | 0 |
| I02A-TRACE-live_20261103T185532Z_1c1629 | 0 | 0 | 277 | 421 | 421 | 0 |
| I02A-TRACE-timeline_20261103T185837Z_e08b8b | 5,628 | 7,512 | 863 | 8,926 | 8,926 | 0 |
| I02A-TRACE-timeline_20261107T172848Z_f2ac52 | 5,628 | 7,512 | 3,702 | 12,289 | 12,536 | 266 |
| I02A-TRACE-timeline_20261108T200246Z_764014 | 5,628 | 7,512 | 3,379 | 12,057 | 12,315 | 0 |
| I02A-TRACE-timeline_20261108T213113Z_1d82c9 | 5,628 | 7,512 | 3,002 | 11,764 | 12,042 | 0 |
| I02A_20261103T164324Z_348959 | 0 | 0 | 282 | 424 | 424 | 0 |
| I02A_20261103T172804Z_a3ca9a | 0 | 0 | 283 | 424 | 424 | 0 |
| I02A_20261103T172929Z_0e5d39 | 0 | 0 | 286 | 426 | 426 | 0 |

Hardware samples (state, not stops): count and median period.

| run | sample group | samples | median period |
| --- | --- | --- | --- |
| I02A-TRACE-code_20261103T170709Z_0ac2db | gpu0-nvidia-smi | 875 | 100,206 µs |
| I02A-TRACE-components_20261104T142238Z_0b249c | gpu0-nvidia-smi | 823 | 100,198 µs |
| I02A-TRACE-components_20261108T195135Z_f32fab | gpu0-nvidia-smi | 789 | 100,186 µs |
| I02A-TRACE-components_20261108T195135Z_f32fab | nvml-500ms | 166 | 500,082 µs |
| I02A-TRACE-components_20261108T195135Z_f32fab | nvml-50ms | 1,664 | 50,080 µs |
| I02A-TRACE-components_20261108T195135Z_f32fab | nvml-gpm | 833 | 100,080 µs |
| I02A-TRACE-components_20261108T195135Z_f32fab | nvml-pcie-rx | 2,767 | 30,080 µs |
| I02A-TRACE-components_20261108T195135Z_f32fab | nvml-pcie-tx | 2,765 | 30,081 µs |
| I02A-TRACE-components_20261108T195738Z_2a3785 | gpu0-nvidia-smi | 690 | 100,184 µs |
| I02A-TRACE-components_20261108T195738Z_2a3785 | nvml-500ms | 145 | 500,080 µs |
| I02A-TRACE-components_20261108T195738Z_2a3785 | nvml-50ms | 1,455 | 50,080 µs |
| I02A-TRACE-components_20261108T195738Z_2a3785 | nvml-gpm | 728 | 100,082 µs |
| I02A-TRACE-components_20261108T195738Z_2a3785 | nvml-pcie-rx | 2,420 | 30,082 µs |
| I02A-TRACE-components_20261108T195738Z_2a3785 | nvml-pcie-tx | 2,420 | 30,080 µs |
| I02A-TRACE-components_20261108T195912Z_b38a05 | gpu0-nvidia-smi | 738 | 100,188 µs |
| I02A-TRACE-components_20261108T195912Z_b38a05 | nvml-500ms | 156 | 500,084 µs |
| I02A-TRACE-components_20261108T195912Z_b38a05 | nvml-50ms | 1,558 | 50,084 µs |
| I02A-TRACE-components_20261108T195912Z_b38a05 | nvml-gpm | 776 | 100,084 µs |
| I02A-TRACE-components_20261108T195912Z_b38a05 | nvml-pcie-rx | 2,592 | 30,090 µs |
| I02A-TRACE-components_20261108T195912Z_b38a05 | nvml-pcie-tx | 2,591 | 30,088 µs |
| I02A-TRACE-components_20261108T201219Z_7ea831 | gpu0-nvidia-smi | 741 | 100,192 µs |
| I02A-TRACE-components_20261108T201219Z_7ea831 | nvml-500ms | 157 | 500,083 µs |
| I02A-TRACE-components_20261108T201219Z_7ea831 | nvml-50ms | 1,567 | 50,083 µs |
| I02A-TRACE-components_20261108T201219Z_7ea831 | nvml-gpm | 783 | 100,084 µs |
| I02A-TRACE-components_20261108T201219Z_7ea831 | nvml-pcie-rx | 2,606 | 30,090 µs |
| I02A-TRACE-components_20261108T201219Z_7ea831 | nvml-pcie-tx | 2,606 | 30,088 µs |
| I02A-TRACE-components_20261108T204131Z_8c3f47 | gpu0-nvidia-smi | 791 | 100,196 µs |
| I02A-TRACE-components_20261108T204131Z_8c3f47 | nvml-500ms | 167 | 500,083 µs |
| I02A-TRACE-components_20261108T204131Z_8c3f47 | nvml-50ms | 1,668 | 50,085 µs |
| I02A-TRACE-components_20261108T204131Z_8c3f47 | nvml-gpm | 834 | 100,086 µs |
| I02A-TRACE-components_20261108T204131Z_8c3f47 | nvml-pcie-rx | 2,772 | 30,089 µs |
| I02A-TRACE-components_20261108T204131Z_8c3f47 | nvml-pcie-tx | 2,772 | 30,090 µs |
| I02A-TRACE-components_20261108T204441Z_dadcfe | gpu0-nvidia-smi | 798 | 100,199 µs |
| I02A-TRACE-components_20261108T204441Z_dadcfe | nvml-500ms | 167 | 500,085 µs |
| I02A-TRACE-components_20261108T204441Z_dadcfe | nvml-50ms | 1,668 | 50,085 µs |
| I02A-TRACE-components_20261108T204441Z_dadcfe | nvml-gpm | 833 | 100,087 µs |
| I02A-TRACE-components_20261108T204441Z_dadcfe | nvml-pcie-rx | 2,773 | 30,092 µs |
| I02A-TRACE-components_20261108T204441Z_dadcfe | nvml-pcie-tx | 2,773 | 30,092 µs |
| I02A-TRACE-components_20261108T204701Z_1b9632 | gpu0-nvidia-smi | 791 | 100,192 µs |
| I02A-TRACE-components_20261108T204701Z_1b9632 | nvml-500ms | 166 | 500,085 µs |
| I02A-TRACE-components_20261108T204701Z_1b9632 | nvml-50ms | 1,656 | 50,086 µs |
| I02A-TRACE-components_20261108T204701Z_1b9632 | nvml-gpm | 829 | 100,085 µs |
| I02A-TRACE-components_20261108T204701Z_1b9632 | nvml-pcie-rx | 2,752 | 30,092 µs |
| I02A-TRACE-components_20261108T204701Z_1b9632 | nvml-pcie-tx | 2,752 | 30,089 µs |
| I02A-TRACE-components_20261108T212815Z_ee256d | docker-ie-devtools-dcgm-1 | 79 | 1,005,335 µs |
| I02A-TRACE-components_20261108T212815Z_ee256d | docker-ie-devtools-devtools-1 | 79 | 1,005,360 µs |
| I02A-TRACE-components_20261108T212815Z_ee256d | docker-ie-devtools-grafana-1 | 79 | 1,005,391 µs |
| I02A-TRACE-components_20261108T212815Z_ee256d | docker-ie-devtools-node-1 | 79 | 1,005,352 µs |
| I02A-TRACE-components_20261108T212815Z_ee256d | docker-ie-devtools-prometheus-1 | 79 | 1,005,226 µs |
| I02A-TRACE-components_20261108T212815Z_ee256d | docker-ie-i02a-l1-capture-1 | 76 | 1,005,375 µs |
| I02A-TRACE-components_20261108T212815Z_ee256d | docker-ie-i02a-l1-client-1 | 11 | 1,005,618 µs |
| I02A-TRACE-components_20261108T212815Z_ee256d | docker-ie-i02a-l1-server-1 | 78 | 1,005,342 µs |
| I02A-TRACE-components_20261108T212815Z_ee256d | engine | 12 | 1,004,054 µs |
| I02A-TRACE-components_20261108T212815Z_ee256d | gpu0-nvidia-smi | 764 | 100,189 µs |
| I02A-TRACE-components_20261108T212815Z_ee256d | nvml-500ms | 161 | 500,083 µs |
| I02A-TRACE-components_20261108T212815Z_ee256d | nvml-50ms | 1,599 | 50,085 µs |
| I02A-TRACE-components_20261108T212815Z_ee256d | nvml-gpm | 800 | 100,086 µs |
| I02A-TRACE-components_20261108T212815Z_ee256d | nvml-pcie-rx | 2,658 | 30,088 µs |
| I02A-TRACE-components_20261108T212815Z_ee256d | nvml-pcie-tx | 2,658 | 30,089 µs |
| I02A-TRACE-components_20261108T213518Z_289d7a | docker-ie-devtools-dcgm-1 | 78 | 1,004,764 µs |
| I02A-TRACE-components_20261108T213518Z_289d7a | docker-ie-devtools-devtools-1 | 78 | 1,004,902 µs |
| I02A-TRACE-components_20261108T213518Z_289d7a | docker-ie-devtools-grafana-1 | 78 | 1,005,038 µs |
| I02A-TRACE-components_20261108T213518Z_289d7a | docker-ie-devtools-node-1 | 78 | 1,004,661 µs |
| I02A-TRACE-components_20261108T213518Z_289d7a | docker-ie-devtools-prometheus-1 | 78 | 1,004,808 µs |
| I02A-TRACE-components_20261108T213518Z_289d7a | docker-ie-i02a-l1-capture-1 | 73 | 1,004,763 µs |
| I02A-TRACE-components_20261108T213518Z_289d7a | docker-ie-i02a-l1-client-1 | 9 | 1,004,752 µs |
| I02A-TRACE-components_20261108T213518Z_289d7a | docker-ie-i02a-l1-server-1 | 76 | 1,004,938 µs |
| I02A-TRACE-components_20261108T213518Z_289d7a | engine | 10 | 1,003,903 µs |
| I02A-TRACE-components_20261108T213518Z_289d7a | gpu0-nvidia-smi | 738 | 100,194 µs |
| I02A-TRACE-components_20261108T213518Z_289d7a | nvml-500ms | 156 | 500,086 µs |
| I02A-TRACE-components_20261108T213518Z_289d7a | nvml-50ms | 1,559 | 50,084 µs |
| I02A-TRACE-components_20261108T213518Z_289d7a | nvml-gpm | 780 | 100,084 µs |
| I02A-TRACE-components_20261108T213518Z_289d7a | nvml-pcie-rx | 2,593 | 30,087 µs |
| I02A-TRACE-components_20261108T213518Z_289d7a | nvml-pcie-tx | 2,593 | 30,089 µs |
| I02A-TRACE-components_20261108T214523Z_1d27d0 | docker-blissful_chatelet | 1 | n/a |
| I02A-TRACE-components_20261108T214523Z_1d27d0 | docker-ie-devtools-dcgm-1 | 83 | 1,005,464 µs |
| I02A-TRACE-components_20261108T214523Z_1d27d0 | docker-ie-devtools-devtools-1 | 83 | 1,005,383 µs |
| I02A-TRACE-components_20261108T214523Z_1d27d0 | docker-ie-devtools-grafana-1 | 83 | 1,005,465 µs |
| I02A-TRACE-components_20261108T214523Z_1d27d0 | docker-ie-devtools-node-1 | 83 | 1,005,632 µs |
| I02A-TRACE-components_20261108T214523Z_1d27d0 | docker-ie-devtools-prometheus-1 | 83 | 1,005,426 µs |
| I02A-TRACE-components_20261108T214523Z_1d27d0 | docker-ie-i02a-l1-capture-1 | 78 | 1,005,521 µs |
| I02A-TRACE-components_20261108T214523Z_1d27d0 | docker-ie-i02a-l1-client-1 | 9 | 1,005,757 µs |
| I02A-TRACE-components_20261108T214523Z_1d27d0 | docker-ie-i02a-l1-server-1 | 81 | 1,005,462 µs |
| I02A-TRACE-components_20261108T214523Z_1d27d0 | engine | 13 | 1,003,734 µs |
| I02A-TRACE-components_20261108T214523Z_1d27d0 | gpu0-nvidia-smi | 791 | 100,193 µs |
| I02A-TRACE-components_20261108T214523Z_1d27d0 | nvml-500ms | 168 | 500,087 µs |
| I02A-TRACE-components_20261108T214523Z_1d27d0 | nvml-50ms | 1,674 | 50,085 µs |
| I02A-TRACE-components_20261108T214523Z_1d27d0 | nvml-gpm | 836 | 100,085 µs |
| I02A-TRACE-components_20261108T214523Z_1d27d0 | nvml-pcie-rx | 2,782 | 30,087 µs |
| I02A-TRACE-components_20261108T214523Z_1d27d0 | nvml-pcie-tx | 2,782 | 30,090 µs |
| I02A-TRACE-components_20261108T214816Z_2b7068 | docker-ie-devtools-dcgm-1 | 90 | 1,005,313 µs |
| I02A-TRACE-components_20261108T214816Z_2b7068 | docker-ie-devtools-devtools-1 | 90 | 1,005,382 µs |
| I02A-TRACE-components_20261108T214816Z_2b7068 | docker-ie-devtools-grafana-1 | 90 | 1,005,405 µs |
| I02A-TRACE-components_20261108T214816Z_2b7068 | docker-ie-devtools-node-1 | 90 | 1,004,997 µs |
| I02A-TRACE-components_20261108T214816Z_2b7068 | docker-ie-devtools-prometheus-1 | 90 | 1,005,155 µs |
| I02A-TRACE-components_20261108T214816Z_2b7068 | docker-ie-i02a-l1-capture-1 | 86 | 1,005,200 µs |
| I02A-TRACE-components_20261108T214816Z_2b7068 | docker-ie-i02a-l1-client-1 | 10 | 1,006,760 µs |
| I02A-TRACE-components_20261108T214816Z_2b7068 | docker-ie-i02a-l1-server-1 | 89 | 1,005,325 µs |
| I02A-TRACE-components_20261108T214816Z_2b7068 | engine | 16 | 1,003,582 µs |
| I02A-TRACE-components_20261108T214816Z_2b7068 | gpu0-nvidia-smi | 863 | 100,195 µs |
| I02A-TRACE-components_20261108T214816Z_2b7068 | nvml-500ms | 181 | 500,084 µs |
| I02A-TRACE-components_20261108T214816Z_2b7068 | nvml-50ms | 1,805 | 50,087 µs |
| I02A-TRACE-components_20261108T214816Z_2b7068 | nvml-gpm | 903 | 100,088 µs |
| I02A-TRACE-components_20261108T214816Z_2b7068 | nvml-pcie-rx | 2,999 | 30,091 µs |
| I02A-TRACE-components_20261108T214816Z_2b7068 | nvml-pcie-tx | 2,999 | 30,094 µs |
| I02A-TRACE-components_20261108T215027Z_e1ce13 | docker-ie-devtools-dcgm-1 | 82 | 1,005,199 µs |
| I02A-TRACE-components_20261108T215027Z_e1ce13 | docker-ie-devtools-devtools-1 | 82 | 1,005,247 µs |
| I02A-TRACE-components_20261108T215027Z_e1ce13 | docker-ie-devtools-grafana-1 | 82 | 1,005,174 µs |
| I02A-TRACE-components_20261108T215027Z_e1ce13 | docker-ie-devtools-node-1 | 82 | 1,005,219 µs |
| I02A-TRACE-components_20261108T215027Z_e1ce13 | docker-ie-devtools-prometheus-1 | 82 | 1,005,153 µs |
| I02A-TRACE-components_20261108T215027Z_e1ce13 | docker-ie-i02a-l1-capture-1 | 78 | 1,005,294 µs |
| I02A-TRACE-components_20261108T215027Z_e1ce13 | docker-ie-i02a-l1-client-1 | 9 | 1,006,008 µs |
| I02A-TRACE-components_20261108T215027Z_e1ce13 | docker-ie-i02a-l1-server-1 | 81 | 1,005,405 µs |
| I02A-TRACE-components_20261108T215027Z_e1ce13 | docker-keen_perlman | 1 | n/a |
| I02A-TRACE-components_20261108T215027Z_e1ce13 | engine | 12 | 1,003,652 µs |
| I02A-TRACE-components_20261108T215027Z_e1ce13 | gpu0-nvidia-smi | 790 | 100,191 µs |
| I02A-TRACE-components_20261108T215027Z_e1ce13 | nvml-500ms | 166 | 500,084 µs |
| I02A-TRACE-components_20261108T215027Z_e1ce13 | nvml-50ms | 1,659 | 50,085 µs |
| I02A-TRACE-components_20261108T215027Z_e1ce13 | nvml-gpm | 829 | 100,087 µs |
| I02A-TRACE-components_20261108T215027Z_e1ce13 | nvml-pcie-rx | 2,758 | 30,092 µs |
| I02A-TRACE-components_20261108T215027Z_e1ce13 | nvml-pcie-tx | 2,758 | 30,089 µs |
| I02A-TRACE-components_20261108T215349Z_561bfe | docker-ie-devtools-dcgm-1 | 84 | 1,005,142 µs |
| I02A-TRACE-components_20261108T215349Z_561bfe | docker-ie-devtools-devtools-1 | 84 | 1,005,262 µs |
| I02A-TRACE-components_20261108T215349Z_561bfe | docker-ie-devtools-grafana-1 | 84 | 1,005,181 µs |
| I02A-TRACE-components_20261108T215349Z_561bfe | docker-ie-devtools-node-1 | 84 | 1,005,131 µs |
| I02A-TRACE-components_20261108T215349Z_561bfe | docker-ie-devtools-prometheus-1 | 84 | 1,005,230 µs |
| I02A-TRACE-components_20261108T215349Z_561bfe | docker-ie-i02a-l1-capture-1 | 79 | 1,005,279 µs |
| I02A-TRACE-components_20261108T215349Z_561bfe | docker-ie-i02a-l1-client-1 | 9 | 1,005,437 µs |
| I02A-TRACE-components_20261108T215349Z_561bfe | docker-ie-i02a-l1-server-1 | 81 | 1,005,218 µs |
| I02A-TRACE-components_20261108T215349Z_561bfe | engine | 11 | 1,003,817 µs |
| I02A-TRACE-components_20261108T215349Z_561bfe | gpu0-nvidia-smi | 795 | 100,196 µs |
| I02A-TRACE-components_20261108T215349Z_561bfe | nvml-500ms | 168 | 500,088 µs |
| I02A-TRACE-components_20261108T215349Z_561bfe | nvml-50ms | 1,678 | 50,085 µs |
| I02A-TRACE-components_20261108T215349Z_561bfe | nvml-gpm | 839 | 100,086 µs |
| I02A-TRACE-components_20261108T215349Z_561bfe | nvml-pcie-rx | 2,788 | 30,090 µs |
| I02A-TRACE-components_20261108T215349Z_561bfe | nvml-pcie-tx | 2,788 | 30,093 µs |
| I02A-TRACE-kernels_20261103T181509Z_52744d | gpu0-nvidia-smi | 8,058 | 100,244 µs |
| I02A-TRACE-live_20261103T185532Z_1c1629 | gpu0-nvidia-smi | 782 | 100,201 µs |
| I02A-TRACE-timeline_20261103T185837Z_e08b8b | gpu0-metrics | 44,466 | 100 µs |
| I02A-TRACE-timeline_20261103T185837Z_e08b8b | gpu0-nvidia-smi | 862 | 100,205 µs |
| I02A-TRACE-timeline_20261107T172848Z_f2ac52 | gpu0-metrics | 48,560 | 100 µs |
| I02A-TRACE-timeline_20261107T172848Z_f2ac52 | gpu0-nvidia-smi | 927 | 100,191 µs |
| I02A-TRACE-timeline_20261108T200246Z_764014 | gpu0-metrics | 69,703 | 100 µs |
| I02A-TRACE-timeline_20261108T200246Z_764014 | gpu0-nvidia-smi | 866 | 100,191 µs |
| I02A-TRACE-timeline_20261108T200246Z_764014 | nvml-500ms | 257 | 500,084 µs |
| I02A-TRACE-timeline_20261108T200246Z_764014 | nvml-50ms | 2,561 | 50,085 µs |
| I02A-TRACE-timeline_20261108T200246Z_764014 | nvml-gpm | 1,278 | 100,084 µs |
| I02A-TRACE-timeline_20261108T200246Z_764014 | nvml-pcie-rx | 4,258 | 30,087 µs |
| I02A-TRACE-timeline_20261108T200246Z_764014 | nvml-pcie-tx | 4,258 | 30,089 µs |
| I02A-TRACE-timeline_20261108T213113Z_1d82c9 | docker-ie-devtools-dcgm-1 | 112 | 1,004,316 µs |
| I02A-TRACE-timeline_20261108T213113Z_1d82c9 | docker-ie-devtools-devtools-1 | 112 | 1,004,327 µs |
| I02A-TRACE-timeline_20261108T213113Z_1d82c9 | docker-ie-devtools-grafana-1 | 112 | 1,004,172 µs |
| I02A-TRACE-timeline_20261108T213113Z_1d82c9 | docker-ie-devtools-node-1 | 112 | 1,004,095 µs |
| I02A-TRACE-timeline_20261108T213113Z_1d82c9 | docker-ie-devtools-prometheus-1 | 112 | 1,004,002 µs |
| I02A-TRACE-timeline_20261108T213113Z_1d82c9 | docker-ie-i02a-l1-capture-1 | 81 | 1,004,458 µs |
| I02A-TRACE-timeline_20261108T213113Z_1d82c9 | docker-ie-i02a-l1-client-1 | 16 | 1,005,886 µs |
| I02A-TRACE-timeline_20261108T213113Z_1d82c9 | docker-ie-i02a-l1-server-1 | 81 | 1,004,714 µs |
| I02A-TRACE-timeline_20261108T213113Z_1d82c9 | engine | 17 | 1,003,461 µs |
| I02A-TRACE-timeline_20261108T213113Z_1d82c9 | gpu0-metrics | 39,982 | 100 µs |
| I02A-TRACE-timeline_20261108T213113Z_1d82c9 | gpu0-nvidia-smi | 815 | 100,183 µs |
| I02A-TRACE-timeline_20261108T213113Z_1d82c9 | nvml-500ms | 225 | 500,081 µs |
| I02A-TRACE-timeline_20261108T213113Z_1d82c9 | nvml-50ms | 2,249 | 50,081 µs |
| I02A-TRACE-timeline_20261108T213113Z_1d82c9 | nvml-gpm | 1,125 | 100,083 µs |
| I02A-TRACE-timeline_20261108T213113Z_1d82c9 | nvml-pcie-rx | 3,737 | 30,083 µs |
| I02A-TRACE-timeline_20261108T213113Z_1d82c9 | nvml-pcie-tx | 3,736 | 30,082 µs |
| I02A_20261103T164324Z_348959 | gpu0-nvidia-smi | 711 | 100,196 µs |
| I02A_20261103T172804Z_a3ca9a | gpu0-nvidia-smi | 710 | 100,201 µs |
| I02A_20261103T172929Z_0e5d39 | gpu0-nvidia-smi | 711 | 100,203 µs |
<!-- /gen:stops -->

Reading the counts:

- The code run's 1.10 M detail rows leave stepping entirely. Its finest stop tier, kernel, has 286 per iteration;
  module has 269.
- Graphs-on timeline runs have no module stops (missing, 3.1) and 207 to 311 kernel stops per iteration.
- Hand-offs are an upper bound: every change of box along a request's rows in start order, including overlaps.
- Runs without traces hold only requests and stamps: about 575 phase stops.

## Decision log

| date | decision | by |
| --- | --- | --- |
| 2026-11-08 | Command center is for learning and intuition across granularities; nsys and ncu are first-class links | owner |
| 2026-11-08 | ncu link-only plus headline counters; nsys event rows stay imported | owner |
| 2026-11-08 | Live GPU load from NVML GPM at 100 ms; other NVML counters at measured refresh; memory used at 50 ms | owner |
| 2026-11-08 | GPM read time kept; the measured ~165 ms lag stated in evidence | owner |
| 2026-11-08 | Dependency installs pre-approved; `nvidia-ml-py==13.615.71` in `devtools/Dockerfile` | owner |
| 2026-11-08 | Option B data layer (ie-run/3, CCVB, `/api/v3`, browser `RunStore`) | owner |
| 2026-11-08 | The v1 devtools page stays until the owner retires it | owner |
| 2026-11-08 | Three dimensions, each with its own tiers; CPU and GPU are hardware, not lanes | owner |
| 2026-11-08 | No stop budget: only real units are stops; jump check instead | owner |
| 2026-11-08 | Every-row walk kept in two modes; rows map to their process; branches shown where created | owner |
| 2026-11-08 | Build natively; no v1 pages embedded in 3D; v1 styling copied, never imported | owner |
| 2026-11-08 | Stacked world and execution spine kept as worlds; stages and cube dropped (D10) | owner |
| 2026-11-08 | Tiers independent per dimension with a paired / independent toggle; everything clickable, keys as shortcuts | owner |
| 2026-11-08 | Architecture uses v1 exact styling and all 26 component boxes | owner |
| 2026-11-08 | Playback plays every event in the bounds and loops; the tier sets the bounds only | owner |
| 2026-11-08 | One tier selector per dimension (the header ladder) | owner |
| 2026-11-08 | Execution spine is 2D and zoomable; lens Architecture, Hardware, Split; no empty space | owner |
| 2026-11-08 | Bottom bar, playback clock and hardware sidebar follow v2-scene, rebuilt | owner |
| 2026-11-08 | Colour means logical flow (request in, prefill, decode loop, stream out), not OS process | owner |
| 2026-11-08 | Header uses D10 style and sizing | owner |
| 2026-11-08 | Three worlds (Stacked, Spine with Split lens at 55%, Architecture full screen); lanes variant dropped | owner |
| 2026-11-08 | Each spine pane zooms and pans on its own | owner |
| 2026-11-08 | Back / forward through selections in the bottom bar | owner |
| 2026-11-08 | The command center is a shell around load, launch and compare | owner |
| 2026-11-08 | Rep world added; every rep has key moments (`moments.toml`) | owner |
| 2026-11-08 | D13 is the initial layout; tiers default to Independent | owner |
| 2026-11-08 | Load, Launch and Compare in the header; compare in other worlds is an A / B switch | owner (with D13) |
| 2026-11-08 | One doc (this one); the prototype is the baseline for `/static/cc/index.html`, not a separate product | owner |
| 2026-11-08 | The verify skill stays in place; production is built to it | owner |
| 2026-11-08 | CPU-side counters are required | owner |
| 2026-11-08 | Merge into main later | owner |
