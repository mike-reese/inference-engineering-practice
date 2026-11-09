# Rep world

The Rep world is the rep's own page. It shows what the rep teaches and its key moments from `moments.toml`, each with
its evidence and a "show me" button. It also shows why it matters, the results on three clocks (client, wire,
engine) from the run's `latency.json`, and the client TTFT split into segments across the clocks. "Show me" opens
the Spine world with the moment's first row selected and the cursor on it.

## Sub-features

- `rep-head` the title (`h1`) and the run chip: run id, kind and time.
- `rep-moments` one `.mom` per `moments.toml` entry: title `.t`, evidence values `.ev`, show me `[data-go=<id>]`.
- `rep-results` `table.res`: TTFT, mean ITL and end-to-end per clock.
- `rep-split` `.seg > div`: one segment per TTFT split step; its `title` is `from → to · value · clocks`.
- `rep-lessons` `.lesson` blocks.

## How to get to it (user POV)

- Load opens every replay on the Rep world. Otherwise click `Rep` in the header, or press W until it shows.

## Driving it with ccv

Preconditions:

- Baseline (README). Recorded on 2026-11-09 on `:7711` (store-cc), session `m1c-skill-rep`.
- `$CCV launch --size full --url "$(view '{"session":{"mode":"replay","rep":"I02A-L1","run":"'$R1'"},"world":"rep"}')"`.

- **Read the page.** `$CCV eval 'document.querySelector("#stage .rw h1").textContent'` gives `Streamed latency`. The
  chip reads `I02A-TRACE-timeline_20261109T060522Z_ee2252 · trace: timeline · 2026-11-09 06:05`. The `h2` titles
  are `What this rep teaches`, `Key moments · review the dynamic in the replay`, `Why it matters`, `Results` and
  `Where client TTFT goes · 7 segments, 3 clocks`. There are 6 moments and 5 lessons.
- **Results.** The rows of `#stage .rw table.res` read `TTFT 24.572 / 24.030 / 20.433 ms`,
  `Mean ITL 121.500 / 121.503 / 121.503 ms` and `End-to-end 7679.551 / 7678.880 / 7675.095 ms` (client, wire,
  engine).
- **Moment evidence.** Moment 2 (`The first body read holds only the role event`) has the evidence
  `first body read 24.078 ms` and `first token event 24.572 ms`.
- **TTFT split.** 7 segments. The first is `send → request's last byte on the wire · 1.677 ms · client → pcap`; the
  fourth is `first_scheduled_time → first_token_time · 19.162 ms · engine`.
- **Show me.** Run `$CCV click --css '#stage .rw [data-go="first-read-role"]' --after rep-show-me`. The Spine world
  opens at execution › phase: `__cc.sel` is `64361`, `__cc.t` is `73402194561`, and the bar's Selected tab starts
  `execution · phase` `body read` `at 73402.195 ms from the run's t0 · 24.078 ms from its request's send`.
  `__cc.bounds` is that phase unit, `[73401789686, 73402650050]`, not the whole run.
- **Back to the Rep world.** Run `$CCV click --css '.ch-nav button[data-w=rep]'`. `sel` and `t` are kept.
- **A run whose request did not complete.** Open I02C run `I02C_20261107T181031Z_5626f7` in the Rep world. Results
  show A's values (headers `6.066 ms`, TTFT `48.878 ms`, end-to-end `2860.301 ms`), `–` for B, and the flag
  `Request B did not complete in this run (clients.B.complete is false).` Each "show me" is disabled and names the
  missing row, for example `no response headers row for B in this run`.
- **Console.** `$CCV console`: 0 errors.

## Gotchas

- The moments come from the rep's `moments.toml` through `/api/v3/reps`. An entry can name several events; "show me"
  selects the first row of the first one.
- The dock tab starts as `selection` (D13's name). The bar shows it as Selected.
- `walkthroughs.sh` checks every moment's row and time, and every split segment's value and click bounds, against
  the store and `latency.json`.
