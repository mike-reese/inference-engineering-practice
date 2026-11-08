# Level navigation

The scene lays out seven zoom levels side by side: Infrastructure, Components, Trace, Iteration, Model ops, Kernel and
Hardware. A user frames a level with its header button, zooms with the mouse wheel, and pans with a drag.

## Sub-features

- `nav-snap` a header button frames that level.
- `nav-zoom` the mouse wheel zooms at the pointer.
- `nav-pan` a left-button drag pans the scene.

## How to get to it (user POV)

- Choose `1 Infrastructure` to `7 Hardware` in the header.
- Scroll the mouse wheel over the scene.
- Drag the scene with the left mouse button.

## Driving it with ccv

Preconditions:

- Baseline; `$CCV open side` done.

- **Frame Infrastructure.** Choose `1 Infrastructure`. Run `$CCV click --role button --name "1 Infrastructure" --exact --after nav-1`. `$CCV state` shows `focus_level` `{"index": 0, "name": "Infrastructure"}` and camera `target` `[0, 0, 0]`.
- **Frame Components.** Choose `2 Components`. Run `$CCV click --role button --name "2 Components" --exact --after nav-2`. `focus_level.index` is `1`; `target` is `[11500, 0, 0]`.
- **Frame Trace.** Choose `3 Trace`. Run `$CCV click --role button --name "3 Trace" --exact --after nav-3`. `focus_level.index` is `2`; `target` is `[23000, 0, 0]`.
- **Frame Iteration.** Choose `4 Iteration`. Run `$CCV click --role button --name "4 Iteration" --exact --after nav-4`. `focus_level.index` is `3`; `target` is `[34500, 0, 0]`.
- **Frame Model ops.** Choose `5 Model ops`. Run `$CCV click --role button --name "5 Model ops" --exact --after nav-5`. `focus_level.index` is `4`; `target` is `[46000, 0, 0]`.
- **Frame Kernel.** Choose `6 Kernel`. Run `$CCV click --role button --name "6 Kernel" --exact --after nav-6`. `focus_level.index` is `5`; `target` is `[57500, 0, 0]`.
- **Frame Hardware.** Choose `7 Hardware`. Run `$CCV click --role button --name "7 Hardware" --exact --after nav-7`. `focus_level.index` is `6`; `target` is `[69000, 0, 0]`.
- **Zoom in.** Choose `4 Iteration`, then scroll up over the scene. Run `$CCV click --role button --name "4 Iteration" --exact` and `$CCV wheel --css "#stage" --dy -240 --steps 6 --after nav-zoom-in`. `state.camera.position[1]` (height) is lower than before the wheel.
- **Zoom out.** Scroll down by the same amount. Run `$CCV wheel --css "#stage" --dy 240 --steps 6 --after nav-zoom-out`. The height returns to its value before the zoom in.
- **Pan.** Choose `4 Iteration`, then drag the scene to the left. Run `$CCV click --role button --name "4 Iteration" --exact` and `$CCV drag --css "#stage" --by -400,0 --after nav-pan`. `state.camera.target[0]` is greater than `34500` and `focus_level.name` is still `Iteration`.
- **URL keeps the camera.** Run `$CCV wait --expr 'location.hash.includes("z=")'`. It returns `waited` `true`.
- **Proof.** Run `$CCV aria nav` and `$CCV console`. The ARIA file lists the seven level buttons; the console has no `pageerror`.

## Gotchas

- Camera heights depend on the window size that Hyprland gives the browser; assert directions and target x values, not heights.
- Zoomed fully out, the side layout shrinks to a dot (gap P1): an empty-looking screenshot there is the current behavior, not a load failure.
- The camera reaches the URL (`z=`) after a 120 ms debounce. Use `wait`, not a read straight after the action.
