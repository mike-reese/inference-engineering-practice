# Compare

Compare opens two runs, A and B. The Rep world shows both results side by side with `B − A` and `%` columns. The
replay worlds show one side at a time, under a ribbon that names it. The header's A and B buttons switch sides; the
cursor time is kept when it lies inside the other run's extent (else it moves to the nearest end), and a row
selection is dropped.

## Sub-features

- `cmp-pick` `.sh-pan [data-p=a][data-v=<run>]` and `[data-p=b][data-v=<run>]`; `Compare ▸` (`[data-p=compare]`)
  is disabled until A and B are two different runs.
- `cmp-results` `#stage .rw table.res` with columns A, B, `B − A`, `%`.
- `cmp-ribbon` over the replay worlds: `compare · showing A · <run> · <kind> · <time>`.
- `cmp-side` `.ch-nav .ab button[data-v=A]` (or `B`).

## How to get to it (user POV)

- Click `Compare` in the header. Runs of another rep: choose that rep on the left for B; A is kept.

## Driving it with ccv

Preconditions:

- Baseline (README). Recorded on 2026-11-09 on `:7711` (store-cc), session `m1c-skill-compare`.
- `$CCV launch --size full --url "$(view '{"session":{"mode":"replay","rep":"I02A-L1","run":"'$R1'"},"world":"rep"}')"`.

- **Open.** `$CCV click --css '.ch-nav [data-sh=open][data-v=compare]'`. The pick line reads
  `A I02A-TRACE-timeline_20261109T060522Z_ee2252 · B pick a run`, and `Compare ▸` is disabled.
- **Pick.** `$CCV click --css ".sh-pan [data-p=a][data-v=\"$R1\"]"`, then
  `$CCV click --css '.sh-pan [data-p=b][data-v="I02A-TRACE-code_20261103T170709Z_0ac2db"]'`. `Compare ▸` is enabled.
- **Compare.** `$CCV click --css '.sh-pan [data-p=compare]' --after compare-rep`. `__cc.session` is `compare` with
  `run` R1, `runB` the code run, side `A`. Two chips (`.top .chip.cmp`) read `A · I02A-TRACE-timeline_20261109T060522Z_ee2252 · trace:
  timeline · 2026-11-09 06:05` and `B · I02A-TRACE-code_20261103T170709Z_0ac2db · trace: code · 2026-11-03 17:07`.
  The TTFT client row shows `–` until both runs are open; wait for it. Results: `TTFT client 24.572 ms 123.607 ms +99.035 +403.0%`,
  `TTFT engine 20.433 ms 115.980 ms +95.547 +467.6%`, `Mean ITL client 121.500 ms 199.329 ms +77.829 +64.1%`,
  `End-to-end client 7679.551 ms 12681.820 ms +5002.269 +65.1%` (nine rows: three metrics on three clocks).
- **Ribbon.** `$CCV click --css '.ch-nav button[data-w=spine]'`. The ribbon reads `compare · showing A ·
  I02A-TRACE-timeline_20261109T060522Z_ee2252 · trace: timeline · 2026-11-09 06:05`; the side buttons are `A` (on)
  and `B`; the position reads `… · 5456 stops here`.
- **Side B.** `$CCV click --css '.ch-nav .ab button[data-v=B]'`. The side is `B`; the ribbon reads
  `compare · showing B · I02A-TRACE-code_20261103T170709Z_0ac2db · trace: code · 2026-11-03 17:07`; the position
  reads `… · 1606 stops here` at the same `t`. Click `A` to return.
- **Console.** `$CCV console`: 0 errors.

## Gotchas

- The ribbon is a direct child `div` of `#stage`; find it by its text starting with `compare`.
- `regress.sh` checks the mode, the `B − A` column, the ribbon and the switch to B.
