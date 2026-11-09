# Command center verification map

The maintained recipes for verifying the command center as a user. Read this index, then the matching feature file.
`$CCV` is `devtools/verify/ccv`. The page is `/static/cc/index.html`: D13's layout drawn only from the v3 store
(RunStore), the registry and the rep files. A header holds the worlds, the three ladders and Load, Launch and
Compare. The stage shows one of four worlds: Rep, Stacked, Spine or Architecture. The inspector bar sits at the
bottom (or right) and the hardware sidebar on the right. The D5v2 prototype recipes are legacy and go at M4
(COMMAND_CENTER.md section 7).

## Baseline preconditions

- The app server and the host runner are up. On 2026-11-09 the recipes ran on the cc-migration worktree:
  `ie-devtools-cc` at `http://127.0.0.1:7711` with the store `/mnt/ie-data/cc/store-cc` (39 runs), and the runner
  at `:7702` behind the page's `/runner` proxy. After the cutover the main checkout serves the page at `:7710`. Set
  `CCV_APP` to the server you verify.
- `$CCV sessions` is empty before you launch. Run one ccv browser at a time on this machine: on 2026-11-08 several
  WebGL browsers next to a GPU engine crashed it. Close yours (`$CCV close`) after each recipe.
- R1 is `I02A-TRACE-timeline_20261109T060522Z_ee2252` (generation 3, final): the I02A timeline run that
  COMMAND_CENTER.md section 5 walks. Row ids below are R1's in that generation. A new import renumbers them.
- Recipes launch `--size full` (2534 x 1301). Pixel-dependent results (axis ticks, strip clicks) assume that size.

## Opening a view

The page reads its view once at load from the URL hash, a JSON object: `session` (`{mode, rep, run}`), `world`,
`focus`, `tiers` (0-based per dimension), `t` (ns on the run clock), `sel` (`{"eid": ...}` or
`{"id", "generation"}`) and `dock` (`{pos, tab, open}`). It has no hashchange listener, so each new view needs a new
query string. The recipes use this helper:

```bash
CCV=devtools/verify/ccv; export CCV_APP=http://127.0.0.1:7711 CCV_SESSION=cc-<recipe>
R1=I02A-TRACE-timeline_20261109T060522Z_ee2252
view() { python3 -c 'import sys,urllib.parse; print(sys.argv[1] + "/static/cc/index.html?r=" + sys.argv[3] + "#" + urllib.parse.quote(sys.argv[2]))' "$CCV_APP" "$1" "$RANDOM"; }
$CCV launch --size full --url "$(view '{"session":{"mode":"replay","rep":"I02A-L1","run":"'$R1'"},"world":"rep"}')"
```

`launch` returns when `window.READY` is set: the first frame drawn with the run's store open.

## Reading state

- `window.__cc` is the page state. Read it with `$CCV state` or a read-only `$CCV eval`: `world`, `focus`, `tiers`,
  `t`, `sel` (a row id, or a thing key such as `gpu0` or `host/client`), `bounds`, `dock`, `nav` (`{back, fwd}`),
  `session`, `playing`, `pace`, `rate`, `follow` and `metric`.
- A row's kind and name:
  `$CCV eval 'import("./control/control.js").then((m) => { const S = m.store(), id = __cc.sel; return S.kinds[S.field("kind", id)].name + ": " + S.nameText(S.field("name", id)); })'`.
- `$CCV state` returns `url`, `title`, `ready`, `viewport` and every field of `window.__cc` (above). On the legacy
  D5v2 page it returns that page's `timeline`, `camera`, `focus_level` and `flyout_tab` instead.

## Page handles

| Part | Handles |
| --- | --- |
| worlds | `.ch-nav button[data-w=rep]` (also `stacked`, `spine`, `architecture`); key W cycles |
| position | `.ch-nav .pos`, for example `execution › phase (3/6) · t = 73378.117 ms · 5456 stops here` |
| focus | `.ch-focus .t` (title), `.ch-focus .d` (what the tier shows) |
| ladders | `button[data-act=focus][data-dim=D]`, `button[data-act=tier][data-dim=D][data-n=i]` (i 0-based), `button[data-act=paired][data-n=1]` (or `0`), `button[data-act=keys]` |
| shell | `.ch-nav [data-sh=open][data-v=load]` (also `launch`, `compare`), `.ch-nav [data-sh=follow]`, `.ch-nav .ab button[data-v=A]` (or `B`); panel `.sh-pan [data-p=P][data-v=V]` with P one of `tab`, `rep`, `load`, `a`, `b`, `compare`, `launch`, `close`; options `.sh-pan [data-opt="action.option"]` |
| bar | `.b-tabs [data-tab=T]` with T one of `selected`, `cursor`, `metrics`, `tokens`, `kernels`, `run`; `.b-hist[aria-label=Back]` (or `Forward`); `[data-act=A]` with A one of `pos`, `big`, `open`, `back`, `play`, `next`; `.b-pace`, `.b-rate`; strips `.b-over`, `.b-detail` |
| bar links | `.b-body [data-sel]` select, `[data-seek]` seek, `[data-m]` metric, `[data-raw]` raw record, `[data-world]` world, `[data-run]` load, `#bar [data-open]` Nsight |
| sidebar | `#hw .hwrow` (its `title` starts with the metric label), `#hw h3` (one per clock), `#hw .win` |
| Rep world | `#stage .rw`: `h1`, `.top .chip`, `.mom` (`.t`, `.ev`), `[data-go=<moment id>]`, `.lesson`, `table.res`, `.seg > div` |
| Spine world | `.sp2 .lhead button[data-mode=hw]` (also `split`, `arch`), `.sp2 .rl[data-band=i]`, `#stage .spine svg`, `.sp2 .pane .ptitle` |
| Stacked world | `#stage canvas` (parts are picked on it), `#stage .sw-lbl` labels, `#stage .lens .tog` |
| Architecture world | `#stage .arch .cbox[data-box=K]` (`.on`, `.driven`), `.card[data-sel]`, `[data-proc]`, `[data-layer]` with `.nowis`; strip `#stage .aw .strip rect.u[data-l=i]`, `[data-fit]` |

Keys: ← → next stop of the focused tier; Shift ← → one tier coarser; Alt ← → next row; ↑ ↓ fly one tier; E H A
focus; 1-6 tier; P paired; W world; D dock; Space play; T pace; `[` `]` back and forward.

## Driving conventions

- Prefer data attributes and ids (`--css`), then `--role/--name`, then `--text`. In the Stacked world, click a part
  at a point the page reports (`cc-stacked.md`); never hard-code coordinates.
- Act only with real input; `eval` is read-only. Never call the page's setters.
- Pass `--after <recipe>-<step>` on acting commands that change what the user sees.
- After editing a file under `devtools/frontend/cc/`, open a new `?r=` URL so the new modules load.

## Proof and skip reporting

- Capture the action and the resulting state: the `--after` screenshot plus a read-only `eval` of `__cc` or the DOM.
- End every recipe with `$CCV console` (0 errors expected), then `$CCV close`.
- Report an unreachable entry point with the failed command and the unmet precondition. Never report it as verified
  through another path.
- `devtools/verify/regress.sh` (51 checks) and `devtools/verify/walkthroughs.sh` (section 5: 79 checks on R1 and
  I02C) check these recipes' numbers against the store and the results files. Set `CC_URL` (and `CC_STORE` for the
  walkthroughs) to the server you verify.

## Feature entry contract

Each file has an H1 title and one paragraph, then `Sub-features`, `How to get to it (user POV)`,
`Driving it with ccv` (starting with `Preconditions:`, one labeled bullet per action: user action, exact command,
observable result) and `Gotchas`.

## Features

- [Rep world](./cc-rep.md): lessons, key moments with "show me", results on three clocks, the TTFT split.
- [Spine world](./cc-spine.md): step, walk and fly the tiers; lens panes, band labels, zoom and play.
- [Stacked world](./cc-stacked.md): the 3D board, part picks, hardware tiers, the pulse label and the lens.
- [Architecture world](./cc-architecture.md): the component map lit at the cursor, cards, processes, software
  layers, the execution strip and the beam.
- [Load](./cc-load.md): replay any stored run of a rep.
- [Launch](./cc-launch.md): start a rep action through the runner and follow it live (dry run in recipes).
- [Compare](./cc-compare.md): two runs, deltas in the Rep world, side A or B in the replay worlds.
- [Inspector](./cc-inspector.md): the bar's six tabs, links, history, raw record, dock, transport, strips and Nsight
  buttons.
- [Hardware sidebar](./cc-sidebar.md): sampled metrics at the cursor, one group per clock, sparklines over the bounds.

## Legacy (D5v2 prototype, `/static/prototypes/D5v2/side/index.html`, until M4)

- [Level navigation](./level-navigation.md): header level buttons, wheel zoom and drag pan across the seven levels.
- [Timeline](./timeline.md): scrub, step, play and speed on the footer timeline.
- [Select and inspect](./select-inspect.md): click an item in the scene; the Selected panel, the URL and history follow.
- [Flyout tabs](./flyout.md): the ten v1 tabs in the right-hand flyout, dock and size.
- [Run launcher](./run-launcher.md): the Run tab's actions and jobs; starting a run has side effects.
