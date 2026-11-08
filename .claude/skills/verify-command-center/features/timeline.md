# Timeline

> **Legacy (v2 prototype).** This recipe drives the D5v2 page, which goes at the v3 cutover. Open it with
> `$CCV open "http://127.0.0.1:7710/static/prototypes/D5v2/side/index.html"` wherever the steps say `$CCV open side`
> (that now opens the v3 page, `/static/cc/index.html`).

The footer timeline holds the run's cursor over one request window, with iterations in green and stamps as blue ticks.
A user scrubs it, steps with ◀ and ▶|, and plays it at a chosen speed. Every level follows the cursor.

## Sub-features

- `tl-scrub` a click on the timeline moves the cursor.
- `tl-step` ◀ and ▶| move to the previous or next step: a stamp, or a kernel when level 5 or deeper is in focus.
- `tl-play` play and pause at a speed in steps per second.

## How to get to it (user POV)

- Click the timeline bar at the bottom of the page.
- Choose the ◀, ▶ play and ▶| buttons, and the speed select to their left.

## Driving it with ccv

Preconditions:

- Baseline; `$CCV open side` done.

- **Scrub.** Click the middle of the timeline. Run `$CCV click --css "#tl" --frac 0.5,0.5 --after tl-scrub`. `$CCV state` shows `timeline` `122.185 ms / 244.369 ms · step: stamps`.
- **Step forward.** Choose ▶|. Run `$CCV click --css "#next" --after tl-step`. `timeline` reads `122.967 ms / 244.369 ms · step: stamps`.
- **Step back.** Choose ◀. Run `$CCV click --css "#back"`. `timeline` reads `121.310 ms / 244.369 ms · step: stamps`.
- **Kernel steps.** Choose `5 Model ops`, then ▶|. Run `$CCV click --role button --name "5 Model ops" --exact` and `$CCV click --css "#next"`. `timeline` reads `121.318 ms / 244.369 ms · step: kernels`.
- **Speed.** Pick `5` steps per second. Run `$CCV select --css "#speed" --option 5`. `$CCV eval 'document.querySelector("#speed").value'` returns `"5"`.
- **Play.** Choose ▶ play. Run `$CCV click --css "#play"`. `state.playing` is `true`, and the `timeline` time is higher in a `state` read 1.5 s later.
- **Pause.** Choose ⏸ pause. Run `$CCV click --css "#play" --after tl-paused`. `state.playing` is `false`.
- **Proof.** Run `$CCV console`. It must have no `pageerror`.

## Gotchas

- Known bug (gaps doc T7, 2026-11-08): the scrub sets a fractional cursor; the Summary panel's store queries fail with
  HTTP 500 and log one `pageerror`. The Proof step fails until T7 is fixed. Report it; do not skip the scrub.
- At kernel steps, play advances microseconds per step; a 1.5 s play moves the cursor by about 0.03 ms.
- Keyboard stepping does not exist: `$CCV key ArrowRight` changes nothing (gap T8).
- The timeline has no zoom; it always shows the whole request window (gap T3).
