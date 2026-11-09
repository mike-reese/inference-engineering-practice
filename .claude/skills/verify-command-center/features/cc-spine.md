# Spine world

The Spine world draws the execution ladder as bands on one time axis, with a lens pane of the hardware or
architecture view at the cursor. Keys step between the stops of the focused tier, walk every row, and fly up and
down the tiers. Band labels set the tier. The wheel zooms the axis; a double-click fits it. Space plays the events
inside the bounds.

## Sub-features

- `spine-step` ← → next stop, Shift ← → a stop one tier coarser, Alt ← → the next row of any process, ↑ ↓ fly.
- `spine-lens` `.sp2 .lhead button[data-mode=hw]` (also `split`, `arch`): one or two lens panes (`.sp2 .pane`).
- `spine-bands` `.sp2 .rl[data-band=i]`: a click sets execution tier i.
- `spine-zoom` wheel on `#stage .spine svg` zooms the axis; a double-click fits it, and each of its clicks also
  selects or seeks.
- `spine-play` Space plays every event in the bounds, looping; the bounds hold during play.

## How to get to it (user POV)

- "Show me" in the Rep world opens it. Otherwise click `Spine` in the header, or press W.

## Driving it with ccv

Preconditions:

- Baseline (README). Recorded on 2026-11-09 on `:7711` (store-cc), session `m1c-skill-spine`.
- Open R1 at the measured request's send:
  `$CCV launch --size full --url "$(view '{"session":{"mode":"replay","rep":"I02A-L1","run":"'$R1'"},"world":"spine","focus":"execution","tiers":{"execution":2,"hardware":2,"architecture":4},"sel":{"eid":"client/sdk/measured/send#0"}}')"`,
  then `$CCV wait --expr 'typeof __cc.sel === "number"'`.

- **Open.** `sel` is `62124` (`client event: send`), `t` is `73378116661`, and `.ch-nav .pos` reads
  `execution › phase (3/6) · t = 73378.117 ms · 5456 stops here`.
- **Step.** `$CCV key ArrowRight` three times: `62126 client event: HTTP request built`, then
  `62127 client transport: connection.connect_tcp`, then `62129 network frame: SYN` (`t` `73379506723`).
- **Coarser stop.** `$CCV key ArrowRight --mods shift`: `62208 iteration: iteration 66` at `73381720350`; the tier
  stays phase.
- **Fly.** `$CCV key ArrowUp`: the position reads `execution › iteration (2/6) · … · 192 stops here`.
  `$CCV key ArrowDown` returns to phase.
- **Walk.** `$CCV key ArrowRight --mods alt`: `62209 component stamp: batch scheduled`, same `t`.
- **Lens.** `$CCV click --css '.sp2 .lhead button[data-mode=hw]'`: one pane, `hardware · 3 device`. `split`: two
  panes, `architecture` and `hardware · 3 device`. `arch`: one pane, `architecture`.
- **Band label.** `$CCV click --css '.sp2 .rl[data-band="5"]'`: `__cc.tiers.execution` is `5` and the lit label is
  `6 kernel`. `data-band="2"` returns to `3 phase`.
- **Zoom.** Read the axis with
  `$CCV eval '[...document.querySelectorAll(".sp2 .spine svg .axl")].map((t) => t.textContent).join(" ")'`: ticks
  1 µs apart (`73381.720 ms` to `73381.737 ms`). `$CCV wheel --css '#stage .spine svg' --dy -240 --steps 3`: ticks
  0.5 µs apart (`73381.7265 ms` to `73381.7325 ms`).
- **Fit.** `$CCV click --css '#stage .spine svg' --count 2`: the 1 µs ticks return. The clicks also selected
  `62210 nvtx range: _schedule` at `73381721534`.
- **Play.** `$CCV key " "`, wait 3 s, read `__cc`: `playing` true, `t` inside the bounds, the bounds equal to those
  at play start, `pace` `time`, `rate` `1`. `$CCV key " "` stops.
- **Console.** `$CCV console`: 0 errors.

## Gotchas

- Steps and walks add no history entries; only a selection by click or link does. A view opened at a selection
  starts with Back empty, so `[` does nothing there.
- A double-click is two clicks: each selects the row under it or seeks. Expect the selection to move.
- In time pace the bounds play in 8 s at ×1, looping. A long bound wraps fast at ×4.
