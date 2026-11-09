# Architecture world

The Architecture world shows the deployment at the architecture tier: the fleet and hosts (tiers 1 and 2), the
containers as cards (tier 3) with their processes (tier 4), the component map (tier 5), and the map with the
software layers under model forward (tier 6).
The boxes of the phases holding the cursor are lit (`on`); what they drive is marked (`driven`). An execution strip
below it holds the request, phase and kernel rows on one time axis, and a beam joins the current phase to its box.

## Sub-features

- `arch-map` `#stage .arch .cbox[data-box=K]` with classes `on`, `prev`, `seen`, `driven`, `lit`. A click selects
  the box's phase at or after the cursor.
- `arch-cards` at tiers 3 and 4: `.card[data-sel]` and process rows `[data-proc]`. `.nowis` says where the request
  is now.
- `arch-layers` at tier 6: `[data-layer]` cards (toolkit, runtime, device code) with the module, launch call and
  kernel at the cursor.
- `arch-strip` `#stage .aw .strip`: `rect.u[data-l=i]` selects a row, `[data-fit]` toggles `[fit]` and `[run]`, a
  click on empty space seeks.
- `arch-beam` `#stage .aw .beam path` from the strip to the lit box or card.

## How to get to it (user POV)

- Click `Architecture` in the header, or press W. Press A to focus architecture, then 1 to 6.

## Driving it with ccv

Preconditions:

- Baseline (README). Recorded on 2026-11-09 on `:7711` (store-cc), session `m1c-skill-arch`.
- Open R1 at the ASGI headers stamp, component tier:
  `$CCV launch --size full --url "$(view '{"session":{"mode":"replay","rep":"I02A-L1","run":"'$R1'"},"world":"architecture","focus":"architecture","tiers":{"execution":2,"hardware":2,"architecture":4},"t":73381153020}')"`.

- **Lit boxes.** `$CCV eval '[...document.querySelectorAll("#stage .arch .cbox.on")].map((g) => g.dataset.box)'`
  gives `transport,asgi`; no box is driven. `.ch-focus .t` reads `architecture › component`. The beam has a path.
- **Click a box.** `$CCV click --css '#stage .arch .cbox[data-box="forward"]' --after arch-forward`: `sel` `51131`
  (`component stamp: model forward launched`), `t` `73382016397`. The bar reads `at 73382.016 ms from the run's t0 ·
  3.900 ms from its request's send, lasts 14.278 ms`. Lit boxes: `transport,forward`; driven: `gpu`.
- **Processes.** `$CCV key 4`: `architecture › process`. The `.nowis` lines read
  `the request is now at: HTTP transport` and `the request is now at: model forward`.
- **Containers.** `$CCV key 3`: `architecture › container`, same two lines.
- **Select a card.** `$CCV click --css '#stage .arch .card[data-sel]'`: `sel` `host/client`; the bar starts
  `architecture · container` `client-1 (Locust client)` `Observed: topology.json (docker inspect)`.
- **Software layers.** `$CCV key 6`: `architecture › software layer`. The cards read
  `toolkit: no module row above this kernel (last kernel before the cursor)`,
  `runtime: cudaMemcpyAsync_v3020 at 73287.024 ms (CPU side) (last kernel before the cursor)` and
  `device code: device to host · 4 B (last kernel before the cursor)`.
- **Strip select.** `$CCV click --css '#stage .aw .strip rect.u[data-l="4"]' --after arch-strip-kernel`: `sel` `9834`
  (`kernel: Kernel2<cutlass_80_tensorop_bf16_s16816gemm_relu_bf16_128x64_64x3_tn_align8>`), `t` `72228656575`.
  The layers read `runtime: cuLaunchKernel at 72228.648 ms (CPU side)` and
  `device code: Kernel2<…> · grid 8×1×5 · 36 of 36 SMs (inferred from the grid)`.
- **Strip fit.** `$CCV click --css '#stage .aw .strip [data-fit]'`: the toggle reads `[run]`, then `[fit]` again.
- **Strip seek.** `$CCV click --css '#stage .aw .strip svg' --frac 0.6,0.97`: `t` moves (to `52317855238` here);
  `sel` is kept.
- **Console.** `$CCV console`: 0 errors.

## Gotchas

- `__cc.tiers.architecture` is 0-based: key 5 (component) is `4`. Keys 1 and 2 show the fleet and its hosts, 3 the
  container cards, 4 the cards with their processes, 5 the component map, and 6 the map with the software layers.
- A box click selects that box's phase at or after the cursor, so `t` moves forward.
- A strip seek lands between rows, so `t` can be fractional.
- `walkthroughs.sh` checks the lit boxes and the forward box's busy state at the ASGI headers against the store.
