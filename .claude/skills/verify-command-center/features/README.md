# Command center verification map

The maintained recipes for verifying the side-by-side command center as a user. Read this index, then use the
matching feature file. `$CCV` is `devtools/verify/ccv` in the main checkout. The page is v3
(`/static/cc/index.html`, what `$CCV open side` opens). The v2 prototype recipes are legacy and go at the cutover.

## Baseline preconditions

- `docker start ie-devtools-v2scene` is up, and the host runner is up (`make runner` in the main checkout).
- `$CCV doctor` passes: the browser is ours, the app answers at `http://127.0.0.1:7710`, the v3 store
  (`/api/v3/runs`) lists its runs (25 on 2026-11-09; every rep run adds one), the runner answers, and the scene is
  READY.
- `$CCV open side` loads the v3 page without a hash on the newest run in the store, which changes with every rep run.
  Recipes therefore open their run by URL. The timeline run `I02A-TRACE-timeline_20261107T172848Z_f2ac52` is
  generation 13 on 2026-11-09: `#side?run=I02A-TRACE-timeline_20261107T172848Z_f2ac52` opens it at
  `timeline` `71088.037123 ms / 91930.364906 ms · window 1.519 s`, `focus_level.name` `Trace`.
- A fresh `launch` has a fresh profile: the inspector is docked at the bottom at normal size on its `Selected` tab
  (`$CCV state` → `dock` `bottom`, `flyout_tab` `selected`). Dock, size and tab persist per profile in
  `localStorage["cc.inspector"]`.
- Only the side-by-side layout is driven (owner, 2026-11-08).
- The browser is ours; the app server, store and runner are Mike's shared instances. Drive them read-only, except a
  run start that the task or Mike asked for.

## Driving conventions

- Start each recipe with `$CCV open side`, or with the recipe's exact URL (a hash sets run, cursor, window and focus).
  After editing a file under `devtools/frontend/cc/`, add a new query string (`?v=N`) so the new modules load.
- Prefer `--role/--name`, then ids or data attributes (`--css`), then scene labels (`--text ... --force`).
  Never use coordinates.
- Act only with real input; `eval` is read-only.
- Pass `--after <feature-id>-<step>` on acting commands that change what the user sees.

## Proof and skip reporting

- Capture the action and the resulting state: the `--after` screenshot plus `state` or a read-only `eval`.
- End every recipe with `$CCV console` and report every `pageerror`.
- Report an unreachable entry point with the failed command and the unmet precondition. Never report it as verified
  through another path.

## Feature entry contract

Each file has an H1 title and one paragraph, then `Sub-features`, `How to get to it (user POV)`,
`Driving it with ccv` (starting with `Preconditions:`, one labeled bullet per action: user action, exact command,
observable result) and `Gotchas`.

## Features (v3)

- [Timeline](./cc-timeline.md): step, grain, strip zoom, focus keys, scrub, select with Back/Forward, help, play,
  and a live run's rows arriving on the levels.
- [L1 Infra](./cc-infra.md): the containment tree (containers, processes, threads, GPU streams, host hardware) lit
  from the rows active at the cursor.
- [L2 Components](./cc-components.md): the component map lit at the cursor, the request's packet on its edge.
- [L6 Kernel](./cc-kernel.md): the device op at the cursor, its launch call and neighbours, Nsight Compute counters.
- [L7 Hardware](./cc-hardware.md): SMs, memory controllers, VRAM, copy engines and PCIe lit from samples at the cursor.
- [Inspector](./cc-inspector.md): the bottom flyout's six tabs, dock and size, Nsight buttons, and a hover on a
  metric's inputs that lights those rows on every level.
- [Hardware sidebar](./cc-sidebar.md): sampled metrics at the cursor with sparklines and evidence.

## Legacy (v2 prototype, `/static/prototypes/D5v2/side/index.html`)

- [Level navigation](./level-navigation.md): header level buttons, wheel zoom and drag pan across the seven levels.
- [Timeline](./timeline.md): scrub, step, play and speed on the footer timeline.
- [Select and inspect](./select-inspect.md): click an item in the scene; the Selected panel, the URL and history follow.
- [Flyout tabs](./flyout.md): the ten v1 tabs in the right-hand flyout, dock and size.
- [Run launcher](./run-launcher.md): the Run tab's actions and jobs; starting a run has side effects.
