# Command center v2 verification map

The maintained recipes for verifying the side-by-side command center as a user. Read this index, then use the
matching feature file. `$CCV` is `devtools/verify/ccv` in the `v2-scene` worktree.

## Baseline preconditions

- `docker start ie-devtools-v2scene` is up, and the host runner is up (`make runner` in the main checkout).
- `$CCV doctor` passes: the browser is ours, the app answers at `http://127.0.0.1:7710`, the v2 store has 9 runs,
  the runner answers, and the scene is READY.
- `$CCV open side` loads the side page without a hash: default run `I02A-TRACE-timeline_20261107T172848Z_f2ac52`,
  cursor `21.243 ms / 244.369 ms`, iteration 67, camera on level 1.
- No rep stack is running (`docker ps` shows only `ie-devtools-*`), so Engine, Metrics and Lifecycle show their empty
  states.
- The flyout is docked right at normal size (`$CCV state` → `dock` `right`; `fly-big` off).
- Only the side page is driven (owner, 2026-11-08).
- The browser is ours; the app server, store and runner are Mike's shared instances. Drive them read-only, except a
  run start that the task or Mike asked for.

## Driving conventions

- Start each recipe with `$CCV open side`, which resets the cursor, selection and camera.
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

## Features

- [Level navigation](./level-navigation.md): header level buttons, wheel zoom and drag pan across the seven levels.
- [Timeline](./timeline.md): scrub, step, play and speed on the footer timeline.
- [Select and inspect](./select-inspect.md): click an item in the scene; the Selected panel, the URL and history follow.
- [Flyout tabs](./flyout.md): the ten v1 tabs in the right-hand flyout, dock and size.
- [Run launcher](./run-launcher.md): the Run tab's actions and jobs; starting a run has side effects.
