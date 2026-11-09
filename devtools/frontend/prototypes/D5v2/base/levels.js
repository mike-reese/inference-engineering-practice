// Zoom levels as classes. Every layout (flat, side, nested, split) places levels; the level classes draw them, so a
// change to a level shows in every layout.
//   Level       base: a group placed by the layout ({cx, cy, z, s}); local x -500..500, y -300..300, y down.
//   MeshLevel   three.js instanced boxes, links, cursor line, selection outline, flows (Trace and deeper).
//   PanelLevel  a v1 devtools view mounted in the scene as a CSS3DObject (Infrastructure, Components): the same
//               view code, styles and live feed as v1, so these levels lose nothing against v1.
import * as THREE from "three";
import { CSS3DObject } from "three/addons/renderers/CSS3DRenderer.js";
import { state as live, connect, addStamps } from "/static/live.js";
import { InfraView } from "/static/views/infra.js";
import { ComponentsView } from "/static/views/components.js";
import { TraceView } from "/static/views/trace.js";
import { router } from "/static/views/util.js";

export const BG = new THREE.Color("#15171b");
// v1's stylesheet, with its :root colour tokens moved to :host so they apply inside each panel's shadow root
const V1CSS = (await (await fetch("/static/style.css")).text()).replaceAll(":root", ":host");

export class Level {
  constructor(def, index, scene) { this.def = def; this.i = index; this.sc = scene; this.group = new THREE.Group(); }
  get items() { return this.def.items; }
  mount(p) { const g = this.group; g.position.set(p.cx, p.z, p.cy); g.rotation.x = Math.PI / 2; g.scale.setScalar(p.s); this.sc.scene.add(g); }
  setAlpha(a) { this.group.traverse((o) => { if (o.material) o.material.opacity = (o.userData.baseOpacity ??= o.material.opacity) * a; }); }
  pickable() { return this.group.userData.mesh || null; }
  dispose() { this.sc.scene.remove(this.group); this.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); }); }
}

export class MeshLevel extends Level {
  mount(p) {
    super.mount(p); const g = this.group, l = this.def;
    const geo = new THREE.PlaneGeometry(1, 1).translate(0.5, 0.5, 0);
    const mat = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    const m = new THREE.InstancedMesh(geo, mat, Math.max(1, l.items.length)); m.count = l.items.length; m.frustumCulled = false;
    const M = new THREE.Matrix4(), c = new THREE.Color();
    l.items.forEach((b, k) => { M.makeScale(b.x1 - b.x0, b.y1 - b.y0, 1).setPosition(b.x0, b.y0, 0); m.setMatrixAt(k, M); m.setColorAt(k, c.set(b.col)); });
    if (m.instanceColor) m.instanceColor.needsUpdate = true; m.userData.level = this.i; g.add(m); g.userData.mesh = m;
    if (l.links?.length) { const pts = []; for (const [a, b] of l.links) pts.push((a.x0 + a.x1) / 2, a.y1, 0, b.x0, b.y0, 0);
      const ln = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(pts, 3)),
        new THREE.LineBasicMaterial({ color: "#d8dee9", transparent: true, opacity: 0.45, depthTest: false })); ln.frustumCulled = false; g.add(ln); }
    if (l.X) { const cur = new THREE.Mesh(new THREE.PlaneGeometry(1, 600), new THREE.MeshBasicMaterial({ color: "#e5484d", depthTest: false, transparent: true, side: THREE.DoubleSide }));
      cur.frustumCulled = false; g.add(cur); g.userData.cursor = cur; }
    const sel = new THREE.LineLoop(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(12), 3)), new THREE.LineBasicMaterial({ color: "#ffb000", depthTest: false, transparent: true }));
    sel.visible = false; sel.frustumCulled = false; g.add(sel); g.userData.sel = sel;
    const fl = new THREE.Group(); g.add(fl); g.userData.flows = fl;
  }
  recolor(fn) { const m = this.group.userData.mesh; if (!m) return; const c = new THREE.Color();
    this.def.items.forEach((b, k) => { const r = fn(b); c.set(r?.col ?? b.col); if (r?.dim != null) c.lerp(BG, r.dim); m.setColorAt(k, c); }); m.instanceColor.needsUpdate = true; }
  cursor(t, pxw) { const cur = this.group.userData.cursor; if (cur && this.def.X) { cur.position.set(this.def.X(t), 0, 0); cur.scale.x = pxw; } }
  select(b) { const s = this.group.userData.sel; if (!b) { s.visible = false; return; } const a = s.geometry.attributes.position;
    a.array.set([b.x0, b.y0, 0, b.x1, b.y0, 0, b.x1, b.y1, 0, b.x0, b.y1, 0]); a.needsUpdate = true; s.visible = true; }
  flows(list) { const fl = this.group.userData.flows; fl.clear();
    for (const [a, b, w, col] of list) { if (!(w > 0)) continue; const ax = (a.x0 + a.x1) / 2, ay = (a.y0 + a.y1) / 2, bx = (b.x0 + b.x1) / 2, by = (b.y0 + b.y1) / 2, len = Math.hypot(bx - ax, by - ay);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(len, Math.min(24, w)), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.8, depthTest: false, side: THREE.DoubleSide }));
      m.position.set((ax + bx) / 2, (ay + by) / 2, 0); m.rotation.z = Math.atan2(by - ay, bx - ax); m.renderOrder = this.group.renderOrder; m.frustumCulled = false; fl.add(m); } }
}

// ---------------- panels: v1 views inside the scene
const PX = 1600, PY = 960;            // the panel's CSS size; it fills the level's 1000 x 600 footprint
const INTERACTIVE = "button, select, input, label, a, summary, tr[data-i], .card, .cbox, details";

/** v1 Infrastructure: same render; a card click opens that container's components in the next level, not a v1 tab. */
class SceneInfraView extends InfraView {
  render(state) {
    super.render(state);
    this.root.querySelectorAll(".card[data-service]").forEach((card) => (card.onclick = () => this.onOpen?.(card.dataset.project, card.dataset.service)));
  }
  drawLinks(state) { // v1 measures screen rectangles; inside a 3D transform those are scaled, so use layout offsets
    const svg = this.root.querySelector("svg.links"), base = this.root.querySelector(".infra"), gpu = this.root.querySelector("#gpu");
    if (!svg || !base || !gpu) return;
    const off = (el) => { let x = 0, y = 0; for (let e = el; e && e !== base; e = e.offsetParent) { x += e.offsetLeft; y += e.offsetTop; } return { x, y, w: el.offsetWidth, h: el.offsetHeight }; };
    const g = off(gpu), holders = new Set(state.gpuProcesses.map((p) => p.container));
    svg.innerHTML = [...holders].map((id) => { const el = this.root.querySelector(`.card[data-id="${id}"]`); if (!el) return "";
      const r = off(el), x1 = r.x + r.w, y1 = r.y + r.h / 2, x2 = g.x, y2 = g.y + 30;
      return `<path d="M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}"/>`; }).join("");
  }
}

// ---------------- hosting a v1 view: a shadow root with v1's stylesheet, redrawn from the one live feed
const drawn = new Set();          // every hosted view's draw(); the live feed redraws them all (at most once a frame each)
let feedOpen = false;
/** Host a v1 view class in a new element. Returns { host, shadow, root, view, draw }. Links and v1 navigation go
 *  through router (views/util.js), which the scene page points at its own routing. */
export function hostV1(ViewClass, { cls = "v1host", style = "", wrapStyle = "", title = "" } = {}) {
  const host = document.createElement("div"); host.className = cls; host.style.cssText = style;
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${V1CSS}</style><style>
    :host { display:block; } .wrap { overflow:auto; background:var(--bg); color:var(--text); font:13px/1.4 ui-monospace, monospace;
      padding:12px 16px; box-sizing:border-box; ${wrapStyle} }
    .lvl { color:var(--dim); font-size:11px; text-transform:uppercase; margin:0 0 8px; }</style>
    <div class="wrap">${title ? `<div class="lvl">${title}</div>` : ""}<div class="root"></div></div>`;
  const root = shadow.querySelector(".root"), view = new ViewClass(root);
  const h = { host, shadow, root, view, pending: false, active: true };
  h.draw = () => { if (h.pending || !h.active) return; h.pending = true; requestAnimationFrame(() => { h.pending = false; view.render(live); }); };
  view.redraw = h.draw;
  // keep MapControls off interactive elements, so v1's buttons, selects and cards get their clicks
  host.addEventListener("pointerdown", (e) => { if (e.composedPath().some((n) => n.matches?.(INTERACTIVE))) e.stopPropagation(); });
  host.addEventListener("wheel", (e) => { if (!host.closest?.(".panels")) e.stopPropagation(); }, { passive: true });   // a docked host scrolls, it does not zoom
  shadow.addEventListener("click", (e) => { const a = e.composedPath().find((n) => n.tagName === "A"); if (!a) return; const href = a.getAttribute("href") || "";
    if (href.startsWith("#")) { e.preventDefault(); router.go(href.slice(1)); } });
  drawn.add(h);
  if (!feedOpen) { feedOpen = true; connect({ onChange: () => drawn.forEach((x) => x.draw()) }); }
  return h;
}

/** The scene panels are kept across rebuilds (their own state: picked run, step cursor, replay). */
const panels = {};
const VIEWS = { infra: SceneInfraView, components: ComponentsView, trace: TraceView };
function panelView(kind) {
  if (panels[kind]) return panels[kind];
  const h = hostV1(VIEWS[kind], { cls: "v1panel", style: `width:${PX}px;height:${PY}px;`,
    wrapStyle: `width:${PX}px; height:${PY}px; border:1px solid var(--line); border-radius:8px;`, title: " " });
  h.obj = new CSS3DObject(h.host); h.kind = kind;
  return (panels[kind] = h);
}

export class PanelLevel extends Level {
  mount(p) {
    super.mount(p);
    const pv = this.pv = panelView(this.def.panel);
    pv.shadow.querySelector(".lvl").textContent = `level ${this.i + 1} · ${this.def.name} · v1 view${this.def.panel === "trace" ? ", run " + (this.def.run || "") : ", live"}`;
    if (this.def.panel === "components" && this.def.service && pv.service !== this.def.service) { pv.service = this.def.service; pv.view.open([this.def.project, this.def.service]); }
    if (this.def.panel === "components" && this.def.run) this.loadRun(pv, this.def.run);
    if (this.def.panel === "trace" && this.def.run && pv.run !== this.def.run) { pv.run = this.def.run; pv.view.open([this.def.run], live); pv.draw(); }
    pv.view.onOpen = (project, service) => this.sc.onPanelOpen?.(project, service);
    // a CSS3DObject faces +z in its group; the group lies on the ground plane, so turn it to face the camera above
    pv.obj.rotation.set(Math.PI, 0, 0); pv.obj.scale.setScalar(1000 / PX); pv.obj.position.set(0, 0, 0);
    this.group.add(pv.obj); this.sc.cssScene.add(this.group);   // the CSS3D renderer draws this group
    pv.draw();
  }
  setAlpha(a) { const h = this.pv.host; h.style.opacity = a; h.style.visibility = a < 0.02 ? "hidden" : "visible"; h.style.pointerEvents = a < 0.5 ? "none" : "auto"; }
  pickable() { return null; }
  dispose() { this.group.remove(this.pv.obj); this.sc.cssScene.remove(this.group); }
  /** Components: replay the scene's run (its saved stamps), on the measured request, stepped by the global cursor. */
  async loadRun(pv, run) {
    if (pv.run !== run) { pv.run = run;
      if (!live.componentStamps[run]?.length) { const r = await fetch(`/api/components?saved=${encodeURIComponent(run)}`); const d = await r.json(); if (d[run]) addStamps(run, d[run]); }
      const v = pv.view; v.runId = run; v.follow = false; v.built = null; v.cursor = -1; v.shown = 0;
      const xr = new Set((live.componentStamps[run] || []).flatMap((s) => s.xrids)); v.request = [...xr].find((x) => x.endsWith("-measured")) ?? [...xr][0] ?? null;
      pv.lastT = null; pv.draw(); }
  }
  cursor(t) { const pv = this.pv; if (!pv || pv.kind !== "components" || t == null || pv.lastT === t || pv.view.playing || pv.view.runId !== pv.run) return; pv.lastT = t;
    const steps = pv.view.stamps(live); if (!steps.length || !pv.root.querySelector(".compview")) return;
    let i = 0; for (let k = 0; k < steps.length; k++) { if (steps[k].t0 <= t) i = k; else break; }
    if (i !== pv.view.cursor) pv.view.go(live, i, false); }
  recolor() {} select() {} flows() {}
}

/** Open a scene panel's v1 view with v1 route params (e.g. trace/<run>/<request>), as a v1 link would. */
export function panelOpen(kind, params) { const h = panelView(kind); if (kind === "trace" && params[0]) h.run = params[0]; h.view.open?.(params, live); h.view.built = null; h.draw(); }

export function makeLevel(def, i, scene) { return def.panel ? new PanelLevel(def, i, scene) : new MeshLevel(def, i, scene); }
