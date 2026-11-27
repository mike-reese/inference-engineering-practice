# Spine world

The Spine world draws the execution ladder as bands on one time axis, with a lens pane of the hardware or
architecture view at the cursor. Units open at the same time stack in lanes inside their band, and each band label
ends with its lane count. The request band draws each request's lifecycle (request in, queued, prefill, decode,
stream out). When the lanes do not fit the pane, the bands scroll and the legend says so. Keys step between the
stops of the focused tier, walk every row, and fly up and down the tiers. Band labels set the tier. The wheel zooms
the axis; a double-click fits it. Space plays the events inside the bounds.

## Sub-features

- `spine-step` ← → next stop, Shift ← → a stop one tier coarser, Alt ← → the next row of any process, ↑ ↓ fly.
- `spine-lens` `.sp2 .lhead button[data-mode=hw]` (also `split`, `arch`): one or two lens panes (`.sp2 .pane`).
- `spine-bands` `.sp2 .rl[data-band=i]`: a click sets execution tier i. The label reads the tier and its lane
  count, for example `6 kernel2 lanes` (`5 module3 lanes · inferred`).
- `spine-lanes` `.sp2 .lhead button[data-lanes=request]` (`one per request`) and `[data-lanes=packed]` (`reuse when
  free`) set how the request band uses lanes. When the lanes do not fit, `.sp2 .legend .fit` reads `N lanes do not
  fit: wheel over the tier names, or shift + wheel, scrolls the bands`. The legend names the flows and `▨ queued`,
  `┄ missing rows`.
- `spine-zoom` wheel on `#stage .spine svg` zooms the axis; a double-click fits it, and each of its clicks also
  selects or seeks.
- `spine-play` Space plays every event in the bounds, looping; the bounds hold during play.

## How to get to it (user POV)

- "Show me" in the Rep world opens it. Otherwise click `Execution spine` in the header, or press W.

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
- **Lanes.** Re-recorded on 2026-11-18 on `:7710`, session `vcc-maint-1118`, with the steps below. The band labels
  read `1 request3 lanes`, `2 iteration2 lanes`, `3 phase8 lanes`, `4 layer1 lane`, `5 module3 lanes · inferred`,
  `6 kernel2 lanes`; `.sp2 .legend .fit` reads `20 lanes do not fit: wheel over the tier names, or shift + wheel,
  scrolls the bands`. `$CCV click --css '.sp2 .lhead button[data-lanes=packed]'`: `reuse when free` is on and the
  request label reads `1 request1 lane`. `[data-lanes=request]` returns to `3 lanes`.
- **Scroll the bands.** At full size only the request, iteration and phase labels show; the others are hidden
  (`display: none`) and ccv reports `matched but not visible`. Scroll as a user does:
  `$CCV wheel --css '.sp2 .rl[data-band="2"]' --dy 120 --steps 3`. `__spineLayout().view.scrollTop` is `111` and the
  labels `2 iteration` to `6 kernel` show.
- **Band label.** `$CCV click --css '.sp2 .rl[data-band="5"]'`: `__cc.tiers.execution` is `5` and the lit label
  (`.sp2 .rl.on`) is `6 kernel2 lanes`. `data-band="2"` returns to `3 phase8 lanes`.
- **Zoom.** Read the axis with
  `$CCV eval '[...document.querySelectorAll(".sp2 .spine svg .axl")].map((t) => t.textContent).join(" ")'`: ticks
  2 µs apart (`73381.720 ms` to `73381.740 ms`). `$CCV wheel --css '#stage .spine svg' --dy -240 --steps 3`: ticks
  0.5 µs apart (`73381.7265 ms` to `73381.7335 ms`).
- **Fit.** `$CCV click --css '#stage .spine svg' --count 2`: the 2 µs ticks return. The fit animates, so read the
  ticks after it settles (`sleep 0.2` is enough); a read right after the click gave `73381.724 ms` to
  `73381.737 ms`, mid-way. The clicks land on an empty lane, so they seek: `t` is `73381729922.63` and `sel` stays
  `62209`.
- **Play.** `$CCV key " "`, read `__cc`, wait 3 s, read it again: `playing` true, `t` inside the bounds, the bounds
  (`[73381721534, 73381741063]`, the phase holding the cursor) equal to those at play start, `pace` `time`, `rate`
  `1`. `$CCV key " "` stops.
- **Console.** `$CCV console`: 0 errors.

## Gotchas

- Steps and walks add no history entries; only a selection by click or link does. A view opened at a selection
  starts with Back empty, so `[` does nothing there.
- A double-click is two clicks: each selects the row under it or seeks. Expect the selection or the cursor to move.
- A band label whose band is scrolled out of the pane is hidden. Scroll the bands first (wheel over the tier names),
  or set the tier with a key (1 to 6).
- In time pace the bounds play in 8 s at ×1, looping. A long bound wraps fast at ×4.
- After any change to how the bands place units, run `devtools/verify/overlap_check.py` (about 2 s, half tile, the
  I02C code run): no two units open at the same time share y, and each stream (the boxes of one colour key, the
  8th field of each box) keeps its lanes. It reads `window.__spineLayout()` at the fitted view only; a page without
  that contract fails.
