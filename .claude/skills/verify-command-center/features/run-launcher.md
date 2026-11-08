# Run launcher

> **Legacy (v2 prototype).** This recipe drives the D5v2 page, which goes at the v3 cutover. Open it with
> `$CCV open "http://127.0.0.1:7710/static/prototypes/D5v2/side/index.html"` wherever the steps say `$CCV open side`
> (that now opens the v3 page, `/static/cc/index.html`).

The Run tab lists the registered reps (`reps/*/rep.toml`) and each action with its options. `Start` queues an action
on the host runner. The right side follows a job's steps and output, with links to its run.

## Sub-features

- `run-list` the registered rep's actions, one `Start` button each.
- `run-follow` a job link shows that job's steps, state and run.
- `run-start` `Start` queues a job (side effects: a GPU run and a new run folder).

## How to get to it (user POV)

- The flyout's `Run` tab.

## Driving it with ccv

Preconditions:

- Baseline; `$CCV open side` done; `$CCV doctor` reports the runner ok.
- The runner's job history has jobs 1 to 3 (I02A-L1, 2026-11-03). Check with `curl -s "127.0.0.1:7701/runner/jobs?limit=3"`; on another history, use an existing job id.
- `run-start` only when the task or Mike asks for a run: the GPU is shared.

- **Open.** Choose `Run`. Run `$CCV click --role button --name "Run" --exact --after run-tab` and `$CCV wait --text "Streamed latency"`. `state.flyout_tab` is `run`.
- **List.** Read the action list. Run `$CCV aria run-list`. The file holds 10 `button "Start"` lines (actions `off`, `timeline`, `code`, `kernels`, `nographs`, `live`, `components`, `check`, `k4`, `source`).
- **Find one action.** Run `$CCV find --css 'button.start[data-rep="I02A-L1"][data-action="off"]'`. It returns `name` `Start`.
- **Follow a job.** Choose the `job 2` link in the jobs list. Run `$CCV click --role link --name "job 2" --exact --after run-job2` and `$CCV wait --text "job 2: I02A-L1"`. The job header reads `job 2: I02A-L1 · Live (engine iteration stats)` and `$CCV wait --text "I02A-TRACE-live_20261103T185532Z_1c1629"` finds its run.
- **Start (authorized only).** Choose `Start` on Measured run. Run `$CCV click --css 'button.start[data-rep="I02A-L1"][data-action="off"]' --after run-start`. `curl -s "127.0.0.1:7701/runner/jobs?limit=1"` shows a new job with action `off`, state `queued` or `running`; the right side shows its steps.
- **Proof.** Run `$CCV console` (no `pageerror`); for a start, also save the runner job JSON and list the new run folder under `reps/*/results/`.

## Gotchas

- The jobs list is below the visible part of the flyout; `ccv` scrolls it into view before clicking, as a user would.
- The job panel shows the newest job until a job link is chosen.
- `run-start` has not been verified (no run was authorized, 2026-11-08). Report it as unverified until a run is asked for.
- A finished run does not appear in the v2 scene: the v2 store is imported by hand (gap T4). Check it in the Runs tab.
