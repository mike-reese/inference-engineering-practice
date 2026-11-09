# Launch

Launch starts a rep action through the host runner (`POST /runner/jobs`) and follows its run live: the job names its
run, the run opens from the store as it records, and the final generation reloads as a replay. The panel lists the
rep's actions from `rep.toml` by group, with each action's options. The page checks each option against its pattern
before posting. In recipes the page opens with `?dry_run=1`: the runner checks the action and its options and starts
nothing.

## Sub-features

- `launch-actions` `.sh-pan .act` per action: label, `measured`, minutes, `[data-p=launch][data-v=<action>]`.
- `launch-options` `.sh-pan [data-opt="<action>.<option>"]` inputs and selects; a bad value gets the class `bad`.
- `launch-live` a launch switches to live mode: `__cc.session.mode` `live`, the Spine world, follow on.
- `launch-follow` `.ch-nav [data-sh=follow]` turns following the newest moment on and off.
- `launch-dry` with `?dry_run=1`, a note in the panel, `dry run` in the header and the stage, and no job.

## How to get to it (user POV)

- Click `Launch` in the header. A rep without `rep.toml` cannot be launched; the panel says how to add one.

## Driving it with ccv

Preconditions:

- Baseline (README). Recorded on 2026-11-09 on `:7711`, session `m1c-skill-launch`.
- Never launch without the dry run. First check the runner honors it:
  `curl -s $CCV_APP/runner/health` must print `"dry_run": true`.
- Open with `?dry_run=1` in the query:
  `$CCV launch --size full --url "$CCV_APP/static/cc/index.html?dry_run=1&r=$RANDOM#$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))' '{"session":{"mode":"replay","rep":"I02A-L1","run":"'$R1'"},"world":"rep"}')"`.

- **Open.** `$CCV click --css '.ch-nav [data-sh=open][data-v=launch]' --after launch-open`. The note reads
  `Dry run (?dry_run=1): the runner checks the action and its options and starts nothing.` Groups: `run`, `check`.
  Ten actions, starting `Measured run · measured · about 2 min`, `Timeline (Nsight Systems) · about 4 min`,
  `Code (PyTorch profiler) · about 6 min`, `Kernels (Nsight Compute) · about 15 min`. Options include
  `timeline.profile_range=1-129`, `code.profile_range=66-129`, `kernels.profile_range=67-67`.
- **A bad option.** `$CCV click --css '.sh-pan [data-opt="timeline.profile_range"]'`, `$CCV key End`,
  `$CCV type x`: the value is `1-129x`, which fails the pattern `^\d{1,3}-\d{1,3}$`. Then
  `$CCV click --css '.sh-pan [data-p=launch][data-v=timeline]'`. The input gets `bad`, the mode stays `replay`,
  and the panel stays open.
- **Dry-run launch.** Check the guard first:
  `$CCV eval 'new URLSearchParams(location.search).get("dry_run") === "1" && document.querySelector(".sh-pan .note").textContent.startsWith("Dry run")'`
  must be true. Read `curl -s "$CCV_APP/runner/jobs?limit=1"`, then
  `$CCV click --css '.sh-pan [data-p=launch][data-v=off]' --after launch-live`. The runner's newest job is unchanged.
  `__cc.session.mode` is `live` with `live` `{"action":{"id":"off","label":"Measured run"},"options":{},"job":null,
  "dry_run":true,"state":"dry run"}`; the world is `spine`; follow is on. The header reads `dry run`; the stage
  reads `dry run: the runner checked the action and started nothing`.
- **Follow off.** `$CCV click --css '.ch-nav [data-sh=follow]'`: `__cc.follow` is false.
- **Rep world chip.** `$CCV click --css '.ch-nav button[data-w=rep]'`: the chip reads
  `● live · Measured run · dry run, nothing started`.
- **Console.** `$CCV console`: 0 errors.

## Gotchas

- Without `?dry_run=1` the same click starts a GPU job on the shared machine and writes a run folder. Launch for
  real only when the task or Mike asks for a run; GPU recording is the coordinator's.
- The page reads `dry_run` once at load. Changing the query needs a new page load.
- `live.sh` covers what needs a real recording: the head moves, follow holds the head, the mask.
