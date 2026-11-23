# Load

Load replays any stored run. Its panel lists every rep from `/api/v3/reps` with its run count, and the chosen rep's
runs from the v3 store grouped by kind, each with its time, its client TTFT and result file (or "results not
computed", or the request that did not complete) and a
`Replay ▸` button. A replay opens on the Rep world with the cursor at the run's t0. A rep without stored runs says
so.

## Sub-features

- `load-panel` `.sh-pan` with the tabs `Load · replay a run`, `Launch · run live`, `Compare · two runs`.
- `load-reps` `.sh-pan .reps button[data-p=rep]`: rep id, title, run count, `replay only` when the rep has no
  `rep.toml`.
- `load-runs` `.sh-pan .main h3` per kind, `.row` per run, `[data-p=load][data-v=<run>]`.
- `load-close` Escape, the × button (`[data-p=close]`) or a click outside closes the panel.

## How to get to it (user POV)

- Click `Load` in the header.

## Driving it with ccv

Preconditions:

- Baseline (README). Recorded on 2026-11-09 on `:7720` (store-cc), session `fix3s`; re-driven 2026-11-10 on `:7710`,
  session `vcc-maint-1110`. The counts below are the store's on 2026-11-10; every import changes them.
- `$CCV launch --size full --url "$(view '{"session":{"mode":"replay","rep":"I02A-L1","run":"'$R1'"},"world":"spine","focus":"execution","tiers":{"execution":2,"hardware":2,"architecture":4}}')"`.

- **Open.** `$CCV click --css '.ch-nav [data-sh=open][data-v=load]' --after load-open`. The tab `Load · replay a run`
  is on. The reps read `I01-L2 Chat service under load · 8 runs · replay only`, `I01A-L1 … · 0 runs · replay only`,
  `I01B-L1 … · 0 runs · replay only`, `I01C-L1 … · 0 runs · replay only`, `I02A-L1 Streamed latency · 37 runs`,
  `I02B-L1 … · 0 runs · replay only`, `I02C-L1 One slot, queued requests · 8 runs` (it has a `rep.toml`, so it can be
  launched). The panel opens on the session's rep (its button has `on`). I02A-L1's groups:
  `measured · 11`, `trace: kernels · 4`, `trace: timeline · 6`, `trace: components · 14`, `trace: live · 1`,
  `trace: code · 1` (37 rows).
- **A run row.** The code run's row reads `I02A-TRACE-code_20261103T170709Z_0ac2db 2026-11-03 17:07 TTFT 123.607 ms
  · latency.json Replay ▸`.
- **Replay.** `$CCV click --css '.sh-pan [data-p=load][data-v="I02A-TRACE-code_20261103T170709Z_0ac2db"]'`. The panel
  closes; `__cc.session` is `replay` of that run, the world is `rep`, `__cc.t` is `0`, and the chip reads
  `I02A-TRACE-code_20261103T170709Z_0ac2db · trace: code · 2026-11-03 17:07`.
- **A rep without runs.** Open Load again, then `$CCV click --css '.sh-pan [data-p=rep][data-v="I01A-L1"]'`. The main
  area reads `No recorded runs for I01A-L1 under its results folder.`
- **A run whose request did not complete.** `$CCV click --css '.sh-pan [data-p=rep][data-v="I02C-L1"]'`. The groups
  are `trace: live · 2`, `trace: code · 2`, `trace: timeline · 1`, `measured · 1`, `trace: off · 2`. The row of
  `I02C_20261107T181031Z_5626f7` reads `request B did not complete` where a run's TTFT would be; c37c3e reads
  `TTFT B 2727.314 ms · readout.json`.
- **Close.** `$CCV key Escape`: the panel is hidden and the replayed run stays.
- **Console.** `$CCV console`: 0 errors.

## Gotchas

- The run list is the store's, not the results folders'. A run folder that was never imported does not show.
- Load always opens on the Rep world. `regress.sh` checks the replay, the world and the empty-rep message.
