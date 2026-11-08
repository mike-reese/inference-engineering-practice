# D12 shared brief (read in full)

> Update (owner, 2026-11-08): the four layout variants are gone. D12 now has three worlds: Stacked, Execution spine (Split lens at 55%) and Architecture (variant 2). `stage.js` mounts them. `regress.sh` takes no argument.

Owner's goal: Mike is designing a command center for an intuitive, conceptual understanding of LLM inference. It has three
dimensions (execution, hardware, architecture), each with its own tiers, in one visual world. We hillclimb through
throwaway prototypes on scratch data toward an end-state render. Design doc:
`/home/mike/Work/Code/Personal/inference-engineering-practice-v2scene/COMMAND_CENTER_DIMENSIONS.md` (section 2).
D12 = `devtools/frontend/prototypes/D12/` (a copy of D11 plus the changes below). URL:
`http://127.0.0.1:7710/static/prototypes/D12/index.html` (state in the URL hash; `window.__d12` is the state).

## Owner's D12 rulings (verbatim where quoted)
1. Playback: "play ALL events within the bounds of the active grains, looping when it hits the bounds ... we should
   not be skipping anything. The bounds just limit the playback." DONE in `model.js` (read it): `togglePlay`,
   `setPace("events"|"time")`, `setRate`, `state.bounds` (span of the execution unit at the cursor at
   `state.tiers.execution`), `state.playEvent` (the event being visited), `eventsIn()`, `EVENTS`. Do not reimplement.
2. "We now have two architecture layer selections. Not effective. Keep the single top-level layer selection" (the
   header ladder) "and stop it from being full screen - keep it like it was in the D10 prototype" (a lens).
3. "The architecture layer merits its own full screen display ... it should probably replace what the hardware
   section shows in the execution spine as the top level for the playback view." Agents prototype options
   (`state.layout`, `LAYOUTS` in model.js; one file per variant in `layouts/`, `mountLayout(stageEl) -> dispose`).
4. Build off the updated v2 (`devtools/frontend/cc/`, live at
   `http://127.0.0.1:7710/static/cc/index.html#side?run=I02A-TRACE-components_20261108T204701Z_1b9632`): its bottom
   bar (tabs Selected / At cursor / Metrics / Tokens / Kernels / Run, level buttons, play / pace / rate, timeline) is
   "genuinely easier to read" and "SO MUCH SMOOTHER" in playback; its hardware cutout on the right is "so awesome".
5. (mid-turn) "The hardware lens on the Execution Spine shouldn't be deleted ... make it a subview like the
   architecture one is so we can swap between them in one window. The 3D isn't really that useful in the execution
   spine view, make it a static window if possible where we can zoom."

Never import from `devtools/frontend/views/` (v1) or `devtools/frontend/cc/` (v2). Read them, copy the approach and the
look (CSS, structure). Mike: "we are not importing them ... We are rebuilding it."

## Smoothness rules (why v2 is smooth; follow them)
- `subscribe(fn)` calls `fn(state, changed)` at most once per animation frame; `changed` has a boolean per key
  (layout, world, focus, tiers, paired, t, sel, metric, playing, pace, rate, bounds, playEvent, dock).
- Rebuild DOM only when a structural key changed; on a `t`-only change update the cheap parts (cursor line, lit
  class toggles, numbers). No `innerHTML` rebuild of a whole panel per frame. No setInterval.

## Must not regress (D11 behaviours the owner already approved)
R1 World tabs (Stacked world, Execution spine) switch in place; cursor, selection and tiers persist.
R2 Header: three clickable tier ladders (one per dimension) and the Paired / Independent toggle with the visible
   aligned link. This is the ONLY tier selection for each dimension.
R3 Everything is clickable: tiers, things, units, stops, metrics. Keys stay as shortcuts.
R4 Process colours (`data.PROCESS_COLOR`, `data.processOf`) in every view.
R5 Selection data in v1 style: payload chips, templated text, SSE events, scheduler table, kernel fields, clickable
   parents and hardware.
R6 Metrics: scratch vs measured columns labelled, the two TTFT split bars, a click lights the inputs everywhere.
R7 Control plane placeholders (run picker, rep launcher, Compare, Logs, Tools, Lifecycle).
R8 Dock / bar bottom or right, collapse, resize.
R9 Architecture drawn natively in the v1 Infrastructure / Components style with sparklines; tool containers shown.
R10 State in the URL hash; reload keeps the position.
R11 Zero page errors in the console.

## Constraints
- Own only the files your brief names. Others are being written in parallel; stubs may show. Need a change in
  model.js / data.js / stage.js / index.html? Report it, do not make it (exception named in your brief).
- Verify with the project skill `verify-command-center` (`devtools/verify/ccv`; read `.claude/skills/verify-command-center/SKILL.md`)
  on the hidden CCV-1 output only. Never run hyprctl or any focus or workspace command, never create/remove/reload
  outputs, never move Mike's cursor or focus. `ccv open` with only a new hash does not reload: add `?r=N`.
- Fast: aim for under an hour. Throwaway prototype code. No narrating comments. No em dashes in your report.
- Screenshots to `/mnt/ie-data/cc-v2-verify/evidence/d12-<your part>/`. Close your ccv session.
- Report: what works, what is rough, screenshots, console errors, which R1-R11 you checked and how.
