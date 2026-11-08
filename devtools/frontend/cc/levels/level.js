// The Level interface every scene level implements, and the pieces every level shares (frame background, title).
// A level is a lens over the one row set: it owns no rows and no view state; it draws from Frames.
import * as THREE from "three";
import { fmtSpan, LIT_CSS } from "../control/bar.js";

/**
 * @typedef {{group: THREE.Group, store: import("../store/run.js").RunStore, gpu: import("../scene/rows_gpu.js").GpuRows, H: number, index: number, redraw: () => void}} MountCtx
 *   group: the level's local frame (x 0..1000 right, y 0..H down); H = 1000 / stage aspect
 *   redraw(): draw again with the same Frame (after a level's own async load, e.g. a detail row)
 * @typedef {{px: number, onScreen: boolean, index: number, label: (x: number, y: number, text: string, cls?: string, maxPx?: number) => boolean,
 *   button: (x: number, y: number, text: string, onClick: () => void, aria?: string) => boolean}} View
 *   px: screen pixels per local unit; label(): a CSS2D label at a fixed screen size, at local (x, y);
 *   button(): a real <button> at local (x, y) for this draw (a small pool; returns false when none is left)
 * @typedef {{
 *   name: string, key: string, homeTier: number,
 *   natural: (store: any, t: number) => [number, number] | null,   the level's natural window at t
 *   mount: (ctx: MountCtx) => void, frame: (f: import("../control/control.js").Frame, view: View) => void,
 *   pick: (local: {x: number, y: number}, f: any) => number,          row id under the point, or -1
 *   resize: (H: number) => void, dispose: () => void,
 * }} Level
 */

export const TITLE_H = 22;

/** Rows lit by Control.light (a hover on a Metrics input): every level draws them, or what holds them, in this colour. */
export const LIT = new THREE.Color(LIT_CSS);

/** The level's own window: the Control window when focused, its natural window at the cursor otherwise. */
export function windowOf(level, f, store) { return f.focus === level.index ? f.win : level.natural(store, f.cursor.t) ?? f.win; }

/** Frame background and outline in local units. */
export function frameMeshes(H, color = "#1b1e24") {
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(1000, H), new THREE.MeshBasicMaterial({ color, depthTest: false, side: THREE.DoubleSide }));
  bg.position.set(500, H / 2, 0); bg.renderOrder = 0;
  const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([[0, 0], [1000, 0], [1000, H], [0, H]].map(([x, y]) => new THREE.Vector3(x, y, 0))),
    new THREE.LineBasicMaterial({ color: "#3a404c", depthTest: false }));
  line.renderOrder = 5;
  return [bg, line];
}

/** The title label: "<n> <name> · <what the window is> <width>". */
export function title(level, f, view, win) {
  const what = f.focus === level.index ? `window · grain ${f.grainName}` : level.key;
  view.label(8, TITLE_H / 2, `${level.index + 1} ${level.name} · ${what} · ${fmtSpan(win[1] - win[0])}`, "title");
}
