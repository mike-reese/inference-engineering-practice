# Architecture world

The Architecture world shows the deployment at the architecture tier: the fleet and hosts (tiers 1 and 2), the
containers as cards (tier 3) with their processes (tier 4), the component map (tier 5), and the map with the
software layers under model forward (tier 6).
The boxes of the phases holding the cursor are lit (`on`); what they drive is marked (`driven`). An execution strip
below it holds the request, phase and kernel rows on one time axis, and a beam joins the current phase to its box.

## Sub-features

- `arch-map` `#stage .arch .cbox[data-box=K]` with classes `on`, `prev`, `seen`, `driven`, `lit`. A click selects
  the box's next phase after the cursor.
- `arch-cards` at tiers 3 and 4: `.card[data-sel]` and process rows `[data-proc]`. `.nowis` says where the request
  is now.
- `arch-layers` at tier 6: `[data-layer]` cards (toolkit, runtime, device code), each with its role line (for
  example `builds the op and calls the runtime`), its kinds, and the module, launch call and kernel at the cursor.
- `arch-strip` `#stage .aw .strip`: `rect.u[data-l=i]` selects a row, `[data-fit]` toggles `[fit]` and `[run]`, a
  click on empty space seeks.
- `arch-beam` `#stage .aw .beam path` from the strip to the lit box or card.
- `arch-motion` while playing, a packet (`.compmap .packet`) glides from the previous box to the new one over 300 ms
  (about 18 frames), and the beam's dot (`.aw .beam circle`) follows the cursor along the strip, at 60 Hz.
  `devtools/verify/motion.sh` checks both.

## How to get to it (user POV)

- Click `Architecture` in the header, or press W. Press A to focus architecture, then 1 to 6.

## Driving it with ccv

Preconditions:

- Baseline (README). Recorded on 2026-11-09 on `:7711` (store-cc), session `m1c-skill-arch`; re-driven 2026-11-10 on
  `:7710`, session `vcc-maint-1110`.
- Open R1 at the ASGI headers stamp, component tier:
  `$CCV launch --size full --url "$(view '{"session":{"mode":"replay","rep":"I02A-L1","run":"'$R1'"},"world":"architecture","focus":"architecture","tiers":{"execution":2,"hardware":2,"architecture":4},"t":73381153020}')"`.

- **Lit boxes.** `$CCV eval '[...document.querySelectorAll("#stage .arch .cbox.on")].map((g) => g.dataset.box)'`
  gives `transport,asgi`; no box is driven. `.ch-focus .t` reads `architecture › component`. The beam has a path.
- **Click a box.** `$CCV click --css '#stage .arch .cbox[data-box="forward"]' --after arch-forward`: `sel` `62251`
  (`component stamp: model forward launched`), `t` `73382016397`. The bar reads `at 73382.016 ms from the run's t0 ·
  3.900 ms from its request's send, lasts 14.278 ms`. Lit boxes: `transport,forward`; driven: `gpu`. A second click on
  the same box moves on to its next phase (`63594` at `73398399756`); the recipe continues from the first click.
- **Processes.** `$CCV key 4`: `architecture › process`. The `.nowis` lines read
  `the request is now at: HTTP transport` and `the request is now at: model forward`.
- **Containers.** `$CCV key 3`: `architecture › container`, same two lines.
- **Container samples move inside a request.** Open the run `I02A_20261109T205538Z_14d5d8` (recorded with the 100 ms
  cgroup and 50 ms NVML samplers) at `"tiers":{"execution":2,"hardware":2,"architecture":2},"t":67437000000` (its
  measured request runs 67437 to 67672 ms) and press → twelve times, reading the server card's `[data-v=cpu]`,
  `[data-v=mem]` and `[data-v=net]` after each. Recorded 2026-11-09: `CPU 118 %` and `↑ 175.5 KiB/s` up to 67440.1
  ms, then `CPU 16 %` and `↑ 23.0 KiB/s` from 67457.1 ms; `RAM 3565` then `3566 MiB / 8192 MiB`. The memory row reads
  `RAM`, not `mem`: it is host RAM (cgroup), the GPU memory is the card's blue `GPU` line. On a run recorded before
  2026-11-09 (R1) the same steps show one Docker stats sample a second, so the values hold across a whole request.
- **GPU memory adds up.** On the same view, `#gpu [data-held] li` lists every process holding GPU memory at the
  cursor (the run's containers and the host's own, for example Hyprland), then `[data-part=reserved]` (driver
  reserve), `[data-part=rest]` (no listed process) and `[data-part=used]` (`= 9.84 GiB used, one NVML read`). The
  parts sum to the used line within display rounding. On R1 the list has no reserved line: after the processes comes
  one `[data-part=rest]` line, the used memory minus the compute processes its sampler listed (1.52 GiB at
  t = 73.4 s), then `[data-part=used]` (`= 9.57 GiB used`).
- **Select a card.** `$CCV click --css '#stage .arch .card[data-sel]'`: `sel` `host/client`; the bar starts
  `architecture · container` `client-1 (Locust client)` `Observed: topology.json (docker inspect)`.
- **Software layers.** `$CCV key 6`: `architecture › software layer`. The cards read
  `toolkit: no module row above this kernel (last kernel before the cursor)`,
  `runtime: cudaMemcpyAsync_v3020 at 73287.024 ms (CPU side) (last kernel before the cursor)` and
  `device code: device to host · 4 B (last kernel before the cursor)`.
- **Strip select.** `$CCV click --css '#stage .aw .strip rect.u[data-l="4"]' --after arch-strip-kernel`: `sel` `9844`
  (`kernel: Kernel2<cutlass_80_tensorop_bf16_s16816gemm_relu_bf16_128x64_64x3_tn_align8>`), `t` `72228656575`.
  The layers read `toolkit: layer 0 · tensorrt_llm/_torch/modules/linear.py(2303): forward (inferred, M2)`,
  `runtime: cuLaunchKernel at 72228.648 ms (CPU side)` and
  `device code: Kernel2<…> · grid 8×1×5 · 36 of 36 SMs (inferred from the grid)`.
- **Strip fit.** `$CCV click --css '#stage .aw .strip [data-fit]'`: the toggle reads `[run]`, then `[fit]` again.
- **Strip seek.** `$CCV click --css '#stage .aw .strip svg' --frac 0.6,0.97`: `t` moves (to `52317855238` here);
  `sel` is kept.
- **Console.** `$CCV console`: 0 errors.

## Gotchas

- The page shows samples; it does not check them. `uv run --no-sync python devtools/verify/samplers_check.py
  reps/I02A-L1_streamed_latency/results/<run>` checks a run's 100 ms cgroup and 50 ms NVML samples against Docker
  stats and the backend's NVML reads of the same run (periods, RAM, CPU, GPU total, the GPU split). Run it on every new
  run recorded after a sampler change. Docker stats records are stamped when they arrive, up to 0.6 s after their
  read (measured on 14d5d8), so never compare them to the nearest fast sample.

- `__cc.tiers.architecture` is 0-based: key 5 (component) is `4`. Keys 1 and 2 show the fleet and its hosts, 3 the
  container cards, 4 the cards with their processes, 5 the component map, and 6 the map with the software layers.
- A box click selects that box's first phase that starts after the cursor, so `t` moves forward and a click on the
  box of the selected phase moves on to its next one. After a box's last phase the source wraps to its first
  (`arch.js`, `onClick`).
- A strip seek lands between rows, so `t` can be fractional.
- `walkthroughs.sh` checks the lit boxes and the forward box's busy state at the ASGI headers against the store.
- Packets fire only when the phases at the cursor change. Whole-run bounds at time pace cut most trips short (a newer
  packet of the same flow replaces one in flight); event pace gives full trips, with the map still between them.
