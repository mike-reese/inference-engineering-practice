# Inspector

The inspector bar sits below the stage (or on its right). Six tabs: Selected (the selected row's detail, evidence,
place in the three dimensions, links and raw record), At cursor (everything true at the cursor on every tier),
Metrics (the run's `aux.json` metrics with their formulas and input rows, and the TTFT split), Tokens (the cursor
request's tokens on three clocks), Kernels (the cursor iteration's device rows) and Run (the run's generation,
requests, iterations and units, with the Nsight buttons). Under the tabs: the transport (step, play, pace, rate)
and two strips, the run overview and the detail window. Row names are links that select, `↦` links seek, and "↗"
buttons ask the host runner to open a report in Nsight Systems or Nsight Compute.

## Sub-features

- `insp-tabs` `.b-tabs [data-tab=T]`; a tab re-renders only when its inputs change.
- `insp-links` `.b-body [data-sel]` selects, `[data-seek]` seeks, `[data-m]` selects a metric, `[data-world]` and
  `[data-run]` switch world or run, `#bar [data-open]` posts `/runner/open`.
- `insp-history` `.b-hist[aria-label=Back]` and `Forward`, and the keys `[` `]`, walk selections (`__cc.nav`).
- `insp-raw` the Selected tab's `raw record` summary, then `[data-raw]`, fetches the row's source record (`/raw?id=`).
- `insp-dock` `[data-act=pos]` (or key D) docks bottom or right, `[data-act=big]` enlarges, `.b-collapse` closes and
  opens; `body` gets `dock-bottom`, `dock-right`, `dock-closed`.
- `insp-transport` `[data-act=back]`, `[data-act=next]`, `[data-act=play]`, `.b-pace` (events, time), `.b-rate`.
- `insp-strips` `.b-over` (the run extent: a click seeks), `.b-detail` (the bounds plus 10 % each side: a click
  selects the nearest stop within 6 px, else seeks; a drag seeks).

## How to get to it (user POV)

- It is always on screen. Click a tab name; click ⤢ or the dock button in its header; press D.

## Driving it with ccv

Preconditions:

- Baseline (README). Recorded on 2026-11-09 on `:7711` (store-cc), session `m1c-skill-inspector`; re-driven
  2026-11-10 on `:7710`, session `vcc-maint-1110`.
- Open R1 at the send, Selected tab:
  `$CCV launch --size full --url "$(view '{"session":{"mode":"replay","rep":"I02A-L1","run":"'$R1'"},"world":"spine","focus":"execution","tiers":{"execution":2,"hardware":2,"architecture":4},"sel":{"eid":"client/sdk/measured/send#0"},"dock":{"pos":"bottom","tab":"selected","open":true}}')"`,
  then `$CCV wait --expr 'typeof __cc.sel === "number"'`.

- **Selected.** `.b-body` starts `execution · phase` `send` `at 73378.117 ms from the run's t0 · 0.000 ms from its
  request's send ↦`. Its first links: `62123 measured`, `62124 send`, `host/client client-1 (Locust client)`.
- **Follow a link, Back, Forward.** `$CCV click --css '.b-body [data-sel]'`: `sel` `62123`, `nav` `{back: 1, fwd: 0}`.
  `$CCV click --css '.b-hist[aria-label=Back]'`: `62124`, `{back: 0, fwd: 1}`. `Forward`: `62123` again. The keys
  `[` and `]` do the same.
- **Raw record.** `$CCV wheel --css '.b-body' --dy 200 --steps 2`, then
  `$CCV click --css '.b-body details:has([data-raw]) > summary'`, then `$CCV click --css '.b-body [data-raw]'`.
  `.b-body [data-raw-out]` shows the record: `{ "t0": 2848238637901, "t1": null, "proc": "client", "box":
  "send_one", "name": "send", "xrid": "I02A-TRACE-timeline_20261109T060522Z_ee2252-measured", …`.
- **Kernel path (M2).** Open R1 as above with `"sel":{"eid":"kernel/i66/Kernel2#96"}`. `.b-body ol.path` reads
  request `measured`, iteration `iteration 66`, phase `[Executor] _forward_step 65: 1 ctx reqs, 0 gen reqs`, layer
  `layer 24 of iteration 66`, three modules tagged `inferred (M2)` (`logits_processor.py(13)`, `embedding.py(90)`,
  `linear.py(2303)`, innermost last), kernel (CPU side) `cuLaunchKernel`, kernel `Kernel2<…>`. With
  `kernel/i70/kernel_mha#0` (decode attention, unmatched) the module step reads `none: no inferred module holds this
  kernel (M2)` and the launch call is `cudaGraphLaunch_v10000`. The code run `I02A-TRACE-code_20261103T170709Z_0ac2db`
  has no iteration or phase rows, so its kernel path reads request, layer, its measured module frames (untagged),
  the launch call, the kernel.
- **At cursor.** `$CCV click --css '.b-tabs [data-tab=cursor]'`: `73378.117 ms from the run's t0 · everything true at
  the cursor`, then request `measured`, iteration `iteration 64`, phase `_fetch_new_requests`, layer `layer 24 of
  iteration 64`, module `tensorrt_llm/_torch/modules/linear.py(2303): forward` tagged `inferred (M2)`, kernel
  `device to host (copy)`.
- **Metrics.** `[data-tab=metrics]` starts `Metrics as they are calculated at import (aux.json), with the rows each
  one reads.` Its TTFT split bar (`.segbar .seg[data-m]`) selects a metric per segment; `walkthroughs.sh` clicks all 7.
- **Tokens.** `[data-tab=tokens]` starts `requests: warmup · measured · closer` `measured · 64 tokens · each read on
  three clocks`. Its third row reads `3 " KV" iteration 68 27.739 ms 30.304 ms 30.628 ms 3.615 ms 2.565 ms 0.323 ms ↦`;
  `$CCV click --css '.b-body [data-seek]' --nth 2` moves `t` to `73405855954` and keeps `sel`.
- **Kernels.** The tab shows the cursor's iteration. After the Tokens seek `[data-tab=kernels]` starts `iteration 69 ·
  310 device rows (266 kernels, 44 copies and memsets) · 0 profiled · modules inferred (M2): 101 of 310 device rows
  in no module`; at the opening cursor it starts `iteration 64` with the same counts. It holds one Nsight button:
  `$CCV eval '[...document.querySelectorAll("#bar [data-open]")].map((b) => b.textContent.trim() + " " + b.dataset.open)'`
  gives `Nsight Systems ↗ {"run":"I02A-TRACE-timeline_20261109T060522Z_ee2252","path":"trace/timeline.nsys-rep"}`.
  Do not click it (see Gotchas).
- **Run.** `[data-tab=run]` starts `I02A-TRACE-timeline_20261109T060522Z_ee2252 generation 4 · final · trace:
  timeline · 2026-11-09 06:05`, `requests warmup, measured, closer`, `iterations 192 (3 prefill, 189 decode)`,
  `length 87.578 s`. An earlier pass the same day read its two buttons: `Nsight Systems ↗` (the run's
  `trace/timeline.nsys-rep`) and `Nsight Compute ↗` (`I02A-TRACE-kernels_20261109T060737Z_8f4ae7`,
  `trace/kernels.ncu-rep`). `$CCV click --css '.b-body [data-world=rep]'` opens the Rep world.
- **Dock.** `$CCV key d`: `dock.pos` `right`, body `dock-right`. `$CCV click --css '.b-pos'`: back to `bottom`.
  `$CCV click --css '[data-act=big]'`: `dock.big` true. `$CCV click --css '.b-collapse'`: `dock.open` false, body
  `dock-closed`; again: open.
- **Transport.** From `sel` `65151` at `73405855954`: `$CCV click --css '[data-act=next]'` gives `65152` at
  `73405857673`; `[data-act=back]` returns. `$CCV select --css '.b-pace' --option time` and
  `$CCV select --css '.b-rate' --option 4`: `pace` `time`, `rate` `4`; `.b-grain` reads `grain: execution › phase ·
  4 in view · 77 events in bounds`, `.b-tlabel` reads `73405.856 / 88294.364 ms · bounds 73405.856–73406.304
  (448.3 µs)`: the bounds are the phase holding the cursor. `$CCV click --css '[data-act=play]'` plays (`playing`
  true); click again to stop.
- **Strips.** `$CCV click --css '.b-over' --frac 0.5,0.5`: `t` `44505584510`, the middle of the run extent
  `[716805506, 88294363514]`; the bounds become the whole run, `[0, 88294363514]`.
  `$CCV click --css '.b-detail' --frac 0.3,0.5`: a stop lay within 6 px, so `sel` `127` (`network frame: ACK`)
  and `t` `22710249081`. `$CCV drag --css '.b-detail' --by 120,0 --steps 6`: `t` `49196581417.85`, `sel` kept.
- **Console.** `$CCV console`: 0 errors.

## Gotchas

- Do not click an "↗" button unless Mike says focus may move now: the runner starts `nsys-ui` or `ncu-ui` on his
  workspace and its window takes his focus. Verify up to the request: read `data-open`.
- The raw-record button is inside a closed `<details>`. ccv counts it as visible but cannot scroll to it or click
  it; open the summary first. Scroll the bar body with the wheel when the summary sits below the fold.
- `.b-over` spans the run extent, which starts at the store's `extent[0]` (716.806 ms on R1), not at 0.
- A detail click with no stop within 6 px only seeks, so `t` can be fractional. The stops are the focused execution
  tier's: the Strips numbers hold at the phase tier (at the request tier the same click only seeks, to
  `22956535540.94`).
- The Selected tab of a kernel row also holds an `Nsight Systems ↗` button (`#bar [data-open]`). Do not click it.
- In time pace the bounds play in 8 s at ×1: at ×4 R1's 88 s bounds loop every 2 s.
- The keys `[` `]` and the Back and Forward buttons walk the page's own history; the browser's Back does not.
