# Spine world

The Spine world draws the execution ladder as bands on one time axis, with a lens pane of the hardware or
architecture view at the cursor. Keys step between the stops of the focused tier, walk every row, and fly up and
down the tiers. Band labels set the tier. The wheel zooms the axis; a double-click fits it. Space plays the events
inside the bounds.

## Sub-features

- `spine-step` ← → next stop, Shift ← → a stop one tier coarser, Alt ← → the next row of any process, ↑ ↓ fly.
- `spine-lens` `.sp2 .lhead button[data-mode=hw]` (also `split`, `arch`): one or two lens panes (`.sp2 .pane`).
- `spine-bands` `.sp2 .rl[data-band=i]`: a click sets execution tier i. Each label also shows its band's lane count
  (`3 phase` `8 lanes`).
- `spine-lanes` units open at the same time stack in lanes inside their band. The request band draws each request
  as lifecycle segments (request in, queued, prefill, decode, stream out).
  `.sp2 .lhead button[data-lanes=request]` (`one per request`) and `[data-lanes=packed]` (`reuse when free`) set
  how requests take lanes. When the lanes do not fit, the bands scroll: wheel over the tier names, or Shift + wheel.
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
- **Lens.** A new profile opens on `split`: two panes, `architecture` and `hardware · 3 device`.
  `$CCV click --css '.sp2 .lhead button[data-mode=hw]'`: one pane, `hardware · 3 device`. `split`: two panes again.
  `arch`: one pane, `architecture`. Each `.ptitle` starts with that text and ends with a zoom hint
  (`wheel zoom · drag pan`), so compare by prefix.
- **Zoom.** Read the axis with
  `$CCV eval '[...document.querySelectorAll(".sp2 .spine svg .axl")].map((t) => t.textContent).join(" ")'`: 11 ticks
  2 µs apart (`73381.720 ms` to `73381.740 ms`). `$CCV wheel --css '#stage .spine svg' --dy -240 --steps 3`: 15 ticks
  0.5 µs apart (`73381.7265 ms` to `73381.7335 ms`).
- **Fit.** `$CCV click --css '#stage .spine svg' --count 2`: the 2 µs ticks return. The clicks landed on no box, so
  they only seek: `sel` stays `62209` and `t` is `73381729922.63` (re-recorded 2026-11-17; before the lanes the
  same clicks selected `62210 nvtx range: _schedule`).
- **Band label.** On R1 at full size the bands do not fit (the note reads `20 lanes do not fit: wheel over the tier
  names, or shift + wheel, scrolls the bands`): only the labels `1 request`, `2 iteration` and `3 phase` show, and a
  click on `.sp2 .rl[data-band="5"]` fails with `matched but not visible`. Scroll the bands first:
  `$CCV wheel --css '.sp2 .rl[data-band="2"]' --dy 200 --steps 3` (`__spineLayout().view.scrollTop` is `111`). Then
  `$CCV click --css '.sp2 .rl[data-band="5"]'`: `__cc.tiers.execution` is `5`, the lit label (`.sp2 .rl.on`) reads
  `6 kernel` `2 lanes`, and the position reads `execution › kernel (6/6) · … · 39768 stops here`. `data-band="2"`
  returns to `3 phase` `8 lanes`.
- **Request lanes.** `$CCV click --css '.sp2 .lhead button[data-lanes=packed]'`: the request label reads
  `1 request` `1 lane`. `[data-lanes=request]`: `3 lanes` again (R1's three requests never overlap).
- **Play.** `$CCV key " "`, wait 3 s, read `__cc`: `playing` true, `t` inside the bounds, the bounds equal to those
  at play start, `pace` `time`, `rate` `1`. `$CCV key " "` stops.
- **Console.** `$CCV console`: 0 errors.

## Gotchas

- Steps and walks add no history entries; only a selection by click or link does. A view opened at a selection
  starts with Back empty, so `[` does nothing there.
- A double-click is two clicks: each selects the box under it or seeks. Expect the selection or the cursor to move.
- A band label outside the scrolled view has `display: none`. ccv cannot scroll to it; scroll the bands with the
  wheel over a visible label first. The lens mode and the request-lane mode are kept in localStorage
  (`cc.spine.lens.tab`, `cc.spine.lanes`); every ccv session starts with a new profile.
- In time pace the bounds play in 8 s at ×1, looping. A long bound wraps fast at ×4.
- After any change to how the bands place units, run `devtools/verify/overlap_check.py` (about 2 s, half tile, the
  I02C code run): no two units open at the same time share y, and each stream (the boxes of one colour key, the
  8th field of each box) keeps its lanes. It reads `window.__spineLayout()` at the fitted view only; a page without
  that contract fails.
