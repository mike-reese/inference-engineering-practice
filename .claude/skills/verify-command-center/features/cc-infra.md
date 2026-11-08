# L1 Infra

Level 1 draws the run's containment tree as nested boxes that fill the stage: one column per container, network and
GPU (client, bridge network, server, GPU, ordered by the first request's path), process groups inside, and one tile
per thread or GPU stream. A strip below holds the host hardware (board, chipset, CPU, DMI, NVMe, PCIe links, RAM). A
tile is lit when a row on that thread or stream is active at the cursor; its colour is the active row's kind and its
second line is the row's name. The GPU column shows the GPU metric samples at the cursor at its foot.

## Sub-features

- `infra-lit` tiles light from the rows active at the cursor; each header counts `k of n threads/streams active`.
- `infra-samples` the GPU column foot shows SMs active, tensor cores active, DRAM read and memory used at the cursor,
  or why there is no sample.
- `infra-select` a click on a tile selects its active row; the tile of the selected row's lane gets a white border.

## How to get to it (user POV)

- Press 1, or choose `1 Infra` in the transport bar.

## Driving it with ccv

Preconditions:

- Baseline. Results taken on 2026-11-08 in a half tile (1259 x 1301 viewport), timeline run generation 11, and
  reproduced at generation 12.

- **Open at a kernel of iteration 67.** Run
  `$CCV open "http://127.0.0.1:7710/static/cc/index.html#side?run=I02A-TRACE-timeline_20261107T172848Z_f2ac52&t=72714460148&f=1"`.
  `state`: `timeline` `72714.460148 ms / 85717.066124 ms · window 85.717 s`, `focus_level` `1 Infra`.
- **Read the headers.** Run
  `$CCV eval 'JSON.stringify([...document.querySelectorAll(".labels .lab.group")].filter(e => e.style.display !== "none").map(e => e.textContent))'`.
  It returns `client-1 (Locust client) · 2 of 3 threads active`, `bridge network · 0 of 1 threads active`,
  `server-1 (trtllm-serve) · 17 of 66 threads active`, `NVIDIA GeForce RTX 5060 Ti · 1 of 5 streams active`.
  Screenshot: `cc-step4-v3/s4-focus-L1.png` (full tile).
- **Select a thread.** Click the `Thread-3 (_event_loop_wrapper)` tile. Run
  `$CCV click --text "Thread-3 (_event_loop_wrapper)" --exact --force --after cc-infra-select`. `sel` is `52498`;
  the URL has `sel=stamp/forward/measured/i67/model-forward-launched#0`; the inspector's Selected tab shows
  `component stamp: model forward launched`; the tile has a white border.
- **Proof.** Run `$CCV console`: `errors: 0`.

## Gotchas

- Tile names are labels over the canvas: `find` reports them `covered` by `canvas`, so clicks need `--force`.
- Lane names repeat (`tid 0 ?`, `(process-wide)`, `0`): pick a unique one, such as a named thread.
- Stream `4294967295` is a stream id of -1 read as unsigned in the source; it is shown as recorded.
- The level updates only while it is on screen; read its state after focusing it.
