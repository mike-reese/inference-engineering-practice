# L7 Hardware

Level 7 draws the inventory from the manifest: the host (CPU, RAM), the PCIe link, and inside the GPU the copy
engines, 36 SMs, L2, four memory controllers and VRAM. Parts light from the samples at the cursor. In replay the
source is Nsight Systems GPU metrics (10 kHz): `SMs Active` × the SM count lights that many SM boxes (a count; which
SMs is not recorded), DRAM read and write light the memory controllers, PCIe RX and TX the link, and memory used fills
VRAM (nvidia-smi, 100 ms). A memcpy row active at the cursor lights a copy engine.

## Sub-features

- `hw-sms` the lit SM count follows `SMs active` at the cursor; stale samples (older than two periods) grey the SMs.
- `hw-memory` memory controllers from DRAM read + write, VRAM used level from `memory.used`.
- `hw-copies` copy engines light for memcpy rows overlapping the cursor; a click selects that memcpy.
- `hw-select` the selected memcpy outlines its copy engine; a selected kernel outlines the lit SMs while it runs.

## How to get to it (user POV)

- Press 7, or choose `7 Hardware`.

## Driving it with ccv

Preconditions:

- Baseline. Results taken on 2026-11-08 in a half tile (1259 x 1301), generation 12; row ids and the GPC clock are from generation 13 (2026-11-09). The Nsight Systems GPU metric
  samples run from 68107211256 to 72963573775 ns (48560 samples).

- **SMs at a decode GEMV.** Run
  `$CCV open "http://127.0.0.1:7710/static/cc/index.html#side?run=I02A-TRACE-timeline_20261107T172848Z_f2ac52&t=72717916267&f=7"`.
  The note reads `SMs active 86 % × 36 SMs → 31 lit (a count; which SMs is not recorded)`;
  `$CCV eval 'CC.scene.levels[6].smOn'` returns `31`. Screenshot: `cc-step4-half/cc-hw-before.png`.
- **Step past the next sample.** Press → twice (the first lands on the row at the URL time). Run `$CCV key ArrowRight`
  twice. The cursor is `72717954304`; the note reads `SMs active 100 % × 36 SMs → 36 lit`; `smOn` is `36`.
  Screenshot: `cc-step4-half/cc-hw-after-step.png`.
- **A copy engine.** Run the URL with `t=72714509000` (inside memcpy row `53042`, device to device, 960 ns).
  `$CCV eval 'CC.scene.levels[6].copies'` returns `[53042]`. Click it: `$CCV click --text "copy engine 0" --exact --force --after cc-hw-copy`.
  `sel` is `53042`, eid `memcpy/i67/device-to-device#0`; copy engine 0 has a white border. Screenshot:
  `cc-step4-half/s4-L7-copy-select.png`.
- **Proof.** Run `$CCV console`: `errors: 0`.

## Gotchas

- The run's Nsight Systems export holds only negative GPC clock values (-1691680384 to -1474443904). The importer
  decodes them as unsigned Hz (`registry/nsys.json`), so from generation 13 the GPU header reads
  `NVIDIA GeForce RTX 5060 Ti · GPC clock 2790 MHz` at `t=72717916267`. A raw negative clock would read `invalid in the source`.
- No L2 counter is sampled in replay; L2 is drawn but never lit, with the label `no sampled L2 counter`.
- Outside the sample span the SMs grey. At `t=80000000000` the note reads
  `SMs: no sample at the cursor; samples cover 68.11–72.96 s` (the group's first and last sample), and the memory
  controllers and link read
  `no DRAM sample` and `no PCIe sample`.
