# Spine world

The Spine world draws the execution ladder as bands on one time axis, with a lens pane of the hardware or
architecture view at the cursor. Keys step between the stops of the focused tier, walk every row, and fly up and
down the tiers. Band labels set the tier. Units that are open at the same time stack in lanes inside their band,
and the bands scroll when the lanes do not fit. The wheel zooms the axis; a double-click fits it. Space plays the
events inside the bounds.

## Sub-features

- `spine-step` ← → next stop, Shift ← → a stop one tier coarser, Alt ← → the next row of any process, ↑ ↓ fly.
- `spine-lens` `.sp2 .lhead button[data-mode=hw]` (also `split`, `arch`): one or two lens panes (`.sp2 .pane`).
- `spine-bands` `.sp2 .rl[data-band=i]`: a click sets execution tier i. Each label reads its tier and its lane count
  (`3 phase` `8 lanes`).
- `spine-lanes` `.sp2 .lhead button[data-lanes=request]` (`one per request`, the default) and `[data-lanes=packed]`
  (`reuse when free`) choose how the request band uses lanes. When the lanes do not fit, `.sp2 .legend .fit` says so
  (`20 lanes do not fit: wheel over the tier names, or shift + wheel, scrolls the bands`) and labels scrolled out are
  hidden.
- `spine-zoom` wheel on `#stage .spine svg` zooms the axis; a double-click fits it, and each of its clicks also
  selects or seeks.
- `spine-play` Space plays every event in the bounds, looping; the bounds hold during play.

## How to get to it (user POV)

- "Show me" in the Rep world opens it. Otherwise click `Spine` in the header, or press W.

## Driving it with ccv

Preconditions:

- Baseline (README). Recorded on 2026-11-09 on `:7711` (store-cc), session `m1c-skill-spine`; re-driven 2026-11-10 on
  `:7710`, session `vcc-maint-1110b`.
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
- **Scroll the bands.** `.sp2 .legend .fit` reads `20 lanes do not fit: …`, and the labels of bands 3 to 5 (layer,
  module, kernel) are hidden: `$CCV find --css '.sp2 .rl[data-band="5"]'` fails with `matched but not visible`.
  `$CCV wheel --css '.sp2 .rl[data-band="2"]' --dy 240 --steps 3`: `__spineLayout().view.scrollTop` is `111` and the
  kernel label shows (the request label is now hidden).
- **Band label.** `$CCV click --css '.sp2 .rl[data-band="5"]'`: `__cc.tiers.execution` is `5` and the lit label
  (`.sp2 .rl.on`) is `6 kernel` `2 lanes`. `data-band="2"` returns to `3 phase` `8 lanes`.
- **Zoom.** Read the axis with
  `$CCV eval '[...document.querySelectorAll(".sp2 .spine svg .axl")].map((t) => t.textContent).join(" ")'`: ticks
  2 µs apart (`73381.720 ms` to `73381.740 ms`). `$CCV wheel --css '#stage .spine svg' --dy -240 --steps 3`: ticks
  0.5 µs apart (`73381.7265 ms` to `73381.7335 ms`).
- **Fit.** `$CCV click --css '#stage .spine svg' --count 2`, then wait 1 s (the fit is animated): the 2 µs ticks
  return. Here the clicks seeked and selected nothing: `sel` stays `62209` and `t` is `73381729922.63`.
- **Play.** `$CCV key " "`, `$CCV wait --expr '__cc.playing === true'`, read `__cc.bounds`
  (`[73381721534, 73381741063]`: play start takes the bounds of the phase holding the cursor, here `_schedule`), wait
  3 s, read `__cc`: `playing` true, `t` inside the bounds, the same bounds, `pace` `time`, `rate` `1`. `$CCV key " "`
  stops.
- **Lanes.** `$CCV click --css '.sp2 .lhead button[data-lanes=packed]'`: the request label reads `1 request` `1 lane`
  and the note `18 lanes do not fit: …`. `[data-lanes=request]` returns to `3 lanes`. The choice is kept in
  `localStorage["cc.spine.lanes"]`. Do not pass `--after` on these two clicks (Gotchas): read the labels with `eval`,
  then take the screenshot with the next key, `$CCV key ArrowRight --after spine-packed`.
- **Console.** `$CCV console`: 0 errors.

## Gotchas

- Steps and walks add no history entries; only a selection by click or link does. A view opened at a selection
  starts with Back empty, so `[` does nothing there.
- A double-click is two clicks: each selects the box under it, or seeks when no box is there. Expect the selection or
  the cursor to move. The fit is animated: read the axis after it settles, not at once.
- In time pace the bounds play in 8 s at ×1, looping. A long bound wraps fast at ×4.
- After a click on a lane button, or on the `Architecture` lens button when another lens was on, `$CCV shot` and
  `--after` time out (`CDP Page.captureScreenshot did not answer in 30 s`) while the page is healthy: `doctor`
  passes, `eval` answers and the state changed. `hover` and a later lane click do not end it; the next key that
  changes the page (`ArrowRight`) or a new page load does. Seen on 2026-11-11 (session `vcc-maint-1111`) on each of four
  lane clicks and on the one lens click tried; the cause is not known (SKILL.md, Hidden monitor).
- After any change to how the bands place units, run `devtools/verify/overlap_check.py` (about 2 s, half tile, the
  I02C code run): no two units open at the same time share y, and each stream (the boxes of one colour key, the
  8th field of each box) keeps its lanes. It reads `window.__spineLayout()` at the fitted view only; a page without
  that contract fails.
