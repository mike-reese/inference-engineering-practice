# Command center v3: native levels on one event set (option B)

Status: synthesized design, 2026-11-08. It is the contract for the implementation. Change the design here first,
then the code. Design packages and measurements: the architect arena (candidates 1-3), summarized in "Synthesis".

## Problem

One run lives in three stores today: the v2 Parquet store (levels 4-7), v1 `run.json` (the hosted Trace panel), and
component stamps over SSE (the hosted Components panel). Their ids differ, so a selection cannot cross levels. Four
step models fight over one cursor. The hosted panels fill 33% of the stage with 5 px text. Each cursor move costs
HTTP queries of 8-30 ms, and a fractional cursor breaks them (T7). New runs never reach the store (manual import).

The owner wants one 3D command center with one control plane. The timeline zooms to the finest event and steps
through every event. Zoomed out at a coarser layer, a step jumps to the next event of that layer. It is one granular
event set, not separate stores. Live and replay show the same views. Low latency comes first.

## Role: what the command center is for, and what it leaves to Nsight

Owner, 2026-11-08: the command center is primarily for learning, validating and building intuition at a high level
for each rep, as the reps add complexity. It must prioritize that. It gives what nsys and ncu cannot: one view that
links the high-level information across every granularity, from request to kernel to hardware, live and in replay.
Nsight Systems and Nsight Compute stay the tools for targeted inspection. They are first-class links and references,
not things to rebuild. True investigative work spans all three programs.

What follows from that:

- **nsys: import the event rows, link for the rest.** Kernel, memcpy, memset, CUDA API and NVTX rows are imported,
  because levels 4-5 and tier 3-5 stepping are built from them. Without them, replay stops at component stamps. Every
  imported row and every iteration carries an "open in Nsight Systems" link to its report and time range.
- **ncu: link only.** L6 shows a few headline counters (duration, achieved occupancy, DRAM and L2 bytes, SM and
  memory throughput as % of peak) and an "open in Nsight Compute" link for the kernel. Sections, rule findings and
  source views stay in ncu-ui. This repeats the pattern of commit 91c28c2 (`openInTool` -> host runner
  `/runner/open`).
- **Live GPU load comes from NVML GPM, not from a profiler.** NVML GPM reads SM utilization, SM occupancy, tensor
  utilization and DRAM bandwidth about every 100 ms with no profiler attached. nsys GPU metrics (10 kHz) arrive in
  windows about 3 s late with gaps between windows, so they belong to replay.

## Usage (caller's view)

```js
// frontend/cc/app.js: the composition root
const store = await openRun(url.run ?? (await latestRun()));   // manifest + binary blocks; tails the run if live
const control = new Control(store, readUrl());                  // the one owner of cursor, window, grain, selection
new Scene($("#stage"), store, control, LEVELS);                 // levels draw from Frames; no state of their own
new ControlBar($("#bar"), store, control); new Inspector($("#inspector"), store, control, TABS);
new HardwareSidebar($("#hw"), store, control); bindKeys(window, control);
```

```js
// control/keys.js, ArrowRight: the next event at the grain, in (start, id) order
control.step(+1, e.shiftKey ? "coarser" : e.altKey ? "finest" : null);
// levels/components.js, every frame: light the boxes with a stamp active at the cursor
frame(f) { this.boxes.light(this.store.activeBy("comp", f.cursor.t)); }
```

```py
# backend/store: one writer for live and import
w = RunWriter.open(root, run, registry, status="live")
hub.publish(w.append(server_stamps.parse(line, ctx)))   # the same parse() the importer calls
manifest = import_run(run_dir, root, registry)          # run end: the next generation, nsys/ncu added
```

## Shape

### Data: one row table, one total order

- Every source becomes rows of one event table: run.json spans, nsys, component and client stamps, pcap frames,
  engine stats, docker events. Samples are a separate table of clocked values. Samples are never stepped.
- Total order is `(start, id)`. `id` is dense `0..N-1`. In a final generation, `id` follows `(start_ns, source order)`.
- Times are Float64 ns from the run's `t0_ns` (exact to 2^53 ns). `Control.seek` rounds the cursor once, so a
  fractional ns never exists (T7).
- Hot columns (the browser holds these; 54 B per row):

| column | type | meaning |
| --- | --- | --- |
| `id` | `<u4` | dense row id |
| `start`, `end` | `<f8` | ns from `t0_ns`; `end == start` for an instant |
| `lane` | `<u2` | thing index of the thread, GPU stream, client or wire lane |
| `comp` | `<u2` | thing index of the component box, `0xFFFF` = none |
| `kind` | `\|u1` | kind code (`manifest.kinds`) |
| `tier` | `\|u1` | rank 0..6, see below |
| `depth` | `<u2` | sub-row inside the lane (nesting, then greedy packing); a lane past 65,535 stops the import |
| `req` | `<u2` | request index, `0xFFFF` = none |
| `iter` | `<i4` | engine iteration, `-1` = none. A device op takes its launching call's iteration |
| `parent` | `<i4` | parent row id, `-1` = none |
| `cause` | `<i4` | cross-lane origin row: CUDA launch call for a device op, ZMQ send for a receive; `-1` = none |
| `name` | `<u4` | string index (`manifest.names`) |
| `bytes` | `<f8` | bytes moved, NaN if none |

- Cold columns stay in Parquet; the server answers them by id: `eid` (the stable URL key), `what`, `args`,
  `evidence`, `term`, `source`, `corr`, `quirk`, `parent_rule`, `raw_file`, `raw_ptr`, `code_origin` and
  `code_where` (code-level runs), `layer` (decoder layer of a kernel, Inferred by the RMSNorm heuristic of
  `trace/adapters/nsys.py` `layer_of`; null when the heuristic gives none).

### Tier (rank) and grain

The tier ladder is in `devtools/registry/kinds.json`, the one list of kinds:

| tier | name | kinds |
| --- | --- | --- |
| 0 | request | client request, container event |
| 1 | iteration | iteration (derived: scheduler stamp to the next one, Calculated), engine timestamp |
| 2 | stage | component stamp, client event, client transport, network frame, top NVTX range |
| 3 | op | NVTX range nested in an NVTX range, cuda graph node |
| 4 | call | cuda runtime call, cuda driver call, cuda synchronization, cuda event record, cpu operator, python call |
| 5 | device | kernel, memcpy, memset |
| 6 | os | os runtime call, profiler overhead, profiler message |

- `derive_tier`: the kind's tier; one tier finer when nested in the same kind (NVTX only, one step). Then
  `tier(child) >= tier(parent)` must hold, or the import stops and names the row.
- The derived iteration has kind `iteration`. The executor's forward-step NVTX range (ie-run/2 kind
  `engine iteration`) is imported as an `nvtx range` with term "executor forward step (NVTX range)". A run with
  no scheduler stamps has no derived iteration rows.
- python call, cpu operator and cuda driver call sit at tier 4. In the code-level run cuda runtime calls (tier 4)
  are children of python calls and cpu operators, so those two can be no finer than tier 4; tier 4 is the finest
  placement that keeps the invariant. They are 1.08 M of 1.14 M rows there, so tier-4 stepping is dense (open
  question: a coarser tier for them is also valid).
- Thing containment is a separate axis: "where". Tier is "how fine". Every thing has Euler `pre`/`post`.
  Component boxes are things (`registry/components.json`, moved from v1 `components_map.js`).
- **Step.** `step(dir, r)` moves to the next or previous row in `(start, id)` order with `tier <= r`. Every row is
  visited at tier 6. Zoom and focus never change the cursor, so position is kept.
- **Grain.** The step tier follows the window width: `grainFor(width, px)` picks the finest tier whose median start
  gap is at least 6 px. Panning never changes it. Shift steps one tier coarser; Alt steps every row.
- **Focus.** Focusing a level sets the window to that level's natural window at the cursor (L1 run, L2/L3 request,
  L4 iteration plus the device work it launched, L5 64 device ops, L6/L7 the device op and 4 neighbours). The grain
  then follows the width. "Focus a coarser level" and "zoom out" are one state change.
- **Strip.** The timeline's detail row draws every stop at the current grain as a tick. What you see is what you step.

### Storage: ie-run/3, one folder per run

Root `$CC_STORE` (default `/mnt/ie-data/cc/store`), layout `runs/<run>/`:

```
manifest.json                 schema "ie-run/3", run, generation, status (live|final), t0_ns, head_ns, tiers, kinds,
                              link_kinds, things (with pre/post), names, requests, metrics catalog, block list,
                              aux, source, tools, inputs_sig, import stats. Written by temp file + rename.
g<gen>/events-<block>.parquet hot + cold columns, sorted (start, id), zstd
g<gen>/links.parquet          every link (from, to, kind, weight, rule, evidence)
g<gen>/samples-<group>.parquet one group per source track and shared clock (ts_ns, one column per metric)
g<gen>/profiles.parquet       Nsight Compute headline counters per kernel (ncu.json `headline`), in the registry unit
g<gen>/aux.json               calculated metrics with their inputs (row ids, sample indexes), facts, measures
g<gen>/<block>.ccvb           binary twin of each hot block (the browser maps it as typed arrays); links.ccvb holds
                              the links that are not causes (cause links are the `cause` column)
capture/<source>.jsonl        live-only sources: gpu (NVML), docker (events), docker-stats, engine (Prometheus scrape),
                              engine_iterations_raw (the engine's iteration stats); the final import reads them
capture/clock.json            the run's t0_ns and wall offset, fixed when the live run opens (one t0, see below)
```

Manifest entries (implemented in step 1):

- `kinds`: `[{code, name, tier, nest_bump, derived, color, label, home}]`, code = position in `registry/kinds.json`.
  `link_kinds`: `[{code, name, cause, label}]`.
- `metrics`, the catalog of the run's samples: `[{code, metric, label, unit, thing, group, sidebar, source,
  period_ms, period_ns_measured, evidence}]`. `source` and `period_ms` come from `registry/kinds.json` `metrics`;
  `period_ns_measured` is the median sample gap of this run.
- `blocks`: `[{name, table, band, rows, t, tier_counts, bytes, etag}]`, plus `group` and `metrics` for samples.
  `aux`: `{name: "aux.json", bytes, etag}`, fetched through the blocks route.
- `source`: `{run_dir (relative to REPO), importer, live?}` (`importer` is `store.importer` for a final generation,
  null for a live one). `tools`: `{nsys: {run, path, session_start_ns, evidence},
  ncu: {run, path, kernels, counters}}`. `path` is relative to that run's folder, the form `/runner/open` takes.
  `session_start_ns` is the run-clock ns of the nsys report's time zero, Calculated from kernels matched by CUDA
  correlation id (ids shared by a graph's kernels are skipped); null when the offsets disagree.
- The previous generation `g<gen-1>` stays until the next import; older ones are deleted.

Bands: `spine` (tiers 0..2, always resident) and `fine` (tiers 3..6, blocks of 32,768 rows). Block time bounds may
overlap; every browser query merges across blocks, so a late live row is legal anywhere.

CCVB layout (little-endian, zero copy):

```
0     "CCVB"
4     u32 H, header length; padded with spaces so 8 + H is a multiple of 8
8     header JSON {schema:"ccvb/1", table:"events"|"links"|"samples", block, band, gen, rows, base_rows,
                   t:[minStart,maxStart,maxEnd], tier_counts[7], dict_delta, metrics, columns:[{name,type,offset,length}]}
8+H   column buffers, 8-byte aligned, numpy dtype strings
```

In a samples block, `metrics` holds catalog codes (`manifest.metrics[code]`), and the columns are `ts` (`<f8`) then
`m0..mk` (`<f4`) in that order. A code, not a metric name, because two GPUs report the same metric name.

`backend/store/schema.py` is the one column list. `frontend/cc/store/columns.js` mirrors it; `make store-check`
fails when they differ.

### Retrieval

Server (`backend/store/serve.py`), replacing the 11 `/api/v2` routes:

- `GET /api/v3/runs` -> `{runs: [{run, generation, status, t0_ns, head_ns, rows, tier_counts, bytes}]}`, newest run
  first (by the timestamp in the run name)
- `GET /api/v3/runs/{run}/manifest` (ETag, `Cache-Control: no-cache`, 304 on `If-None-Match`)
- `GET /api/v3/runs/{run}/blocks/{gen}/{name}` (a CCVB block, or `aux.json`; ETag = the manifest's etag,
  `immutable`, 304 on `If-None-Match`)
- `GET /api/v3/runs/{run}/detail?ids=...` (at most 256) -> `{rows: [...]}`. Each row: hot fields decoded (kind,
  name, lane and comp keys, request), cold fields, `parents` (nearest first) and `cause` as short rows, `links`,
  `metrics` (aux metrics whose inputs hold the row), `counters` (ncu headline values with units, or null) and
  `open: {nsys: {run, path, t: [start, end] in report ns}, ncu: {run, path, profile_row}}`. `?eids=<eid>` (one eid
  per parameter, since eids are free text) resolves stable eids to the same rows.
- `GET /api/v3/runs/{run}/raw?id=` (the raw record from the run folder; 404 when the file is not there)
- `WS /api/v3/stream?run=&have=` (append deltas, seal, generation and status frames; step 5). A seal frame is
  `{type: "seal", seq, generation, sealed_rows, blocks, derived?}`; `derived` is `{ids, parent, cause, tier, depth}`
  (parallel lists) for the rows whose derived values changed at that seal.

Browser: one `RunStore` (`frontend/cc/store/run.js`). It answers `step`, `grainFor`, `widthFor`, `chain`,
`activeBy`, `scan`, `count`, `row`, `children`, `linksOf`, `samplesAt`, `series`, `detail`, `resolve`,
`subscribe`, `head`. It hides blocks, CCVB, the socket, dictionaries, indexes, the id map and generations.
No caller sees a block or a frame of the wire.

### Render

- `Control` is the timeline service and the only writer of view state and the URL. It emits at most one immutable
  `Frame` per animation frame: `{cursor, win, grain, chain, sel, lit, focus, play, live, changed}`.
- Scene, control bar, inspector and sidebar subscribe to it. Levels implement
  `{name, homeTier, natural, mount, frame, pick, resize, dispose}`. `levels/index.js` is the one list of levels.
- Each level's local frame is 1000 x 1000/aspect of the stage, so a focused level fills the stage. Text is CSS2D
  labels at a fixed screen size. No CSS3D.
- L3 Trace, L4 Iteration, L5 Model ops: one `lanesLevel(spec)`. Rows are on the GPU once; the vertex shader maps
  start/end against window uniforms with float32 hi/lo pairs, so zoom and pan change uniforms only. Picks are
  analytic (lane band, then binary search).
- L2 Components: component things, lit by `activeBy("comp", t)`, packets on edges between consecutive boxes of a
  request, data-form text. L1 Infra: containment tree (host, containers, processes, GPU, network) with samples at t.
  L6 Kernel: the device op at the cursor, its launch, its neighbours, and the headline Nsight Compute counters with
  their own units, plus "open in Nsight Compute" (no sections or findings). L7 Hardware: inventory things lit from
  samples at t (replay: nsys GPU metrics at 10 kHz; live: NVML GPM at 100 ms).
- Inspector (bottom flyout), one list `inspector/tabs.js`: Selected, At cursor, Metrics (formula and inputs; hover
  lights inputs on every level), Tokens, Kernels, Raw record, Run (results, workload, config). Selected and Kernels
  carry the Nsight links: "open in Nsight Systems" at the row's time range, "open in Nsight Compute" for a profiled
  kernel. Links go through the host runner (`/runner/open`), like commit 91c28c2.
- Hardware sidebar: rows from the manifest metric catalog (`sidebar: true`), value at the cursor plus a sparkline,
  with each row's source and period as evidence. GPM rows: SM utilization, SM occupancy, tensor utilization, DRAM
  bandwidth. NVML rows: memory used, power, clocks, PCIe throughput, temperature. In live follow, the cursor is the
  live head.
- The catalog rules are `registry/kinds.json` `metrics` (`sidebar`, `label`, `unit`, `source`, `period_ms`). Group
  `nvml`: `nvml.gpm.sm_util`, `nvml.gpm.sm_occupancy`, `nvml.gpm.tensor_util`, `nvml.gpm.dram_bw_util` (source
  "NVML GPM", 100 ms) and `nvml.memory.used`, `nvml.power.draw`, `nvml.clocks.sm`, `nvml.pcie.rx`, `nvml.pcie.tx`,
  `nvml.temperature.gpu` (source "NVML", period null until the step-5 probe sets it). The step-5 sampler writes these
  names. Replay rows: nvidia-smi `gpu.csv` (100 ms) and Nsight Systems GPU metrics (0.1 ms).
- ncu's raw CSV prints each counter in a display unit (us, Mbyte). The import scales the headline counters to the
  `registry/ncu.json` unit (ns, byte) with its `scale` table and records the factor as `unit_rule`. The ie-run/2
  store kept the display values under the registry unit (duration 1000x, bytes 10^6x too small).

### Control plane

- One transport bar: run picker, live dot, back, play/pause, forward, pace (time or events), rate, grain name,
  overview strip with the window brush, detail strip with the step ticks.
- One keymap, `control/keys.js`, the only `keydown` listener: left/right step, Shift coarser, Alt finest,
  up/down focus coarser/finer, 1-7 focus a level, Space play, +/- zoom, 0 natural window, Home/End, L live, Esc clear.
- One URL: `#side?run=&t=&w=&sel=<eid>&f=&z=`. Run and selection push a history entry; the rest replace, 150 ms.
- Play runs on `requestAnimationFrame` and stops at the run end or the live head.

### Live and replay are one path

- Live rows use the same adapter `parse()` as import, the same `RunWriter`, the same CCVB blocks, pushed over the
  stream socket. The browser merges them with the same indexes, and the same levels draw them.
- Follow mode is only a cursor rule: cursor = head minus a lag; the window trails the head.
- `RunWatcher`: `labels.json` appears, a live run opens; `run.json` appears, the importer writes the next
  generation; browsers reload it (keep t, re-resolve the selection by eid).
- One parser per source (`backend/store/adapters/`): the live tails (`ingest.py`) and the final import
  (`importer.py`) feed the same adapter class, so a row gets the same eid live and final (same template, ordinals
  per prefix in emission order). `make store-check` fails when a live generation (g0) has an eid that its final
  generation lacks.
- One t0: the live writer fixes `t0_ns` (the rep's `labels.json` write time on CLOCK_MONOTONIC) and the wall offset
  when the run opens and writes them to `capture/clock.json`; the final import uses that file, so cursor and URL `t`
  carry across the reload. Without the file, the import keeps the previous manifest's t0, else the earliest row.
  Rows before t0 (network frames of health checks before the rep starts) have a negative `start`.
- Seal-time derivation: each seal (<= 10 s) runs the importer's rules over the held rows: containment parents on
  the lanes that got rows, causes from ZMQ and network message links, tiers, depths. The seal text frame carries
  `derived: {ids, parent, cause, tier, depth}` for every row whose values changed, and sealed blocks holding such
  rows are rewritten under new names.
- What arrives live: client records and stamps, server stamps, derived iterations, network frames (a connection's
  frames are held only until its request headers end; frames with no `X-Request-ID` are written with req none),
  `gpu.csv`, NVML, docker events and stats, engine scrape and iteration stats, the inventory. Request rows (tier 0)
  arrive when the client writes the request's record (at request end). Only the final import has: nsys, PyTorch
  profiler and ncu rows, engine records (`engine_records.json`), run.json metrics and facts, `serves` links, layers.
- A rolling `host` run (30 min) holds machine samples and docker events between reps.
- Live GPU samples come from the NVML collector (step 5): GPM counters at 100 ms, other NVML counters at their
  measured refresh interval, not `nvidia-smi` at 1 Hz. The live sidebar is only as fresh as the counter: each row
  shows its period. In replay, the same sidebar rows read the imported nsys GPU metrics where the run has them.

## Synthesis

- Base: candidate 2 (client-authoritative columnar). It scored highest on one event set, measured latency
  (0.05-0.23 us per step, 6.8 us state at t for 75 lanes, 17.6 ms CPU to open a 92k-row run, all in Node 26) and
  buildability (Parquet stays canonical, DuckDB stays for agents, conversion from ie-run/2 first).
- Cross-judge skipped: no model from another family is available in this harness.
- Grafts from candidate 3 (log-first): the derived iteration (scheduler stamp to the next; the NVTX forward step
  covers only 0.92 ms of a 3.48 ms period, measured); a device op belongs to its launching call's iteration (device
  work runs +1.52 to +4.84 ms of a 3.34 ms iteration, measured); the `cause` column in place of 39,768 launch link
  rows; natural windows per level; step ticks on the strip; the sidebar driven by the metric catalog;
  `labels.json`/`run.json` triggers.
- Grafts from candidate 1 (server-authoritative): up/down keys for focus; a keymap table that also renders the help.
- Rejected: candidate 1's stateful server session (every interaction is a round trip, one Python process carries
  every session); candidate 3's custom log format as the canonical store (two codecs, LATE blocks, no Parquet for
  agents).

## Tradeoffs accepted

- We accept browser memory (10.9 MB for the timeline run, 64 MB budget) in exchange for no network on any step,
  scrub or zoom.
- We accept two encodings of the hot columns (Parquet canonical, CCVB derived) in exchange for zero-parse loads
  and DuckDB for agents.
- We accept that a live row has no parent or cause, and its kind's base tier, until the next seal (at most 10 s);
  the seal frame's `derived` field then sets them.
- We accept a reload (target 250 ms) when a new generation lands, in exchange for one id rule per generation.
- We accept a fixed 7-tier ladder; a new kind must fit into it.

## Owner decisions open

1. Retrieval moves from server queries to the browser (storage stays DuckDB over Parquet).
2. The store becomes writable by the devtools backend (`/mnt/ie-data/cc/store`), so new runs land without a command.
3. Resolved 2026-11-08 (owner): Nsight Compute is link-only plus L6 headline counters; Nsight Systems event rows
   stay imported (levels 4-5 and kernel stepping depend on them); both tools are first-class links. No ncu sections
   or findings in the store, so neither `ncu` in the image nor a rep.py CSV is needed.
4. The v1 devtools page and its views stay in the repo until the owner retires them; v3 does not host them.
5. Resolved 2026-11-08 (owner approved; dependency installs are pre-approved from now on): `nvidia-ml-py==13.615.71`
   is in `devtools/Dockerfile`. The worktree's container runs image `ie-devtools:v2scene`; NVML reads the
   RTX 5060 Ti on driver 615.78.08 from inside it.
6. Open (step 3, 2026-11-08): a derived iteration spans an idle gap. In the timeline run (generation 9), iteration
   129 runs 12.55 s (72.93 s to 85.48 s): scheduler stamp to the next stamp, across the gap between requests. L4's
   natural window there is 12.55 s, and L3 draws one 10 s iteration bar. Should a derived iteration end at the
   request end or at its last device work when the next stamp is past an idle gap? (backend `derive.py`)
7. Open (step 3): `layer` is a cold column, but L5 draws decoder-layer bands for every kernel in view, so the
   browser repeats the RMSNorm heuristic of `nsys.py` `layer_of`: two copies of one rule. Make `layer` a hot column
   (`<i2`, +2 B per row), or keep the browser copy?
8. Open (step 3): 12,096 of the 39,768 device rows in the timeline run are named `kernel` (the nsys short name of
   the templated GEMM kernels), so L5 labels read "kernel". Should `name` carry a short name that tells GEMMs apart
   (for example the demangled base name), with the full name staying cold?
9. Open (step 3): the timeline run has a lane `gpu0/stream 4294967295` (2,392 rows, nsys stream id -1 read as u32).
   Name it as "no stream" (or what nsys means by it), or keep the raw id?
10. Open (step 3): browser memory for the code-level run (1,140,076 rows) is 120 MB (columns 58.7, indexes 18.3,
    GPU instance arrays 43.5), over the 64 MB budget. The timeline run is 15 MB. Options: integer GPU attributes
    (40 to 24 B per row), fine blocks loaded on demand, or a run-size budget. Which one, or accept it?

## Implementation order (each step ends in a check)

1. `backend/store`: schema, registry, derive, CCVB, `importer` (run folder plus `capture/` to ie-run/3, through
   the adapters; it replaced `convert`, which read the ie-run/2 store, on 2026-11-08), `make store-check` (row
   counts against the manifest, tier invariant, CCVB round trip, dense ids, unique eids, column lists equal, live
   eids in the final generation, one t0).
2. `serve.py` routes. Check: headers, `detail` p95 <= 30 ms.
3. `frontend/cc`: store, control, keys, url, bar, scene, lanes levels. Check with `ccv`: input-to-frame p95 for step,
   scrub, zoom; T3, T7, T8 closed.
4. Components, Infra, Kernel, Hardware levels, inspector, sidebar.
5. Live: writer, ingest, stream hub, RunWatcher, host run, and the NVML collector (gaps D3, H4). Today every GPU
   source samples at 1 Hz (`nvidia-smi -lms 1000`, `dmon -d 1`), so live GPU samples would still arrive once a
   second whatever the transport does.
   - NVML GPM sampler: `pynvml` in the backend, one thread, at 100 ms. Measured 2026-11-08 on this card (driver
     615.78.08): GPM gives new values about every 100 ms (49 updates in 5 s, 0.10 s apart); one read costs 0.09 ms
     (median of 50); under a matmul load it read SM 99%, tensor 49%, DRAM 29%. Polling faster mostly returns zeros
     (195 of 244 reads at 20 ms), so the sampler never polls faster than 100 ms. Window rule (lead decision
     2026-11-08): a read with a zero or empty window (no update: SM, occupancy and tensor read 0, DRAM reads NaN)
     or a window shorter than 50 ms is dropped, not plotted; a window of 50 ms or more is kept. The manifest's
     `nvml_sampler.gpm_dropped` counts the drops by reason. Counters: SM utilization, SM occupancy, tensor utilization,
     DRAM bandwidth. Test scripts: `gpm_trace.py`, `load.py` in the measuring session's scratchpad.
   - The other NVML counters (memory used, power, clocks, PCIe throughput, temperature) are probed before their
     rate is set: `backend/store/probe_nvml.py` polls each at 5 ms for 10 s, idle and under a rep load, and
     records the distinct-value refresh interval (median and p95) and the read cost to
     `/mnt/ie-data/cc/probe/nvml_refresh.json`, with a summary here. Each is polled at its measured interval, not
     faster; one that refreshes no faster than 1 s stays at 1 s.

     Probe summary, 2026-11-08 (RTX 5060 Ti, driver 615.78.08). Three phases: idle, a matmul and copy load, and
     a loop that allocates and frees 512 MiB every 50 ms. Period = the fastest phase's median refresh, rounded to
     1 ms, then up to the next 10 ms. Refresh is the median time between distinct values (idle / load / churn).

     | Counter                         | Refresh ms (idle / load / churn) | Read ms | Period ms | Clock          |
     | ------------------------------- | -------------------------------- | ------- | --------- | -------------- |
     | GPM SM, occupancy, tensor, DRAM | 100.0 / 100.0 / 100.0            | 0.08    | 100       | `nvml-gpm`     |
     | memory used                     | none / none / 50.0               | 0.05    | 50        | `nvml-50ms`    |
     | power                           | 500.0 / 500.0 / 500.0            | 0.01    | 500       | `nvml-500ms`   |
     | SM clock                        | 500.0 / 500.0 / 500.0            | 0.01    | 500       | `nvml-500ms`   |
     | temperature                     | 500.0 / 500.0 / none             | 0.01    | 500       | `nvml-500ms`   |
     | PCIe RX                         | 21.1 / 20.6 / 20.8               | 20.6    | 30        | `nvml-pcie-rx` |
     | PCIe TX                         | 21.0 / 20.6 / 20.8               | 20.6    | 30        | `nvml-pcie-tx` |

     - GPM polled at 5 ms: 1900 of 2000 reads per phase had an empty window.
     - A PCIe read blocks for its own counting window (about 20.6 ms), so its refresh equals its read cost. RX and
       TX read at the same time overlap (wall time 50% of their summed cost), so each has its own thread.
     - memory used has no fixed refresh. It changes when memory is allocated or freed, and the 50 ms is the churn
       loop's own cycle. A follow-up poll at 1 ms followed loops of 5 ms and 20 ms (median 5.6 ms and 20.3 ms).
       So 50 ms is a chosen period, not a measured refresh. Owner, 2026-11-08: keep 50 ms.
     - "none": fewer distinct values than the probe can time in 10 s (the value did not change).
   - Output: every read is appended to `capture/gpu.jsonl` (the raw record) and written through the same
     `RunWriter` as the `nvml` sample group, to the live run and to the `host` run. The metric catalog records each
     counter's source and measured period, and the sidebar shows it ("NVML GPM tensor, 100 ms"). It replaces
     `nvidia-smi`/`dmon` as the live GPU source; their collectors stay for v1 until cutover.
   - Two open checks, both during a traced rep. (1) GPM and an nsys or ncu run may block each other, since they
     likely share the hardware counters (a guess, not tested). Record what each tool gets while both run, and if
     they conflict, pause GPM during a profiled capture and write a gap record for it. (2) GPM DRAM read low
     (1-3%) during a copy-heavy load, unexplained. Compare GPM DRAM with nsys DRAM bandwidth on the same window
     before the sidebar shows it without a caveat.
     Results (step 5, 2026-11-08): (1) no conflict: during a 7.0 s nsys GPU-metrics capture GPM read 70 times,
     median gap 100.09 ms, no errors. (2) GPM DRAM equals nsys DRAM read + write (69 windows, correlation 1.000,
     mean difference 0.49 points), but only when each GPM window is moved about 165 ms earlier; SM utilization
     shows the same lag. Owner, 2026-11-08: keep GPM's read time; state the measured lag in each GPM metric's
     evidence line ("describes about 165 ms before the read, measured against nsys on one run"). Do not shift
     timestamps.
   Checks: GPM samples at 100 ms in `capture/gpu.jsonl` with no zero-window reads; the probe table exists and the
   chosen periods match it; live append visible <= 100 ms for stamps and <= 100 ms after each GPM sample; the
   two open checks reported; a run end produces the next generation with no command.
