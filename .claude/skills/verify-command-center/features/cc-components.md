# L2 Components

Level 2 draws the component map (`registry/components.json` geometry, carried by the manifest's `component map`
thing): containers, processes and the ZMQ boundary as frames, components as boxes, and their edges. A box is lit when
a row of that component is active at the cursor. The request at the cursor walks a path of component rows; a packet
sits on the edge from the previous box to the current one with the row's data form (for example
`stamp: logits [1,151936]`), and each box says how often and how long the request used it.

## Sub-features

- `comp-lit` boxes light from `activeBy("comp", t)`; the current box has an accent border, the previous box a dim one.
- `comp-packet` the packet and its data-form label on the hot edge; the note reads `<request> · step k of n`.
- `comp-select` a click on a box selects its active row, else the request's latest row on that box at or before the cursor's step.

## How to get to it (user POV)

- Press 2, or choose `2 Components`.

## Driving it with ccv

Preconditions:

- Baseline. Results taken on 2026-11-08 in a half tile (1259 x 1301), generation 11, reproduced at generation 12; row ids and step counts below are from generation 13 (2026-11-09).

- **Open inside iteration 67.** Run
  `$CCV open "http://127.0.0.1:7710/static/cc/index.html#side?run=I02A-TRACE-timeline_20261107T172848Z_f2ac52&t=72714460148&f=2"`.
  `state`: `timeline` `72714.460148 ms / 91930.364906 ms · window 10.247 s`, `focus_level.name` `Components`.
  `$CCV eval 'JSON.stringify(CC.scene.levels[1].lit.map((x,k)=>x>=0?CC.scene.levels[1].comps[k].name:null).filter(Boolean))'`
  returns `Locust user`, `HTTP transport`, `GPU kernels`, `model forward`. The packet label reads
  `stamp: logits [1,151936]`; the note reads `…-measured · step 39 of 996 · lit: a row of that component is active at the cursor`. Screenshot: `cc-step4-v3/s4-focus-L2.png`.
- **Step every row.** Press Alt+→ twice. Run `$CCV key ArrowRight --mods alt` twice. The cursor is `72714472647`
  and the lit list drops `GPU kernels` (the kernel at the cursor ended).
- **Select a box.** Click `model forward`. Run `$CCV click --text "model forward" --exact --force --after cc-comp-select`.
  `sel` is `53011`, eid `stamp/forward/measured/i67/model-forward-launched#0`; the box gets a white border; the
  Selected tab shows the lane `host › server-1 (trtllm-serve) › server pid 400 › Thread-3 (_event_loop_wrapper)`.
  Screenshot: `cc-step4-v3/s4-L2-select.png`.
- **Proof.** Run `$CCV console`: `errors: 0`.

## Gotchas

- A URL `t` equal to a row start leaves the cursor id at -1, so the first → or Alt+→ lands on that same row (same
  `t`, its id) and the time does not change. Press it again.
- The map keeps its 2:1 aspect: on a wide stage it fills the height and leaves margins left and right.
- Requests without component stamps (the warmup before stamps start) light only the client boxes.
