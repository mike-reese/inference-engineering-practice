# Stacked world

The Stacked world is a 3D board drawn from the run's inventory: CPU, host RAM, the network, NVMe, chipset, the GPU
with its SMs, L2, memory controllers, VRAM and copy engines, and the links between them. Process plates sit above
the board. A pulse label names the execution unit at the cursor for the execution tier. Hardware tiers 1 to 6 fly
the camera from the system to the SM internals. A click on a part selects it and sets the hardware tier to the
part's tier. The lens on the stage shows the architecture view and collapses.

## Sub-features

- `stk-labels` CSS2D labels `#stage .sw-lbl`: `big` parts, `proc` plates (`proc on` while the process holds the
  cursor), `pulse` (the unit at the cursor), `stat` (utilization text).
- `stk-tiers` with hardware focused, keys 1 to 6 set the tier; `.ch-focus .t` and `.d` name it.
- `stk-pick` a click on a part's mesh selects it (`__cc.sel` is the part's key) and sets its hardware tier.
- `stk-pulse` the pulse label follows the execution tier: request, forward step, kernel.
- `stk-lens` `#stage .lens .tog` collapses and expands the lens.

## How to get to it (user POV)

- Click `Stacked` in the header, or press W.

## Driving it with ccv

Preconditions:

- Baseline (README). Recorded on 2026-11-09 on `:7711` (store-cc), session `m1c-skill-stacked`.
- Open R1 at the busiest DRAM-read sample of the ncu-tied kernels:
  `$CCV launch --size full --url "$(view '{"session":{"mode":"replay","rep":"I02A-L1","run":"'$R1'"},"world":"stacked","focus":"execution","tiers":{"execution":2,"hardware":2,"architecture":4},"t":73402310386}')"`.

- **Labels.** `$CCV eval '[...document.querySelectorAll("#stage .sw-lbl")].map((e) => e.className + "|" + e.textContent)'`
  lists 15 labels: `Intel(R) Core(TM) i9-9900K CPU @ 3.60GHz (8C/16T)`, `host RAM 62.7 GiB`, `bridge network`,
  `WD_BLACK SN7100 1TB`, `Intel Z390 chipset`, `NVIDIA GeForce RTX 5060 Ti`, `GDDR7 15.6 GiB (VRAM)`,
  `DMI 3.0, x4 at 8 GT/s`, `PCIe Gen 3 x8`, `PCIe 8.0 GT/s PCIe x4`, the plates `client [client]` (on),
  `trtllm-serve process [server]`, `executor worker process [server]` (on), `bridge network [network]`, and the
  pulse `[Executor] _forward_step 67: 0 ctx reqs, 1 gen reqs`.
- **Hardware tiers.** `$CCV key h`, then keys 1 to 6. `.ch-focus .t` reads `hardware › system`, `› node`,
  `› device`, `› unit`, `› kernel traffic`, `› SM internals`. Key 3's description is
  `bytes moving between devices`; key 6's is `warps, shared memory, registers (Nsight Compute)`.
- **Pick a part.** At tier 3, find a pickable point near the GPU label. This probe moves only the hover box:
  `$CCV eval '(() => { const cv = document.querySelector("#stage canvas"), r = cv.getBoundingClientRect(), L = [...document.querySelectorAll("#stage .sw-lbl")].find((e) => /5060/.test(e.textContent)).getBoundingClientRect(); const hits = []; for (let y = r.top + 10; y < r.bottom; y += 12) for (let x = r.left + 10; x < r.right; x += 12) { cv.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true })); if (cv.style.cursor === "pointer") hits.push([x, y]); } cv.dispatchEvent(new PointerEvent("pointerleave")); const cx = (L.left + L.right) / 2, cy = (L.top + L.bottom) / 2; hits.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy)); return Math.round(hits[0][0]) + "," + Math.round(hits[0][1]); })()'`
  returned `1234,679`. `$CCV click --at 1234,679 --after stacked-pick`: `sel` is `gpu0`, focus `hardware`, tier
  `2` (device). The bar starts `hardware · gpu` `NVIDIA GeForce RTX 5060 Ti` `Observed: nvidia-smi, CUDA device
  properties` with `cc 12.0`, `sms 36`, `l2_bytes 33554432`, `vram_bytes 16712335360`, `bus_bits 128`,
  `copy_engines 2`.
- **Pulse.** `$CCV key e`, then 1: the pulse reads `request`; 3: `[Executor] _forward_step 67: 0 ctx reqs, 1 gen reqs`;
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
