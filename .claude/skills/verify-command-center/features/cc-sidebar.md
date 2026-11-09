# Hardware sidebar

The sidebar (`#hw`, 270 px on the right) stays on screen at every level. It shows each sampled hardware metric the
registry marks `sidebar`, grouped by source (Nsight Systems GPU metrics at 10 kHz, nvidia-smi at 100 ms), with the
value at the cursor and a min-max sparkline over the window with a yellow cursor line. A row with no sample at the
cursor shows `–` and why; a value that cannot be valid shows `invalid` and the recorded value. Sidebar metrics with no
samples in the run are left out and counted in a note.

## Sub-features

- `hw-value` the value at the cursor (the last sample at or before it); percents on 0-100, others on the run's range.
- `hw-spark` the sparkline follows the window; a sparse source holds its last value for up to two sample periods.
- `hw-stale` greyed rows with the reason: outside the sample span, or an implausible recorded value.

## How to get to it (user POV)

- It is always on screen on the right of the stage.

## Driving it with ccv

Preconditions:

- Baseline. Results taken on 2026-11-08 in a half tile (1259 x 1301), generation 12, re-checked at generation 13 (2026-11-09). 13 rows: DRAM read, DRAM write,
  GPC clock, PCIe RX, PCIe TX, SMs active, tensor cores active (Nsight Systems), and SM clock, GPU memory used, power,
  GPU temperature, GPU utilization, memory controller utilization (nvidia-smi).

- **Values at a decode GEMV.** Run
  `$CCV open "http://127.0.0.1:7710/static/cc/index.html#side?run=I02A-TRACE-timeline_20261107T172848Z_f2ac52&t=72717916267&f=7"`.
  Read the rows with
  `$CCV eval 'JSON.stringify([...document.querySelectorAll("#hw .hwrow")].map(r => r.querySelector(".nm").textContent + " = " + r.querySelector(".val").textContent))'`.
  It returns `DRAM read = 77 %`, `DRAM write = 1.0 %`, `GPC clock = 2790 MHz`, `SMs active = 86 %`,
  `tensor cores active = 16 %`, `SM clock = 2610 MHz`, `GPU memory used = 9678 MiB`, `power = 37.3 W`.
- **Step.** Press → twice. Run `$CCV key ArrowRight` twice. The cursor is `72717954304`; the rows read
  `DRAM read = 94 %`, `DRAM write = 3.0 %`, `SMs active = 100 %`, `tensor cores active = 26 %`; the nvidia-smi rows
  keep their values (100 ms period). Screenshot: `cc-step4-half/cc-hw-after-step.png`.
- **Outside the sample span.** Open the same URL with `t=80000000000&f=3`. The Nsight Systems rows read `–` with
  `no sample at the cursor; samples cover 68.11–72.96 s` (the group's first and last sample); `SM clock = 2625 MHz`
  and `GPU memory used = 9678 MiB` still show.
- **Proof.** Run `$CCV console`: `errors: 0`.

## Gotchas

- `GPC clock` reads a number from generation 13: the export holds only negative values, and the importer decodes them
  as unsigned Hz. A negative value in %, MHz, W or MiB still reads `invalid`, and the row's why text names the recorded
  value (`the source recorded <value> <unit>, not a valid reading`).
- nvidia-smi `GPU utilization` can read `0.0 %` while `SMs active` reads 86 %: they come from different tools and
  sample periods, and the sidebar shows each as recorded.
- The sidebar is not a level: it updates on every cursor change whatever the focused level.
- On a live run it also redraws when samples arrive, and it rebuilds its rows when a sidebar metric gets its first
  sample or the catalog grows. A live I02A components run has its 10 NVML rows at open (2026-11-08), so the rebuild
  was not observed there.
