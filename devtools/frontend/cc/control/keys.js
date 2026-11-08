// The one keymap and the page's only keydown listener. The help overlay (?) renders this same table, so the keys and
// their help cannot drift. Each row names its intent for the input-to-frame marks.
import { perf } from "../perf.js";

/** @typedef {import("./control.js").Control} Control */
/** @typedef {{keys: string[], label?: string, does: string, intent?: string, run: (c: Control) => void}} KeyRow */

/** @param {{name: string}[]} levels @returns {KeyRow[]} */
export function keymap(levels) {
  return [
    { keys: ["ArrowRight"], label: "→", does: "next event at the grain", intent: "step", run: (c) => c.step(+1) },
    { keys: ["ArrowLeft"], label: "←", does: "previous event at the grain", intent: "step", run: (c) => c.step(-1) },
    { keys: ["Shift+ArrowRight"], label: "Shift →", does: "next event one tier coarser", intent: "step", run: (c) => c.step(+1, "coarser") },
    { keys: ["Shift+ArrowLeft"], label: "Shift ←", does: "previous event one tier coarser", intent: "step", run: (c) => c.step(-1, "coarser") },
    { keys: ["Alt+ArrowRight"], label: "Alt →", does: "next row of any tier (every row)", intent: "step", run: (c) => c.step(+1, "finest") },
    { keys: ["Alt+ArrowLeft"], label: "Alt ←", does: "previous row of any tier", intent: "step", run: (c) => c.step(-1, "finest") },
    { keys: ["ArrowUp"], label: "↑", does: "focus the next coarser level", intent: "focus", run: (c) => c.focusStep(-1) },
    { keys: ["ArrowDown"], label: "↓", does: "focus the next finer level", intent: "focus", run: (c) => c.focusStep(+1) },
    ...levels.map((l, i) => ({ keys: [String(i + 1)], does: `focus ${l.name}, natural window at the cursor`, intent: "focus", run: (c) => c.focusLevel(i) })),
    { keys: [" "], label: "Space", does: "play / pause", intent: "play", run: (c) => c.togglePlay() },
    { keys: ["+", "="], label: "+", does: "zoom the window in around the cursor", intent: "zoom", run: (c) => c.zoom(0.5) },
    { keys: ["-"], label: "−", does: "zoom the window out around the cursor", intent: "zoom", run: (c) => c.zoom(2) },
    { keys: ["0"], does: "natural window of the focused level", intent: "zoom", run: (c) => c.naturalWindow() },
    { keys: ["Home"], does: "first event at the grain", intent: "step", run: (c) => c.home() },
    { keys: ["End"], does: "last event at the grain", intent: "step", run: (c) => c.end() },
    { keys: ["l"], label: "L", does: "follow the live head (live runs only)", intent: "live", run: (c) => c.toggleFollow() },
    { keys: ["Escape"], label: "Esc", does: "close this help, else clear the selection", intent: "select", run: (c) => (help.hidden ? c.clear() : (help.hidden = true)) },
    { keys: ["?"], does: "show or hide this help", run: () => (help.hidden = !help.hidden) },
  ];
}

let help = /** @type {HTMLElement} */ ({ hidden: true });

const combo = (e) => {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return (e.altKey ? "Alt+" : "") + (e.shiftKey && k.startsWith("Arrow") ? "Shift+" : "") + k;
};

/** @param {Window} target @param {Control} control @param {{name: string}[]} levels */
export function bindKeys(target, control, levels) {
  const rows = keymap(levels), by = new Map(rows.flatMap((r) => r.keys.map((k) => [k, r])));
  help = document.createElement("div"); help.id = "help"; help.hidden = true; help.setAttribute("role", "dialog"); help.setAttribute("aria-label", "Keys");
  help.innerHTML = `<h2>Keys</h2><table>${rows.map((r) => `<tr><th>${r.label ?? r.keys[0]}</th><td>${r.does}</td></tr>`).join("")}</table>`;
  document.body.append(help);
  target.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || /** @type {HTMLElement} */ (e.target).closest?.("input, select, textarea")) return;
    const row = by.get(combo(e));
    if (!row) return;
    e.preventDefault();
    if (row.intent) perf.input(row.intent, e.timeStamp);
    row.run(control);
  });
  return { toggleHelp: () => (help.hidden = !help.hidden) };
}
