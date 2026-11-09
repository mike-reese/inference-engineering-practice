// The one keymap (COMMAND_CENTER.md 2.4) and the page's only keydown listener for it. The header's ? help renders
// KEYS, built from the same rows, so the keys and their help cannot drift. Everything here is also clickable.
import { state, step, walkRow, fly, focus, setTier, setPaired, setWorld, setDock, togglePlay, setPace, goBack, goForward, WORLDS } from "./control.js";
import { perf } from "../perf.js";

const arrow = (e) => (e.key === "ArrowRight" ? +1 : e.key === "ArrowLeft" ? -1 : 0);
const letter = (e, c) => e.key.length === 1 && e.key.toLowerCase() === c;
const FOCUS = { e: "execution", h: "hardware", a: "architecture" };

/** label and does are the help's two columns; intent names the input for perf's input-to-frame marks. */
const ROWS = [
  { label: "← →", does: "previous / next stop of the focused tier", intent: "step", match: (e) => arrow(e) && !e.shiftKey && !e.altKey, run: (e) => step(arrow(e)) },
  { label: "Shift ← →", does: "stop one tier coarser", intent: "step", match: (e) => arrow(e) && e.shiftKey && !e.altKey, run: (e) => step(arrow(e), true) },
  { label: "↑ ↓", does: "fly one tier coarser / finer", intent: "focus", match: (e) => e.key === "ArrowUp" || e.key === "ArrowDown", run: (e) => fly(e.key === "ArrowUp" ? -1 : +1) },
  { label: "E H A", does: "focus execution / hardware / architecture", intent: "focus", match: (e) => e.key.length === 1 && e.key.toLowerCase() in FOCUS, run: (e) => focus(FOCUS[e.key.toLowerCase()]) },
  { label: "1-6", does: "tier n of the focused dimension", intent: "focus", match: (e) => e.key.length === 1 && e.key >= "1" && e.key <= "6", run: (e) => setTier(state.focus, Number(e.key) - 1) },
  { label: "P", does: "paired / independent tiers", intent: "focus", match: (e) => letter(e, "p"), run: () => setPaired(!state.paired) },
  { label: "W", does: "next world", intent: "world", match: (e) => letter(e, "w"), run: () => setWorld(WORLDS[(WORLDS.findIndex(([id]) => id === state.world) + 1) % WORLDS.length][0]) },
  { label: "D", does: "dock bottom / right", intent: "dock", match: (e) => letter(e, "d"), run: () => setDock({ pos: state.dock.pos === "bottom" ? "right" : "bottom" }) },
  { label: "Space", does: "play every event in the bounds, looping", intent: "play", match: (e) => e.key === " ", run: () => togglePlay() },
  { label: "T", does: "pace: events / time", intent: "play", match: (e) => letter(e, "t"), run: () => setPace(state.pace === "time" ? "events" : "time") },
  { label: "Alt ← →", does: "previous / next row of the focused tier (walk every row, section 3.4)", intent: "step", match: (e) => arrow(e) && e.altKey, run: (e) => walkRow(arrow(e)) },
  { label: "[ ]", does: "back / forward through selections (choice 4)", intent: "select", match: (e) => e.key === "[" || e.key === "]", run: (e) => (e.key === "[" ? goBack() : goForward()) },
];

/** [keys, what they do] per row, for the help. */
export const KEYS = ROWS.map((r) => [r.label, r.does]);

export function bindKeys(target) {
  target.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.target.closest?.("input, textarea, select")) return;
    const row = ROWS.find((r) => r.match(e));
    if (!row) return;
    e.preventDefault();
    perf.input(row.intent, e.timeStamp);
    row.run(e);
  });
}
