# Flyout tabs

> **Legacy (v2 prototype).** This recipe drives the D5v2 page, which goes at the v3 cutover. Open it with
> `$CCV open "http://127.0.0.1:7710/static/prototypes/D5v2/side/index.html"` wherever the steps say `$CCV open side`
> (that now opens the v3 page, `/static/cc/index.html`).

The right-hand flyout holds the v1 tabs that are not places in the scene: Summary, Run, Runs, Requests, Engine,
Metrics, Lifecycle, Logs, Tools and Compare. A tab replaces the flyout's content and the scene stays as it is. The
flyout docks right or bottom and can be made larger.

## Sub-features

- `fly-tab` each tab shows its v1 view.
- `fly-dock` dock right or bottom.
- `fly-size` larger or smaller.

## How to get to it (user POV)

- Choose a tab button at the top of the flyout.
- Choose `dock ↓ bottom` / `dock → right` and `⤢` at its right.

## Driving it with ccv

Preconditions:

- Baseline; `$CCV open "http://127.0.0.1:7710/static/prototypes/D5v2/side/index.html"` done (`$CCV open side` opens the v3 page); no rep stack running.
- For Logs: the app server has seen the `ie-devtools` Compose stack's `devtools` container since it started.
  `curl -s 127.0.0.1:7710/api/logs/sources` lists it. The list holds only Compose containers followed since the server
  started, so after a reboot it is `[]` and the Logs picker is empty until a Compose stack runs.

- **Summary.** Choose `Summary`. Run `$CCV click --role button --name "Summary" --exact --after fly-summary` and `$CCV wait --text "At the cursor"`. `state.flyout_tab` is `summary`.
- **Run.** Choose `Run`. Run `$CCV click --role button --name "Run" --exact --after fly-run` and `$CCV wait --text "Streamed latency"`. `flyout_tab` is `run`.
- **Runs.** Choose `Runs`. Run `$CCV click --role button --name "Runs" --exact --after fly-runs` and `$CCV wait --text "steps done"`. `flyout_tab` is `runs`.
- **Requests.** Choose `Requests`. Run `$CCV click --role button --name "Requests" --exact --after fly-requests` and `$CCV wait --text "turns per conversation"`. `flyout_tab` is `requests`.
- **Engine.** Choose `Engine`. Run `$CCV click --role button --name "Engine" --exact --after fly-engine` and `$CCV wait --text "No engine with iteration stats yet"`. `flyout_tab` is `engine`.
- **Metrics.** Choose `Metrics`. Run `$CCV click --role button --name "Metrics" --exact --after fly-metrics` and `$CCV wait --text "No engine counters yet"`. `flyout_tab` is `metrics`.
- **Lifecycle.** Choose `Lifecycle`. Run `$CCV click --role button --name "Lifecycle" --exact --after fly-lifecycle` and `$CCV wait --text "No engine container seen yet"`. `flyout_tab` is `lifecycle`.
- **Logs.** Choose `Logs`. Run `$CCV click --role button --name "Logs" --exact --after fly-logs` and `$CCV wait --text "ie-devtools/devtools"`. `flyout_tab` is `logs`.
- **Tools.** Choose `Tools`. Run `$CCV click --role button --name "Tools" --exact --after fly-tools` and `$CCV wait --text "Grafana: engine, client and GPU"`. `flyout_tab` is `tools`.
- **Compare.** Choose `Compare`. Run `$CCV click --role button --name "Compare" --exact --after fly-compare` and `$CCV wait --text "Compare runs"`. `flyout_tab` is `compare`.
- **Dock bottom.** Choose `dock ↓ bottom`. Run `$CCV click --role button --name "dock right or bottom" --after fly-dock-bottom`. `state.dock` is `bottom`.
- **Dock right.** Choose `dock → right`. Run `$CCV click --role button --name "dock right or bottom"`. `state.dock` is `right`.
- **Larger.** Choose `⤢`. Run `$CCV click --role button --name "larger or smaller" --after fly-big`. `$CCV eval 'document.body.classList.contains("fly-big")'` returns `true`.
- **Smaller.** Choose `⤢` again. Run `$CCV click --role button --name "larger or smaller"`. The same `eval` returns `false`.
- **Proof.** Run `$CCV console`. It must have no `pageerror`.

## Gotchas

- The dock and size buttons are named by their `title` (`dock right or bottom`, `larger or smaller`), not their visible text.
- Dock and size persist in the browser profile; end in `right` and normal size so later runs start from baseline.
- With a rep stack running, Engine, Metrics and Lifecycle show data instead of their empty-state text.
- Links inside a tab may move the scene camera instead of opening a tab: Infrastructure, Components and Trace are places in the scene.
