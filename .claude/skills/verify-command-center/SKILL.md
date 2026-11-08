---
name: verify-command-center
description: Verify the inference-engineering command center v2 (the three.js side-by-side scene at :7710) the way a user does, in a real headed Chromium driven over CDP by the `ccv` CLI. Use it while building or changing anything under devtools/ (scene, levels, timeline, flyout, inspector, hardware views, backend APIs they read) to prove the change works from the user's seat, with screenshots, accessibility snapshots, app state and console logs as evidence.
---

# Verify the command center as a user

The command center v2 is a web page: a three.js scene (WebGL canvas plus CSS3D panels and CSS2D labels), a header of level buttons, a right-hand flyout of tabs, and a timeline footer. It must be verified in a **real, headed Chromium with the real GPU**: headless rendering (SwiftShader) gets WebGL, CSS3D, wheel zoom and frame timing wrong. `ccv` launches our own Chromium on a hidden Hyprland monitor and drives it with real input events over the Chrome DevTools Protocol. Mike keeps working on his own screens; nothing you do may move his focus or cursor. See **Hidden monitor**.

Layout rule (owner, 2026-11-08): verify **only the side-by-side page** (`/static/prototypes/D5v2/side/index.html`). Never open the flat, nested or split pages.

CLI: `devtools/verify/ccv` (no dependencies; Node 26 built-in fetch and WebSocket). Every command prints one JSON object, exits 1 with `{"ok": false, "error": ...}` on failure, and appends itself to the session's `actions.jsonl`. `ccv help` lists everything.

```bash
CCV=~/Work/Code/Personal/inference-engineering-practice-v2scene/devtools/verify/ccv
```

## Launch

1. The app server: `docker start ie-devtools-v2scene` (port 7710; devtools and `src` from the `v2-scene` worktree, run folders from the main checkout, v2 store read-only). For the Run tab, the host runner: `make runner` in `~/Work/Code/Personal/inference-engineering-practice`. A backend change needs `docker restart ie-devtools-v2scene`; a frontend change needs only a reload (`$CCV open side`).
2. The browser: `export CCV_SESSION=<feature-or-task>`, then `$CCV launch` (half tile, the default and the minimum) or `$CCV launch --size full`. Ready when the output has `"ready": {"scene": true, "ready": true}`: the page set `window.READY` after loading the run from the store and drawing the levels. The output also names the `workspace`, `tile` and `viewport`.

## Sessions

Several agents verify at once. Each session is its own Chromium with its own profile, CDP port (9340-9399) and evidence folder, in its own tile on `CCV-1`.

| `--size` | Window | Viewport | Per workspace |
| --- | --- | --- | --- |
| `half` (default, minimum) | 1259x1388 | 1259x1301 | 2 (left, right) |
| `full` | 2534x1388 | 2534x1301 | 1 |

- Workspaces 21-30 hold up to 20 half or 10 full sessions. `launch` packs halves next to halves and refuses when no tile of the asked size is free.
- Every command acts on one session: set `CCV_SESSION` once per shell, or pass `--session NAME`. With exactly one session running, the name may be left out. Use a name unique to your task, so you never drive another agent's browser.
- `$CCV sessions` lists the running sessions with their workspace, tile and port. Never close or drive a session you did not launch.
- Recipe numbers that depend on width (window lengths after a wheel zoom, tick counts, drag targets) hold for one tile size. A recipe states the size its numbers assume; launch that size to reproduce them.
- Never attach to Mike's own browser.

## Hidden monitor

Owner rule (2026-11-08): never switch Mike's focus, not even for a moment.

- The browsers run on `CCV-1`, a 2560x1440 Hyprland headless output at 20000,20000 that no screen shows, with Mike's tile geometry. Hyprland creates it at start from `~/.config/hypr/ccv-agent.lua` and pins workspaces 21-30 to it. It uses the real GPU (WebGL renders on the RTX 5060 Ti).
- Only one workspace of `CCV-1` is shown. The `render_unfocused` window rule keeps sending frame callbacks to agent windows on the others at 60 Hz, so every session draws and its screenshots return. Mike's screens run at 144 Hz, so compare frame timings only between runs on `CCV-1`.
- Every CDP call times out after 30 s with an error naming the method, so a stuck browser fails a command instead of blocking it. Run `$CCV doctor` when that happens.
- `launch` gives each Chromium the app id `ccv-agent-<session>` and a floating tile on its workspace, placed with `silent`. It refuses when `CCV-1` is missing, not 2560x1440 or not off-screen, and closes the browser when the window lands outside its tile or the viewport is below 1259x1301. `doctor` checks the tile, the frame rate and the viewport.
- Chromium asks for window activation on every synthetic click. The `ccv-agent-*` window rule (`suppress_event`, `no_focus`) drops that request. Keys, scrolling and screenshots work without focus (`Emulation.setFocusEmulationEnabled`).
- Never create, remove or reconfigure an output, and never run `hyprctl reload`, `hyprctl dispatch` or focus and workspace commands: each one can move Mike's focus. If `CCV-1` is missing, stop and tell Mike; the fix (`hyprctl output create headless CCV-1`) is his to run.
- Mike sees the page through your evidence: `--after` screenshots, `$CCV shot`, `$CCV state`.

## Doctor

`$CCV doctor` is read-only. It passes only when the session's browser is ours and alive, CDP answers, the window is in its tile on `CCV-1`, frames are drawn, the viewport is at least 1259x1301, the app server and v2 store answer, the runner answers, the page is the app, and the scene is READY. Run it first, and again whenever anything looks wrong.

## Drive

Act only through real input: `click`, `hover`, `wheel`, `drag`, `key`, `type`, `select`, `open`, `back`, `forward`. Choose targets with stable handles, in this order:

| Handle | Use for | Example |
| --- | --- | --- |
| `--role R --name N [--exact]` | buttons, links, selects, inputs, including inside the v1 panels' shadow roots | `$CCV click --role button --name "4 Iteration" --exact` |
| `--css SEL` | elements with ids or data attributes | `#tl` timeline, `#next`, `#back`, `#play`, `#speed`, `#stage`, `#sum`, `#selbox`, `#side`; `button.start[data-rep="I02A-L1"][data-action="off"]` |
| `--text T --force` | items drawn in the 3D scene, located by their CSS2D label | `$CCV click --text "model forward launched" --force` |
| `--at x,y` | never in the feature map; ad hoc only (coordinates change with the window size) | |

- `--frac fx,fy` clicks inside a target at a fraction of its box: `$CCV click --css "#tl" --frac 0.5,0.5` scrubs the timeline to the middle.
- A target outside the viewport is scrolled into view first, as a user scrolls to it; then it must be visible and not covered at its center. `find` reports `in_viewport` and `covered` without scrolling or sending input. Scene labels have `pointer-events: none`, so the canvas under them "covers" them. `--force` sends the click to that point, and the canvas item under the label receives it. That is the user path.
- `wheel --css "#stage" --dy -240 --steps 6` zooms in (negative dy) or out (positive) at the target's center with MapControls. `drag --css "#stage" --by -400,0` presses at the target's center and moves by dx,dy: left button pans, `--button right` rotates.
- `back` and `forward` are the browser's Back and Forward buttons (a selection is a history entry).
- `wait --text T | --css SEL | --gone-text T | --expr JS` replaces fixed sleeps. Scene rebuilds and v1 panel fetches are asynchronous.
- `eval JS` is for **read-only** probes (for example `location.hash`, `document.querySelector("#selbox").innerText`). Never call app setters, `window.SNAP`, `window.PLAY` or `set()` to make something happen: that skips the user path and proves nothing.

## Evidence

Each session's evidence is in `/mnt/ie-data/cc-v2-verify/evidence/<session>/` (set by `launch --session`, or `CCV_SESSION`):

- `actions.jsonl`: every command with its arguments, its result or its error.
- `console.jsonl`: console messages, page errors and navigations, recorded by a watcher that `launch` starts. `$CCV console` summarizes it with an error count.
- `<name>.png`: `$CCV shot <name>` (viewport, or `--css SEL` for one element), or `--after <name>` on any action.
- `<name>.aria.txt`: `$CCV aria <name>`, the accessibility tree including shadow roots.

Proof standard:

- Drive the real user path and record both the action (`actions.jsonl`, with the `--after` screenshot) and the resulting state (`$CCV state`, a read-only `eval` of the URL or panel text, or `aria`).
- A screenshot alone is not proof of a state change. Pair it with `state` before and after.
- Check side effects where they exist: the URL hash (`t=`, `sel=`, `z=`), a runner job (`curl -s 127.0.0.1:7701/runner/jobs?limit=1`), files written in a run folder.
- Finish with `$CCV console`: zero `pageerror` entries, or report each one.
- For performance claims, use `$CCV perf`: draw time and input-to-frame latency recorded by the page.
- Report a path you could not reach with the command that failed and the unmet precondition. Never report it as verified through a different path.

## Cleanup

`$CCV close` stops only this session's Chromium and watcher (process groups from its record), frees its tile and deletes its profile. Close every session you launched when you finish. Evidence stays in `/mnt/ie-data/cc-v2-verify/evidence/<session>/`. Never kill Chromium by name: Mike's own browser is also Chromium. Leave `ie-devtools-v2scene` and the runner running unless Mike says otherwise; they are his.

Do not click `Start` in the Run tab (it runs a GPU job on the shared machine and writes a run folder) unless the task or Mike asks for a run. See `features/run-launcher.md`.

## Helpers

| Helper | Invocation | What it does |
| --- | --- | --- |
| `devtools/verify/ccv` | `$CCV <command> [options]`; `$CCV help` | the CLI: shell wrapper for `ccv.mjs` |
| `devtools/verify/ccv.mjs` | run through `ccv` | launch, CDP input, observation, evidence logging |
| console watcher | started by `$CCV launch` (`ccv.mjs _watch`); stopped by `$CCV close` | records console messages, page errors and navigations to `console.jsonl` |

`launch` writes one record per session in `~/.local/state/inference-engineering/ccv/sessions/<session>.json` (`pid`, `watcher`, `port`, `profile`, `workspace`, `tile`); a lock in the same folder serializes concurrent launches. Environment: `CCV_SESSION`, `CCV_APP` (`http://127.0.0.1:7710`), `CCV_EVIDENCE`, `CCV_STATE`, `CCV_CHROMIUM` (`/usr/bin/chromium`).

## Feature map

`features/README.md` indexes one recipe per user-facing feature. When you change a feature, verify every entry point its file lists, and update the file when the UI changes.
