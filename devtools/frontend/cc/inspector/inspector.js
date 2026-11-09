// The inspector: a flyout docked at the bottom (default) or right of the stage, with a normal and a big size, like the
// D5v2 prototype. It renders the open tab of inspector/tabs.js only when that tab's deps change, and handles every link
// inside a tab in one delegated click handler. A hover on an element with data-light="<id>,<id>" (a Metrics input) lights
// those rows on every level through Control.light. Dock, size and tab persist per viewer (localStorage, optional).
import { TABS } from "./tabs.js";
import { openInNsight } from "./nsight.js";
import { perf } from "../perf.js";

const KEY = "cc.inspector";
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {}; } catch { return {}; } };
const write = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private window: the choice lasts this page only */ } };
const same = (a, b) => a && a.length === b.length && a.every((x, i) => x === b[i]);

export class Inspector {
  /** @param {HTMLElement} root @param {import("../store/run.js").RunStore} store @param {import("../control/control.js").Control} control */
  constructor(root, store, control) {
    this.control = control; this.store = store;
    const saved = read();
    this.pref = { tab: TABS.some((t) => t.key === saved.tab) ? saved.tab : TABS[0].key, dock: saved.dock === "right" ? "right" : "bottom", big: !!saved.big };
    root.innerHTML = `<div id="ftabs" role="tablist" aria-label="Inspector tabs">${TABS.map((t) => `<button role="tab" data-t="${t.key}">${t.label}</button>`).join("")}
      <span class="fsp"></span><span id="fstatus" role="status" aria-live="polite"></span>
      <button id="fdock" title="move the inspector"></button><button id="fbig" title="enlarge or shrink the inspector" aria-label="enlarge or shrink the inspector">⤢</button></div>
      <div id="fbody" role="tabpanel"></div>`;
    this.body = /** @type {HTMLElement} */ (root.querySelector("#fbody")); this.status = root.querySelector("#fstatus");
    this.ctx = { store, aux: null, memo: new Map(), timer: 0, rerender: () => { this.deps = null; this.render(); } };
    store.aux().then((a) => { this.ctx.aux = a; this.ctx.rerender(); })
      .catch((e) => { this.ctx.aux = { metrics: [], facts: {}, unavailable: [{ what: "aux.json", why: String(e.message ?? e) }] }; this.ctx.rerender(); });

    root.querySelector("#ftabs").addEventListener("click", (e) => {
      const b = /** @type {HTMLElement} */ (e.target).closest("button"); if (!b) return;
      if (b.dataset.t) { this.pref.tab = b.dataset.t; this.deps = null; this.render(); }
      else if (b.id === "fdock") this.pref.dock = this.pref.dock === "bottom" ? "right" : "bottom";
      else if (b.id === "fbig") this.pref.big = !this.pref.big;
      write(this.pref); this.layout();
    });
    // a click on a link must not keep keyboard focus, or Space (play) would also press the focused button
    root.addEventListener("mousedown", (e) => { if (/** @type {HTMLElement} */ (e.target).closest("button")) e.preventDefault(); });
    this.body.addEventListener("click", (e) => this.link(/** @type {HTMLElement} */ (e.target)));
    this.lightEl = null;
    this.body.addEventListener("pointerover", (e) => this.light(/** @type {HTMLElement} */ (e.target).closest("[data-light]"), e.timeStamp));
    this.body.addEventListener("pointerleave", (e) => this.light(null, e.timeStamp));
    this.layout();
    // appended rows change what a tab's scans and lists hold: drop them, and the tab's deps (store.N) re-render it
    control.subscribe((f) => { if (f.changed.data) this.ctx.memo.clear(); this.f = f; this.render(); });
  }

  /** Light the rows an element names (data-light), or none; only when the hovered element changes. */
  light(el, ts) {
    if (el === this.lightEl) return;
    this.lightEl = el;
    perf.input("light", ts);
    this.control.light(el ? el.dataset.light.split(",").map(Number) : null);
  }

  layout() {
    const { dock, big, tab } = this.pref;
    document.body.classList.toggle("dock-bottom", dock === "bottom");
    document.body.classList.toggle("insp-right", dock === "right");
    document.body.classList.toggle("fly-big", big);
    const d = document.querySelector("#fdock"); d.textContent = dock === "bottom" ? "dock → right" : "dock ↓ bottom";
    for (const b of document.querySelectorAll("#ftabs button[data-t]")) { const on = b.dataset.t === tab; b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on)); }
  }

  /** Re-render the open tab when its deps changed; otherwise only its cursor tick. */
  render() {
    const f = this.f; if (!f) return;
    const tab = TABS.find((t) => t.key === this.pref.tab), deps = [tab.key, ...tab.deps(f, this.ctx)];
    if (!same(this.deps, deps)) {
      this.deps = deps;
      if (this.lightEl) { this.lightEl = null; this.control.light(null); }   // the hovered element is about to be replaced
      try { tab.render(this.body, f, this.ctx); }
      catch (e) { console.error(`inspector ${tab.key}`, e); this.body.innerHTML = `<pre class="fatal">${String(e.message ?? e)}</pre>`; }
    } else if (tab.tick && f.changed.cursor) tab.tick(this.body, f, this.ctx);
  }

  async link(el) {
    const a = el.closest("[data-sel],[data-seek],[data-open],[data-raw]"); if (!a) return;
    const d = a.dataset;
    if (d.sel) this.control.select(Number(d.sel));
    else if (d.seek) { const [t, id] = d.seek.split(",").map(Number); this.control.seekRow({ t, id }); }
    else if (d.open) {
      const target = JSON.parse(d.open);
      this.say(`asking the runner to open ${target.path}…`);
      const r = await openInNsight(target); this.say(r.message, !r.ok);
    } else if (d.raw) {
      const out = this.body.querySelector(`[data-raw-out="${d.raw}"]`);
      out.textContent = "loading…";
      try {
        const r = await fetch(`${this.store.base}/raw?id=${d.raw}`), j = await r.json();
        out.textContent = r.ok ? JSON.stringify(j.value ?? j, null, 1) : `HTTP ${r.status}: ${JSON.stringify(j)}`;
      } catch (e) { out.textContent = String(e); }
    }
  }

  say(text, bad = false) { this.status.textContent = text; this.status.classList.toggle("bad", bad); }
}
