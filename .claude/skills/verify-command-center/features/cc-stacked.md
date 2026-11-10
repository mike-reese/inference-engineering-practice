# Stacked world

The Stacked world is a 3D board drawn from the run's inventory: CPU, host RAM, the network, NVMe, chipset, the GPU
with its SMs (each with its L1 / shared memory and 4 tensor cores), L2, memory controllers, VRAM and copy engines,
and the links between them. Each container is a box standing on the CPU with its processes stacked inside as
plates; a process that holds GPU memory has a tether to the GPU. Every row live at the cursor lights its process and
the hardware it ran on in its own flow colour (white: live with no flow, or several flows on one part), so CPU and
GPU work show side by side. Inside the GPU, a running kernel streams particles VRAM -> memory controller -> L2 -> an
SM's L1 -> a tensor core (the share set by the Tensor Active sample), and back for writes; a PCIe copy sends a
packet along the PCIe link, a device-to-device copy one across the VRAM chips. A pulse label names the execution unit at the cursor for the execution tier. Hardware tiers 1 to 6 fly
the camera from the system to the SM internals. A click on a part selects it and sets the hardware tier to the
part's tier. The lens on the stage shows the architecture view and collapses.

## Sub-features

- `stk-labels` CSS2D labels `#stage .sw-lbl`: `big` parts, `proc` plates (`proc on` while the process has a live
  row or GPU work at the cursor), `proc box` containers (name, `container`, Docker CPU sample), `pulse` (the unit at
  the cursor), `stat` (utilization text, `launches GPU work` on the tether of the process whose GPU work is live).
- `stk-motion` the in-GPU stream moves while playing and between kernels (`$CCV record`); `devtools/verify/motion.sh`
  checks it moves at 60 Hz.
- `stk-live` concurrent work: each lit plate, container, device and particle takes the flow colour of its own row.
- `stk-tiers` with hardware focused, keys 1 to 6 set the tier; `.ch-focus .t` and `.d` name it.
- `stk-pick` a click on a part's mesh selects it (`__cc.sel` is the part's key) and sets its hardware tier.
- `stk-pulse` the pulse label follows the execution tier and reads as the spine band does: request, iteration with its
  flow, forward step, kernel.
- `stk-lens` `#stage .lens .tog` collapses and expands the lens.

## How to get to it (user POV)

- Click `Stacked` in the header, or press W.

## Driving it with ccv

Preconditions:

- Baseline (README). Recorded on 2026-11-09 on `:7711` (store-cc), session `m1c-skill-stacked`; re-driven 2026-11-10
  on `:7710`, session `vcc-maint-1110`.
- Open R1 at the busiest DRAM-read sample of the ncu-tied kernels:
  `$CCV launch --size full --url "$(view '{"session":{"mode":"replay","rep":"I02A-L1","run":"'$R1'"},"world":"stacked","focus":"execution","tiers":{"execution":2,"hardware":2,"architecture":4},"t":73402310386}')"`.

- **Labels.** `$CCV eval '[...document.querySelectorAll("#stage .sw-lbl")].filter((e) => e.offsetParent !== null).map((e) => e.className + "|" + e.textContent)'`
  lists 20 visible labels (re-recorded 2026-11-09 on `:7700`, session `stacked-recipe`):
  `Intel(R) Core(TM) i9-9900K CPU @ 3.60GHz (8C/16T)`, `host RAM 62.7 GiB`, `bridge network`, `WD_BLACK SN7100 1TB`,
  `Intel Z390 chipset`, `NVIDIA GeForce RTX 5060 Ti`, `GDDR7 15.6 GiB (VRAM)`, `DMI 3.0, x4 at 8 GT/s`,
  `PCIe Gen 3 x8`, `PCIe 8.0 GT/s PCIe x4`; the containers (`proc box on`; `textContent` joins the three lines with
  newlines, `server-1\ncontainer\nCPU 344 %`) `server-1 container CPU 344 %`,
  `client-1 container CPU 13 %`, `capture-1 container CPU 0.0 %`, `trackers-1 container CPU 1.0 %`; the plates
  (`proc on`) `trtllm-serve process`, `executor worker process`, `client`, and `bridge network` (off);
  `launches GPU work` (the executor's tether); and the pulse `[Executor] _forward_step 67: 0 ctx reqs, 1 gen reqs`.
- **Concurrent work.** At the same cursor the executor plate and the GPU board glow decode green, the client plate
  is lit in its row's flow, the trtllm-serve plate is white (live OS calls, no flow recorded). `$CCV key h`, key 4
  (unit): the stat line reads `Kernel2<…>: 36/36 SMs (inferred from the grid) · 266.8 MiB read from VRAM (Nsight
  Compute) · tensor active 27 % (sample)`, and particles run from the VRAM chips through L2 into the SMs and their
  tensor cores. A host-to-device copy (`t` 73278864000, execution tier 6) lights host RAM and the PCIe link with a
  packet on it; a device-to-device copy (`t` 73190826500) sends a packet across the VRAM chips.
- **Motion while playing** (`stk-motion`). Screenshots cannot prove it; record it. At hardware tier 3 (device), the
  GPU board's box comes from its labels:
  `B=$($CCV eval '(() => { const L = [...document.querySelectorAll("#stage .sw-lbl")]; const g = L.find(e => /5060/.test(e.textContent)).getBoundingClientRect(), v = L.find(e => /VRAM/.test(e.textContent)).getBoundingClientRect(); const x0 = Math.round(g.left - 60), x1 = Math.round(v.right + 10), y1 = Math.round(g.top), y0 = Math.round(y1 - (x1 - x0) * 0.42); return `${x1-x0}x${y1-y0}+${x0}+${y0}`; })()' | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])')`
  (`514x216+1061+461` at full size). Open R1 at execution tier 2 (iteration), `t` 73402310386, click
  `[data-act=play]`, then `$CCV record gpu-play --ms 3000 --box $B`. On 2026-11-09 (session `rec-proof`): 122
  frames, `moving_pairs` 121 of 121, `longest_still_ms` 0. The build before the fix gave 31 of 82 and 1271 ms, so
  the check fails when the stream freezes. The sheet shows yellow outlines on the active SMs and dots between VRAM,
  the memory controllers, L2 and the SMs.
- **Between kernels.** At `t` 73402702979 (execution tier 6, a 3 µs gap) no kernel holds the cursor; the GPU stat
  label reads `between kernels · last fill ended 1.6 µs ago · next computeBlockDigitCounts in 1.6 µs · SMs active
  62 % (about 22/36) · DRAM read 55 % (sample)`, and `$CCV record between-kernels --ms 1500 --box 1500x620+600+300`
  at hardware tier 4 gives 67 of 67 moving pairs. A run without kernel rows (`I02A_20261109T064024Z_4518dc`) also
  streams, from its NVML SM and DRAM samples.
- **Hardware tiers.** `$CCV key h`, then keys 1 to 6. `.ch-focus .t` reads `hardware › system`, `› node`,
  `› device`, `› unit`, `› kernel traffic`, `› SM internals`. Key 3's description is
  `bytes moving between devices`; key 6's is `warps, shared memory, registers (Nsight Compute)`.
- **Pick a part.** At tier 3, find a pickable point near the GPU label. This probe moves only the hover box:
  `$CCV eval '(() => { const cv = document.querySelector("#stage canvas"), r = cv.getBoundingClientRect(), L = [...document.querySelectorAll("#stage .sw-lbl")].find((e) => /5060/.test(e.textContent)).getBoundingClientRect(); const hits = []; for (let y = r.top + 10; y < r.bottom; y += 12) for (let x = r.left + 10; x < r.right; x += 12) { cv.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true })); if (cv.style.cursor === "pointer") hits.push([x, y]); } cv.dispatchEvent(new PointerEvent("pointerleave")); const cx = (L.left + L.right) / 2, cy = (L.top + L.bottom) / 2; hits.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy)); return Math.round(hits[0][0]) + "," + Math.round(hits[0][1]); })()'`
  returned `1234,679`. `$CCV click --at 1234,679 --after stacked-pick`: `sel` is `gpu0`, focus `hardware`, tier
  `2` (device). The bar starts `hardware · device` `NVIDIA GeForce RTX 5060 Ti` `Observed: nvidia-smi, CUDA device
  properties` with `cc 12.0`, `sms 36`, `l2_bytes 33554432`, `vram_bytes 16712335360`, `bus_bits 128`,
  `copy_engines 2`.
- **Pulse.** `$CCV key e`, then 1: the pulse reads `request measured` (the request band's label); 2: `iteration 68:
  decode`; 3: `[Executor] _forward_step 67: 0 ctx reqs, 1 gen reqs`;
  6: `Kernel2<cutlass_80_wmma_tensorop_bf16_s161616gemm_bf16_32x32_128x1_tn_align8>`.
- **Lens.** `$CCV click --css '#stage .lens .tog'`: the button reads `expand` and the lens body is hidden. Click
  again: `collapse`, shown.
- **Console.** `$CCV console`: 0 errors.

## Gotchas

- Labels take no clicks: the label layer has `pointer-events: none`, as in D13. `click --text <label> --force`
  sends the click to the canvas under the label, which is usually empty floor, so nothing is selected. Click the
  part's mesh as above.
- The camera framing depends on the tier and the viewport. Find the point again after a tier change or a resize.
- `__cc.tiers.hardware` is 0-based: key 3 sets `2`.
