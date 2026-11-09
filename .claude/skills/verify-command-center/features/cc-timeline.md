# Command center v3 timeline

The v3 page (`/static/cc/index.html`, what `$CCV open side` opens) has one transport bar and one keymap over the
run's one event table. The cursor steps at a grain that follows the window width, and the detail strip draws every
stop of that grain as a tick. Levels 3-5 (Trace, Iteration, Model ops) are lanes; levels 1, 2, 6 and 7 are native
views with their own recipes (`cc-infra.md`, `cc-components.md`, `cc-kernel.md`, `cc-hardware.md`). The v2 page stays
at `/static/prototypes/D5v2/side/index.html` (legacy); this file covers only v3.

## Sub-features

- `cc-step` ← and → step to the previous or next row at the grain; Shift steps one tier coarser; Alt steps every row.
- `cc-zoom` the wheel on the detail strip zooms around the pointer; the grain and the ticks follow the width.
- `cc-focus` keys 1-7, ↑ and ↓ focus a level: the camera snaps to it and the window becomes its natural window.
  Key 0 restores the natural window.
- `cc-scrub` a drag on the detail strip moves the cursor to an integer ns.
- `cc-select` a click on a row's label selects it; the URL `sel` takes its eid; Back and Forward restore it. The
  selected row's Nsight Systems target is `CC.control.frame.selRow.open.nsys`.
- `cc-help` ? opens the keymap; Esc closes it.
- `cc-play` ▶ play and ⏸ pause in the footer.
- `cc-live` a live run's rows arrive on every level without a reload: new lanes and sub-rows on levels 3-5, the lit
  boxes of level 2, the tiles of level 1, the sidebar's samples. The cursor follows the head; any step ends follow.

## How to get to it (user POV)

- Open `http://127.0.0.1:7710/static/cc/index.html`.
- Press the keys anywhere on the page. The detail strip is the lower row of the footer; the level buttons, ◀, ▶ play
  and ▶| are above it.

## Driving it with ccv

Preconditions:

- Baseline, plus `$CCV doctor` shows `v3 store (/api/v3/runs)` ok and the timeline run
  `I02A-TRACE-timeline_20261107T172848Z_f2ac52` is generation 13 or later (the row ids below are generation 13's).
- `$CCV open "http://127.0.0.1:7710/static/cc/index.html#side?run=I02A-TRACE-timeline_20261107T172848Z_f2ac52"`
  done (`open side` loads the newest run, which is no longer this one). `$CCV state` shows `timeline`
  `71088.037123 ms / 91930.364906 ms · window 1.519 s`, `grain` `request`, `focus_level.name` `Trace`.
- The results below were taken in a half tile (`$CCV launch`, viewport 1259 x 1301), the default and minimum size; three concurrent sessions reproduced them on 2026-11-08, one session again at generation 12, and one at generation 13 on 2026-11-09. Window widths after a wheel zoom and the tick counts depend
  on the strip width.

- **Step forward.** Press →. Run `$CCV key ArrowRight --after cc-tl-step`. `timeline` reads `72692.873711 ms / 91930.364906 ms · window 1.519 s`; the URL has `t=72692873711`.
- **Step back.** Press ←. Run `$CCV key ArrowLeft`. `timeline` reads `71088.037123 ms`.
- **Zoom on the strip.** Wheel up over the strip. Run `$CCV wheel --css "#detail" --dy -240 --steps 3 --after cc-tl-zoom`. `timeline` ends `window 516.011 ms`; `grain` is `iteration`.
- **Step at the new grain.** Press →. Run `$CCV key ArrowRight`. `cursor` is `{t: 71117821110, id: 9204}`; `#grain` reads `grain: iteration · 9 in view`.
- **One tier coarser.** Press Shift+→. Run `$CCV key ArrowRight --mods shift`. `cursor` is `{t: 72692873711, id: 51752}`, the next request.
- **Every row.** Press Alt+→. Run `$CCV key ArrowRight --mods alt`. `cursor` is `{t: 72692873711, id: 51753}`: the same start, the next id.
- **Natural window.** Press 0. Run `$CCV key 0`. `timeline` ends `window 10.247 s`; `grain` is `request`.
- **Focus a level.** Press 4. Run `$CCV key 4 --after cc-tl-focus-4`. `focus_level.name` is `Iteration`, `timeline` ends `window 5.503 ms`, `#grain` reads `grain: stage · 52 in view`.
- **Coarser and finer level.** Press ↑, then ↓. Run `$CCV key ArrowUp`: `focus_level.name` `Trace`, `window 10.247 s`. Run `$CCV key ArrowDown`: `focus_level.name` `Iteration`, `window 5.503 ms`.
- **Scrub.** Press 3, then drag on the strip. Run `$CCV key 3` and `$CCV drag --css "#detail" --by 120,0 --after cc-tl-scrub`. `cursor` is `{t: 78803919740, id: -1}`: an integer ns, no row.
- **Select a row.** Click its label. Run `$CCV click --text "http11.receive_response_body" --exact --force --after cc-tl-select`. `sel` is `51830`; the URL has the eid, URL-encoded: `sel=client%2Ftransport%2Fmeasured%2Fhttp11.receive_response_body%230`.
- **Back and Forward.** Run `$CCV back`: `sel` is `-1` and the URL has no `sel`. Run `$CCV forward`: `sel` is `51830` again.
- **Clear.** Press Esc. Run `$CCV key Escape`. `sel` is `-1`.
- **Help.** Press ?. Run `$CCV key ? --after cc-tl-help`. `$CCV eval '!document.querySelector("#help").hidden'` returns `true`. Run `$CCV key Escape`; it returns `false`.
- **Play.** Choose ▶ play. Run `$CCV click --css "#play"`. `playing` is `true` and `#play` reads `⏸ pause`. A `state` read 1.5 s later shows the cursor about 2.1 s further (time pace plays the 10.247 s window in 8 s); the URL `t` trails it by at most 150 ms.
- **Pause.** Choose ⏸ pause. Run `$CCV click --css "#play" --after cc-tl-paused`. `playing` is `false`; the URL `t` equals `cursor.t`.
- **A kernel and its Nsight Systems target.** Run `$CCV open "http://127.0.0.1:7710/static/cc/index.html#side?run=I02A-TRACE-timeline_20261107T172848Z_f2ac52&t=72750000000&f=5"`: `timeline` `72750.000000 ms / 91930.364906 ms · window 294.1 µs`, `grain` `device`, `focus_level.name` `Model ops`. Run `$CCV click --text "internal::gemvx::kernel" --exact --force --after cc-tl-kernel` (the first of three; at this height the label shows the full kernel name). After 1 s, `$CCV eval 'CC.control.frame.selRow.open.nsys'` returns `run` `I02A-TRACE-timeline_20261107T172848Z_f2ac52`, `path` `trace/timeline.nsys-rep`, `t` `[4642867724, 4642917580]`; `sel` is `59177`; the URL has `sel=kernel%2Fi77%2Fkernel%232`.
- **A live run (only when the task allows a rep run).** From the main checkout, with no `ie-i02a-*` container, run
  `make rep REP=I02A-L1_streamed_latency TRACE=components` in the background. When `/api/v3/runs` lists a new run
  with `status` `live`, run `$CCV open "http://127.0.0.1:7710/static/cc/index.html#side?run=<run>&f=3"`. For about
  70 s the engine loads: `CC.store.N` is 0 and the sidebar's NVML rows update. Then about 2160 rows arrive within 2 s:
  level 3 grows from 7 to 9 lanes and `CC.control.frame.live` stays `true`. Press 2, then Alt+←
  (`$CCV key 2`, `$CCV key ArrowLeft --mods alt`): follow ends on the newest row, and level 2 lights `HTTP transport`
  and `model forward`. When the rep ends, the page loads the final generation (2171 rows). Evidence from 2026-11-08:
  `fe-live-rows/live2-L3-*.png`, `fe-live-rows/live3-L2-*.png`. The runner can start the same rep:
  `curl -s -X POST 127.0.0.1:7701/runner/jobs -H 'content-type: application/json' -d '{"rep":"I02A-L1","action":"components"}'`.
- **Live request rows and request-grain steps.** A request row (tier 0) arrives when the client writes the
  request's record, at request end. During the live run, once `$CCV wait --expr 'CC.store.reqRows.length >= 1'`
  returns, press 3, then End (`$CCV key 3`, `$CCV key End`): follow ends and `cursor.id` is the warm-up request row
  (`client/request/warmup`); level 2 shows that request. Shift+← steps one tier coarser.
- **Seal-derived parents, live.** Each seal (at most 10 s) sets parent, cause, tier and depth of held rows;
  `CC.store.rev` counts those seals. After `$CCV wait --expr 'CC.store.rev >= 1'`, a stage row that arrived live has
  a parent (`CC.store.field("parent", id) >= 0`). Selected on the live run (`sel=<its eid>` in the URL, or a click),
  the Selected tab shows `parent rule` `Calculated: time containment on one thread` and `parents`, while `status` is
  still `live`. Evidence: `fe-live-contract/live4-selected-live.png`.
- **Cursor across the final reload.** Scrub during the live run (`$CCV drag --css "#detail" --by 40,0`) and note the
  URL `t` and `w`. When the final import ends, the page reloads generation 1 with the same `t`, `w` and `f` (live and
  final share `t0_ns`), and `sel` resolves by eid to the final row id (row ids and lane indexes differ between
  generations). Evidence: `fe-live-contract/live4-final.png`.
- **Rows before t0.** Health-check network frames before the rep starts have a negative `start` (up to 797 rows per
  run). Run `$CCV open "http://127.0.0.1:7710/static/cc/index.html#side?run=I02A-TRACE-components_20261108T204701Z_1b9632&f=1"`,
  then Home and Alt+← (`$CCV key Home`, `$CCV key ArrowLeft --mods alt`): `cursor` is `{t: -111955, id: 796}`, the
  timeline reads `-0.111955 ms / 7592.498690 ms`, and the URL has `t=-111955`. A URL with a negative `t` opens there.
- **Proof.** Run `$CCV console`. It must have `errors: 0`.

## Gotchas

- A hash-only navigation keeps the loaded modules. After editing a file under `devtools/frontend/cc/`, open the page
  with a new query string (`$CCV open "http://127.0.0.1:7710/static/cc/index.html?v=2"`) to load the new code.
- three.js comes from jsDelivr (`three@0.170.0`); without network the page does not load.
- Row names need 12 px sub-rows. On a short stage only the outermost row of each lane is named, so which `--text`
  targets exist depends on the window size. Check with `$CCV find --text ...` first.
- A click on a lane name (the left gutter) selects nothing; picks cover the plot area only.
- Zoom never reaches the `os` grain on the timeline run: tiers 5 and 6 have the same median gap (1888 ns), and a tie
  goes to the coarser tier. Alt+→ steps os rows.
- Halving with `+` skips the `call` grain (it lies between about 0.39 and 0.54 ms at this strip width). Wheel steps
  of `--dy -40` from level 4 reach it at `window 520.7 µs`.
- At a request start, the level 5-7 natural windows span the idle gap before it (about 97 ms), because the device ops
  around the cursor include the previous request's last ones.
- Iteration 129 of the timeline run spans 12.55 s, so key 4 there opens a 12.55 s window (design doc, owner
  decision 6).
- `eval` is read-only and `PERF` has no reset: open a new page for fresh `$CCV perf` samples.
- A live run has no request rows until each request ends (the client writes its record then). Before that, level 2
  reads `no request at the cursor` and End at the `request` grain does nothing. Alt+← works.
- While following the head, level 2 lights nothing: a row arrives when it ends, so none is active 100 ms behind the
  head.
- The live window after the rows arrive is short on a components run: about 12-15 s from the first request row to
  the final reload. Script the steps (`$CCV wait --expr ...`) rather than typing them.
- A live row has no parent or cause and its kind's base tier until the next seal; then lanes, level 2 paths and the
  Selected tab update without a reload.
