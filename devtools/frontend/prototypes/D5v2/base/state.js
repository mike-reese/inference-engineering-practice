// D6 (frozen A): one shared store for the page, vanilla module, JSDoc types.
// History rule: a selection adds a history entry; the cursor and the zoom do not (they replace the current entry).
// URL: #<view>?t=&sel=&z=   t = ns from the request start, sel = stable event or thing id, z = camera and target.

/**
 * @typedef {Object} State
 * @property {string} view      layout name (flat, side, nested, split)
 * @property {string} run       ie-run/2 run id in the v2 store
 * @property {number} t         cursor, ns on the run clock (CLOCK_MONOTONIC)
 * @property {?string} sel      selected item: event eid or thing id
 * @property {?number[]} z      camera [x, y, z] and orbit target [x, y, z] (world)
 * @property {boolean} playing
 * @property {number} speed     playback steps per second
 * @property {string} container the open container thing id
 */

/** @type {State} */
export const state = { view: "", run: "", t: 0, sel: null, z: null, playing: false, speed: 20, container: "host/server" };
/** @type {Set<(keys: Set<string>) => void>} */
const subs = new Set();
let t0 = 0, urlTimer = 0;

/** @param {(keys: Set<string>) => void} fn */
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

/**
 * Change the state, notify subscribers once, and write the URL by the history rule.
 * @param {Partial<State>} patch
 * @param {{fromUrl?: boolean}} [o]
 */
export function set(patch, o = {}) {
  const keys = new Set();
  for (const [k, v] of Object.entries(patch)) if (state[k] !== v) { state[k] = v; keys.add(k); }
  if (!keys.size) return;
  for (const fn of subs) fn(keys);
  if (o.fromUrl) return;
  if (keys.has("sel")) { clearTimeout(urlTimer); history.pushState(null, "", url()); }
  else if (keys.has("t") || keys.has("z") || keys.has("container")) { clearTimeout(urlTimer); urlTimer = setTimeout(() => history.replaceState(null, "", url()), 150); }
}

/** @param {number} origin ns: the time that t= counts from */
export function setOrigin(origin) { t0 = origin; }

function url() {
  const q = new URLSearchParams();
  q.set("t", String(Math.round(state.t - t0)));
  if (state.sel) q.set("sel", state.sel);
  if (state.z) q.set("z", state.z.map((v) => +v.toPrecision(12)).join(","));
  if (state.container !== "host/server") q.set("c", state.container);
  return `${location.pathname}${location.search}#${state.view}?${q}`;
}

/** @returns {Partial<State>} */
export function readUrl() {
  const h = location.hash.slice(1), i = h.indexOf("?"), q = new URLSearchParams(i >= 0 ? h.slice(i + 1) : "");
  /** @type {Partial<State>} */ const o = {};
  if (q.has("t")) o.t = t0 + Number(q.get("t"));
  o.sel = q.get("sel");
  if (q.has("z")) { const z = q.get("z").split(",").map(Number); if (z.length === 6 && z.every(Number.isFinite)) o.z = z; }
  if (q.has("c")) o.container = q.get("c");
  return o;
}

addEventListener("popstate", () => set(readUrl(), { fromUrl: true }));
