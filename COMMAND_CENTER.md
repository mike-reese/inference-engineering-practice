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
python3 design/dimensions/map_surfaces.py --write          # section 9; exits 1 if a surface is unmapped or a place is unknown
uv run --no-project --with duckdb python design/dimensions/stop_counts.py --write   # section 10; exits 1 if the stop check fails
uv run --no-project --with duckdb python design/dimensions/stop_counts.py --self-test   # must exit 1
```

Both read the ladders and each kind's place from `devtools/registry/kinds.json` (P1).

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
  (0.5x to 16x), drag to pan, double-click to reset. Each pane keeps its zoom across reloads. Zoom does not snap to
  tier bounds; flying to a tier already sets that tier's window (choice 2).
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
| Alt ← → | previous / next row of the focused tier (walk every row, section 3.4) |
| [ ] | back / forward through selections (choice 4) |

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
| `result` | optional: the run's result file the paths read, relative to the run folder. Default `latency.json`, read per request (the moments' `request` entry); any other file is read whole (I02C `readout.json`, I01-L2 `analysis/summary.json`) |

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
| module | attention, MLP, linear, norm, with their ops | module `forward()` frames (code run); in graphs-on runs, those frames matched to each forward step's kernels (M2) | 269 per iteration (code run); 173 per decode and 221 per prefill step (R1) | measured in the code run; inferred in graphs-on runs |
| kernel | one kernel, copy or memset, with the CPU call that launched it | nsys or PyTorch profiler | 2.3 µs median kernel | measured |

- Everything finer than a module is **detail**: built-ins, nn plumbing, nested aten ops, CUDA queries, syncs, OS
  calls and profiler rows. They stay in the store and open in the inspector. They are never stops.
- A launch call and its kernel are one stop, seen from the CPU and the GPU. The code run's 18,309 launch calls match
  its 18,309 device rows by correlation id (measured).
- Graphs-on runs replay a captured graph, so they have no module frames. Their modules are inferred (M2,
  `store/modules.py`). Each forward step's device rows are aligned with the code run's by a longest common
  subsequence of kernel short names, copy directions and memsets. A code-run module becomes a row (kind
  `inferred module`, evidence "Inferred" with the rule) only when every device row it launched pairs and the pairs
  are consecutive on one stream. The match is not 1:1. The 286 and 207 kernels per iteration are run averages; per
  forward step the code run has 242 device rows in decode and 311 in prefill, R1 has 267 and 311, and each R1 decode
  iteration also holds 43 sampling rows (measured). Decode attention runs different kernels (code run: masked MHA,
  one kernel; graphs on: XQA, two), so attention and its backend are not inferred in decode. On R1, 101 of 310
  kernel stops per decode iteration stay unmatched (48 XQA kernels, 10 other rows of the forward stream, 43 sampling
  rows), 49 of 354 per prefill (6 copies of the forward stream, 43 sampling rows), all measured. The spine's module
  row says "inferred", and its headline shows the unmatched count of the cursor's iteration.

### 3.2 Hardware

| tier | what you see | source | resolution | status |
| --- | --- | --- | --- | --- |
| system | utilization of every GPU and host: GPU %, VRAM, CPU %, RAM | `nvidia-smi` query; NVML; Docker stats per container; host `/proc/stat`, `/proc/meminfo` (P2) | 100 ms; 50 to 500 ms; about 1 s; 100 ms | GPU and per-container CPU and memory measured (Docker stats stored since run 1d82c9); host CPU % and RAM used added in P2 |
| node | the board: CPU, RAM, chipset, PCIe and DMI links, GPU, NVMe, NIC | inventory probe (`registry/inventory.json`) | static | measured |
| device | bytes moving between devices: PCIe copies, network frames, NVMe reads, RAM traffic | memcpy rows with bytes; nsys PCIe RX/TX %; tcpdump; `/proc/diskstats` (P2); `perf` `uncore_imc` (P2) | per copy; 100 µs; per frame; 100 ms; 100 ms | PCIe and network measured; NVMe and RAM bandwidth added in P2 |
| unit | parts inside a device: SMs active, tensor, warps in flight, DRAM read/write, copy engines; CPU cores, L3 | nsys GPU metrics; `/proc/stat` per core (P2); `perf` `uncore_cbox_*` (P2) | 100 µs; 100 ms; 100 ms | GPU measured; CPU cores and L3 added in P2 |
| kernel traffic | one kernel's DRAM and L2 bytes, occupancy, throughput, grid over 36 SMs | ncu | per kernel, profiled iterations only | measured for the 266 profiled kernels of iteration 67 in run f2ac52; run R1 (section 7.3) replaces it; tie to the run inferred |
| SM internals | warps, shared memory, registers, source lines | ncu sections | per kernel | link only (open in Nsight Compute) |

- CPU-side counters are required (owner, 2026-11-08): CPU cores, L3 and RAM bandwidth, stored, not live only. The
  kernel exposes `uncore_imc` and `uncore_cbox_0..7` (measured 2026-11-08). `perf` is not installed and
  `perf_event_paranoid` is 2, so the capture container gets `perf` and `CAP_PERFMON`; the host sysctl stays. NVMe
  I/O comes from `/proc/diskstats`. Work item P2.
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
another container, process or box. Samples are state, never stops. No stop budget: only real units are stops. The
stop check (P1) guards against a detail kind landing on a stop tier: kernel stops must equal the device rows in the
run's nsys report, and a mutation self-test proves the check fails when a detail kind is mapped to a stop tier.

**Walking every row (owner).** Below the stop tiers, two modes: every row of the focused tier in time order across
every process, or only the rows of the selected process or object (about 64 detail rows per `linear` call).

**Process identity and branches (owner).** Every row maps to its process (a row's lane is a thread or stream under
its process in the things tree, measured). A process or thread that creates another shows the branch at the step
where it happens. Thread creation is recorded (42 `pthread_create` calls in the timeline run, measured). Process
creation (the MPI-spawned worker) is missing: it happens before the profiler's capture range. P2 adds it: the
capture container polls the server container's `/proc` every 100 ms and writes a `process start` row per new pid
(pid, ppid, command, start time from `/proc/<pid>/stat`, 10 ms clock-tick resolution).

## 4. Fit test: future reps

A rep fits when it only adds registry entries. This is a design check, not acceptance: I03 and later reps do not exist
yet (owner, 2026-11-08). Each change below is built with its rep, not in the migration of section 7.

| rep | adds | verdict |
| --- | --- | --- |
| I06, three engines and a hand-written kernel | containers `vllm`, `sglang`; process `double_kernel`; a component map per engine | structure change: `components.json` holds one map; it needs one per engine, keyed by the run's engine |
| I27, Kubernetes | kind `k8s event` (architecture / container stop); things cluster, control plane component, k8s node, pod | fits; apply-to-ready becomes the stops of architecture / container |
| I30, TP 8 on 8 GPUs | kind `nccl collective` (execution module, hardware device NVLink, architecture runtime); 8 GPUs, NVLink, 8 ranks | fits as entries; kernel stops grow about 8x, so stepping needs a rule: one GPU, or all ranks in time order |
| I33, Mooncake KV with NVMe spill | kind `kv transfer` naming source and destination things; container `mooncake_master`; component transfer engine | fits if the row names its things; needs NVMe and RAM bandwidth (P2) |

## 5. Walkthroughs (acceptance tests for the production build)

Only reps that exist are acceptance tests: I02A and I02C today (owner, 2026-11-08). Each walkthrough is a script
(`devtools/verify/walkthroughs.sh`, built in M1) that drives the page in `ccv` and checks every value against a
source outside the interface: the run's `latency.json`, its nsys report (`.sqlite`) or its client records.

- **I02A, which client time is the first token?** On run R1. Execution / phase: step the request's hops (headers
  sent by ASGI, role event, first token event). Cross to architecture / component: the ASGI box lights while the
  worker's forward box is still busy. Cross to hardware / device: the GPU is running prefill when the headers leave.
  One cursor, three answers. The Rep world's moments 1 to 4 jump to these points. Checks: each hop's time equals
  `latency.json` (`wire.headers_ms` and the TTFT segments); the GPU state at the headers time equals the R1 nsys
  report (a prefill kernel running).
- **I02C, two requests in flight on one slot.** On an imported I02C run. Execution / request shows two request
  stops, A and B. Checks: each stop's send and first-content times equal `send_ns` and `first_content_ns` of that
  client in the run's `readout.json`, moved onto the run clock.

## 6. Data layer (built: ie-run/3 and `/api/v3`)

This is the contract the backend (`devtools/backend/store/`) and `cc/store/` implement. It stays as is; section 7
adds what the interface needs on top.

### 6.1 One row table, one total order

- Every source becomes rows of one event table: run.json spans, nsys, component and client stamps, pcap frames,
  engine stats, docker events. Samples are a separate table of clocked values, never stepped.
- Total order is `(start, id)`. `id` is dense `0..N-1`; in a final generation it follows `(start_ns, source order)`.
- Times are Float64 ns from the run's `t0_ns`. `seek` rounds the cursor once, so a fractional ns never exists.
- Hot columns (the browser holds these, 57 B per row; `flow` added in P3):

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
| `name` | `<u4` | string index (`manifest.names`) of the short name (choice 7) |
| `bytes` | `<f8` | bytes moved, NaN if none |
| `layer` | `<i2` | decoder layer of a kernel (RMSNorm rule of `trace/adapters/nsys.py` `layer_of`), `-1` = none |
| `flow` | `\|u1` | logical flow: 0 request in, 1 prefill, 2 decode loop, 3 stream out, `0xFF` = none |

- Cold columns stay in Parquet; the server answers them by id: `eid` (the stable URL key), `what`, `args`,
  `evidence`, `term`, `source`, `corr`, `quirk`, `parent_rule`, `raw_file`, `raw_ptr`, `code_origin`, `code_where`,
  `full_name` (the full demangled name when `name` is shortened).
- `backend/store/schema.py` is the one column list; `frontend/cc/store/columns.js` mirrors it; `make store-check`
  fails when they differ.

### 6.2 Storage tiers (today) and the execution ladder (target)

The store ranks rows on a 7-tier ladder in `devtools/registry/kinds.json`: request, iteration, stage, op, call,
device, os. Its rungs mix the three dimensions. Tier 4 (call) holds 1,120,878 of 1,140,076 rows in the code run
(measured), so stepping on it walks about 17,500 rows per iteration. The interface steps on the per-dimension tiers
of section 3 instead. The storage tier stays as a column until nothing reads it (M4). Kind-by-kind placement is
each kind's `place` in `devtools/registry/kinds.json` (P3); section 9 maps every surface onto it.

- `derive_tier`: the kind's tier; one finer when nested in the same kind (NVTX only). `tier(child) >= tier(parent)`
  must hold, or the import stops and names the row.
- The derived iteration (scheduler stamp to the next) has kind `iteration`. The executor's NVTX forward step covers
  only 0.92 ms of a 3.48 ms period (measured), so it is imported as an `nvtx range`. A run with no scheduler stamps
  has no derived iteration rows.
- A derived iteration ends where its last row ends (device work, NVTX range or stamp carrying its `iter`, whichever
  ends last), not at the next scheduler stamp. The idle gap between requests belongs to no iteration (choice 5;
  before P3, iteration 129 of the timeline run spanned 12.55 s across that gap).

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
g<gen>/aux.json               calculated metrics with their inputs (row ids, sample indexes) and clock, facts, measures
g<gen>/<block>.ccvb           binary twin of each hot block (typed arrays in the browser)
capture/<source>.jsonl        live-only sources: gpu (NVML), docker, docker-stats, engine, engine_iterations_raw
capture/clock.json            the run's t0_ns and wall offset, fixed when the live run opens
```

- `kinds`: `[{code, name, tier, nest_bump, derived, color, label, home}]`; `link_kinds`: `[{code, name, cause, label}]`.
- `metrics`, the catalog of the run's samples: `[{code, metric, label, unit, thing, group, sidebar, source,
  period_ms, period_ns_measured, evidence}]`.
- `blocks`: `[{name, table, band, rows, t, tier_counts, bytes, etag}]`. Bands: `spine` (tiers 0..2, resident) and
  `fine` (tiers 3..6, blocks of 32,768 rows). Every browser query merges across blocks.
- `tools`: `{nsys: {run, path, session_start_ns, evidence}, ncu: {run, path, kernels, counters}}`. A kernels-level
  run's `ncu` also names its timeline run: `timeline: {run, generation, kernels, event_eids}` (the tied kernel rows
  by eid), so a kernels run imports after its timeline run.
- A metric's `clock` in `aux.json` names the observers whose clocks stamp its inputs, in input order: `client`,
  `wire`, `engine` for those row sources, the source name for any other, the sample group for samples.
- Container things carry `image`, `networks`, `netns` and `mem_limit` from the run's `topology.json` when it exists.
- CCVB: `"CCVB"`, u32 header length, header JSON `{schema:"ccvb/1", table, block, band, gen, rows, base_rows, t,
  tier_counts, dict_delta, metrics, columns:[{name,type,offset,length}]}`, then 8-byte-aligned column buffers.
- The previous generation stays until the next import; older ones are deleted.
- ncu prints display units (us, Mbyte); the import scales headline counters to the `registry/ncu.json` unit with its
  `scale` table and records the factor as `unit_rule`.

### 6.4 Retrieval

Server `backend/store/serve.py`:

- `GET /api/v3/runs`: `{runs: [{run, generation, status, t0_ns, head_ns, rows, tier_counts, bytes}]}`, newest first
- `GET /api/v3/runs/{run}/manifest` (ETag, no-cache, 304), plus `metric_places`: every registry metric's place (its
  hardware tier), joined when served, so a registry change needs no import
- `GET /api/v3/runs/{run}/blocks/{gen}/{name}` (a CCVB block or `aux.json`; immutable, ETag)
- `GET /api/v3/runs/{run}/detail?ids=` (at most 256; or `?eids=`): hot fields decoded, cold fields, `parents`,
  `cause`, `links`, `metrics`, `counters`, and `open: {nsys: {run, path, t}, ncu: {run, path, profile_row}}`
- `GET /api/v3/runs/{run}/raw?id=`: the raw record from the run folder
- `GET /api/v3/reps` (`backend/store/reps.py`): `{reps, runs}` in D13's `session-data.json` shape; a run's `result`
  is read from the result file its rep's `moments.toml` names (2.6): `latency.json`'s summary of the moments' request,
  or any other file whole; null when the run has none (results not computed)
- `WS /api/v3/stream?run=&have=`: append deltas, seal (`derived: {ids, parent, cause, tier, depth}`), generation
  and status frames

Browser: one `RunStore` (`frontend/cc/store/run.js`) answers `step(dim, tier)` and `walk` (the place and stop rules
of the manifest, applied by `store/dims.js`), `grainFor`, `widthFor`, `chain`, `activeBy`, `scan`, `count`, `row`,
`children`, `linksOf`, `samplesAt`, `series`, `metricTier`, `detail`, `resolve`, `head`. It hides
blocks, CCVB, the socket, dictionaries, indexes, the id map and generations.

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
  records, run.json metrics and facts, `serves` links, layers, inferred modules (M2).
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

- Browser memory for no network on any step, scrub or zoom: budget 160 MB per open run (choice 9), counted as the
  total of every typed array the run's `RunStore` and its units hold (`ccv perf` `memory_mb` `typed_mb`; MB = 2^20
  bytes). Measured 2026-11-09 in the spine world: 109.89 MB for the code run, 1.14 M rows at about 101 bytes per row
  (hot columns 57, start, end and the order lists 24, the id map 8, dimensions 6.9, block indexes 4.7), the same in 3
  opens. The browser holds no per-row GPU copy: the spine paints its units on a 2D canvas. Compare holds two runs.
- Two encodings of the hot columns (Parquet canonical, CCVB derived) for zero-parse loads and DuckDB for agents.
- A reload (target 250 ms) when a new generation lands, for one id rule per generation.

## 7. Migration plan: prototype to production

Target: `/static/cc/index.html` is the command center of section 2, drawn only from recorded runs in the v3 store.
No scratch value ships (owner, 2026-11-08): every number, unit, box and moment on the page comes from a run, the
registry or a rep file. Three prerequisite steps put the checks (P1), trackers and runs (P2) and data (P3) in place.
M1 then moves the whole interface at once, Load, Launch and Compare included. M2 to M4 follow on the production
page. Each step starts only when the previous step's check passes. No open choice blocks a step (section 8).

The prototype's files move into `devtools/frontend/cc/`; the 3D side-by-side levels go in M1. The verify skill stays
where it is (`.claude/skills/verify-command-center`); M1 rewrites its recipes for the new page.

### 7.1 What moves where

| prototype (`prototypes/D13/`) | production (`frontend/cc/`) | change |
| --- | --- | --- |
| `model.js` (state, frame loop, history, session, keys, hash) | `control/control.js`, `control/keys.js`, `control/url.js` | `Control` gains the D13 state (world, focus, tiers, paired, metric, bounds, playEvent, dock, nav, session, head, follow); one keymap (2.4); the hash of 2.3 replaces `#side?run=&t=…`; state exposed read-only as `window.__cc` for `ccv` |
| `data.js` (scratch units, boxes, samples, metrics) | `store/run.js`, registry reads | not copied: every scratch value becomes a store query or a registry read (7.2) |
| `session.js`, `tools/build_session.py`, `session-data.json` | `session.js` plus `GET /api/v3/reps` (P3) | the snapshot is not copied |
| `shell.js`, `chrome.js` | `chrome/` | Launch posts `/runner/jobs`; Compare opens two stores |
| `stage.js`, `worlds/rep.js`, `worlds/stacked.js`, `worlds/spine.js`, `worlds/architecture.js` | `worlds/` | "show me" looks up the moment's `event` in the run; stand-in regexes are not copied |
| `arch.js` | `arch.js` | box state from `activeBy("comp", t)` and things; the request panel from the cold `args` of client and stamp rows |
| `hwside.js` | `sidebar/sidebar.js` | rows from the manifest metric catalog (`sidebar: true`), each with its source and measured period |
| `bar.js` | `control/bar.js`, `inspector/` | tab list already matches `inspector/tabs.js`; keep `nsight.js` links |
| `zoom.js` | `zoom.js` | as built |
| `regress.sh` | `devtools/verify/regress.sh` (P1) | page from `CC_URL`; expectations from the store and rep files |
| (none) | `levels/*`, `scene/*` (3D side-by-side levels) | deleted in M1. The Stacked world uses no `scene/` helper. `scene/rows_gpu.js` and the store's per-row GPU copies it read (43.52 MB in the code run) are deleted: the spine paints its units on a 2D canvas, so nothing called it; `scene/samples.js` (imported by the sidebar and inspector) moves to `sidebar/` |

### 7.2 Where each scratch value comes from

Every list in `data.js` and `hwside.js`, with its production source. "P2" and "P3" mark the step that adds it.

| D13 scratch value | production source | status |
| --- | --- | --- |
| execution units (request, iteration, phase, layer, module, kernel) | store rows, placed per dimension by `kinds.json` (P3) | rows measured; placement P3 |
| module units of graphs-on runs | kind `inferred module`: the code run's module frames matched to each forward step's device rows (`store/modules.py`; the code run per rep in `registry/modules.json`) | inferred, M2 |
| kernel grid, block, registers, shared memory | cold `args` of each kernel row (nsys) | measured |
| kernel DRAM and L2 bytes, occupancy, throughput | `profiles.parquet` (ncu), profiled iteration only; other kernels say "not profiled" | measured (f2ac52; R1) |
| transfers (hardware / device stops) | memcpy and memset rows with bytes | measured |
| flow of each unit | hot `flow` column (P3 rule) | P3 |
| architecture things, 26 component boxes | manifest `things`; `registry/components.json` | measured |
| hardware things | `inventory.json` through the manifest | measured |
| SMs active, DRAM read/write, PCIe, warps, copy engines | nsys GPU metrics (replay, 100 µs); NVML GPM (live, 100 ms) | measured |
| GPU utilization, VRAM, SM clock, power, temperature | `nvidia-smi` `gpu.csv`; NVML 50 ms and 500 ms groups | measured (run 1d82c9) |
| per-container CPU, memory, network | Docker stats sample groups | measured (stored since run 1d82c9) |
| host CPU % (total and per core), RAM used | `/proc/stat`, `/proc/meminfo` at 100 ms (P2) | P2 |
| L3 and RAM bandwidth | `perf stat -I 100` on `uncore_cbox_*` and `uncore_imc` (P2) | P2 |
| NVMe I/O | `/proc/diskstats` for the SN7100 at 100 ms (P2) | P2 |
| process starts (the MPI-spawned worker) | `/proc` poll of the server container, kind `process start` (P2) | P2 |
| request payload per step | cold `args` of client request and stamp rows | measured |
| calculated metrics and their inputs | `aux.json` | measured |
| rep catalog, runs, result summaries | `GET /api/v3/reps` (P3) | P3 |
| key moments | `moments.toml` per rep; `event` resolved against the run's names (P3 lint) | I02A file exists |
| live head and mask | `head_ns` and stream frames | measured |
| hardware each unit ran on | the kind's hardware place in `registry/kinds.json` (section 9), refined by lane (thread: CPU, stream: GPU) | inferred, P3 |
| hardware tier of each sidebar metric (`hwside.js` `tier`) | the metric's hardware place in `registry/kinds.json` (section 3.2), joined to the manifest when served | inferred, M1 |
| process role (HTTP process, executor worker) | each component boundary maps to the pid whose lanes carry its stamps | inferred, P3 |
| GPU memory held per process and container | `nvidia-smi --query-compute-apps` at 500 ms, group `gpu-apps` | measured, P2 |
| kernel class (gemm, attention, memory, other) | name rule in `registry/kinds.json` | inferred, P3 |
| SMs used by a kernel | min(36, grid blocks) from cold `args` | inferred, labelled |
| containers shown | compose and docker names merged into one thing; only the rep's and devtools' projects kept | P3 importer fix |
| container image, networks, network namespace, memory limit | the run's `topology.json` (`docker inspect` after `compose up`), set on the container thing as `image`, `networks`, `netns`, `mem_limit`; a run without it says "image not recorded" | measured (runs with `topology.json`) |
| box run counts and flow stripes | one load-time aggregate over `comp` and `flow` in `RunStore` | P3 |

### 7.3 Runs to record (owner approved, 2026-11-08)

- **R1, the reference run.** I02A `timeline` action with every P2 tracker on, then its `kernels` (ncu) run on the
  same prompt, tied by the rule of `registry/ncu.json` (iteration 67). R1 replaces f2ac52 as the run with ncu
  counters and 1d82c9 as the newest timeline run. `regress.sh` and the I02A walkthrough run on R1. Its run ids go in
  the decision log when recorded.
- **I02C.** No new recording first. P2 fixes the importer and imports `I02C_20261107T181031Z_5626f7` and
  `I02C_20261107T181629Z_c37c3e`. `I02C_20261107T180301Z_e0e4f0` has no clock anchor and stays unimported, with
  its reason in the import log. If either run still stops after the fix, record one I02C run (approved).
- **M1's Launch check** records one I02A `off` run through the runner (approved).
- The code run `I02A-TRACE-code_20261103T170709Z_0ac2db` stays the module source; no re-recording.

### 7.4 Steps (each ends in a check that can fail)

| step | change | check |
| --- | --- | --- |
| P1 checks that can fail | Merge `v2-scene` into `main` (choice 11); the container mounts one checkout. `regress.sh` moves to `devtools/verify/`, reads its page from `CC_URL` (default `/static/cc/index.html`), stops on its first check when `window.__cc` is missing, asserts a non-null value before every before / after comparison, and reads expected values from the store and files (run list from `/api/v3/runs`, TTFT from that run's `latency.json`, moment count from `moments.toml`, box count from `components.json`), never literals. History moves to `[` `]`; Alt ← → walks rows (choice 4). The runner gains `dry_run` on `POST /runner/jobs` (validates the action and options, returns the job, starts nothing); `regress.sh` launches with it. `stop_counts.py` reads placement from `registry/kinds.json` (the file `RunStore` reads), drops the jump check, and asserts per run: kernel stops equal the kernel, memcpy and memset rows of the run's nsys `.sqlite` (39,768 for f2ac52, measured); detail is never negative; every row has one tier per dimension. `stop_counts.py --self-test` maps `cuda runtime call` to phase and must exit 1. `map_surfaces.py` reads D13 and `cc/` instead of D5v2 and `cc/levels/`, and fails when a new place names a world or tier missing from the ladders. D13 sets `window.__cc` too. | Against the current `/static/cc/index.html`, `regress.sh` exits 1 at its first check (today 12 of 50 pass on a page without the state handle). `stop_counts.py --self-test` exits 1. `stop_counts.py` and `map_surfaces.py` exit 0 on every stored run. `make store-check` passes. |
| P2 trackers, importer, runs | A `trackers` sidecar (own image, shares the server's PID namespace, only `CAP_PERFMON`) records host CPU % (total and per core) and RAM used from `/proc` at 100 ms; L3 and RAM bandwidth with `perf stat -I 100` on `uncore_cbox_*` and `uncore_imc` (`perf` installed in the image, `CAP_PERFMON`); NVMe I/O from `/proc/diskstats`; process starts from a `/proc` poll of the server container (new kind `process start`). Each source has one adapter for live and final (6.5), and each metric names its source and measured period in the catalog. The importer turns the run.json Prometheus scrape spans into samples of group `prometheus` (today an I02C import stops on `prometheus/baseline/line 103`). Record R1; import R1 and the two I02C runs (7.3). | R1's manifest has every new metric group, with `period_ns_measured` near 100 ms. Under a 10 s memory load, the tracker's RAM bandwidth is within 5% of a standalone `perf stat -a -e uncore_imc/data_reads/,uncore_imc/data_writes/` over the same 10 s, and host CPU % is within 2 points of `mpstat 1`. R1 has a `process start` row for the executor worker. R1's ncu profiles cover every kernel of iteration 67 with matching names. Both I02C runs import. `make store-check` passes. |
| P3 data shape | `kinds.json` gains each kind's place per dimension and the hand-off rule (from `design/dimensions/proposal.json`, then deleted); `RunStore.step` steps by (dimension, tier); the every-row walk has its two modes (3.4). Kernel short names (choice 7). Derived iterations end at their last row (choice 5). Lane `gpu0/stream 4294967295` is labelled "no stream" (choice 8). Hot column `flow`: prefill or decode from the iteration's kind, request in and stream out from the request's client and server stream rows. `GET /api/v3/reps`: reps, `rep.toml` actions, README sections, moments, and the store's runs with labels and a `latency.json` summary, or "results not computed". A moments lint resolves every `at` and `evidence` path and every `event` in each run of the rep. `schema.py`, `columns.js` and the CCVB writer gain `flow` and cold `full_name`. | `stop_counts.py` exits 0 and its self-test exits 1. In `ccv`, `RunStore.step` counts per tier equal `stop_counts.py` for R1 and the code run. No device row is named bare `kernel` (12,096 of 39,768 today). No derived iteration in R1 contains a 100 ms span with no row of its own. Each R1 stream-out unit overlaps the next decode iteration, and its time range matches the client's token arrival times and `frames.tsv`. An I02C run steps through two request stops. The moments lint passes for I02A. `make store-check` passes. |
| M1 production cutover | `cc/` gets the D13 chrome, stage, four worlds, bar, sidebar and shell, drawn only from `RunStore`, the registry and `/api/v3/reps`. Load replays any stored run; Launch posts `/runner/jobs` and follows the live run through `RunWatcher` and the stream, with mask and follow; Compare opens two stores with the A / B switch (choice 3). "Show me" uses the moment's `event`. `levels/` and `scene/` are deleted; `data.js` and `session-data.json` are not copied. The verify recipes are rewritten for the new page, one per world plus Load, Launch, Compare and the inspector. `walkthroughs.sh` (section 5) is written. | `regress.sh` passes on `/static/cc/index.html` with R1, with 0 console errors. `walkthroughs.sh` passes. `cc/` contains no `scratch`, `stand-in` or `simulated` text and no import from `prototypes/`. One real Launch of I02A `off`: followed live, the shown head equals the stream's `head_ns`, and at its end it becomes a replay with no command; `make store-check` passes on it (live eids in final). Compare: B − A in the Rep world equals TTFT recomputed from each run's client rows in the store, not read from `latency.json`. The sidebar's DRAM % at an R1 cursor equals the nsys GPU metrics of that 100 µs window in R1's `.sqlite`. The code run opens within 160 MB (`ccv perf`). |
| M2 module inference | Graphs-on runs get module rows by matching kernel sequences against the code run's modules. Until then their module tier says "missing" (3.1). | For R1, every inferred module's kernel names equal the code run's for that module; each module span contains its kernels; unmatched kernels per iteration are counted and shown (286 against 207 kernels per iteration, measured, so 1:1 cannot hold); per-name kernel totals equal `nsys stats -r cuda_gpu_kern_sum` for R1. |
| M3 rep files | `moments.toml` for every rep with recorded event runs: I01-L2, I02A, I02C; `rep.toml` for each with a `rep.py` (I02A, I02C). I01-L2 has no `rep.py`, so it has no `rep.toml` and is replay only. I01A, I01B, I01C and I02B have no event runs to import and stay "No recorded runs". | The moments lint passes for I01-L2, I02A and I02C, and a rep whose moments resolve on no run fails it. The Rep world lists moments for each, and `regress.sh` passes. |
| M4 retire | Delete `store_v2.py` and `/api/v2`, `prototypes/D1`, `D2`, `D5v2`, `D13`, the v2 collectors, the legacy D5v2 recipes, and the storage `tier` column once nothing reads it. The v1 page stays until the owner retires it. Deleting `/mnt/ie-data/cc-v2-proto` (29 GB, the v2 store) is data deletion: the owner confirms it at M4 (choice 1). | `map_surfaces.py` exits 0 reading only `cc/` and v1. A grep of `devtools/` and the skill finds no removed path. `regress.sh` passes with 0 failed requests in the console log. `make store-check` passes. |

## 8. Resolved choices (owner, 2026-11-08, on the agent's recommendation)

1. **v2 alongside during the migration.** The v2 store and D5v2 stay read-only until M4. The verify skill opens D5v2
   only for legacy recipes. M4 removes the code; the owner confirms deleting the 29 GB v2 store at M4.
2. **Snap-to-tier zoom.** No snap. Flying to a tier already sets that tier's natural window (3.4); wheel zoom stays
   free from 0.5x to 16x.
3. **Compare as a split.** No split. The A / B switch is final; the Rep world shows A, B, B − A and %.
4. **Key for walking every row.** Alt ← → walks every row (owner). Back / forward moves to `[` and `]`.
5. **A derived iteration across an idle gap.** An iteration ends where its last row ends (6.2), so the gap between
   requests belongs to no iteration. `derive.py`, P3.
6. **`layer` hot or cold.** Already hot (measured 2026-11-08): `schema.py` and `columns.js` carry `layer <i2`, and
   the browser holds no copy of the rule. Closed; the earlier 7.2 row was stale.
7. **Kernel short names.** Yes. The hot `name` is a short name: the demangled function's base name, and when that
   base is generic (`kernel`, `Kernel`, `Kernel2`, `device_kernel`), the leaf identifier of its first template
   argument appended. The full demangled name moves to cold `full_name`. P3.
8. **Stream id -1.** The lane is labelled "no stream"; the inspector shows the raw id 4294967295. P3.
9. **Browser memory for the code run.** Accept it: the budget is 160 MB per open run (6.6), so the code run (120 MB)
   loads whole and stepping keeps needing no network. Fine blocks on demand would put the network back on the step
   path. The host has 62 GiB of RAM.
10. **Kernel duration unit.** No bug in v3 (measured 2026-11-08): ncu durations are stored in ns (`unit_rule`
    "report value in us times 1000 = ns"); the shortest profiled kernel in f2ac52 is 1,536 ns, and its profiled
    kernel rows have a median of 2,320 ns. Closed.
11. **Merge into main.** Before P1, replacing "later". The dev server reads rep files from the main checkout
    (`/repo`), which has no `moments.toml`, and the runner records from `main`, so P2's trackers must be on `main`.

## 9. Map of every current surface

Generated by `map_surfaces.py` from the registry (tiers, kinds and each kind's place), the D13 worlds (`model.js`),
the v1 `index.html`, the `cc/` panels and `cc/control/keys.js`. It fails when a surface has no entry, an entry
matches no surface, or a new place names a tier missing from the ladders or a world D13 does not draw. "owner"
marks an open choice.

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
| kind | engine timestamp | execution: detail (of its request); hardware: -; architecture: component (worker) |
| kind | component stamp | execution: phase; hardware: -; architecture: component |
| kind | client event | execution: phase; hardware: -; architecture: component (client) |
| kind | client transport | execution: phase; hardware: -; architecture: component (client transport) |
| kind | network frame | execution: phase; hardware: device (NIC link); architecture: container (network) |
| kind | nvtx range | execution: phase if top-level, else detail; hardware: device (CPU); architecture: component (worker) |
| kind | cuda graph node | execution: detail; hardware: device (GPU); architecture: software layer (runtime) |
| kind | cuda runtime call | execution: kernel (CPU side) if launch, else detail; hardware: device (CPU); architecture: software layer (runtime) |
| kind | cuda driver call | execution: kernel (CPU side) if launch, else detail; hardware: device (CPU); architecture: software layer (runtime) |
| kind | cuda synchronization | execution: detail; hardware: device (CPU); architecture: software layer (runtime) |
| kind | cuda event record | execution: detail; hardware: device (CPU); architecture: software layer (runtime) |
| kind | cpu operator | execution: detail (under its module); hardware: device (CPU); architecture: software layer (toolkit) |
| kind | python call | execution: module if module forward, else detail; hardware: device (CPU); architecture: software layer (toolkit) |
| kind | kernel | execution: kernel; hardware: kernel traffic if profiled, else unit (SMs); architecture: software layer (device code) |
| kind | memcpy | execution: kernel; hardware: device (PCIe link, copy engine); architecture: software layer (device code) |
| kind | memset | execution: kernel; hardware: unit (copy engine, VRAM); architecture: software layer (device code) |
| kind | os runtime call | execution: detail; hardware: device (CPU); architecture: process (OS) |
| kind | profiler overhead | execution: detail; hardware: device (CPU); architecture: process (profiler) |
| kind | profiler message | execution: detail; hardware: -; architecture: process (profiler) |
| kind | process start | execution: detail; hardware: -; architecture: process (lifecycle stop) |
| kind | inferred module | execution: module; hardware: device (GPU); architecture: software layer (toolkit) |
| D13 world | Rep | the session's front page, outside the dimensions: moments put the cursor on stops in any dimension |
| D13 world | Stacked world | all three dimensions in 3D: architecture standing on its hardware (the board as floor), execution as a moving pulse |
| D13 world | Execution spine | execution / request to kernel as bands, with a lens on architecture and hardware |
| D13 world | Architecture | architecture / container, process and component (the v1 drawing) over a thin execution strip |
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
| panel | sidebar | hardware / system and device and unit, each metric at its place in registry/kinds.json (a click focuses that tier); persistent in every view |
| panel | inspector | detail of the selection in any dimension; holds every detail row |
| panel | bar | the timeline strip: ticks are the stops of the focused (dimension, tier) |
| control | previous / next stop of the focused tier | ← → (section 2.4): the previous or next stop of the focused (dimension, tier), section 3.4 |
| control | stop one tier coarser | Shift ← → (section 2.4): a step at the next coarser tier of the same dimension |
| control | fly one tier coarser / finer | ↑ ↓ (section 2.4): fly one tier coarser or finer in the focused dimension; the cursor stays |
| control | focus execution / hardware / architecture | E H A (section 2.4): pick the focused dimension; when paired, its tier comes from the alignment table |
| control | tier n of the focused dimension | 1-6 (section 2.4): fly to tier n of the focused dimension |
| control | paired / independent tiers | P (section 2.4): paired tiers follow the alignment table of section 3.4 |
| control | next world | W (section 2.4): cycle the four worlds of section 2.2 |
| control | dock bottom / right | D (section 2.4): move the dock |
| control | play every event in the bounds, looping | Space (section 2.4): play the bounds, the execution unit at the cursor (section 2.3) |
| control | pace: events / time | T (section 2.4): the playback pace |
| control | previous / next row of the focused tier (walk every row, section 3.4) | Alt ← → (section 2.4): the first walk mode of section 3.4; the second mode (rows of the selected process or object, owner) has no key yet |
| control | back / forward through selections (choice 4) | [ ] (section 2.4): selection history, section 8 choice 4 |
<!-- /gen:surfaces -->

## 10. Stop counts per run

Generated by `stop_counts.py` over every final run in the store `CC_STORE` names (default
`/mnt/ie-data/cc/store`; during the migration, the worktree's copy `/mnt/ie-data/cc/store-cc`), with the placement in
`devtools/registry/kinds.json` (section 3.4). The stop check fails a run when its kernel stops differ from the kernel,
memcpy and memset rows of its device trace (the Nsight Systems `.sqlite`, or `torch_trace.json` for a code run), when
its module stops differ from the module `forward()` frames of `torch_trace.json`, when a kind's execution place does
not fit its storage tier, when a row is on two execution tiers, or when detail is negative. `--self-test` runs four
mutations (`cuda runtime call` and `os runtime call` at phase, `cpu operator` and `cuda graph node` at module) and
must exit 1: every mutation fails the check.

<!-- gen:stops -->
Execution stops (own tier), per iteration in brackets. `layer` groups kernel rows by decoder layer. A kernel stop's launch call is its CPU side (launches, below): the same stop, not detail. `detail` is the rows no stop tier claims; they are never stops.

| run | rows | iterations | request | iteration | phase | layer | module | kernel | detail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| I02A-TRACE-code_20261103T170709Z_0ac2db | 1,140,823 | 64 | 3 (0) | 0 (0) | 1,606 (25) | 1,600 (25) | 17,216 (269) | 18,309 (286) | 1,085,380 (16,959) |
| I02A-TRACE-components_20261104T142238Z_0b249c | 2,827 | 128 | 2 (0) | 128 (1) | 2,675 (21) | 0 (0) | 0 (0) | 0 (0) | 22 (0) |
| I02A-TRACE-components_20261108T195135Z_f32fab | 3,146 | 128 | 2 (0) | 128 (1) | 2,994 (23) | 0 (0) | 0 (0) | 0 (0) | 22 (0) |
| I02A-TRACE-components_20261108T195738Z_2a3785 | 3,020 | 128 | 2 (0) | 128 (1) | 2,868 (22) | 0 (0) | 0 (0) | 0 (0) | 22 (0) |
| I02A-TRACE-components_20261108T195912Z_b38a05 | 3,116 | 128 | 2 (0) | 128 (1) | 2,964 (23) | 0 (0) | 0 (0) | 0 (0) | 22 (0) |
| I02A-TRACE-components_20261108T201219Z_7ea831 | 3,099 | 128 | 2 (0) | 128 (1) | 2,947 (23) | 0 (0) | 0 (0) | 0 (0) | 22 (0) |
| I02A-TRACE-components_20261108T204131Z_8c3f47 | 3,155 | 128 | 2 (0) | 128 (1) | 3,003 (23) | 0 (0) | 0 (0) | 0 (0) | 22 (0) |
| I02A-TRACE-components_20261108T204441Z_dadcfe | 3,170 | 128 | 2 (0) | 128 (1) | 3,018 (24) | 0 (0) | 0 (0) | 0 (0) | 22 (0) |
| I02A-TRACE-components_20261108T204701Z_1b9632 | 3,164 | 128 | 2 (0) | 128 (1) | 3,012 (24) | 0 (0) | 0 (0) | 0 (0) | 22 (0) |
| I02A-TRACE-components_20261108T212815Z_ee256d | 3,148 | 128 | 2 (0) | 128 (1) | 2,979 (23) | 0 (0) | 0 (0) | 0 (0) | 39 (0) |
| I02A-TRACE-components_20261108T213518Z_289d7a | 3,109 | 128 | 2 (0) | 128 (1) | 2,938 (23) | 0 (0) | 0 (0) | 0 (0) | 41 (0) |
| I02A-TRACE-components_20261108T214523Z_1d27d0 | 3,193 | 128 | 2 (0) | 128 (1) | 3,022 (24) | 0 (0) | 0 (0) | 0 (0) | 41 (0) |
| I02A-TRACE-components_20261108T214816Z_2b7068 | 3,296 | 128 | 2 (0) | 128 (1) | 3,125 (24) | 0 (0) | 0 (0) | 0 (0) | 41 (0) |
| I02A-TRACE-components_20261108T215027Z_e1ce13 | 3,190 | 128 | 2 (0) | 128 (1) | 3,019 (24) | 0 (0) | 0 (0) | 0 (0) | 41 (0) |
| I02A-TRACE-components_20261108T215349Z_561bfe | 3,175 | 128 | 2 (0) | 128 (1) | 3,004 (23) | 0 (0) | 0 (0) | 0 (0) | 41 (0) |
| I02A-TRACE-kernels_20261103T181509Z_52744d | 11,698 | 0 | 3 | 0 | 11,673 | 0 | 0 | 0 | 22 |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | 8,911 | 192 | 3 (0) | 192 (1) | 8,340 (43) | 0 (0) | 0 (0) | 0 (0) | 376 (2) |
| I02A-TRACE-kernels_20261109T055145Z_5b77fc | 8,480 | 192 | 3 (0) | 192 (1) | 7,995 (42) | 0 (0) | 0 (0) | 0 (0) | 290 (2) |
| I02A-TRACE-kernels_20261109T060737Z_8f4ae7 | 8,418 | 192 | 3 (0) | 192 (1) | 7,925 (41) | 0 (0) | 0 (0) | 0 (0) | 298 (2) |
| I02A-TRACE-live_20261103T185532Z_1c1629 | 1,471 | 0 | 2 | 0 | 1,447 | 0 | 0 | 0 | 22 |
| I02A-TRACE-timeline_20261103T185837Z_e08b8b | 113,192 | 128 | 3 (0) | 0 (0) | 3,508 (27) | 3,200 (25) | 22,240 (174) | 39,768 (311) | 40,161 (314) |
| I02A-TRACE-timeline_20261107T172848Z_f2ac52 | 115,403 | 192 | 3 (0) | 192 (1) | 6,224 (32) | 3,200 (17) | 22,240 (116) | 39,768 (207) | 39,464 (206) |
| I02A-TRACE-timeline_20261108T200246Z_764014 | 124,121 | 192 | 3 (0) | 192 (1) | 6,158 (32) | 3,200 (17) | 22,240 (116) | 39,768 (207) | 48,248 (251) |
| I02A-TRACE-timeline_20261108T213113Z_1d82c9 | 113,860 | 192 | 3 (0) | 192 (1) | 6,063 (32) | 3,200 (17) | 22,240 (116) | 39,768 (207) | 38,082 (198) |
| I02A-TRACE-timeline_20261109T013347Z_69c1bb | 118,023 | 192 | 3 (0) | 192 (1) | 5,482 (29) | 3,200 (17) | 22,240 (116) | 39,768 (207) | 42,826 (223) |
| I02A-TRACE-timeline_20261109T060522Z_ee2252 | 114,139 | 192 | 3 (0) | 192 (1) | 5,456 (28) | 3,200 (17) | 22,240 (116) | 39,768 (207) | 38,968 (203) |
| I02A_20261103T164324Z_348959 | 1,130 | 0 | 2 | 0 | 1,106 | 0 | 0 | 0 | 22 |
| I02A_20261103T172804Z_a3ca9a | 648 | 0 | 2 | 0 | 624 | 0 | 0 | 0 | 22 |
| I02A_20261103T172929Z_0e5d39 | 648 | 0 | 2 | 0 | 624 | 0 | 0 | 0 | 22 |
| I02A_20261109T062054Z_42b814 | 1,052 | 0 | 2 | 0 | 949 | 0 | 0 | 0 | 101 |
| I02A_20261109T062307Z_b80715 | 1,018 | 0 | 2 | 0 | 914 | 0 | 0 | 0 | 102 |
| I02A_20261109T062449Z_b6b075 | 1,051 | 0 | 2 | 0 | 946 | 0 | 0 | 0 | 103 |
| I02A_20261109T062635Z_cf942a | 1,023 | 0 | 2 | 0 | 920 | 0 | 0 | 0 | 101 |
| I02A_20261109T063129Z_320857 | 1,022 | 0 | 2 | 0 | 919 | 0 | 0 | 0 | 101 |
| I02A_20261109T063711Z_70fba8 | 1,010 | 0 | 2 | 0 | 907 | 0 | 0 | 0 | 101 |
| I02A_20261109T064024Z_4518dc | 1,017 | 0 | 2 | 0 | 910 | 0 | 0 | 0 | 105 |
| I02C_20261107T181031Z_5626f7 | 3,018 | 0 | 3 | 0 | 2,781 | 0 | 0 | 0 | 234 |
| I02C_20261107T181629Z_c37c3e | 2,707 | 0 | 3 | 0 | 2,332 | 0 | 0 | 0 | 372 |

Stop check: every execution place is allowed for its kind's storage tier; kernel stops equal the kernel, memcpy and memset rows of the run's device trace; module stops equal the module forward() frames of its torch_trace.json plus the modules its import inferred (M2); no row is on two execution tiers; detail is not negative.

| run | device trace | trace rows | kernel stops | module frames | inferred modules | module stops | rows on two tiers | result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| I02A-TRACE-code_20261103T170709Z_0ac2db | torch_trace.json | 18,309 | 18,309 | 17,216 | 0 | 17,216 | 0 | ok |
| I02A-TRACE-components_20261104T142238Z_0b249c | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A-TRACE-components_20261108T195135Z_f32fab | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A-TRACE-components_20261108T195738Z_2a3785 | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A-TRACE-components_20261108T195912Z_b38a05 | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A-TRACE-components_20261108T201219Z_7ea831 | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A-TRACE-components_20261108T204131Z_8c3f47 | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A-TRACE-components_20261108T204441Z_dadcfe | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A-TRACE-components_20261108T204701Z_1b9632 | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A-TRACE-components_20261108T212815Z_ee256d | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A-TRACE-components_20261108T213518Z_289d7a | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A-TRACE-components_20261108T214523Z_1d27d0 | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A-TRACE-components_20261108T214816Z_2b7068 | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A-TRACE-components_20261108T215027Z_e1ce13 | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A-TRACE-components_20261108T215349Z_561bfe | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A-TRACE-kernels_20261103T181509Z_52744d | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A-TRACE-kernels_20261109T055145Z_5b77fc | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A-TRACE-kernels_20261109T060737Z_8f4ae7 | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A-TRACE-live_20261103T185532Z_1c1629 | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A-TRACE-timeline_20261103T185837Z_e08b8b | timeline.sqlite | 39,768 | 39,768 | 0 | 22,240 | 22,240 | 0 | ok |
| I02A-TRACE-timeline_20261107T172848Z_f2ac52 | timeline.sqlite | 39,768 | 39,768 | 0 | 22,240 | 22,240 | 0 | ok |
| I02A-TRACE-timeline_20261108T200246Z_764014 | timeline.sqlite | 39,768 | 39,768 | 0 | 22,240 | 22,240 | 0 | ok |
| I02A-TRACE-timeline_20261108T213113Z_1d82c9 | timeline.sqlite | 39,768 | 39,768 | 0 | 22,240 | 22,240 | 0 | ok |
| I02A-TRACE-timeline_20261109T013347Z_69c1bb | timeline.sqlite | 39,768 | 39,768 | 0 | 22,240 | 22,240 | 0 | ok |
| I02A-TRACE-timeline_20261109T060522Z_ee2252 | timeline.sqlite | 39,768 | 39,768 | 0 | 22,240 | 22,240 | 0 | ok |
| I02A_20261103T164324Z_348959 | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A_20261103T172804Z_a3ca9a | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A_20261103T172929Z_0e5d39 | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A_20261109T062054Z_42b814 | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A_20261109T062307Z_b80715 | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A_20261109T062449Z_b6b075 | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A_20261109T062635Z_cf942a | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A_20261109T063129Z_320857 | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A_20261109T063711Z_70fba8 | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02A_20261109T064024Z_4518dc | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02C_20261107T181031Z_5626f7 | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |
| I02C_20261107T181629Z_c37c3e | none | 0 | 0 | 0 | 0 | 0 | 0 | ok |

Not counted: host (host run (rolling), no events).

Hardware and architecture stops (`dimensions.stops` in kinds.json). Hardware: device steps on transfers (memcpy, memset), unit on kernels, kernel traffic and SM internals on profiled kernels; system and node step on execution request and iteration. Architecture: container, process and component step on a request's hand-offs (its phase rows moving to another container, process or component); fleet and node on requests; software layer on kernel stops at their launch call.

| run | hardware system | hardware node | hardware device | hardware unit | hardware kernel traffic | hardware SM internals | launches | architecture fleet | architecture node | architecture container | architecture process | architecture component | architecture software layer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| I02A-TRACE-code_20261103T170709Z_0ac2db | 3 | 0 | 2,751 | 15,558 | 0 | 0 | 18,309 | 3 | 3 | 419 | 419 | 630 | 18,309 |
| I02A-TRACE-components_20261104T142238Z_0b249c | 2 | 128 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 575 | 1,098 | 1,788 | 0 |
| I02A-TRACE-components_20261108T195135Z_f32fab | 2 | 128 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 502 | 1,153 | 1,786 | 0 |
| I02A-TRACE-components_20261108T195738Z_2a3785 | 2 | 128 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 534 | 1,165 | 1,787 | 0 |
| I02A-TRACE-components_20261108T195912Z_b38a05 | 2 | 128 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 525 | 1,157 | 1,789 | 0 |
| I02A-TRACE-components_20261108T201219Z_7ea831 | 2 | 128 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 496 | 1,130 | 1,775 | 0 |
| I02A-TRACE-components_20261108T204131Z_8c3f47 | 2 | 128 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 509 | 1,154 | 1,797 | 0 |
| I02A-TRACE-components_20261108T204441Z_dadcfe | 2 | 128 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 521 | 1,210 | 1,778 | 0 |
| I02A-TRACE-components_20261108T204701Z_1b9632 | 2 | 128 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 536 | 1,182 | 1,786 | 0 |
| I02A-TRACE-components_20261108T212815Z_ee256d | 2 | 128 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 447 | 1,038 | 1,747 | 0 |
| I02A-TRACE-components_20261108T213518Z_289d7a | 2 | 128 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 523 | 1,147 | 1,799 | 0 |
| I02A-TRACE-components_20261108T214523Z_1d27d0 | 2 | 128 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 531 | 1,159 | 1,788 | 0 |
| I02A-TRACE-components_20261108T214816Z_2b7068 | 2 | 128 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 507 | 1,099 | 1,775 | 0 |
| I02A-TRACE-components_20261108T215027Z_e1ce13 | 2 | 128 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 553 | 1,169 | 1,794 | 0 |
| I02A-TRACE-components_20261108T215349Z_561bfe | 2 | 128 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 514 | 1,162 | 1,793 | 0 |
| I02A-TRACE-kernels_20261103T181509Z_52744d | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 3 | 428 | 428 | 635 | 0 |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | 3 | 192 | 0 | 0 | 0 | 0 | 0 | 3 | 3 | 805 | 1,759 | 2,682 | 0 |
| I02A-TRACE-kernels_20261109T055145Z_5b77fc | 3 | 192 | 0 | 0 | 0 | 0 | 0 | 3 | 3 | 730 | 1,667 | 2,679 | 0 |
| I02A-TRACE-kernels_20261109T060737Z_8f4ae7 | 3 | 192 | 0 | 0 | 0 | 0 | 0 | 3 | 3 | 799 | 1,762 | 2,687 | 0 |
| I02A-TRACE-live_20261103T185532Z_1c1629 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 277 | 277 | 419 | 0 |
| I02A-TRACE-timeline_20261103T185837Z_e08b8b | 3 | 0 | 5,628 | 34,140 | 0 | 0 | 7,512 | 3 | 3 | 581 | 581 | 635 | 39,768 |
| I02A-TRACE-timeline_20261107T172848Z_f2ac52 | 3 | 192 | 5,628 | 34,140 | 266 | 266 | 7,512 | 3 | 3 | 921 | 1,939 | 2,673 | 39,768 |
| I02A-TRACE-timeline_20261108T200246Z_764014 | 3 | 192 | 5,628 | 34,140 | 0 | 0 | 7,512 | 3 | 3 | 942 | 1,992 | 2,681 | 39,768 |
| I02A-TRACE-timeline_20261108T213113Z_1d82c9 | 3 | 192 | 5,628 | 34,140 | 0 | 0 | 7,512 | 3 | 3 | 839 | 1,793 | 2,676 | 39,768 |
| I02A-TRACE-timeline_20261109T013347Z_69c1bb | 3 | 192 | 5,628 | 34,140 | 266 | 266 | 7,512 | 3 | 3 | 917 | 1,954 | 2,686 | 39,768 |
| I02A-TRACE-timeline_20261109T060522Z_ee2252 | 3 | 192 | 5,628 | 34,140 | 266 | 266 | 7,512 | 3 | 3 | 908 | 1,879 | 2,702 | 39,768 |
| I02A_20261103T164324Z_348959 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 282 | 282 | 422 | 0 |
| I02A_20261103T172804Z_a3ca9a | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 283 | 283 | 422 | 0 |
| I02A_20261103T172929Z_0e5d39 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 286 | 286 | 424 | 0 |
| I02A_20261109T062054Z_42b814 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 281 | 281 | 421 | 0 |
| I02A_20261109T062307Z_b80715 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 281 | 281 | 421 | 0 |
| I02A_20261109T062449Z_b6b075 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 281 | 281 | 421 | 0 |
| I02A_20261109T062635Z_cf942a | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 279 | 279 | 420 | 0 |
| I02A_20261109T063129Z_320857 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 281 | 281 | 421 | 0 |
| I02A_20261109T063711Z_70fba8 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 281 | 281 | 421 | 0 |
| I02A_20261109T064024Z_4518dc | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 281 | 281 | 421 | 0 |
| I02C_20261107T181031Z_5626f7 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 3 | 341 | 341 | 515 | 0 |
| I02C_20261107T181629Z_c37c3e | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 3 | 618 | 618 | 922 | 0 |

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
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | docker-ie-i02a-l1-capture-1 | 778 | 1,003,758 µs |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | docker-ie-i02a-l1-client-1 | 707 | 1,003,909 µs |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | docker-ie-i02a-l1-server-1 | 782 | 1,003,730 µs |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | docker-ie-i02a-l1-test-capture-1 | 44 | 1,005,815 µs |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | docker-ie-i02a-l1-test-server-1 | 45 | 1,005,678 µs |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | docker-ie-i02a-l1-test-trackers-1 | 44 | 1,006,700 µs |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | docker-ie-i02a-l1-trackers-1 | 778 | 1,003,752 µs |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | engine | 709 | 1,003,834 µs |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | gpu-apps-host-pid-13810 | 1,563 | 500,169 µs |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | gpu-apps-host-pid-2214 | 1,563 | 500,169 µs |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | gpu-apps-host-pid-8776 | 1,563 | 500,169 µs |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | gpu-apps-server-pid-1 | 1,198 | 500,252 µs |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | gpu-apps-server-pid-208 | 1,507 | 500,177 µs |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | gpu-apps-server-pid-310 | 1,170 | 500,253 µs |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | gpu-apps-server-pid-341 | 1,484 | 500,187 µs |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | gpu0-nvidia-smi | 7,774 | 100,195 µs |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | host | 7,809 | 99,999 µs |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | nvme | 7,809 | 99,997 µs |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | nvml-500ms | 1,627 | 500,079 µs |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | nvml-50ms | 16,233 | 50,079 µs |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | nvml-gpm | 8,093 | 100,079 µs |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | nvml-pcie-rx | 26,985 | 30,078 µs |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | nvml-pcie-tx | 26,986 | 30,078 µs |
| I02A-TRACE-kernels_20261109T013556Z_9c0b54 | uncore | 7,785 | 100,299 µs |
| I02A-TRACE-kernels_20261109T055145Z_5b77fc | docker-ie-i02a-l1-capture-1 | 730 | 1,002,883 µs |
| I02A-TRACE-kernels_20261109T055145Z_5b77fc | docker-ie-i02a-l1-client-1 | 655 | 1,002,973 µs |
| I02A-TRACE-kernels_20261109T055145Z_5b77fc | docker-ie-i02a-l1-server-1 | 734 | 1,002,910 µs |
| I02A-TRACE-kernels_20261109T055145Z_5b77fc | docker-ie-i02a-l1-trackers-1 | 730 | 1,002,903 µs |
| I02A-TRACE-kernels_20261109T055145Z_5b77fc | engine | 657 | 1,003,533 µs |
| I02A-TRACE-kernels_20261109T055145Z_5b77fc | gpu-apps-host-pid-2240 | 1,466 | 500,085 µs |
| I02A-TRACE-kernels_20261109T055145Z_5b77fc | gpu-apps-server-pid-208 | 1,406 | 500,071 µs |
| I02A-TRACE-kernels_20261109T055145Z_5b77fc | gpu-apps-server-pid-341 | 1,383 | 500,078 µs |
| I02A-TRACE-kernels_20261109T055145Z_5b77fc | gpu0-nvidia-smi | 7,295 | 100,184 µs |
| I02A-TRACE-kernels_20261109T055145Z_5b77fc | host | 7,321 | 99,999 µs |
| I02A-TRACE-kernels_20261109T055145Z_5b77fc | nvme | 7,321 | 100,000 µs |
| I02A-TRACE-kernels_20261109T055145Z_5b77fc | nvml-500ms | 1,526 | 500,082 µs |
| I02A-TRACE-kernels_20261109T055145Z_5b77fc | nvml-50ms | 15,232 | 50,082 µs |
| I02A-TRACE-kernels_20261109T055145Z_5b77fc | nvml-gpm | 7,595 | 100,082 µs |
| I02A-TRACE-kernels_20261109T055145Z_5b77fc | nvml-pcie-rx | 25,328 | 30,080 µs |
| I02A-TRACE-kernels_20261109T055145Z_5b77fc | nvml-pcie-tx | 25,331 | 30,081 µs |
| I02A-TRACE-kernels_20261109T055145Z_5b77fc | uncore | 7,301 | 100,286 µs |
| I02A-TRACE-kernels_20261109T060737Z_8f4ae7 | docker-ie-i02a-l1-capture-1 | 717 | 1,002,916 µs |
| I02A-TRACE-kernels_20261109T060737Z_8f4ae7 | docker-ie-i02a-l1-client-1 | 652 | 1,002,912 µs |
| I02A-TRACE-kernels_20261109T060737Z_8f4ae7 | docker-ie-i02a-l1-server-1 | 721 | 1,002,895 µs |
| I02A-TRACE-kernels_20261109T060737Z_8f4ae7 | docker-ie-i02a-l1-trackers-1 | 717 | 1,002,910 µs |
| I02A-TRACE-kernels_20261109T060737Z_8f4ae7 | engine | 652 | 1,003,503 µs |
| I02A-TRACE-kernels_20261109T060737Z_8f4ae7 | gpu-apps-host-pid-2240 | 1,439 | 500,055 µs |
| I02A-TRACE-kernels_20261109T060737Z_8f4ae7 | gpu-apps-server-pid-208 | 1,386 | 500,057 µs |
| I02A-TRACE-kernels_20261109T060737Z_8f4ae7 | gpu-apps-server-pid-341 | 1,363 | 500,060 µs |
| I02A-TRACE-kernels_20261109T060737Z_8f4ae7 | gpu0-nvidia-smi | 7,161 | 100,183 µs |
| I02A-TRACE-kernels_20261109T060737Z_8f4ae7 | host | 7,188 | 99,999 µs |
| I02A-TRACE-kernels_20261109T060737Z_8f4ae7 | nvme | 7,188 | 99,999 µs |
| I02A-TRACE-kernels_20261109T060737Z_8f4ae7 | nvml-500ms | 1,498 | 500,082 µs |
| I02A-TRACE-kernels_20261109T060737Z_8f4ae7 | nvml-50ms | 14,946 | 50,082 µs |
| I02A-TRACE-kernels_20261109T060737Z_8f4ae7 | nvml-gpm | 7,442 | 100,082 µs |
| I02A-TRACE-kernels_20261109T060737Z_8f4ae7 | nvml-pcie-rx | 24,854 | 30,081 µs |
| I02A-TRACE-kernels_20261109T060737Z_8f4ae7 | nvml-pcie-tx | 24,855 | 30,081 µs |
| I02A-TRACE-kernels_20261109T060737Z_8f4ae7 | uncore | 7,168 | 100,288 µs |
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
| I02A-TRACE-timeline_20261109T013347Z_69c1bb | docker-ie-i02a-l1-capture-1 | 91 | 1,002,484 µs |
| I02A-TRACE-timeline_20261109T013347Z_69c1bb | docker-ie-i02a-l1-client-1 | 17 | 1,002,662 µs |
| I02A-TRACE-timeline_20261109T013347Z_69c1bb | docker-ie-i02a-l1-server-1 | 93 | 1,002,564 µs |
| I02A-TRACE-timeline_20261109T013347Z_69c1bb | docker-ie-i02a-l1-trackers-1 | 91 | 1,002,424 µs |
| I02A-TRACE-timeline_20261109T013347Z_69c1bb | engine | 19 | 1,003,340 µs |
| I02A-TRACE-timeline_20261109T013347Z_69c1bb | gpu-apps-host-pid-13810 | 142 | 499,995 µs |
| I02A-TRACE-timeline_20261109T013347Z_69c1bb | gpu-apps-host-pid-2065 | 185 | 499,995 µs |
| I02A-TRACE-timeline_20261109T013347Z_69c1bb | gpu-apps-host-pid-2214 | 185 | 499,995 µs |
| I02A-TRACE-timeline_20261109T013347Z_69c1bb | gpu-apps-host-pid-8776 | 175 | 499,995 µs |
| I02A-TRACE-timeline_20261109T013347Z_69c1bb | gpu-apps-server-pid-217 | 122 | 499,995 µs |
| I02A-TRACE-timeline_20261109T013347Z_69c1bb | gpu-apps-server-pid-414 | 93 | 500,035 µs |
| I02A-TRACE-timeline_20261109T013347Z_69c1bb | gpu0-metrics | 70,728 | 100 µs |
| I02A-TRACE-timeline_20261109T013347Z_69c1bb | gpu0-nvidia-smi | 921 | 100,183 µs |
| I02A-TRACE-timeline_20261109T013347Z_69c1bb | host | 912 | 100,000 µs |
| I02A-TRACE-timeline_20261109T013347Z_69c1bb | nvme | 912 | 100,000 µs |
| I02A-TRACE-timeline_20261109T013347Z_69c1bb | nvml-500ms | 247 | 500,080 µs |
| I02A-TRACE-timeline_20261109T013347Z_69c1bb | nvml-50ms | 2,461 | 50,082 µs |
| I02A-TRACE-timeline_20261109T013347Z_69c1bb | nvml-gpm | 1,231 | 100,080 µs |
| I02A-TRACE-timeline_20261109T013347Z_69c1bb | nvml-pcie-rx | 4,095 | 30,084 µs |
| I02A-TRACE-timeline_20261109T013347Z_69c1bb | nvml-pcie-tx | 4,095 | 30,080 µs |
| I02A-TRACE-timeline_20261109T013347Z_69c1bb | uncore | 917 | 100,293 µs |
| I02A-TRACE-timeline_20261109T060522Z_ee2252 | docker-ie-i02a-l1-capture-1 | 86 | 1,002,468 µs |
| I02A-TRACE-timeline_20261109T060522Z_ee2252 | docker-ie-i02a-l1-client-1 | 16 | 1,003,191 µs |
| I02A-TRACE-timeline_20261109T060522Z_ee2252 | docker-ie-i02a-l1-server-1 | 88 | 1,002,484 µs |
| I02A-TRACE-timeline_20261109T060522Z_ee2252 | docker-ie-i02a-l1-trackers-1 | 86 | 1,002,481 µs |
| I02A-TRACE-timeline_20261109T060522Z_ee2252 | engine | 18 | 1,003,609 µs |
| I02A-TRACE-timeline_20261109T060522Z_ee2252 | gpu-apps-host-pid-2240 | 174 | 499,999 µs |
| I02A-TRACE-timeline_20261109T060522Z_ee2252 | gpu-apps-server-pid-216 | 117 | 500,017 µs |
| I02A-TRACE-timeline_20261109T060522Z_ee2252 | gpu-apps-server-pid-407 | 94 | 500,019 µs |
| I02A-TRACE-timeline_20261109T060522Z_ee2252 | gpu0-metrics | 46,726 | 100 µs |
| I02A-TRACE-timeline_20261109T060522Z_ee2252 | gpu0-nvidia-smi | 866 | 100,181 µs |
| I02A-TRACE-timeline_20261109T060522Z_ee2252 | host | 864 | 100,000 µs |
| I02A-TRACE-timeline_20261109T060522Z_ee2252 | nvme | 864 | 99,999 µs |
| I02A-TRACE-timeline_20261109T060522Z_ee2252 | nvml-500ms | 231 | 500,082 µs |
| I02A-TRACE-timeline_20261109T060522Z_ee2252 | nvml-50ms | 2,309 | 50,083 µs |
| I02A-TRACE-timeline_20261109T060522Z_ee2252 | nvml-gpm | 1,156 | 100,083 µs |
| I02A-TRACE-timeline_20261109T060522Z_ee2252 | nvml-pcie-rx | 3,837 | 30,083 µs |
| I02A-TRACE-timeline_20261109T060522Z_ee2252 | nvml-pcie-tx | 3,838 | 30,083 µs |
| I02A-TRACE-timeline_20261109T060522Z_ee2252 | uncore | 862 | 100,295 µs |
| I02A_20261103T164324Z_348959 | gpu0-nvidia-smi | 711 | 100,196 µs |
| I02A_20261103T172804Z_a3ca9a | gpu0-nvidia-smi | 710 | 100,201 µs |
| I02A_20261103T172929Z_0e5d39 | gpu0-nvidia-smi | 711 | 100,203 µs |
| I02A_20261109T062054Z_42b814 | docker-ie-i02a-l1-capture-1 | 73 | 1,002,512 µs |
| I02A_20261109T062054Z_42b814 | docker-ie-i02a-l1-client-1 | 3 | 1,004,176 µs |
| I02A_20261109T062054Z_42b814 | docker-ie-i02a-l1-server-1 | 76 | 1,002,534 µs |
| I02A_20261109T062054Z_42b814 | docker-ie-i02a-l1-trackers-1 | 73 | 1,002,460 µs |
| I02A_20261109T062054Z_42b814 | engine | 8 | 1,002,537 µs |
| I02A_20261109T062054Z_42b814 | gpu-apps-host-pid-2240 | 148 | 499,887 µs |
| I02A_20261109T062054Z_42b814 | gpu-apps-host-pid-528549 | 148 | 499,887 µs |
| I02A_20261109T062054Z_42b814 | gpu-apps-server-pid-1 | 95 | 499,873 µs |
| I02A_20261109T062054Z_42b814 | gpu-apps-server-pid-310 | 71 | 499,873 µs |
| I02A_20261109T062054Z_42b814 | gpu0-nvidia-smi | 734 | 100,193 µs |
| I02A_20261109T062054Z_42b814 | host | 732 | 100,000 µs |
| I02A_20261109T062054Z_42b814 | nvme | 732 | 100,001 µs |
| I02A_20261109T062054Z_42b814 | nvml-500ms | 154 | 500,085 µs |
| I02A_20261109T062054Z_42b814 | nvml-50ms | 1,537 | 50,086 µs |
| I02A_20261109T062054Z_42b814 | nvml-gpm | 768 | 100,087 µs |
| I02A_20261109T062054Z_42b814 | nvml-pcie-rx | 2,554 | 30,091 µs |
| I02A_20261109T062054Z_42b814 | nvml-pcie-tx | 2,554 | 30,089 µs |
| I02A_20261109T062054Z_42b814 | uncore | 731 | 100,295 µs |
| I02A_20261109T062307Z_b80715 | docker-ie-i02a-l1-capture-1 | 67 | 1,002,782 µs |
| I02A_20261109T062307Z_b80715 | docker-ie-i02a-l1-client-1 | 2 | 1,005,621 µs |
| I02A_20261109T062307Z_b80715 | docker-ie-i02a-l1-server-1 | 71 | 1,002,779 µs |
| I02A_20261109T062307Z_b80715 | docker-ie-i02a-l1-trackers-1 | 67 | 1,002,789 µs |
| I02A_20261109T062307Z_b80715 | engine | 3 | 1,043,859 µs |
| I02A_20261109T062307Z_b80715 | gpu-apps-host-pid-2240 | 136 | 500,052 µs |
| I02A_20261109T062307Z_b80715 | gpu-apps-host-pid-549343 | 136 | 500,052 µs |
| I02A_20261109T062307Z_b80715 | gpu-apps-server-pid-1 | 83 | 500,043 µs |
| I02A_20261109T062307Z_b80715 | gpu-apps-server-pid-310 | 59 | 500,013 µs |
| I02A_20261109T062307Z_b80715 | gpu0-nvidia-smi | 678 | 100,195 µs |
| I02A_20261109T062307Z_b80715 | host | 674 | 100,000 µs |
| I02A_20261109T062307Z_b80715 | nvme | 674 | 99,999 µs |
| I02A_20261109T062307Z_b80715 | nvml-500ms | 143 | 500,086 µs |
| I02A_20261109T062307Z_b80715 | nvml-50ms | 1,425 | 50,085 µs |
| I02A_20261109T062307Z_b80715 | nvml-gpm | 712 | 100,085 µs |
| I02A_20261109T062307Z_b80715 | nvml-pcie-rx | 2,368 | 30,091 µs |
| I02A_20261109T062307Z_b80715 | nvml-pcie-tx | 2,367 | 30,091 µs |
| I02A_20261109T062307Z_b80715 | uncore | 673 | 100,301 µs |
| I02A_20261109T062449Z_b6b075 | docker-ie-i02a-l1-capture-1 | 73 | 1,002,570 µs |
| I02A_20261109T062449Z_b6b075 | docker-ie-i02a-l1-client-1 | 2 | 1,002,404 µs |
| I02A_20261109T062449Z_b6b075 | docker-ie-i02a-l1-server-1 | 76 | 1,002,581 µs |
| I02A_20261109T062449Z_b6b075 | docker-ie-i02a-l1-trackers-1 | 72 | 1,002,564 µs |
| I02A_20261109T062449Z_b6b075 | engine | 7 | 1,002,923 µs |
| I02A_20261109T062449Z_b6b075 | gpu-apps-host-pid-2240 | 147 | 500,036 µs |
| I02A_20261109T062449Z_b6b075 | gpu-apps-host-pid-568483 | 147 | 500,036 µs |
| I02A_20261109T062449Z_b6b075 | gpu-apps-server-pid-1 | 95 | 500,028 µs |
| I02A_20261109T062449Z_b6b075 | gpu-apps-server-pid-310 | 71 | 500,028 µs |
| I02A_20261109T062449Z_b6b075 | gpu0-nvidia-smi | 728 | 100,196 µs |
| I02A_20261109T062449Z_b6b075 | host | 725 | 99,999 µs |
| I02A_20261109T062449Z_b6b075 | nvme | 725 | 99,999 µs |
| I02A_20261109T062449Z_b6b075 | nvml-500ms | 153 | 500,085 µs |
| I02A_20261109T062449Z_b6b075 | nvml-50ms | 1,525 | 50,085 µs |
| I02A_20261109T062449Z_b6b075 | nvml-gpm | 762 | 100,085 µs |
| I02A_20261109T062449Z_b6b075 | nvml-pcie-rx | 2,534 | 30,091 µs |
| I02A_20261109T062449Z_b6b075 | nvml-pcie-tx | 2,534 | 30,089 µs |
| I02A_20261109T062449Z_b6b075 | uncore | 724 | 100,297 µs |
| I02A_20261109T062635Z_cf942a | docker-ie-i02a-l1-capture-1 | 67 | 1,002,636 µs |
| I02A_20261109T062635Z_cf942a | docker-ie-i02a-l1-client-1 | 2 | 1,003,448 µs |
| I02A_20261109T062635Z_cf942a | docker-ie-i02a-l1-server-1 | 71 | 1,002,496 µs |
| I02A_20261109T062635Z_cf942a | docker-ie-i02a-l1-trackers-1 | 67 | 1,002,645 µs |
| I02A_20261109T062635Z_cf942a | engine | 5 | 1,003,141 µs |
| I02A_20261109T062635Z_cf942a | gpu-apps-host-pid-2240 | 137 | 500,071 µs |
| I02A_20261109T062635Z_cf942a | gpu-apps-host-pid-588676 | 137 | 500,071 µs |
| I02A_20261109T062635Z_cf942a | gpu-apps-server-pid-1 | 85 | 500,091 µs |
| I02A_20261109T062635Z_cf942a | gpu-apps-server-pid-310 | 61 | 500,044 µs |
| I02A_20261109T062635Z_cf942a | gpu0-nvidia-smi | 679 | 100,196 µs |
| I02A_20261109T062635Z_cf942a | host | 675 | 100,000 µs |
| I02A_20261109T062635Z_cf942a | nvme | 675 | 100,000 µs |
| I02A_20261109T062635Z_cf942a | nvml-500ms | 144 | 500,083 µs |
| I02A_20261109T062635Z_cf942a | nvml-50ms | 1,437 | 50,087 µs |
| I02A_20261109T062635Z_cf942a | nvml-gpm | 718 | 100,087 µs |
| I02A_20261109T062635Z_cf942a | nvml-pcie-rx | 2,389 | 30,090 µs |
| I02A_20261109T062635Z_cf942a | nvml-pcie-tx | 2,388 | 30,090 µs |
| I02A_20261109T062635Z_cf942a | uncore | 674 | 100,299 µs |
| I02A_20261109T063129Z_320857 | docker-ie-i02a-l1-capture-1 | 68 | 1,002,715 µs |
| I02A_20261109T063129Z_320857 | docker-ie-i02a-l1-client-1 | 3 | 1,002,567 µs |
| I02A_20261109T063129Z_320857 | docker-ie-i02a-l1-server-1 | 71 | 1,002,726 µs |
| I02A_20261109T063129Z_320857 | docker-ie-i02a-l1-trackers-1 | 68 | 1,002,733 µs |
| I02A_20261109T063129Z_320857 | engine | 4 | 1,004,049 µs |
| I02A_20261109T063129Z_320857 | gpu-apps-host-pid-2240 | 137 | 499,993 µs |
| I02A_20261109T063129Z_320857 | gpu-apps-host-pid-619344 | 137 | 499,993 µs |
| I02A_20261109T063129Z_320857 | gpu-apps-server-pid-1 | 85 | 500,008 µs |
| I02A_20261109T063129Z_320857 | gpu-apps-server-pid-310 | 61 | 499,970 µs |
| I02A_20261109T063129Z_320857 | gpu0-nvidia-smi | 682 | 100,199 µs |
| I02A_20261109T063129Z_320857 | host | 678 | 99,999 µs |
| I02A_20261109T063129Z_320857 | nvme | 678 | 99,999 µs |
| I02A_20261109T063129Z_320857 | nvml-500ms | 145 | 500,086 µs |
| I02A_20261109T063129Z_320857 | nvml-50ms | 1,444 | 50,086 µs |
| I02A_20261109T063129Z_320857 | nvml-gpm | 721 | 100,084 µs |
| I02A_20261109T063129Z_320857 | nvml-pcie-rx | 2,398 | 30,092 µs |
| I02A_20261109T063129Z_320857 | nvml-pcie-tx | 2,399 | 30,089 µs |
| I02A_20261109T063129Z_320857 | uncore | 677 | 100,302 µs |
| I02A_20261109T063711Z_70fba8 | docker-ie-i02a-l1-capture-1 | 67 | 1,002,622 µs |
| I02A_20261109T063711Z_70fba8 | docker-ie-i02a-l1-client-1 | 2 | 1,005,242 µs |
| I02A_20261109T063711Z_70fba8 | docker-ie-i02a-l1-server-1 | 71 | 1,002,646 µs |
| I02A_20261109T063711Z_70fba8 | docker-ie-i02a-l1-trackers-1 | 67 | 1,002,585 µs |
| I02A_20261109T063711Z_70fba8 | engine | 3 | 1,044,314 µs |
| I02A_20261109T063711Z_70fba8 | gpu-apps-host-pid-2240 | 137 | 499,978 µs |
| I02A_20261109T063711Z_70fba8 | gpu-apps-host-pid-651804 | 137 | 499,978 µs |
| I02A_20261109T063711Z_70fba8 | gpu-apps-server-pid-1 | 84 | 500,001 µs |
| I02A_20261109T063711Z_70fba8 | gpu-apps-server-pid-308 | 61 | 500,000 µs |
| I02A_20261109T063711Z_70fba8 | gpu0-nvidia-smi | 679 | 100,197 µs |
| I02A_20261109T063711Z_70fba8 | host | 675 | 100,000 µs |
| I02A_20261109T063711Z_70fba8 | nvme | 675 | 100,000 µs |
| I02A_20261109T063711Z_70fba8 | nvml-500ms | 144 | 500,084 µs |
| I02A_20261109T063711Z_70fba8 | nvml-50ms | 1,432 | 50,085 µs |
| I02A_20261109T063711Z_70fba8 | nvml-gpm | 715 | 100,083 µs |
| I02A_20261109T063711Z_70fba8 | nvml-pcie-rx | 2,377 | 30,089 µs |
| I02A_20261109T063711Z_70fba8 | nvml-pcie-tx | 2,378 | 30,092 µs |
| I02A_20261109T063711Z_70fba8 | uncore | 673 | 100,300 µs |
| I02A_20261109T064024Z_4518dc | docker-ie-i02a-l1-capture-1 | 67 | 1,002,502 µs |
| I02A_20261109T064024Z_4518dc | docker-ie-i02a-l1-client-1 | 2 | 1,004,869 µs |
| I02A_20261109T064024Z_4518dc | docker-ie-i02a-l1-server-1 | 71 | 1,002,477 µs |
| I02A_20261109T064024Z_4518dc | docker-ie-i02a-l1-trackers-1 | 67 | 1,002,493 µs |
| I02A_20261109T064024Z_4518dc | engine | 3 | 1,044,635 µs |
| I02A_20261109T064024Z_4518dc | gpu-apps-host-pid-2240 | 136 | 500,053 µs |
| I02A_20261109T064024Z_4518dc | gpu-apps-host-pid-674691 | 136 | 500,053 µs |
| I02A_20261109T064024Z_4518dc | gpu-apps-server-pid-1 | 83 | 500,071 µs |
| I02A_20261109T064024Z_4518dc | gpu-apps-server-pid-309 | 60 | 500,141 µs |
| I02A_20261109T064024Z_4518dc | gpu0-nvidia-smi | 678 | 100,196 µs |
| I02A_20261109T064024Z_4518dc | host | 676 | 100,000 µs |
| I02A_20261109T064024Z_4518dc | nvme | 676 | 99,999 µs |
| I02A_20261109T064024Z_4518dc | nvml-500ms | 143 | 500,084 µs |
| I02A_20261109T064024Z_4518dc | nvml-50ms | 1,426 | 50,086 µs |
| I02A_20261109T064024Z_4518dc | nvml-gpm | 710 | 100,086 µs |
| I02A_20261109T064024Z_4518dc | nvml-pcie-rx | 2,370 | 30,089 µs |
| I02A_20261109T064024Z_4518dc | nvml-pcie-tx | 2,371 | 30,090 µs |
| I02A_20261109T064024Z_4518dc | uncore | 675 | 100,323 µs |
| I02C_20261107T181031Z_5626f7 | gpu0-nvidia-smi | 1,016 | 100,190 µs |
| I02C_20261107T181031Z_5626f7 | prometheus | 2 | 7,413,886 µs |
| I02C_20261107T181629Z_c37c3e | gpu0-nvidia-smi | 892 | 100,189 µs |
| I02C_20261107T181629Z_c37c3e | prometheus | 2 | 5,522,864 µs |
<!-- /gen:stops -->

Reading the counts:

- The code run's 1.10 M detail rows leave stepping entirely. Its finest stop tier, kernel, has 286 per iteration;
  module has 269.
- Graphs-on timeline runs have 22,240 inferred module stops each (M2, 3.1) and 207 to 311 kernel stops per
  iteration.
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
| 2026-11-08 | Production carries no scratch value; M1 moves the whole interface, Load, Launch and Compare included; trackers added and runs re-recorded as needed (R1, section 7.3) | owner |
| 2026-11-08 | I03 and later reps are not acceptance criteria; they do not exist yet. Section 5 holds I02A and I02C only | owner |
| 2026-11-08 | Open choices 1 to 11 resolved as in section 8; merge into main moves before P1, replacing "later" | owner (agent recommendation) |
| 2026-11-08 | Plan re-sequenced after review: P1 checks, P2 trackers and runs, P3 data, M1 cutover, M2 modules, M3 rep files, M4 retire | owner |
| 2026-11-08 | M4 may delete the v2 store (29 GB). D13 stays until production and D13 are both verified with the verify-command-center skill as identical in layout and function; then D13 is deleted | owner |
| 2026-11-08 | Seven sources added to 7.2 (hardware per unit, process role, GPU memory per process, kernel class, SMs used, container merge, box aggregates), each labelled measured or inferred | owner (agent proposal) |
| 2026-11-08 | Migration continues in worktree `inference-engineering-practice-cc` (branch `cc-migration`) with its own store copy (`/mnt/ie-data/cc/store-cc`), dev server (:7711) and runner (:7702); the owner's :7710 and :7701 are untouched | owner (agent setup) |
| 2026-11-08 | The live checks (live mode, head, follow, mask) move out of `regress.sh` into `devtools/verify/live.sh`, which launches one real I02A `off` run (7.3); `regress.sh` keeps the dry-run checks | agent |
| 2026-11-08 | Trackers run in their own sidecar, not the capture container, so the `ie-capture` tag past runs name stays unchanged; they run on every trace level, `off` included (0.75% of one CPU, measured) | agent |
| 2026-11-08 | gpu-apps records every GPU process, desktop ones included; the views show only processes of the run's containers | agent |
| 2026-11-08 | R1 waits for an idle GPU (a game held it at 100%); P3 and M1 proceed on f2ac52 and 1d82c9, and every R1 check reruns once R1 exists | agent |
| 2026-11-08 | R1 recorded (7.3): timeline `I02A-TRACE-timeline_20261109T013347Z_69c1bb`, and its kernels run `I02A-TRACE-kernels_20261109T013556Z_9c0b54` (Nsight Compute, iteration 67), tied by the rule of `registry/ncu.json` | agent |
| 2026-11-09 | Kernel short names: when the first template argument of a generic base is a builtin type, the name is `ns::base` (e.g. `gemvx::kernel`), a refinement of choice 7 | agent |
| 2026-11-09 | Iteration ends are uncapped (choice 5); row assignment to an iteration still stops at the next scheduler stamp | agent |
| 2026-11-09 | Stop table: hand-offs from the request's phase rows (container and process from the lane's ancestors); hardware node = iteration, unit = kernels, device = memcpy and memset; software layer stops at the launch call | agent |
| 2026-11-09 | I02A `moments.toml` events renamed to stored row names so the lint resolves them; claims and lessons unchanged | agent |
| 2026-11-09 | Container merge keys on (project, service), not service alone, so a rep's test project stays separate (fix in M1) | agent |
| 2026-11-09 | Flow for runs without engine rows (I02C): request in and stream out come from client and server stream rows as 7.4 P3 states; prefill and decode stay none without iterations (fix in M1) | agent |
| 2026-11-09 | R1 kernels run 9c0b54 is kept for building; a test stack held two small CUDA contexts for 16 s of its 700 s ncu window, so the morning GPU run re-records it | agent |
| 2026-11-09 | M3 covers the reps with event runs (I01-L2, I02A, I02C); I01A, I01B, I01C and I02B stay "No recorded runs". `moments.toml` may name its run's result file (`result`, default `latency.json`). The moments lint fails a rep whose moments resolve on no run | agent (coordinator ruling) |
| 2026-11-09 | M2: graphs-on runs get kind `inferred module` (op tier, placed at execution / module, final import only) from the code run's module frames (3.1, `store/modules.py`, the code run per rep in `registry/modules.json`). A frame is kept only when all its device rows pair, consecutive on one stream; decode attention (XQA against the code run's masked MHA) stays unmatched. On R1 (timeline ee2252, kernels run 8f4ae7): 22,240 modules, each with the code run's names and holding its rows; 101 of 310 kernel stops unmatched per decode iteration, 49 of 354 per prefill, shown in the spine headline; per-name kernel totals equal `nsys stats` (`devtools/verify/modules_check.py`). Open: the inspector path, the Kernels tab's module column and the architecture world's toolkit line still find a module only through the launch call, so they miss inferred modules (a held kernel's path also loses its phase and launch call) | agent |

