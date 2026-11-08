# Command center: three dimensions in one world

Status: design and migration guide, running doc, rewritten 2026-11-08. The initial layout is frozen at prototype D13
(owner, 2026-11-08); the next section states it. Decisions go in the log at the end with the date and who made them.

Generated sections (3 and 4) come from `design/dimensions/`. `proposal.json` holds the proposal as data. Rerun:

```
python3 design/dimensions/map_surfaces.py --write          # section 3; exits 1 if a surface is unmapped
uv run --no-project --with duckdb python design/dimensions/stop_counts.py --write   # section 4; exits 1 on a jump
```

## Goal (owner, 2026-11-08)

An intuitive, working interface for building a conceptual understanding of the inference stack. That means what
runs, what calls what, how a serving engine behaves under different circumstances, and how the hardware is used
while it happens. Not every line of code. It has to grow with the many reps still in the workbook.

## The underlying issue

One run can be seen three ways, and each way has its own zoom from coarse to fine:

- **Execution.** What is running: a request, an iteration, a phase, a layer, a module, a kernel.
- **Hardware.** Where it physically happens: overall utilization at the coarsest, data moving inside the GPU at the
  finest. CPU, RAM, L3, NVMe, PCIe, GPU, VRAM, L2 and SMs are all hardware.
- **Architecture.** Which software owns it: containers, processes, components, and the toolkit layer calling the
  runtime layer.

Today there is one 7-tier ladder (`registry/kinds.json`). Its rungs mix the three: some name a software layer, some
a processor, some only mean "finer than the rung above". Tier 4 ("call") became the place for everything that fit
nowhere else. In the code run it holds 1,120,878 of 1,140,076 rows (measured). Stepping is tied to that one ladder,
so stepping at Tier 4 walks about 17,500 rows per iteration (measured, section 4).

The v3 level list repeats the mix. Infra and Components are architecture. Trace to Kernel are execution.
Hardware is hardware. Each level is one tier of one dimension, so no view crosses them.

The store already holds both "where" trees, in one `things` tree per run (measured, timeline run manifest): hardware
things (CPU, RAM, chipset, PCIe and DMI links, GPU, 36 SMs, L2, 4 memory controllers, VRAM, 2 copy engines, NVMe)
and architecture things (containers, processes, threads, streams, 26 component boxes). Each row already points at a
lane (thread or stream) and a component box. The design separates what exists. It does not invent new trees.

## Initial layout (D13 checkpoint, owner 2026-11-08)

The layout the command center is built to. It gathers every ruling from D10 to D13 into one place; section 2 keeps
how each was reached. Reference build: `devtools/frontend/prototypes/D13/` (served at
`http://127.0.0.1:7710/static/prototypes/D13/index.html`); `D13/regress.sh` checks it (50 checks).

### Screen

| region | holds |
| --- | --- |
| header, row 1 (34 px) | world tabs (Rep, Stacked world, Execution spine, Architecture); the session block (rep, run, mode badge, Load, Launch, Compare; follow live in live; A / B in compare); position readout; `?` keys |
| header, row 2 | focus title and what the tier shows; Paired / Independent; the three tier ladders, compact; what is true now in each dimension |
| stage | the open world |
| right sidebar | hardware at the cursor, sparklines over the window (v2-scene) |
| bottom bar (or right, `D`) | back / forward; tabs Selected, At cursor, Metrics, Tokens, Kernels, Run; play, pace, rate; run overview strip and detail strip |

Header style and sizing follow D10: thin tabs and compact ladders, nothing stretched.

### Worlds

| world | what it draws |
| --- | --- |
| Rep (opens first) | the session's front page: what the rep teaches, key moments with show me, lessons, results on three clocks, TTFT segments, README results and pass checks (section 8) |
| Stacked world | 3D: the board as floor, architecture standing on its hardware, execution as a moving pulse; a floating, collapsible architecture lens |
| Execution spine | 2D bands, one per execution tier, with sample and copy strips; a lens window on top (55% of the height, draggable) with Architecture, Hardware and Split (side by side, draggable divider) |
| Architecture | the v1 drawing full screen over a thin execution strip |

Selection, cursor and tiers carry over when the world changes.

### Rules

- **Tiers.** Each dimension has its own tier. Default **Independent**: a tier change moves only that dimension.
  Paired (toggle or `P`) moves the other two to the aligned tier (section 2 table). The header ladder is the only
  tier control.
- **Clicks first.** Tiers, things, units, stops and metrics are all clickable. Keys are shortcuts (`?` lists them).
- **Architecture drawing.** v1's exact styling and all 26 component boxes, rebuilt, never imported.
- **Colour = logical flow.** Request in `#5aa9ff`, prefill `#ff7b72`, decode loop `#3fd0a0`, stream out `#f778ba`.
  Flows overlap in time (stream out runs beside the next decode pass), and a box shows a stripe per flow it serves.
- **Playback.** Plays every event inside the bounds and loops. The bounds are the execution unit at the cursor at
  the execution tier. v2's clock: one animation frame moves the cursor and redraws every view.
- **Zoom.** Each spine pane (architecture, hardware, execution bands) zooms and pans on its own: wheel to zoom,
  drag to pan, double-click to reset. Each pane keeps its zoom across reloads.
- **History.** Back / forward in the bottom bar walk selections. Each step restores the selection, cursor and tab.
- **Session.** Load (replay), Launch (live), Compare (two runs), from the header (section 8). Compare shows A and B
  side by side in the Rep world, and one run at a time with an A / B switch in the other worlds.
- **State in the URL.** Session, world, tiers, cursor, selection and dock live in the hash, so a reload or a link
  keeps the view. A live session reloads as a replay.

### Not in the initial layout yet

- Real run data in the worlds. Every world draws the scratch timeline; show me lands on a stand-in event.
- Launch calling `POST /runner/jobs`.
- `moments.toml` for 5 of 6 reps; `rep.toml` for 5 of 6 reps.
- Walking every row (section 2) and snap-to-tier zoom (open choice 4).

## 1. Dimensions and their tiers

Status words: **measured** (a tool recorded it), **inferred** (derived by a stated rule), **missing** (no source
today). Counts per iteration come from section 4.

### Execution

| tier | what you see | source | resolution | status |
| --- | --- | --- | --- | --- |
| request | one request, send to last byte | client stamps, engine `/perf_metrics` | per request | measured |
| iteration | one scheduler step: which requests run, prefill or decode | scheduler stamps (derived span) | 3.4 ms median | measured |
| phase | executor phases (`_fetch_new_requests`, `_schedule`, `_sample_async`, `_handle_responses`), request hops | NVTX top-level ranges, component stamps | 13 to 26 per iteration | measured |
| layer | one decoder layer | `layer` column (RMSNorm rule in `trace/adapters/nsys.py`) | 25 per iteration (24 layers + final norm) | inferred |
| module | attention, MLP, linear, norm, with their ops | module `forward()` frames (code run) | 269 per iteration | measured in the code run only; missing elsewhere |
| kernel | one kernel, copy or memset, with the CPU call that launched it | nsys or PyTorch profiler | 2.3 µs median kernel | measured |

- Everything finer than a module is **detail**. Built-ins, nn plumbing, nested aten ops, CUDA queries, syncs, OS
  calls and profiler rows stay in the store and open in the inspector. They are never stops.
- A launch call and its kernel are one stop, seen from the CPU and the GPU. The code run's 18,309 launch calls
  match its 18,309 device rows by correlation id (measured).
- Module is the gap. Graphs-on runs replay a captured graph, so they have no module frames. A module there must be
  inferred by matching the kernel sequence learned from the code run (rule not yet written).

### Hardware

| tier | what you see | source | resolution | status |
| --- | --- | --- | --- | --- |
| system | utilization of every GPU and host: GPU %, VRAM, CPU %, RAM | `nvidia-smi` query; NVML GPM (live); Docker stats per container (live) | 100 ms; 100 ms; about 1 s | GPU measured; CPU and RAM live only, not stored |
| node | the board: CPU, RAM, chipset, PCIe and DMI links, GPU, NVMe, NIC | inventory probe (`registry/inventory.json`) | static | measured |
| device | bytes moving between devices: PCIe copies, network frames, NVMe reads | memcpy rows with bytes; nsys PCIe RX/TX %; tcpdump | per copy; 100 µs; per frame | PCIe and network measured; NVMe and RAM bandwidth missing |
| unit | parts inside a device: SMs active, tensor, warps in flight, DRAM read/write, copy engines; CPU cores, L3 | nsys GPU metrics | 100 µs | GPU measured; CPU cores and L3 missing |
| kernel traffic | one kernel's DRAM and L2 bytes, occupancy, throughput, grid over 36 SMs (the v2 SM view) | ncu | per kernel, profiled iterations only | measured for 235 kernels of iteration 67; tie to the run inferred |
| SM internals | warps, shared memory, registers, source lines | ncu sections | per kernel | link only (owner ruling: open in Nsight Compute) |

- Board (probed 2026-11-08): MSI MPG Z390M GAMING EDGE AC; i9-9900K, 8 cores / 16 threads, L3 16 MiB; 62 GiB RAM;
  RTX 5060 Ti, 16 GiB, 36 SMs; PCIe max gen 3, gen 2 x8 at idle (the link trains down at idle); WD_BLACK SN7100.
- One metric sample (100 µs) covers dozens of 2.3 µs kernels. Hardware state follows an iteration (about 34 samples)
  or a long module. Per-kernel hardware data exists only where ncu profiled.
- Decode barely uses PCIe: 5,196 copies in the timeline run, none above 2,304 bytes, 7.0 MB total (measured). The
  large flow is VRAM to SMs (weights read every step), seen only as DRAM bandwidth.

### Architecture

| tier | what you see | source | resolution | status |
| --- | --- | --- | --- | --- |
| fleet | cluster, control plane, nodes | Kubernetes API (from I27) | per object event | missing until I27 |
| node | one host (a Kubernetes node later) | inventory probe | static | measured |
| container | client, server, network sidecar; lifecycle | Docker events (`container event` kind) | per event | measured |
| process | `trtllm-serve` HTTP process, executor worker (MPI-spawned), `orted`, client | nsys pids, things tree | per process | measured in nsys runs |
| component | the 26 boxes in `registry/components.json` (ASGI, LLM API, ZMQ, scheduler, forward, sampler, ...) | component stamps | per stamp | measured in stamped runs |
| software layer | toolkit (Python, PyTorch ops) → runtime (CUDA runtime, driver) → device code (kernels) | row kind | per row | measured |

- The worker's boxes (fetch, scheduler, forward, sampler, update, responses) are the execution phases. Components
  are where execution and architecture join.

## 2. The fly model

**Position.** A position is a dimension and one of its tiers, plus one shared cursor. The cursor is a time and,
when something is selected, a row. Flying changes the position. It never moves the cursor.

**What "now" means.**

- Execution. The unit of the focused tier that contains the cursor, such as the module running at that time.
- Hardware. The state of the focused tier's parts over the sample window holding the cursor (100 µs replay,
  100 ms live), plus transfers in flight. At kernel traffic, the profiled kernel at the cursor.
- Architecture. The boxes holding work at the cursor, and the last hand-off the request made at that tier.

**Moving between tiers.** Finer or coarser inside the focused dimension. The cursor stays. The window becomes the new
tier's natural window around the cursor.

**Crossing dimensions.** The cursor stays, and the target tier comes from an alignment table, so a crossing lands
on the tier that shows the same thing:

| execution | hardware | architecture |
| --- | --- | --- |
| request | system | container |
| iteration | device | process |
| phase | device | component |
| layer, module | unit | component |
| kernel | unit or kernel traffic | software layer |

**Stepping.** A step moves to the next stop of the focused position:

- Execution stops are its units (section 4).
- Hardware stops are the events that move data at that tier: transfers at device, kernels at unit, profiled kernels
  at kernel traffic. System and node have no events of their own, so they step on the aligned execution tier.
- Architecture stops are hand-offs: the request moving to another container, process or box.

Samples are state, never stops.

**Walking every row (owner, 2026-11-08).** Alt + ← / → walks rows below the stop tiers, in two modes:

- Every row of the focused tier in time order, across every process.
- Only the rows of the selected process, or of the selected object (for example the ops and launches inside one
  `linear` call; about 64 detail rows per module, calculated from section 4).

**Process identity and branches (owner, 2026-11-08).**

- Every process has its own colour or mark, used in every dimension, so concurrent processes stay apart.
- Every row maps to its process. The store already has this: a row's lane is a thread or stream, and each thread
  sits under its process in the things tree (measured).
- A process or thread that creates another shows the branch at the step where it happens. Thread creation is
  recorded (42 `pthread_create` calls in the timeline run, measured). Process creation (the MPI-spawned worker) is
  missing: it happens before the profiler's capture range, and no process start time is stored. Candidate sources
  are the nsys process table and the container log.

**Control plane (owner, 2026-11-08; placement and Compare split replaced by the D13 initial layout).** The bar at the bottom holds what is about runs, not inside one run: the run
picker, the rep launcher, Logs, Tools, Lifecycle and Compare. How they look is decided later. Compare splits the
stage into two panes, each run its own full world. A run's own service containers (Grafana, Prometheus, DCGM, node
exporter) belong in that run's world, as architecture / container.

**Base for building (owner, 2026-11-08).** Build from the native levels on the `v2-scene` branch (`devtools/frontend/
cc`), not from v1 pages embedded in 3D.

**Candidate designs (descriptions; one demo each before a freeze).**

1. **Stacked world.** The board is the floor. Architecture boxes stand on the hardware they run on, so the worker
   process sits over the CPU with a stem down to the GPU. Execution is a moving pulse that travels from container
   to process to box, then down the stem as kernels to the SMs. Flying to a tier moves the camera to that layer and
   depth; the other two dimensions dim but stay in place. Strength: matches the "one world" ask literally. Risk:
   occlusion and depth at fine tiers; v2 gap P1 showed a far-apart layout reads as a dot when zoomed out.
2. **Three coordinated stages.** The v2 side layout, one column per dimension. Each column flies its own ladder on
   the shared cursor; highlights and connecting lines tie a selection across columns. Strength: builds on the frozen
   side layout and keeps each investigation readable. Risk: the "world" is implied by links, not seen as one place.
3. **Execution spine with lenses.** The execution timeline is always present. Hardware and architecture open as
   lenses at the aligned tier over the selection, and any lens can fly to full stage. Strength: stepping stays in
   one place; smallest change from v3. Risk: hardware and architecture feel secondary.
4. **Orbit cube.** Each face of one cube is a dimension and depth into a face is the tier. Time is the shared edge,
   so the cursor is a plane slicing all three faces at once. Crossing dimensions orbits to that face.

Prototypes of all four on scratch data: `devtools/frontend/prototypes/D10/` (served at
`http://127.0.0.1:7710/static/prototypes/D10/index.html`).

**D10 outcome (owner, 2026-11-08).** Candidates 2 and 4 are dropped. Candidate 1 (stacked world) is the best view
for understanding hardware. Candidate 3 (execution spine) is the best view for a request's lifecycle. Both stay, as
two world views picked from the header. The selection, cursor and tiers carry over when the view changes.

**Independent tiers (owner, 2026-11-08; Independent is the default since D13).** Each dimension keeps its own tier. A paired / independent toggle decides
what a tier change does. Paired: the other two dimensions move to the aligned tier (the table above). Independent:
only that dimension moves. Everything is clickable: tiers, things, units, stops and metrics. The keys stay as
shortcuts.

**Architecture lens (owner, 2026-11-08).** Containers and components are drawn the way v1 Infrastructure and
Components drew them, with their sparklines and utilization bars. They are rebuilt natively in the new code. Only
the v1 style is copied; no v1 module is imported.

**Flyout dock (owner, 2026-11-08).** A dock at the bottom or right holds what lies outside the world: the data of the
selection at each step (as in the v1 Trace detail), the rep's metrics as they are calculated (I02A: TTFT, ITL,
end-to-end and their segments, each lighting its input spans), and the control plane.

D11 builds these on scratch data: `devtools/frontend/prototypes/D11/` (served at
`http://127.0.0.1:7710/static/prototypes/D11/index.html`).

**Playback (owner, 2026-11-08).** Play visits every event of every tier inside the bounds and loops at the bounds.
The bounds are the execution unit at the cursor at the execution tier (between units, the nearest coarser unit
holding the cursor). The tier limits playback; it never filters events. The clock is v2's (`cc/control/control.js`):
one animation frame advances the cursor and redraws every view, time pace by default (the bounds play in 8 s at x1),
events pace on request.

**One tier selector per dimension (owner, 2026-11-08).** The header ladder is the only tier control. Lenses show the
tier; they do not set it.

**Execution spine is 2D (owner, 2026-11-08).** A flat, zoomable view, no 3D. Its lens window has Architecture,
Hardware and Split (50/50) tabs, and the spine fills its space.

**Built on v2 (owner, 2026-11-08).** The bottom bar (Selected, At cursor, Metrics, Tokens, Kernels, Run), the
playback clock and the hardware sidebar follow the `v2-scene` branch, rebuilt in the prototype, not imported.

D12 builds these with four placements of full-screen architecture behind one switcher:
`devtools/frontend/prototypes/D12/` (served at `http://127.0.0.1:7710/static/prototypes/D12/index.html`).
`D12/regress.sh` re-checks the approved behaviour in every variant.

## 3. Map of every current surface

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
| v1 view | run | rep launcher: control plane (bottom), outside the world |
| v1 view | engine | execution / iteration (live engine stats) |
| v1 view | lifecycle | control plane (bottom), outside the world; container events stay architecture / container stops |
| v1 view | requests | execution / request (list of stops) |
| v1 view | runs | control plane (bottom), outside the world |
| v1 view | compare | control plane (owner): splits the stage into two panes, each run its own full world |
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
| control | focus <level> (keys 1-7) | fly to tier n of the focused dimension; a separate key picks the dimension (fly model, section 2) |
<!-- /gen:surfaces -->

## 4. Stop counts per run

Generated by `stop_counts.py` over every run in `/mnt/ie-data/cc/store/runs/`. There is no stop budget (owner,
2026-11-08): only real units are stops, and their count is what the model does. The jump check guards against the
Tier 4 mistake recurring. It flags a stop tier whose stops per iteration exceed 3 times the largest earlier run of
the same trace level, which means a row kind that should be detail was probably mapped to a stop tier.

<!-- gen:stops -->
Execution stops (own tier). Per iteration in brackets. `detail` rows are never stops.

| run | rows | iterations | request | iteration | phase | layer | module | kernel | detail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| I02A-TRACE-code_20261103T170709Z_0ac2db | 1,140,076 | 64 | 3 (0) | 0 (0) | 859 (13) | 1,600 (25) | 17,216 (269) | 18,309 (286) | 1,103,689 (17,245) |
| I02A-TRACE-components_20261104T142238Z_0b249c | 2,171 | 128 | 2 (0) | 128 (1) | 2,019 (16) | 0 (0) | 0 (0) | 0 (0) | 22 (0) |
| I02A-TRACE-components_20261108T195135Z_f32fab | 2,171 | 128 | 2 (0) | 128 (1) | 2,019 (16) | 0 (0) | 0 (0) | 0 (0) | 22 (0) |
| I02A-TRACE-kernels_20261103T181509Z_52744d | 886 | 0 | 3 | 0 | 861 | 0 | 0 | 0 | 22 |
| I02A-TRACE-live_20261103T185532Z_1c1629 | 595 | 0 | 2 | 0 | 571 | 0 | 0 | 0 | 22 |
| I02A-TRACE-timeline_20261103T185837Z_e08b8b | 90,255 | 128 | 3 (0) | 0 (0) | 2,811 (22) | 3,200 (25) | 0 (0) | 39,768 (311) | 47,673 (372) |
| I02A-TRACE-timeline_20261107T172848Z_f2ac52 | 91,901 | 192 | 3 (0) | 192 (1) | 4,962 (26) | 3,200 (17) | 0 (0) | 39,768 (207) | 46,976 (245) |
| I02A_20261103T164324Z_348959 | 598 | 0 | 2 | 0 | 574 | 0 | 0 | 0 | 22 |
| I02A_20261103T172804Z_a3ca9a | 600 | 0 | 2 | 0 | 576 | 0 | 0 | 0 | 22 |
| I02A_20261103T172929Z_0e5d39 | 600 | 0 | 2 | 0 | 576 | 0 | 0 | 0 | 22 |

Jump check (a stop tier above 3 times its largest earlier run of the same trace level): no jumps.


Hardware and architecture stops.

| run | transfers | launches | container hand-offs | process hand-offs | component hand-offs | ncu-profiled |
| --- | --- | --- | --- | --- | --- | --- |
| I02A-TRACE-code_20261103T170709Z_0ac2db | 2,751 | 18,309 | 504 | 4,693 | 4,693 | 0 |
| I02A-TRACE-components_20261104T142238Z_0b249c | 0 | 0 | 575 | 1,321 | 1,786 | 0 |
| I02A-TRACE-components_20261108T195135Z_f32fab | 0 | 0 | 502 | 1,368 | 1,784 | 0 |
| I02A-TRACE-kernels_20261103T181509Z_52744d | 0 | 0 | 428 | 638 | 638 | 0 |
| I02A-TRACE-live_20261103T185532Z_1c1629 | 0 | 0 | 277 | 421 | 421 | 0 |
| I02A-TRACE-timeline_20261103T185837Z_e08b8b | 5,628 | 7,512 | 851 | 8,914 | 8,914 | 0 |
| I02A-TRACE-timeline_20261107T172848Z_f2ac52 | 5,628 | 7,512 | 3,702 | 12,286 | 12,533 | 235 |
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
| I02A-TRACE-kernels_20261103T181509Z_52744d | gpu0-nvidia-smi | 8,058 | 100,244 µs |
| I02A-TRACE-live_20261103T185532Z_1c1629 | gpu0-nvidia-smi | 782 | 100,201 µs |
| I02A-TRACE-timeline_20261103T185837Z_e08b8b | gpu0-metrics | 44,466 | 100 µs |
| I02A-TRACE-timeline_20261103T185837Z_e08b8b | gpu0-nvidia-smi | 862 | 100,205 µs |
| I02A-TRACE-timeline_20261107T172848Z_f2ac52 | gpu0-metrics | 48,560 | 100 µs |
| I02A-TRACE-timeline_20261107T172848Z_f2ac52 | gpu0-nvidia-smi | 927 | 100,191 µs |
| I02A_20261103T164324Z_348959 | gpu0-nvidia-smi | 711 | 100,196 µs |
| I02A_20261103T172804Z_a3ca9a | gpu0-nvidia-smi | 710 | 100,201 µs |
| I02A_20261103T172929Z_0e5d39 | gpu0-nvidia-smi | 711 | 100,203 µs |
<!-- /gen:stops -->

Reading the counts:

- The code run's 1.10 M detail rows leave stepping entirely. Its finest stop tier, kernel, has 286 per iteration;
  module has 269. The crawl came from detail rows, not from any tier a learner needs.
- Graphs-on timeline runs have no module stops (missing, section 1) and 207 to 311 kernel stops per iteration.
- The newer timeline run counts 192 iterations but only 128 carry kernels (profile range 1-129), so its per-iteration
  layer and kernel numbers are lower than the older run's. Divide by 128 to compare.
- Hand-offs are an upper bound. They count every change of box along a request's rows in start order, including
  rows that overlap in time (concurrent client and server work), not only true hand-offs.
- Runs without traces (I02A measured runs, live, kernels) hold only requests and stamps: about 575 phase stops.

## 5. Walkthroughs

### I02A: which client time is the first token?

The rep found headers at 2.69 ms (P50) and the engine's TTFT at 15.77 ms or more, because TensorRT-LLM sends headers
before it has a token.

- **Today.** Trace level (lanes) to find the headers, the first body read and the first token event among client
  rows. Components level to see ASGI. The engine's TTFT is in the v1 Run tab, outside the scene.
- **New.** Execution / phase: step the request's hops (headers sent by ASGI, role event, first token event). Cross
  to architecture / component: the ASGI box lights while the worker's forward box is still busy. Cross to hardware /
  device: the GPU is running prefill when the headers leave. One cursor, three answers.

### I03: is decode memory-bound?

- **Today.** The Hardware level lights SM boxes from samples (gap P6: "0 of 36 SMs" during decode). The sidebar shows
  DRAM. Nothing frames one iteration.
- **New.** Execution / iteration: step to a decode iteration. Cross to hardware / unit: DRAM read % against SMs
  active over that iteration's 34 samples. Fly to kernel traffic for iteration 67: DRAM bytes per kernel against
  each kernel's FLOPs (the roofline point). Resolution limit stated: per kernel only where ncu profiled.

### I06: why do decode's projections leave SMs idle?

- **Today.** Kernel level: launch shape from cold args, ncu headline counters. The v2 hardware view shows SMs.
- **New.** Execution / module: a `linear` forward (code run). Fly finer to its GEMM kernel. Cross to hardware /
  kernel traffic: grid size against 36 SMs, waves, achieved occupancy (`launch__grid_size`, `launch__block_size`
  are in the ncu metric list). Cross to architecture / software layer: the path from the TRT-LLM linear (toolkit)
  through `cudaLaunchKernel` (runtime) to the cuBLAS kernel (device code).

## 6. Fit test: future reps as registry entries

Each block is what the rep would add. A rep fits when it only adds entries.

**I06, kernels on three engines (vLLM, SGLang, TensorRT-LLM) and a hand-written kernel.**

```json
{"things": [{"kind": "container", "key": "host/vllm"}, {"kind": "container", "key": "host/sglang"},
            {"kind": "process", "key": "host/bare/double_kernel"}],
 "components": {"maps": {"trtllm": "...current map...", "vllm": "...", "sglang": "..."}}}
```

Kernels, launch calls and ncu counters fit as they are. **Does not fit:** `components.json` holds one map for
TensorRT-LLM. Three engines need one map per engine, keyed by the run's engine. That is a structure change.

**I27, Kubernetes (kind cluster, then a managed cluster).**

```json
{"kinds": [{"kind": "k8s event", "execution": "detail", "hardware": "-",
            "architecture": "container (pod condition stop)"}],
 "things": [{"kind": "cluster"}, {"kind": "control plane component"}, {"kind": "k8s node"}, {"kind": "pod"}]}
```

Fits. The fleet and node tiers already exist in the ladder. Figure O1 (apply to ready) becomes the stops of
architecture / container.

**I30, own stack, TP 8 on an 8-GPU node.**

```json
{"kinds": [{"kind": "nccl collective", "execution": "module", "hardware": "device (NVLink)",
            "architecture": "software layer (runtime)"}],
 "things": [{"kind": "gpu", "key": "gpu0..gpu7"}, {"kind": "bus link", "name": "NVLink / NVSwitch"},
            {"kind": "process", "key": "worker rank 0..7"}]}
```

Fits as entries. **Pressure:** one iteration launches its kernels on 8 GPUs, so kernel stops per iteration grow by
about 8 times. Stepping needs a rule: step one GPU, or step all ranks in time order.

**I33, Mooncake KV layer with spill to NVMe.**

```json
{"kinds": [{"kind": "kv transfer", "execution": "phase", "hardware": "device (src and dst things, bytes)",
            "architecture": "component (transfer engine)"}],
 "things": [{"kind": "container", "key": "host/mooncake_master"}, {"kind": "component", "key": "transfer engine"}]}
```

Fits as entries if a `kv transfer` row names its source and destination things (VRAM, RAM, NVMe). **Missing data:**
NVMe I/O and RAM bandwidth are not collected (section 1). Figure M2 needs them.

**Verdict.** Every rep adds entries. Two structure changes come out of it: one component map per engine, and a
stepping rule across GPUs. One collection gap comes out too: NVMe and RAM.

## 7. Migration order

Each phase leaves the interface usable and ends with a check.

| phase | change | interface after | check |
| --- | --- | --- | --- |
| 0 baseline | `ccv` captures of every v3 level and the v2 side page; this doc's counts saved | unchanged | captures exist; scripts rerun clean |
| 1 data | `kinds.json` gains each kind's place in each dimension and the module and launch rules; the importer writes the new placements beside the old `tier` | unchanged | store-check: every row has exactly one place per dimension; counts equal section 4 |
| 2 execution ladder | stepping uses the execution tiers; detail rows leave the stepping path | same levels, no crawl | `stop_counts.py` jump check passes; `ccv` steps through a code-run iteration |
| 3 fly control | position = dimension and tier; keys and buttons fly; each current level registers as the view of its mapped tiers | every level reachable through the new control | `map_surfaces.py` exits 0; help lists every key; `ccv` flies each tier |
| 4 hardware | system (sidebar) → node → device flows → unit → kernel traffic (v2 SM view) → Nsight link | hardware flyable | values at a cursor match nsys and ncu for the same kernel and time |
| 5 architecture | fleet and node shells, containers, processes, components, software layer | architecture flyable | hand-offs per request reconcile with component stamps |
| 6 world | the layout the owner chose from the demos | one world | the three walkthroughs above, done in the interface |
| 7 retire | the old `tier` column and the 7-level list are removed once nothing reads them (owner) | final | no surface in section 3 points at an old item |

Phase 6 follows "freeze, then prototype next": one demo per candidate, on real data, after phases 1 to 3 freeze.

## 8. The shell: load, launch, compare

The command center is a shell around one behavior: open a session on a rep, then look at it through the worlds.
The worlds never pick a run. They draw the session's run. Prototype: `devtools/frontend/prototypes/D13/`.

### The session

A session is one of three modes. It names the rep and the run (two runs in compare).

| mode | how it opens | what the worlds show | ends |
| --- | --- | --- | --- |
| replay | Load: pick a rep, then one of its recorded runs | the whole run; cursor and playback anywhere | when another session opens |
| live | Launch: pick a registered rep's action and options | the run up to the head; past the head is masked "not recorded yet"; follow keeps the cursor at the head | at the end of the run it becomes a replay of that run |
| compare | Compare: pick run A and run B (same rep or another) | Rep world: A, B, B − A, % side by side; replay worlds: one run at a time, A / B switch | when another session opens |

The header shows the open session: rep, run (time and kind), a mode badge, and the Load, Launch and Compare buttons.
Each button opens one panel with three tabs, reps on the left. The session is in the URL hash, so a reload keeps it.
A reload during a live run reopens as a replay.

### Four worlds as lenses on the session

| world | question it answers |
| --- | --- |
| Rep | What does this rep teach, what came out, and where in the run can I see it? |
| Stacked world | Where is the run right now, in all three dimensions at once? |
| Execution spine | What happens in what order, with architecture and hardware beside it? |
| Architecture | Which software owns each step? |

The Rep world is the session's front page. Load and Compare open on it. Launch opens on the spine. It shows the
README's Mechanism ("what this rep teaches"), the key moments, the Why It Matters lessons with their moment counts,
the results on three clocks (client, wire, engine), the TTFT segments, and the README's Results, Pass Check and Task.
A run without `latency.json` says "results not computed". It never shows a made-up value.

### Key moments (`moments.toml`, one per rep)

Every rep has a `moments.toml` beside its README. Each moment names where a lesson can be seen in a run:

| field | meaning |
| --- | --- |
| `id`, `title` | short key and a one-line claim |
| `lesson` | the Why It Matters bullet it proves (bold lead, verbatim) |
| `at` | the moment's time: a result path, e.g. `wire.headers_ms` |
| `event` | what happens there, in the spine's vocabulary (phase or kernel name) |
| `note` | why it matters, two sentences at most |
| `evidence` | result paths shown beside it, each with a label |

Paths read the run's result, so one file serves every run of the rep. A segment is picked by the start of its name
(`segments[first_scheduled_time].ms`), never by index. Older I02A runs have 8 TTFT segments, newer runs 7, so
`segments[3]` names a different segment in each (found while building D13). `[[setup_lessons]]` holds lessons
about the setup with no moment in a run. "Show me" moves the replay to the moment's event and opens the spine.

### Data the shell reads

| source | gives | in D13 |
| --- | --- | --- |
| `reps/*/README.md` | title, sections | `tools/build_session.py` → `session-data.json` |
| `reps/*/rep.toml` | launch actions and options; a rep without one is replay only | same |
| `reps/*/moments.toml` | key moments | same |
| run folders with `basis.json` or `labels.json` | runs, kind (measured / trace), start time | same |
| a run's `latency.json` | results | same; the real build reads `/api/runs/{id}/file` |
| `POST /runner/jobs` | starts a launch | not called; Launch is simulated on the scratch timeline |

### Gaps the prototype shows (measured 2026-11-08)

- 1 of 6 reps has `moments.toml` (I02A-L1). The other 5 need one.
- 1 of 6 reps has `rep.toml`, so only I02A-L1 can be launched.
- 14 of 18 scanned run folders have results. I02C runs live outside `reps/` and are not scanned.
- Every world still draws the scratch timeline. Show me jumps to a stand-in event. Both compare sides replay the
  same events. Per-run events need the real store.

## Open choices (owner)

1. **Final layout of the world.** Initial layout settled: D13 (owner, 2026-11-08), stated at the top of this doc.
   Still open for the end state: P1 (zoomed-out side layout reads as a dot) and P2 (5 px text in panels).
2. **CPU-side counters.** Evidence: CPU cores, L3 and RAM bandwidth are missing (section 1); CPU and RAM utilization
   exist live only, from Docker stats, about 1 s. The i9-9900K exposes uncore counters to `perf` (not yet tried).
   I33 needs NVMe and RAM; nothing else in the fit test does.
3. **v2 alongside during the migration.** Evidence: phases 1 to 3 change no layout; the v2 store at
   `/mnt/ie-data/cc-v2-proto/store_v2` holds hand-imported I02A runs only.
4. **Grain follows zoom.** Today the step tier follows the window width (`grainFor` in `cc/store/run.js`). The
   owner wants to keep it for snapping. Settled: each dimension keeps its own tier, with a paired / independent
   toggle. Open: semantic zoom that snaps to tier bounds (proposed, not yet ruled).
5. **Where the shell controls live.** Initial layout: the header, as built in D13 (accepted with D13). This
   replaces the earlier ruling that put the run picker, rep launcher and Compare in the bottom control plane.
6. **Compare in the replay worlds.** Initial layout: one run at a time with an A / B switch (accepted with D13).
   Open: a split into two full worlds, as first ruled, once per-run events exist and the halves would differ.
7. **Key for walking every row.** Conflict: section 2 gives Alt + ← / → to walking every row (owner). D12 bound the
   same keys to back / forward through selections; the buttons were the owner's ask, the keys were not. Walking
   rows is not built yet. Proposed: give history other keys (`[` and `]`) before row walking is built.

## Decision log

| date | decision | by |
| --- | --- | --- |
| 2026-11-08 | Doc opened; three dimensions proposed | owner |
| 2026-11-08 | Each dimension has its own tiers; CPU and GPU are hardware, not lanes; design before code | owner |
| 2026-11-08 | No stop budget: only real units are stops; `stop_counts.py` jump check added instead | owner |
| 2026-11-08 | Every-row walk kept in two modes (whole tier, or the selected process or object); each process has its own colour, rows map to their process, branches show where they are created | owner |
| 2026-11-08 | Compare and the v1 views (run picker, rep launcher, Logs, Tools, Lifecycle) live in the bottom control plane, outside the world; Compare splits into two full worlds; run-specific service containers are in the run's world | owner |
| 2026-11-08 | Build from the native levels on the `v2-scene` branch; no v1 pages embedded in 3D | owner |
| 2026-11-08 | Old `tier` column and 7-level list removed at phase 7 | owner |
| 2026-11-08 | v2 flat, nested and split pages removed (side page checked: READY, no console errors) | owner |
| 2026-11-08 | D10: stacked world and execution spine kept as header-selectable world views with shared selection; stages and cube dropped | owner |
| 2026-11-08 | Tiers independent per dimension, with a paired / independent toggle; everything clickable, keys as shortcuts | owner |
| 2026-11-08 | Architecture lens drawn in the v1 Infrastructure and Components style, sparklines included; rebuilt natively, never imported from v1 | owner |
| 2026-11-08 | Flyout dock (bottom or right) holds selection data, the rep's metrics (I02A TTFT and others) and the control plane | owner |
| 2026-11-08 | Playback plays every event inside the bounds and loops; the tier sets the bounds only; v2's clock | owner |
| 2026-11-08 | One tier selector per dimension (the header ladder); lenses do not carry their own | owner |
| 2026-11-08 | Execution spine is 2D and zoomable; its lens window swaps Architecture, Hardware and a 50/50 Split; no empty space | owner |
| 2026-11-08 | Bottom bar, playback and hardware sidebar follow the v2-scene branch (rebuilt, not imported) | owner |
| 2026-11-08 | Architecture views use v1 exact styling and all 26 v1 component steps; nothing merged or restyled | owner |
| 2026-11-08 | "Process" colour means logical flow (request in, prefill, decode loop, stream out), not OS process; flows overlap in time | owner |
| 2026-11-08 | Header uses D10 style and sizing: thin world tabs, title, compact ladders, now summary | owner |
| 2026-11-08 | D12: three worlds (Stacked, Execution spine with the Split lens at 55%, Architecture full screen); lanes variant dropped | owner |
| 2026-11-08 | Each spine pane (architecture, hardware, execution bands) zooms and pans on its own | owner |
| 2026-11-08 | Bottom bar has back / forward through selections; each step restores the selection, cursor and tab | owner |
| 2026-11-08 | The command center is a shell around load (replay a run), launch (watch it live) and compare (two runs of one rep, or of two reps) | owner |
| 2026-11-08 | Rep world added: what the rep teaches, results, lessons and key moments that jump into the replay | owner |
| 2026-11-08 | Every rep has key moments (`moments.toml`) | owner |
| 2026-11-08 | D13 is the initial layout (checkpoint); it carries every ruling above that it does not replace | owner |
| 2026-11-08 | Tiers default to Independent; Paired stays a toggle | owner |
| 2026-11-08 | With D13: Load, Launch and Compare in the header; compare in the replay worlds is an A / B switch (replaces the bottom control-plane placement and, for now, the split) | owner |
