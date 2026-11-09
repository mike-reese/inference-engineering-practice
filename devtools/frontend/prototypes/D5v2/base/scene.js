// D3+D4 (frozen C): the scene in three.js itself: PerspectiveCamera, MapControls (pinned addons), Raycaster picking,
// labels as CSS2DObject scene objects (CSS2DRenderer). Frames are drawn on demand: a change requests one frame.
// World: levels are horizontal planes (three's ground plane XZ, Y up). A level's local (x, y) maps to world
// (cx + s·x, z, cy + s·y): placement {cx, cy, z, s} from the layout module. Matrices are built in float64 on the CPU
// (three.js Matrix4 uses JS numbers), so modelView is camera-relative before it reaches float32 on the GPU.
import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { CSS3DRenderer } from "three/addons/renderers/CSS3DRenderer.js";
import { makeLevel } from "./levels.js";

export const LW = 1000, LH = 600, FOV = 50;
const BG = new THREE.Color("#15171b");

/** Distance from which a placed level's 1000 x 600 footprint fills the viewport (with 5% margin). */
export function frameDist(p, aspect) { const t = Math.tan(FOV / 2 * Math.PI / 180); return 1.05 * Math.max(LH * p.s / 2 / t, LW * p.s / 2 / t / aspect); }

export class Scene {
  constructor(stage, layout) {
    this.stage = stage; this.layout = layout; this.levels = []; this.P = []; this.groups = []; this.labelPools = [];
    this.renderer = new THREE.WebGLRenderer({ antialias: !new URLSearchParams(location.search).has("noaa") });
    this.renderer.setClearColor(BG); stage.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    // v1 views as scene objects (PanelLevel): DOM drawn by CSS3DRenderer with the main camera, above the WebGL canvas
    this.css = new CSS3DRenderer(); this.css.domElement.className = "panels"; stage.appendChild(this.css.domElement); this.cssScene = new THREE.Scene(); this.lv = [];
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 1, 1e6);
    this.controls = new MapControls(this.camera, stage);   // on the stage: panels and canvas both pan and zoom
    Object.assign(this.controls, { zoomToCursor: true, enableDamping: false, zoomSpeed: 1.6, minDistance: 0, maxPolarAngle: 85 * Math.PI / 180 });
    this.views = layout.views ? layout.views() : [{ camera: "main", levels: null, rect: (W, H) => ({ x: 0, y: 0, w: W, h: H }) }];
    this.cams = { main: this.camera };
    if (this.views.some((v) => v.camera === "hw")) this.cams.hw = new THREE.PerspectiveCamera(FOV, 1, 1, 1e6);
    this.labelScenes = {}; this.labelRenderers = {};
    for (const v of this.views) { const r = new CSS2DRenderer(); r.domElement.className = "labels"; stage.appendChild(r.domElement);
      this.labelRenderers[v.camera] = r; this.labelScenes[v.camera] = new THREE.Scene(); this.labelPools.push(this.pool(v.camera, 320)); }
    this.ray = new THREE.Raycaster(); this.pending = false; this.onFrame = []; this.anchoring = false;
    this.controls.addEventListener("change", () => { this.anchor(); this.request(); });
    new ResizeObserver(() => this.resize()).observe(stage); this.resize();
  }
  pool(cam, n) { const out = []; for (let i = 0; i < n; i++) { const d = document.createElement("div"); d.className = "lab"; const o = new CSS2DObject(d); o.center.set(0, 0.5); o.visible = false; this.labelScenes[cam].add(o); out.push(o); } out.cam = cam; return out; }
  resize() { const W = this.stage.clientWidth, H = this.stage.clientHeight; this.W = W; this.H = H; this.renderer.setPixelRatio(devicePixelRatio || 1); this.renderer.setSize(W, H, false);
    for (const v of this.views) { const r = v.rect(W, H), lr = this.labelRenderers[v.camera]; lr.setSize(r.w, r.h); Object.assign(lr.domElement.style, { left: r.x + "px", top: r.y + "px" });
      this.cams[v.camera].aspect = r.w / Math.max(1, r.h); this.cams[v.camera].updateProjectionMatrix(); }
    const r0 = this.views[0].rect(W, H); this.css.setSize(r0.w, r0.h); Object.assign(this.css.domElement.style, { left: r0.x + "px", top: r0.y + "px" });
    this.request(); }
  aspect(cam = "main") { const v = this.views.find((x) => x.camera === cam), r = v.rect(this.W, this.H); return r.w / Math.max(1, r.h); }

  /** Replace the content: one Level object per level (levels.js: MeshLevel or PanelLevel), placed by the layout. */
  setLevels(levels) {
    for (const L of this.lv) L.dispose();
    this.levels = levels; this.P = this.layout.place(levels, this);
    this.lv = levels.map((def, i) => { const L = makeLevel(def, i, this); L.group.renderOrder = this.layout.order ? this.layout.order(i) : i; L.mount(this.P[i]);
      L.group.traverse((o) => (o.renderOrder = L.group.renderOrder)); return L; });
    this.groups = this.lv.map((L) => L.group);
    if (this.layout.decorate) this.layout.decorate(this);
    this.request();
  }
  /** Recolour items (siblings dim or hide, lit components, lit SMs) without rebuilding. */
  recolor(i, fn) { this.lv[i]?.recolor(fn); this.request(); }
  cursor(t) { this.cursorT = t; this.lv.forEach((L, i) => L.cursor(t, 2 * this.pxLocal(i))); this.request(); }
  select(i, b) { this.lv.forEach((L) => L.select(null)); if (i != null && b) this.lv[i]?.select(b); this.request(); }
  /** Arrows on the hardware level: [[from item, to item, width in local units, colour]]. */
  flows(i, list) { this.lv[i]?.flows(list); this.request(); }
  /** Local units per CSS pixel at a level, seen from the main camera. */
  pxLocal(i) { const p = this.P[i], d = Math.max(1e-300, this.camera.position.y - p.z), H = this.views[0].rect(this.W, this.H).h; return d * 2 * Math.tan(FOV / 2 * Math.PI / 180) / H / p.s; }
  camState(cam = this.camera) { return { x: cam.position.x, y: cam.position.z, z: cam.position.y }; }

  /** Flat-style layouts keep the orbit target on the plane of the level the layout names, so a wheel passes planes. */
  anchor() { if (this.anchoring || !this.layout.zoomRef || !this.P.length) return; const i = this.layout.zoomRef(this.P, this), y = this.P[i].z, t = this.controls.target;
    if (Math.abs(t.y - y) <= 1e-12 * Math.max(1, Math.abs(y)) || this.camera.position.y <= y) return;
    const dir = t.clone().sub(this.camera.position).normalize(); if (dir.y >= -1e-9) return; const k = (y - this.camera.position.y) / dir.y;
    this.anchoring = true; t.copy(this.camera.position).addScaledVector(dir, k); this.controls.update(); this.anchoring = false; }

  snap(i, cam = "main") { const p = this.P[i]; if (!p) return; if (this.layout.snap && this.layout.snap(i, this) === false) return;
    const d = frameDist(p, this.aspect(cam)), c = this.cams[cam]; c.position.set(p.cx, p.z + d, p.cy + d * 1e-6); c.lookAt(p.cx, p.z, p.cy);
    if (cam === "main") { this.anchoring = true; this.controls.target.set(p.cx, p.z, p.cy); this.controls.update(); this.anchoring = false; } this.request(); }
  setCamera(z) { this.camera.position.set(z[0], z[1], z[2]); this.anchoring = true; this.controls.target.set(z[3], z[4], z[5]); this.controls.update(); this.anchoring = false; this.request(); }
  request() { if (this.pending) return; this.pending = true; requestAnimationFrame(() => { this.pending = false; this.draw(); }); }

  draw() {
    const t = performance.now(), W = this.W, H = this.H, R = this.renderer;
    for (const c of Object.values(this.cams)) { const tgt = c === this.camera ? this.controls.target : null; const d = tgt ? c.position.distanceTo(tgt) : Math.abs(c.position.y - (this.P[6]?.z ?? 0));
      c.near = Math.max(d * 1e-4, 1e-300); c.far = d * 1e7; c.updateProjectionMatrix(); }
    const alpha = this.levels.map((_, i) => this.layout.vis(i, this.P, this));
    this.lv.forEach((L, i) => L.cursor?.(this.cursorT ?? 0, 2 * this.pxLocal(i)));   // the cursor line stays 2 px wide at any zoom
    R.setScissorTest(true);
    this.views.forEach((v, vi) => { const r = v.rect(W, H), cam = this.cams[v.camera];
      R.setViewport(r.x, H - r.y - r.h, r.w, r.h); R.setScissor(r.x, H - r.y - r.h, r.w, r.h); R.clear();
      this.groups.forEach((g, i) => { const a = v.levels && !v.levels.includes(i) ? 0 : (v.camera === "hw" ? 1 : alpha[i]);
        const shown = a > 0.01 && (v.camera === "hw" || cam.position.y > this.P[i].z); g.visible = shown;
        // panels sit above the canvas: where levels overlap (flat, nested, split), a panel the camera has gone past fades out
        const over = this.layout.overlaps && this.layout.focus && this.layout.focus(this.P, this) > i ? 0.08 : 1;
        if (vi === 0 || !this.lv[i].pv) this.lv[i].setAlpha(shown ? a * over : 0); });
      R.render(this.scene, cam);
      if (vi === 0) this.css.render(this.cssScene, cam);
      this.labels(this.labelPools[vi], cam, r, v, alpha); this.labelRenderers[v.camera].render(this.labelScenes[v.camera], cam); });
    R.setScissorTest(false);
    const t2 = performance.now(); for (const f of this.onFrame) f(t, t2);
  }
  /** Pooled CSS2D labels on the items that are large enough on screen, deepest levels last. */
  labels(pool, cam, r, v, alpha) {
    let n = 0; const A = new THREE.Vector3(), B = new THREE.Vector3(), pos = new THREE.Vector3();
    const order = this.levels.map((_, i) => i).sort((a, b) => this.groups[a].renderOrder - this.groups[b].renderOrder);
    for (const i of order) { const g = this.groups[i], a = v.camera === "hw" ? 1 : alpha[i]; if (!g.visible || a < 0.25 || (v.levels && !v.levels.includes(i))) continue;
      g.updateMatrixWorld(); const M = g.matrixWorld;
      for (const b of this.levels[i].items) { if (!b.lab || n >= pool.length) continue;
        A.set(b.x0, b.y0, 0).applyMatrix4(M).project(cam); B.set(b.x1, b.y1, 0).applyMatrix4(M).project(cam);
        if (A.z > 1 || B.z > 1 || A.z < -1) continue;
        const X0 = (A.x + 1) / 2 * r.w, X1 = (B.x + 1) / 2 * r.w, Y0 = (1 - A.y) / 2 * r.h, Y1 = (1 - B.y) / 2 * r.h, w = Math.abs(X1 - X0), h = Math.abs(Y1 - Y0);
        if (w < 30 || h < 9 || Math.max(X0, X1) < 0 || Math.min(X0, X1) > r.w || Math.max(Y0, Y1) < 0 || Math.min(Y0, Y1) > r.h) continue;
        const fs = Math.max(9, Math.min(14, b.header ? h * 0.12 : h * 0.45)), left = Math.max(Math.min(X0, X1), 0), vis = Math.min(Math.max(X0, X1), r.w) - left; if (vis < 24) continue;
        const o = pool[n++], lx = b.x0 + (left - Math.min(X0, X1)) / w * (b.x1 - b.x0);
        pos.set(lx, b.header ? b.y0 + (b.y1 - b.y0) * Math.min(0.5, (fs * 0.9) / h) : (b.y0 + b.y1) / 2, 0).applyMatrix4(M); o.position.copy(pos);
        const e = o.element; if (e._t !== b.lab) { e.textContent = b.lab; e._t = b.lab; }
        e.style.maxWidth = (vis - 4) + "px"; e.style.fontSize = fs + "px"; e.style.opacity = Math.min(1, a + 0.2); e.classList.toggle("hd", !!b.header); o.visible = true; } }
    for (let k = n; k < pool.length; k++) pool[k].visible = false;
  }
  /** Raycaster pick: the deepest visible level whose box is under the pointer (lanes and frames are skipped). */
  pick(clientX, clientY) {
    const rr = this.renderer.domElement.getBoundingClientRect(), X = clientX - rr.left, Y = clientY - rr.top;
    const v = this.views.find((w) => { const r = w.rect(this.W, this.H); return X >= r.x && X < r.x + r.w && Y >= r.y && Y < r.y + r.h; }) || this.views[0];
    const r = v.rect(this.W, this.H), cam = this.cams[v.camera];
    this.ray.setFromCamera(new THREE.Vector2((X - r.x) / r.w * 2 - 1, -((Y - r.y) / r.h) * 2 + 1), cam);
    const alpha = this.levels.map((_, i) => this.layout.vis(i, this.P, this));
    for (let i = this.levels.length - 1; i >= 0; i--) { if (v.levels && !v.levels.includes(i)) continue; if (v.camera !== "hw" && (alpha[i] < 0.3 || cam.position.y <= this.P[i].z)) continue;
      const mesh = this.lv[i].pickable(); if (!mesh) continue;
      const hits = this.ray.intersectObject(mesh, false).filter((h) => { const b = this.levels[i].items[h.instanceId]; return b && !b.lane && !(b.header && b.x1 - b.x0 > 900); });
      if (hits.length) { const h = hits.reduce((m, x) => (x.instanceId > m.instanceId ? x : m)), b = this.levels[i].items[h.instanceId], loc = this.groups[i].worldToLocal(h.point.clone()); return { L: i, b, lx: loc.x }; } }
    return null;
  }
}
