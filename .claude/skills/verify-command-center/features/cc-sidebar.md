# Hardware sidebar

The hardware sidebar on the right shows every sidebar metric of the run's catalog at the cursor, grouped by clock
(one source and one sampling period per group). Each row holds the value at the cursor, a min-max sparkline over the
bounds (it zooms with the execution tier), and its source, period and hardware tier. A row with no fresh sample at
the cursor is greyed with the reason. A click on a row sets the hardware tier to the metric's tier and selects the
thing it is sampled on.

## Sub-features

- `side-groups` `#hw h3`, one per clock: source, period, `(measured)`.
- `side-rows` `#hw .hwrow`: `.nm`, `.val`, `.ev` (source · period · tier), `.why` (stale or implausible), class
  `stale`.
- `side-click` a row click: focus hardware, the metric's tier, `sel` the thing; rows of that tier get `tier`, rows
  of that thing get `sel`.
- `side-window` `#hw .win`: the sparkline window, the bounds of the execution tier.

## How to get to it (user POV)

- It is always on screen on the right. Click a row.

## Driving it with ccv

Preconditions:

- Baseline (README). Recorded on 2026-11-09 on `:7711` (store-cc), session `m1c-skill-sidebar`.
- Open R1 at the busiest DRAM-read sample:
  `$CCV launch --size full --url "$(view '{"session":{"mode":"replay","rep":"I02A-L1","run":"'$R1'"},"world":"spine","focus":"execution","tiers":{"execution":2,"hardware":2,"architecture":4},"t":73402310386}')"`.

- **Groups.** `$CCV eval '[...document.querySelectorAll("#hw h3")].map((h) => h.textContent)'` lists 9 groups:
  `Nsight Systems GPU metrics · every 100.0 µs (measured)`, `nvidia-smi query (gpu.csv) · every 100.181 ms
  (measured)`, four NVML groups (500.082 ms, 50.083 ms, 30.083 ms twice), `NVML GPM · every 100.083 ms (measured)`,
  `/proc/stat (trackers sidecar) + /proc/meminfo (trackers sidecar) · every 100.000 ms (measured)` and
  `perf stat -I 100, uncore_imc … + uncore_cbox … · every 100.295 ms (measured)`.
- **Rows.** 27 rows, none stale. The Nsight Systems rows read `DRAM read 97 %`, `DRAM write 1.0 %`,
  `GPC clock 2794 MHz`, `PCIe RX 0.0 %`, `PCIe TX 1.0 %`, `SMs active 100 %`, `tensor cores active 27 %`. Others:
  `GPU utilization 35 %` (nvidia-smi), `SM utilization 54 %` (NVML GPM), `host CPU busy 6.8 %`,
  `host RAM used 13023 MiB`, `RAM bandwidth (read + write) 2980179712 B/s`.
- **Window.** `#hw .win` reads `window: 73401.79 to 73402.65 ms (phase)`. `$CCV key e`, `$CCV key 1`:
  `window: 0.00 to 88294.36 ms (request)`. Key 3 returns to the phase window.
- **Click a row.** `$CCV click --css '#hw .hwrow[title^="DRAM read"]' --after sidebar-dram`: focus `hardware`, tier
  `3` (unit), `sel` `gpu0`. 13 rows are marked `tier` (the unit-tier metrics) and 23 rows `sel` (the metrics sampled
  on `gpu0`). The bar starts `hardware · gpu` `NVIDIA GeForce RTX 5060 Ti`.
- **Console.** `$CCV console`: 0 errors.

## Gotchas

- `walkthroughs.sh` checks DRAM read and write at three R1 cursors against the nsys `GPU_METRICS` samples in the run's
  `.sqlite` (the 100 µs window holding the cursor).
- nvidia-smi `GPU utilization` (35 %) and Nsight Systems `SMs active` (100 %) disagree at the same cursor: different
  tools and sampling periods. The sidebar shows each as recorded.
- The sidebar is not tied to the focused tier: it updates on every cursor change.
