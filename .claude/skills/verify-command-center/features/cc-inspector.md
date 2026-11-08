# Inspector

The inspector sits below the stage (or on its right) and reads the control frame. Six tabs: Selected (the selected
row's detail, evidence, links, Nsight Compute values and raw record), At cursor (the request, iteration and device op
at the cursor, busy components, active lanes), Metrics (the `aux.json` metrics with formula and input rows), Tokens
(the cursor request's token events and text), Kernels (the cursor iteration's device ops with counters) and Run
(headline results, workload, config, basis). Row ids are links that select; times are links that seek; "↗" buttons
ask the host runner to open a report in Nsight Systems or Nsight Compute. Tab, dock and size persist in
`localStorage` key `cc.inspector`.

## Sub-features

- `insp-tabs` the six tabs; a tab re-renders only when its inputs change (selection, cursor request, iteration).
- `insp-links` `button[data-sel]` selects a row, `button[data-seek]` seeks, `button[data-open]` posts `/runner/open`.
- `insp-raw` "load the raw record" fetches the row's source record from `/raw?id=`.
- `insp-layout` `#fbig` (⤢) enlarges the inspector; `#fdock` moves it between bottom and right.
- `insp-light` a hover on a Metrics row lights all its input rows on every level (`CC.control.frame.lit`); a hover on
  one input link lights that row. Levels and the timeline strips draw lit rows in magenta.

## How to get to it (user POV)

- It is always on screen below the stage. Click a tab name; click ⤢ or "dock → right" in its header.

## Driving it with ccv

Preconditions:

- Baseline. Values below were taken on 2026-11-08, generation 11, and reproduced at generation 12. Sizes are from a half tile (1259 x 1301); the tab
  contents match a full tile (2534 x 1301, session `cc-step4-v3`).
- `$CCV open "http://127.0.0.1:7710/static/cc/index.html#side?run=I02A-TRACE-timeline_20261107T172848Z_f2ac52&t=72714460148&f=6"`.

- **Selected.** Select a row from any level (see `cc-infra.md`). `#fbody` starts
  `component stamp: model forward launched` then `eid stamp/forward/measured/i67/model-forward-launched#0`.
- **At cursor.** Run `$CCV click --role tab --name "At cursor" --exact --after cc-insp-cursor`. `#fbody` reads
  `72714.460148 ms from the run's t0`, `request … -measured · 21.586 ms in, of 10.243 s`,
  `iteration 67 · 0.544 ms in, of 4.753 ms`, `device op kernel: unrolled_elementwise_kernel · running`,
  `components busy: Locust user, HTTP transport, GPU kernels, model forward`,
  `20 of 75 threads and streams have an active row`.
- **Metrics.** Run `$CCV click --role tab --name "Metrics" --exact`. The open group is
  `…-warmup · 33 metrics` (the cursor's request has none); then `unavailable (2)` and `measures (definitions)`. Its
  first rows are `client TTFT 1296.14 ms first token event - send …` and `client headers 60.7146 ms …`.
- **Select a metric input.** Run `$CCV click --css "#fbody details[open] button[data-sel]" --after cc-insp-metric-sel`
  (the first of 58). `sel` is `8666`, eid `client/sdk/warmup/send#0`. Screenshot:
  `cc-step4-v3/s4-metric-input-select.png`.
- **Light a metric's inputs.** Open the run at `t=71200000000&f=3`, choose Metrics, and hover the row
  `TTFT remainder`: `$CCV hover --text "TTFT remainder" --exact --after cc-insp-light`.
  `$CCV eval 'CC.control.frame.lit'` returns `[8666, 14396, 8761, 12816]` (send, event: token, arrival_time,
  first_token_time). Level 3 draws four magenta boxes (`CC.scene.levels[2].litN` is `4`). Press 1: the tiles `sdk`,
  `executor` and `llm_api` get magenta borders. Press 2: the boxes `send_one` and `OpenAI SDK` do. Both timeline
  strips mark the four starts. Levels 4 and 5 draw none (`litN` `0`): no input lies in level 4's iteration window,
  and level 5 holds streams only. No aux metric reads a device op, so levels 6 and 7 cannot be lit from this tab.
  Hover the tab bar (`$CCV hover --css "#ftabs"`): `lit` is `null`. Evidence from 2026-11-08:
  `fe-live-rows/light-L1.png`, `light-L2.png`, `light-L3.png`, `light-strip.png`.
- **Tokens.** Run `$CCV click --role tab --name "Tokens" --exact`. It reads
  `…-measured · 63 token events · 63 on the wire. Text: When the KV (Key-Value) cache grows, …`.
- **Kernels.** Run `$CCV click --role tab --name "Kernels" --exact`. It reads `iteration 67 · 310 device ops · 4.753 ms
  from its scheduler stamp to the end of its device work · 235 with Nsight Compute counters`, then the buttons
  `Nsight Systems ↗` and `Nsight Compute ↗`, then a table whose row 2 is
  `kernel: unrolled_elementwise_kernel 1×1×1 × 128×1×1 1.2 …`.
- **Run.** Run `$CCV click --role tab --name "Run" --exact`. The results row reads
  `warmup 1296.14 ms 3.474 ms 1515.49 ms 1246.5 ms 3.612 ms 287.893 token/s`, then
  `2 of 3 requests have no calculated metrics in aux.json.`
  `$CCV eval 'JSON.stringify([...document.querySelectorAll("#fbody [data-open]")].map(b => [b.textContent, b.dataset.open]))'`
  returns `Nsight Systems report ↗` with `{"run":"I02A-TRACE-timeline_20261107T172848Z_f2ac52","path":"trace/timeline.nsys-rep"}`.
- **Raw record.** On Selected with row 8666 selected, run `$CCV click --text "raw record"` and
  `$CCV click --role button --name "load the raw record" --after cc-insp-raw`.
  `$CCV eval 'document.querySelector("#fbody [data-raw-out]")?.textContent'` returns `84183357509013`.
- **Enlarge.** Run `$CCV click --css "#fbig"`. The body class is `dock-bottom fly-big`; the inspector is 989 x 567 and
  the stage 989 x 568 (normal: 989 x 226 and 989 x 909).
- **Dock right.** Run `$CCV click --css "#fdock"`. The body class is `insp-right`; the inspector is 503 x 1136 and the
  stage 485 x 1136; `#fdock` reads `dock ↓ bottom`. With ⤢ as well, the inspector is 780 and the stage 208 wide.
  Run `$CCV click --css "#fdock"` again to return; `localStorage.getItem("cc.inspector")` reads
  `{"tab":"selected","dock":"bottom","big":false}` after choosing Selected.
- **Nsight targets, up to the request.** For the kernel at the cursor,
  `$CCV eval 'CC.store.detail([CC.control.frame.chain.device.id]).then(([d]) => JSON.stringify(d.open))'` returns
  `nsys` `{run: I02A-TRACE-timeline_20261107T172848Z_f2ac52, path: trace/timeline.nsys-rep, t: [4607303821, 4607305069]}`
  and `ncu` `{run: I02A-TRACE-kernels_20261107T173111Z_60d68c, path: trace/kernels.ncu-rep, profile_row: 0}`. The
  endpoint answers through the proxy:
  `curl -s -X POST -H 'content-type: application/json' -d '{"run":"I02A-TRACE-timeline_20261107T172848Z_f2ac52","path":"trace/does-not-exist.nsys-rep"}' http://127.0.0.1:7710/runner/open`
  returns 404 `no file 'trace/does-not-exist.nsys-rep' in run …`.
- **Proof.** Run `$CCV console`: `errors: 0`.

## Gotchas

- Do not click an "↗" button with a real path unless Mike says focus may move now. The runner starts `nsys-ui` or
  `ncu-ui` on his current workspace and the new window takes his focus. With his go-ahead (2026-11-08) the Kernels tab
  buttons were clicked with `$CCV click --css '#fbody button[data-open*="nsys-rep"]'` (and `ncu-rep`): `nsys-ui` opened
  `timeline.nsys-rep` and `ncu-ui` opened `kernels.ncu-rep` (row 0 `unrolled_elementwise_kernel`, 2.18 us). Evidence:
  `cc3-nsight/window-2.png` (nsys) and `cc3-nsight/window-ncu-ui.png`. `--role button --name "Nsight Systems ↗"` finds
  nothing: the accessible name is the `aria-label` ("Open the iteration's report in Nsight Systems").
- The runner resolves runs under the main checkout (`reps/*/results/<run>/`), not this worktree.
- `$CCV state` reports `dock` null when the inspector is on the right (it looks for `#side`). Read
  `document.body.className` instead.
- Only the warmup request has metrics in `aux.json`; for the measured request the Metrics tab opens the warmup group
  and says the cursor's request has none.
- The Kernels and Selected tabs fetch detail rows after the first render; wait about a second before reading them.
- In a half tile, right dock plus ⤢ leaves the stage 208 px wide.
