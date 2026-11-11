---
name: verify-command-center
description: Verify the inference-engineering command center (the page at /static/cc/index.html, D13's layout drawn from the v3 store, with four worlds, the inspector bar, the hardware sidebar, Load, Launch and Compare) the way a user does, in a real headed Chromium driven over CDP by the `ccv` CLI. Use it while building or changing anything under devtools/ (worlds, chrome, bar, sidebar, shell, backend APIs they read) to prove the change works from the user's seat, with screenshots, accessibility snapshots, app state and console logs as evidence.
---

# Verify the command center as a user

The command center is a web page (`/static/cc/index.html`, what `$CCV open side` opens) drawn only from the v3 store, the registry and the rep files (COMMAND_CENTER.md section 2). A header holds the four worlds, the three ladders (execution, hardware, architecture) and Load, Launch and Compare. The stage shows one world: Rep (the rep's lessons, moments and results), Stacked (a three.js board with CSS2D labels), Spine (the execution tiers on one time axis) or Architecture (cards, the component map and an execution strip). The inspector bar of six tabs, the transport and the timeline strips sit at the bottom (or right), and the hardware sidebar on the right. It must be verified in a **real, headed Chromium with the real GPU**: headless rendering (SwiftShader) gets WebGL, wheel zoom and frame timing wrong. `ccv` launches our own Chromium on a hidden Hyprland monitor and drives it with real input events over the Chrome DevTools Protocol. Mike keeps working on his own screens; nothing you do may move his focus or cursor. See **Hidden monitor**.

Pages: the production page is `/static/cc/index.html`. The D13 prototype was the parity reference; it was deleted on 2026-11-09 after parity audit 4 (91 checks, 0 gaps) and lives in git history (parent of the deletion commit, 7f4f351). Never open the flat, nested or split pages.

CLI: `devtools/verify/ccv` (no dependencies; Node 26 built-in fetch and WebSocket). Every command prints one JSON object, exits 1 with `{"ok": false, "error": ...}` on failure, and appends itself to the session's `actions.jsonl`. `ccv help` lists everything.

```bash
CCV=~/Work/Code/Personal/inference-engineering-practice/devtools/verify/ccv
```

## Launch

1. The app server: `docker start ie-devtools-v2scene` (port 7710; serves the main checkout, mounted read-only at `/repo`; v3 store read-write). For Launch, the host runner: `make runner` in `~/Work/Code/Personal/inference-engineering-practice`. A backend change needs `docker restart ie-devtools-v2scene`. During M1 the `cc-migration` worktree is served by `ie-devtools-cc` on port 7711 with the store `/mnt/ie-data/cc/store-cc`; set `CCV_APP=http://127.0.0.1:7711` to verify it.
2. The browser: `export CCV_SESSION=<feature-or-task>`, check that `$CCV sessions` is empty (one ccv browser at a time on this machine), then `$CCV launch --url "<view>"` (half tile, the default and the minimum) or `$CCV launch --size full --url "<view>"`. The page reads its view (run, world, tiers, cursor, selection, dock) from the URL hash once at load; `features/README.md` has the `view` helper. A frontend change needs a new page load with a new query string. Ready when the output has `"ready": {"scene": true, "ready": true}`: the page set `window.READY` on its first frame with the run's store open. The output also names the `workspace`, `tile` and `viewport`.

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
- Every CDP call times out after 30 s with an error naming the method, so a stuck browser fails a command instead of blocking it. Run `$CCV doctor` when that happens. One case `doctor` does not see: a screenshot (`shot`, `--after`) can time out on a healthy page that stopped presenting frames (`record` then reports 1 frame). It happened on 2026-11-08 (D12 pages) and on 2026-11-11 after the Spine world's lane and lens buttons (`features/cc-spine.md`, Gotchas). A key that changes the page or a new page load ends it; the cause is not known.
- `launch` gives each Chromium the app id `ccv-agent-<session>` and a floating tile on its workspace, placed with `silent`. It refuses when `CCV-1` is missing, not 2560x1440 or not off-screen, and closes the browser when the window lands outside its tile or the viewport is below 1259x1301. `doctor` checks the tile, the frame rate and the viewport.
- Chromium asks for window activation on every synthetic click. The `ccv-agent-*` window rule (`suppress_event`, `no_focus`) drops that request. Keys, scrolling and screenshots work without focus (`Emulation.setFocusEmulationEnabled`).
- Never create, remove or reconfigure an output, and never run `hyprctl reload`, `hyprctl dispatch` or focus and workspace commands: each one can move Mike's focus. If `CCV-1` is missing, stop and tell Mike; the fix (`hyprctl output create headless CCV-1`) is his to run.
- Mike sees the page through your evidence: `--after` screenshots, `$CCV shot`, `$CCV state`.

## Doctor

`$CCV doctor` is read-only. It passes only when the session's browser is ours and alive, CDP answers, the window is in its tile on `CCV-1`, frames are drawn, the viewport is at least 1259x1301, the app server and v3 store answer, the runner answers, the page is the app, and the scene is READY. Run it first, and again whenever anything looks wrong.

## Drive

Act only through real input: `click`, `hover`, `wheel`, `drag`, `key`, `type`, `select`, `open`, `back`, `forward`. Choose targets with stable handles, in this order:

| Handle | Use for | Example |
| --- | --- | --- |
| `--css SEL` | elements with ids or data attributes (the full table is in `features/README.md`) | `.ch-nav button[data-w=spine]`, `.b-tabs [data-tab=kernels]`, `[data-act=play]`, `.b-detail`, `#hw .hwrow`, `.sh-pan [data-p=load][data-v=<run>]`, `#stage .arch .cbox[data-box=forward]`, `.sp2 .rl[data-band="5"]` |
| `--role R --name N [--exact]` | buttons and inputs without a data attribute | `$CCV click --role button --name "Keys" --exact` |
| `--text T` | text the user reads, when no attribute names it | `$CCV click --text "Replay ▸" --nth 2` |
| `--at x,y` | only for the Stacked world's 3D parts, at a point the page reports at run time (`features/cc-stacked.md`); never a hard-coded coordinate | |

- `--frac fx,fy` clicks inside a target at a fraction of its box: `$CCV click --css ".b-over" --frac 0.5,0.5` seeks the cursor to the middle of the run.
- A target outside the viewport, or scrolled out of a scrolling panel such as the inspector body, is scrolled into view first, as a user scrolls to it; then it must be visible and not covered at its center. `find` reports `in_viewport` and `covered` without scrolling or sending input. ccv counts an element inside a closed `<details>` as visible (it keeps a box but is not drawn), and scrolling cannot reach it: open the `summary` first (`features/cc-inspector.md`, raw record).
- The Stacked world's labels have `pointer-events: none` and sit beside their parts, so `--text <label> --force` clicks the floor under the label and selects nothing. Click the part's mesh (`features/cc-stacked.md`).
- `wheel --css "#stage .spine svg" --dy -240 --steps 3` zooms the spine axis in (negative dy) or out (positive). In the Stacked world the wheel and `drag` (left pans, `--button right` rotates) move the camera.
- `back` and `forward` are the browser's Back and Forward buttons. This page writes its hash with `history.replaceState`, so they do not walk selections: use `[` `]` or the bar's ← → (`.b-hist`).
- `select --css ".b-pace" --option time` picks the option whose value equals it, else the one whose trimmed text does; none or two matches is an error. It clicks the select to open its popup, moves inside the popup, presses Enter once, and fails unless the select then holds that value.
- `wait --text T | --css SEL | --gone-text T | --expr JS` replaces fixed sleeps. Scene rebuilds and v1 panel fetches are asynchronous.
- `eval JS` is for **read-only** probes (for example `JSON.stringify(window.__cc)`, `location.hash`, `document.querySelector(".b-body").textContent`). Never call the page's setters (the `control.js` exports such as `select`, `seek`, `setWorld`) to make something happen: that skips the user path and proves nothing. The one exception in the recipes is the Stacked world's hover probe, which dispatches `pointermove` to find a part and changes only the hover box.

## Evidence

Each session's evidence is in `/mnt/ie-data/cc-v2-verify/evidence/<session>/` (set by `launch --session`, or `CCV_SESSION`):

- `actions.jsonl`: every command with its arguments, its result or its error.
- `console.jsonl`: console messages, page errors and navigations, recorded by a watcher that `launch` starts. `$CCV console` summarizes it with an error count.
- `<name>.png`: `$CCV shot <name>` (viewport, or `--css SEL` for one element), or `--after <name>` on any action.
- `<name>.aria.txt`: `$CCV aria <name>`, the accessibility tree including shadow roots.
- `<name>.sheet.png`, `<name>.webp`, `<name>.motion.json`, `<name>.rec/`: `$CCV record <name>`, the animation as the
  user saw it (below).

Proof standard:

- Drive the real user path and record both the action (`actions.jsonl`, with the `--after` screenshot) and the resulting state (a read-only `eval` of `window.__cc`, the URL hash or panel text, or `aria`). `$CCV state` returns `url`, `title`, `ready`, `viewport` and every field of `window.__cc`.
- A screenshot alone is not proof of a state change. Pair it with the state before and after.
- A screenshot never proves an animation: a still frame of a paused cursor looks the same whether the scene moves or
  is frozen (on 2026-11-09 the Stacked GPU stream passed paused screenshots and froze during playback). Watch it with
  `$CCV record`: start the motion first (play, a key, a drag), then record the region.
- Check side effects where they exist: the URL hash (a JSON view: `world`, `t`, `sel`, `dock`), a runner job (`curl -s "$CCV_APP/runner/jobs?limit=1"`, through the page's proxy), files written in a run folder.
- Finish with `$CCV console`: zero `pageerror` entries, or report each one.
## Watching an animation

`$CCV record NAME [--ms 3000] [--css SEL | --box WxH+X+Y] [--fuzz 8] [--still 20]` keeps every frame Chromium paints
for `--ms` (CDP `Page.startScreencast`, one frame per repaint, so the frame times are the ones the user sees), crops
them to the region (the viewport, an element, or a box in CSS pixels) and writes into the session folder:

| File | Holds | Use |
| --- | --- | --- |
| `NAME.sheet.png` | 12 evenly spaced frames, 3 per row, each labelled with its time | read it (an image) to see what moved |
| `NAME.webp` | every frame at its real delay, looping | give Mike the path; it plays in a browser |
| `NAME.motion.json` | frame intervals (p50, p95, max), changed pixels per consecutive frame pair (`magick compare`, fuzz `--fuzz` %), `moving_pairs` of `pairs`, `longest_still_ms` | the numbers behind the claim |
| `NAME.rec/` | the raw frames (`fNNNN.jpg`) and crops (`fNNNN.c.png`) | step through by hand |

The command prints the summary of `motion.json` with the four paths (`sheet`, `animation`, `motion`,
`frames_dir`). Read it this way:

- `longest_still_ms` is the longest stretch where consecutive frames differ by fewer than `--still` pixels: a frozen
  animation shows a long stretch (1271 ms in 3 s for the frozen GPU stream), a moving one 0.
- `moving_pairs` near `pairs` means motion in nearly every frame; `interval_ms` p95 well above 17 ms means the page
  painted fewer frames than the 60 Hz CCV-1 output (a stall, or nothing changed to repaint).
- Under 2 frames in `--ms` is an error: the page did not repaint. Run `$CCV doctor`.
- Choose the region the claim is about. The whole viewport always moves somewhere (the pulse halo), so a viewport
  recording proves little; the Stacked recipe computes the GPU board's box from its labels (`features/cc-stacked.md`).
- Always look at the sheet before reporting: the numbers say that pixels changed, the sheet says what changed.

`devtools/verify/motion.sh` is the regression check for data movement (22 checks, about 2 minutes). It plays R1 in
three views (component map packets, container beam, Stacked GPU stream) and checks three things: the paint rate
(`record` and the page's own frame intervals, 60 Hz), the moving parts' paths (`devtools/verify/movers.js`, a
read-only per-frame sampler: packet trips must glide over about 18 frames, the beam dot must follow the cursor), and
`record`'s motion numbers. Run it after any change to the worlds, the bar, the sidebar or anything painted every
frame. Movement alone is not enough: on 2026-11-09 every view still moved but painted at 8 to 40 fps, because the
bar's detail strip (1000-2000 elements) was overlap-tested against the sidebar's cursor layers each frame. Set
`CC_URL` to the server you verify.

- For performance claims, use `$CCV perf`: draw time and input-to-frame latency recorded by the page.
- Report a path you could not reach with the command that failed and the unmet precondition. Never report it as verified through a different path.

## Cleanup

`$CCV close` stops only this session's Chromium and watcher (process groups from its record), frees its tile and deletes its profile. Close every session you launched when you finish. Evidence stays in `/mnt/ie-data/cc-v2-verify/evidence/<session>/`. Never kill Chromium by name: Mike's own browser is also Chromium. Leave `ie-devtools-v2scene` and the runner running unless Mike says otherwise; they are his.

Never click `Launch ▸` on a page opened without `?dry_run=1`: it runs a GPU job on the shared machine and writes a run folder. Launch for real only when the task or Mike asks for a run. See `features/cc-launch.md`.

An "Nsight Systems ↗ / Nsight Compute ↗" button makes the runner start `nsys-ui` or `ncu-ui` on Mike's desktop, and a new window can take his focus, which the owner rule above forbids. Open decision (2026-11-08, for Mike): how to verify these buttons end to end. Until then, verify them up to the request (read the button's `data-open`); see `features/cc-inspector.md`.

## Helpers

| Helper | Invocation | What it does |
| --- | --- | --- |
| `devtools/verify/ccv` | `$CCV <command> [options]`; `$CCV help` | the CLI: shell wrapper for `ccv.mjs` |
| `devtools/verify/ccv.mjs` | run through `ccv` | launch, CDP input, observation, evidence logging, `record` (needs ImageMagick 7, `magick`) |
| `devtools/verify/samplers_check.py` | `uv run --no-sync python devtools/verify/samplers_check.py RUN_DIR` | a recorded run's host sampler data (cgroup 100 ms, NVML 50 ms) against Docker stats and the backend's NVML reads; exits 1 on a miss |
| `devtools/verify/overlap_check.py` | `devtools/verify/overlap_check.py [--run RUN[,RUN]] [--rep REP[,REP]] [--no-clicks]`; `--self-test` needs no browser; `CC_URL` picks the server | the spine lane guard (about 2 s per run): reads `window.__spineLayout()` and the store in one eval and fails when units open at the same time share y, a stream (the boxes of one colour key, the 8th field of each box) changes lane, or a unit has no box; exits 1 on a miss or a page without the contract |
| console watcher | started by `$CCV launch` (`ccv.mjs _watch`); stopped by `$CCV close` | records console messages, page errors and navigations to `console.jsonl` |

`launch` writes one record per session in `~/.local/state/inference-engineering/ccv/sessions/<session>.json` (`pid`, `watcher`, `port`, `profile`, `workspace`, `tile`); a lock in the same folder serializes concurrent launches. Environment: `CCV_SESSION`, `CCV_APP` (`http://127.0.0.1:7710`), `CCV_EVIDENCE`, `CCV_STATE`, `CCV_CHROMIUM` (`/usr/bin/chromium`).

## Feature map

`features/README.md` indexes one recipe per user-facing feature. When you change a feature, verify every entry point its file lists, and update the file when the UI changes.
