// Control: the timeline service and the only writer of view state (cursor, window, focus, selection, play, camera
// pose) and of the URL. Intents mutate state and request a frame; each animation frame emits at most one immutable
// Frame to the subscribers (scene, bar), then closes the pending input-to-frame marks.
import * as url from "./url.js";
import { perf } from "../perf.js";

const MIN_W = 1000;            // narrowest window: 1 µs
const PLAY_WINDOW_S = 8;       // time pace: the window plays in 8 s at rate x1
const EVENTS_PER_S = 20;       // events pace: steps per second at rate x1
const URL_REPLACE_MS = 150;
const LIVE_LAG_NS = 100e6;     // follow: the cursor trails the live head by 100 ms, the live append budget
const LIVE_LEAD = 0.9;         // follow: the cursor sits at 90% of the window, so the window trails the head

/**
 * @typedef {import("../store/run.js").Cursor} Cursor
 * @typedef {{seq: number, run: string, cursor: Cursor, win: [number, number], grain: number, grainName: string,
 *   chain: any, sel: number, selRow: any, lit: readonly number[] | null, focus: number, play: {on: boolean, pace: string, rate: number},
 *   live: boolean, snap: boolean, px: number, changed: Record<string, boolean>}} Frame
 * selRow is the selected row's detail (null while it loads): cold fields, parents, links, and `open`, the server's
 * Nsight targets for that row. `open.nsys = {run, path, t: [a, b]}` (t in report time) is the "Open in Nsight Systems"
 * hook at the row's time range; rows not from nsys have `open.nsys = null`. The inspector sends it to /runner/open.
 * lit is the row ids a hover lights on every level (a Metrics input), or null. changed.data: this frame merged live
 * rows or samples; a view that indexes rows counts what it has seen against the store (store.N), not this flag alone.
 */

export class Control {
  /** @param {import("../store/run.js").RunStore} store @param {import("./url.js").UrlState} init @param {any[]} levels */
  constructor(store, init, levels) {
    this.store = store; this.levels = levels; this.subs = new Set(); this.px = 1200;
    const req = store.chain(store.extent[0]).request, first = req ? { t: req.win[0], id: req.id } : store.step({ t: -Infinity, id: -1 }, +1, 6);
    // a live run opens following its head unless the URL names a time; default: the first request's start. A URL t is
    // kept as written, even past the rows (a live head carried into the final generation, which shares its t0).
    this.live = store.status === "live" && init.t == null && !store.live?.ended;
    const head = { t: Math.round(store.head() - LIVE_LAG_NS), id: -1 };
    this.cursor = init.t != null ? { t: init.t, id: -1 } : this.live ? head : first ?? head;
    this.focus = init.f ? init.f - 1 : 2;
    this.win = init.w && init.w[1] - init.w[0] >= MIN_W ? init.w : this.natural(this.focus);
    // a URL t outside the window (a hash without w): the window keeps its width around the cursor
    if (this.cursor.t < this.win[0] || this.cursor.t > this.win[1]) {
      const w = this.win[1] - this.win[0], a = Math.round(this.cursor.t - LIVE_LEAD * w);
      this.win = [a, a + w];
    }
    this.sel = -1; this.selEid = init.sel ?? null; this.selRow = null; this.lit = null;
    this.play = { on: false, pace: "time", rate: 1 };
    store.on("wake", () => this.request());
    store.on("generation", (g) => this.reloadGeneration(g));
    store.on("reload", () => this.reloadGeneration(null));
    store.on("status", () => { this.live = false; this.request(); });
    // a seal set parents and causes: the selected row's detail (its parent chain, cause, links) is fetched again
    store.on("derived", () => { if (this.sel >= 0) this.loadSel(this.sel); });
    this.pose = init.z ?? null; this.snapNext = !init.z;
    this.frame = null; this.seq = 0; this.pending = false; this.urlTimer = 0; this.lastPlay = 0; this.carry = 0;
    if (this.selEid) this.resolveSel(this.selEid);
    addEventListener("popstate", () => this.fromUrl(url.parse(location.hash)));
    if (store.live?.ended?.type === "generation") return void this.reloadGeneration(store.live.ended);   // ended during the open
    this.request();
  }

  subscribe(fn) { this.subs.add(fn); if (this.frame) fn(this.frame); return () => this.subs.delete(fn); }

  // ------------------------------------------------------------ intents
  /** Next or previous row at the grain; "coarser" steps one tier coarser, "finest" visits every row. */
  step(dir, mode = null) {
    const g = this.grain(), r = mode === "coarser" ? Math.max(0, g - 1) : mode === "finest" ? 6 : g;
    const next = this.store.step(this.cursor, dir, r);
    this.live = false;
    if (next) { this.cursor = next; this.follow(dir); }
    this.request();   // a step past the run end still closes its input mark on the next frame
  }
  /** Scrub: the cursor goes to t, rounded once to an integer ns (T7). */
  seek(t) { const [a, b] = this.store.extent; this.live = false; this.cursor = { t: Math.round(Math.min(b, Math.max(a, t))), id: -1 }; this.request(); }
  /** Land on a row (a tick on the strip). */
  seekRow(c) { this.live = false; this.cursor = c; this.request(); }
  /** Scale the window around `at` (ns); factor < 1 zooms in. */
  zoom(factor, at = this.cursor.t) {
    const [a, b] = this.win, span = this.store.extent[1] - this.store.extent[0];
    const w = Math.min(span * 1.1, Math.max(MIN_W, (b - a) * factor)), f = (at - a) / (b - a);
    this.setWindow(at - f * w, at - f * w + w);
  }
  pan(dt) { this.setWindow(this.win[0] + dt, this.win[1] + dt); }
  /** Zoom, pan and the overview brush all land here: any of them ends live follow. */
  setWindow(a, b) { this.live = false; this.win = [Math.round(a), Math.round(Math.max(b, a + MIN_W))]; this.request(); }
  /** Focus a level: the window becomes that level's natural window at the cursor, and the camera snaps to it. */
  focusLevel(i) { if (i < 0 || i >= this.levels.length) return; this.focus = i; this.win = this.natural(i); this.snapNext = true; this.request(); }
  focusStep(d) { this.focusLevel(this.focus + d); }
  /** The camera moved to another column: same state change as a focus key, without the snap. */
  focusFromCamera(i) { if (i === this.focus) return; this.focus = i; this.win = this.natural(i); this.request(); }
  naturalWindow() { this.win = this.natural(this.focus); this.request(); }
  select(id) {
    this.sel = id; this.selEid = null; this.selRow = null; this.request();
    if (id < 0) return this.writeUrl(true);
    this.loadSel(id).then((d) => { if (d) { this.selEid = d.eid; this.writeUrl(true); } });
  }
  /** Fetch the selected row's detail into selRow (the store caches it). Resolves to the row, or null if stale. */
  loadSel(id) {
    return this.store.detail([id]).then(([d]) => { if (this.sel !== id || !d) return null; this.selRow = d; this.request(); return d; })
      .catch((e) => { console.error("detail", e); return null; });
  }
  /** A selection from the URL: its eid resolves to a row id, then the detail row (a cache hit after resolve). */
  resolveSel(eid) {
    this.store.resolve(eid).then((id) => { if (id != null && this.selEid === eid) { this.sel = id; this.loadSel(id); } }).catch((e) => console.error("resolve sel", e));
  }
  clear() { if (this.sel >= 0) this.select(-1); }
  /** Light rows on every level (a hover on a Metrics input), or null to clear. Not view state: no URL, no history. */
  light(ids) { this.lit = ids?.length ? Object.freeze([...new Set(ids)].filter((id) => id >= 0 && id < this.store.N)) : null; this.request(); }
  togglePlay() { this.live = false; this.play = { ...this.play, on: !this.play.on }; this.lastPlay = 0; this.carry = 0; this.request(); }
  setRate(rate) { this.play = { ...this.play, rate }; this.request(); }
  setPace(pace) { this.play = { ...this.play, pace }; this.request(); }
  home() { const c = this.store.step({ t: -Infinity, id: -1 }, +1, this.grain()); if (c) { this.live = false; this.cursor = c; this.follow(-1); this.request(); } }
  end() { const c = this.store.step({ t: Infinity, id: 2 ** 31 }, -1, this.grain()); if (c) { this.live = false; this.cursor = c; this.follow(+1); this.request(); } }
  /** Live follow is a cursor rule over a live run (cursor = head - 100 ms, the window trails it); a final run, or a
   *  live run whose writer has ended, has no head to follow. Any seek, step, zoom, pan or play ends it; L toggles. */
  toggleFollow() { if (this.store.status !== "live" || this.store.live?.ended) return; this.live = !this.live; this.play = { ...this.play, on: false }; this.request(); }
  /** The final import wrote the next generation (or the stream lost frames): reload with the same view. Live and final
   *  share one t0, so t and w carry over unchanged; sel stays an eid (lane indexes and row ids differ between generations). */
  reloadGeneration(g) {
    if (g?.t0_ns != null && g.t0_ns !== this.store.t0) console.error(`generation ${g.generation}: t0 ${g.t0_ns}, this generation's is ${this.store.t0}; t is kept as is`);
    clearTimeout(this.urlTimer); this.urlTimer = 0;
    history.replaceState(null, "", url.format(this.state()));
    location.reload();
  }
  setPose(z) { this.pose = z; this.writeUrl(false); }
  setPx(px) { if (px > 0 && px !== this.px) { this.px = px; this.request(); } }
  openRun(run) { location.hash = url.format({ run }); location.reload(); }

  // ------------------------------------------------------------ derived
  grain() { return this.store.grainFor(this.win[1] - this.win[0], this.px); }
  natural(i) {
    const w = this.levels[i].natural(this.store, this.cursor.t) ?? this.store.extent;
    const c = (w[0] + w[1]) / 2, half = Math.max(MIN_W, w[1] - w[0]) / 2;
    return [Math.round(c - half), Math.round(c + half)];
  }
  /** Keep the cursor in the window after a step: page so it lands near the edge it came from. */
  follow(dir) {
    const [a, b] = this.win, w = b - a, t = this.cursor.t;
    if (t >= a && t <= b) return;
    const lead = dir > 0 ? 0.1 : 0.9;
    this.win = [Math.round(t - lead * w), Math.round(t - lead * w) + w];
  }

  // ------------------------------------------------------------ frames
  request() { if (this.pending) return; this.pending = true; requestAnimationFrame((now) => this.tick(now)); }

  tick(now) {
    this.pending = false;
    const t0 = performance.now(), merged = this.store.flush();
    if (this.live) {   // follow: the cursor trails the head; the window keeps its width with the cursor at 90%
      const t = Math.round(this.store.head() - LIVE_LAG_NS), w = this.win[1] - this.win[0];
      this.cursor = { t, id: -1 }; this.win = [Math.round(t - LIVE_LEAD * w), Math.round(t - LIVE_LEAD * w) + w];
    }
    if (this.play.on) this.advance(now);
    const prev = this.frame, g = this.grain();
    /** @type {Frame} */
    const f = Object.freeze({
      seq: ++this.seq, run: this.store.run, cursor: this.cursor, win: this.win, grain: g, grainName: this.store.tiers[g],
      chain: this.store.chain(this.cursor.t), sel: this.sel, selRow: this.selRow, lit: this.lit, focus: this.focus, play: this.play,
      live: this.live, snap: this.snapNext, px: this.px, changed: {},
    });
    for (const k of ["cursor", "win", "grain", "sel", "selRow", "lit", "focus", "play", "px"]) f.changed[k] = !prev || prev[k] !== f[k];
    f.changed.live = !prev || prev.live !== f.live; f.changed.data = !!merged;
    f.changed.snap = this.snapNext; this.snapNext = false;
    Object.freeze(f.changed);
    this.frame = f;
    // one view's error must not stop the others, the live latency marks or the next frame; it is still reported
    for (const fn of this.subs) try { fn(f); } catch (e) { reportError(e); }
    perf.sample("tick_cpu", performance.now() - t0);
    perf.frameDone();
    if (merged) this.store.painted();
    if (this.play.on) { perf.sample("play_frame_cpu", performance.now() - t0); this.request(); }
    else if (this.live) this.request();
    if (f.changed.cursor || f.changed.win || f.changed.focus) this.writeUrl(false);
  }

  /** Play on rAF: time pace moves the cursor so the window plays in 8 s; events pace steps N rows per second. */
  advance(now) {
    const dt = this.lastPlay ? Math.min(100, now - this.lastPlay) : 0; this.lastPlay = now;
    const end = this.store.status === "live" ? Math.round(this.store.head() - LIVE_LAG_NS) : this.store.extent[1];   // stops at the live head
    if (this.play.pace === "time") {
      const w = this.win[1] - this.win[0], t = Math.min(end, this.cursor.t + Math.round(w / PLAY_WINDOW_S * this.play.rate * dt / 1000));
      this.cursor = { t, id: -1 }; this.follow(+1);
      if (t >= end) this.play = { ...this.play, on: false };
    } else {
      this.carry += EVENTS_PER_S * this.play.rate * dt / 1000;
      for (; this.carry >= 1; this.carry--) {
        const next = this.store.step(this.cursor, +1, this.grain());
        if (!next) { this.play = { ...this.play, on: false }; break; }
        this.cursor = next;
      }
      this.follow(+1);
    }
  }

  // ------------------------------------------------------------ URL
  state() { return { run: this.store.run, t: this.cursor.t, w: this.win, sel: this.selEid ?? undefined, f: this.focus + 1, z: this.pose ?? undefined }; }
  /** Push now (run, selection), or replace at most every 150 ms with the state as it is when the write fires. */
  writeUrl(push) {
    if (push) { clearTimeout(this.urlTimer); this.urlTimer = 0; history.pushState(null, "", url.format(this.state())); return; }
    if (this.urlTimer) return;
    this.urlTimer = setTimeout(() => { this.urlTimer = 0; history.replaceState(null, "", url.format(this.state())); }, URL_REPLACE_MS);
  }
  /** Back/Forward: a selection is a history entry; take the cursor, window, focus and selection from the URL. */
  fromUrl(s) {
    if (s.run && s.run !== this.store.run) return location.reload();
    if (s.t != null) { this.cursor = { t: s.t, id: -1 }; this.live = false; }
    if (s.f && s.f - 1 !== this.focus) { this.focus = s.f - 1; this.snapNext = true; }
    this.win = s.w ?? this.natural(this.focus);   // a typed or pasted hash without w opens the level's natural window
    if (!s.sel) { this.sel = -1; this.selEid = null; this.selRow = null; }
    else if (s.sel !== this.selEid) { this.selEid = s.sel; this.resolveSel(s.sel); }
    this.request();
  }
}
