# Select and inspect

Clicking an item drawn in the scene selects it. An outline marks it, the cursor moves to its time, the URL keeps it
(`sel=`), and the Summary tab's `Selected` box shows its name, stable id, description and evidence. Browser Back and
Forward step through selections.

## Sub-features

- `sel-pick` a click on a scene item selects it and moves the cursor to it.
- `sel-panel` the Selected box shows the item.
- `sel-history` each selection is a browser history entry.

## How to get to it (user POV)

- Click an item at levels 4 to 7. Levels 1 to 3 are v1 panels with their own controls.
- Use the browser's Back and Forward buttons.

## Driving it with ccv

Preconditions:

- Baseline; `$CCV open side` done; the Summary tab is open.

- **Frame the level.** Choose `4 Iteration`. Run `$CCV click --role button --name "4 Iteration" --exact`. `$CCV state` shows `focus_level.name` `Iteration`.
- **Find the item.** Run `$CCV find --text "model forward launched"`. It returns a `div.lab` label with `in_viewport` `true`.
- **Pick.** Click the item. Run `$CCV click --text "model forward launched" --force --after sel-pick`. `$CCV eval 'location.hash'` contains `sel=stamp%2Fforward%2Fmeasured%2Fi67%2Fmodel-forward-launched`, and `state.timeline` starts `21.805 ms`.
- **Panel.** Read the Selected box. Run `$CCV eval 'document.querySelector("#selbox").innerText'`. It starts `Selected` and its second line is `model forward launched`.
- **Back.** Choose the browser's Back button. Run `$CCV back --after sel-back`. `$CCV eval 'location.hash.includes("sel=")'` returns `false` and the Selected box is empty.
- **Forward.** Choose Forward. Run `$CCV forward`. `location.hash` contains `sel=` again and the Selected box starts `Selected`.
- **Proof.** Run `$CCV shot sel-panel --css "#side"` and `$CCV console`. The console must have no `pageerror`.

## Gotchas

- Known bug (gaps doc T7): the pick sets a fractional cursor, so the Proof step logs one `pageerror` (HTTP 500 from
  `/state`) until T7 is fixed. Report it.
- `--force` is required: labels take no pointer events, so the canvas item under the label receives the click. That is the user path.
- A label exists only on items wide enough on screen. If `find` reports no match, zoom in first.
- The item id carries the iteration at the cursor (`i67` at baseline); a different cursor selects a different id.
