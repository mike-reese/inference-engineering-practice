# L6 Kernel

Level 6 shows the device op at the cursor with its four neighbours each side: CPU launch lanes above GPU stream lanes,
bars for the ops and their launch calls, and an arrow from each call start to its op start (cause, Observed: CUPTI
correlation id). Below, a card names the op (demangled name, lane, iteration, decoder layer when known, start and
duration, launch delay, grid and block), and a panel shows its headline Nsight Compute counters as gauges with units.
"open in Nsight Compute ↗" asks the host runner to open the profile. An op without counters says
`Nsight Compute: not profiled` and why.

## Sub-features

- `kernel-launch` launch calls, ops and cause arrows around the device op at the cursor; the current op is outlined.
- `kernel-counters` duration (replay, with the Nsight Systems duration beside it), achieved occupancy, SM throughput,
  memory throughput, DRAM read and write, L2 traffic.
- `kernel-not-profiled` the reason from `aux.json` when the op has no counters.
- `kernel-open` the Nsight Compute button (see `cc-inspector.md` for how far to verify it).

## How to get to it (user POV)

- Press 6, or choose `6 Kernel`.

## Driving it with ccv

Preconditions:

- Baseline. Results taken on 2026-11-08 in a half tile (1259 x 1301), generation 12, re-checked at generation 13 (2026-11-09). Nsight Compute profiled
  iteration 67 only (266 kernels tied by launch order and name, Inferred).

- **A profiled kernel.** Run
  `$CCV open "http://127.0.0.1:7710/static/cc/index.html#side?run=I02A-TRACE-timeline_20261107T172848Z_f2ac52&t=72714460148&f=6"`.
  `state`: `timeline` ends `window 1.076 ms`, `focus_level.name` `Kernel`; the title label reads `6 Kernel · window · grain op · 1.076 ms`. The visible labels include `kernel: unrolled_elementwise_kernel`,
  `gpu0/stream 13 · iteration 67`, `launched by cudaLaunchKernel_v7000 on server pid 400/tid 1027 python · 10.0 µs
  from call start to op start`, `grid 1×1×1 · block 128×1×1 · 33 registers/thread · 0 B shared memory`,
  `Nsight Compute: unrolled_elementwise_kernel · profile row 0`, `2.2 µs (nsys: 1.2 µs)`, `5.9 %`, `41.5 KiB`,
  `108.5 KiB`, and the button `open in Nsight Compute ↗`. Screenshot: `cc-step4-half/cc-kernel-profiled.png`.
  Read them with `$CCV eval 'JSON.stringify([...document.querySelectorAll(".labels .lab, .labels .lab-btn")].filter(e => e.style.display !== "none").map(e => e.textContent))'`.
- **The button is reachable.** Run `$CCV find --role button --name "Open this kernel in Nsight Compute"`: `button.lab-btn`,
  `in_viewport` true, not covered.
- **A kernel outside iteration 67.** Run the same URL with `t=72750000000`. The device op is row `59172` (`CC.scene.levels[5].o.cur`)
  `internal::gemvx::kernel`, iteration 77. The labels read
  `gpu0/stream 13 · iteration 77 · decoder layer 0 (Inferred at import: 2 RMSNorm kernels per layer)`,
  `Nsight Compute: not profiled` and `ncu profiled iteration 67 only (266 of its kernels tied to this run by launch
  order and name)`; no button is shown. The layer comes from the hot `layer` column; the iteration total comes from
  the manifest (`tools.ncu.kernels`).
- **Proof.** Run `$CCV console`: `errors: 0`.

## Gotchas

- The window is the device op ± 4 neighbours, so a launch call far before its op is pinned to the left edge.
- The level fetches the ops' detail rows after the first draw; wait about a second before reading the card.
