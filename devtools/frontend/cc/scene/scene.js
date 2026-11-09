// The 3D scene: one WebGL renderer, a top-down PerspectiveCamera with MapControls, and a CSS2D label pool at a fixed
// screen size. The levels sit side by side as columns on the ground plane (world XZ, Y up). Each level's local frame
// is 1000 x 1000/aspect of the stage, so a snapped level fills the stage. Local (x, y) maps to world
// (cx - 500 + x, 0, y - H/2) with cx = 1080 * index; local y grows down the screen.
// Draws happen on a Control frame (inside Control's animation frame) or on a camera move (own animation frame).
import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { GpuRows } from "./rows_gpu.js";
import { perf } from "../perf.js";

const FOV = 50, PITCH = 1080, LABELS = 480, BUTTONS = 8, CLICK_PX = 4;
const TAN = Math.tan(FOV / 2 * Math.PI / 180);

export class Scene {
  /** @param {HTMLElement} stage @param {import("../store/run.js").RunStore} store @param {import("../control/control.js").Control} control */
  constructor(stage, store, control, levels) {
    this.stage = stage; this.store = store; this.control = control; this.levels = levels; this.f = null; this.pending = false;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setClearColor("#15171b"); stage.append(this.renderer.domElement);
    this.css = new CSS2DRenderer(); this.css.domElement.className = "labels"; stage.append(this.css.domElement);
    this.scene = new THREE.Scene(); this.labelScene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 1, 1e6);
    this.controls = new MapControls(this.camera, this.renderer.domElement);
    Object.assign(this.controls, { zoomToCursor: true, enableDamping: false, zoomSpeed: 1.6, maxPolarAngle: 85 * Math.PI / 180 });
    this.pool = Array.from({ length: LABELS }, () => { const d = document.createElement("div"); d.className = "lab"; const o = new CSS2DObject(d); o.center.set(0, 0.5); o.visible = false; this.labelScene.add(o); return o; });
    // Buttons drawn in a level (e.g. "open in Nsight Compute" on L6): real <button>s over the canvas, so they take clicks.
    // A mouse press does not take focus, so Space (play) never also presses the last clicked button.
    this.buttons = Array.from({ length: BUTTONS }, () => { const b = document.createElement("button"); b.className = "lab-btn"; b.onclick = () => b._on?.(); b.onmousedown = (e) => e.preventDefault(); const o = new CSS2DObject(b); o.center.set(0, 0.5); o.visible = false; this.labelScene.add(o); return o; });
    this.measure();
    this.gpu = new GpuRows(store);
    this.groups = levels.map((L, i) => {
      const g = new THREE.Group(); g.rotation.x = Math.PI / 2; this.scene.add(g);
      L.mount({ group: g, store, gpu: this.gpu, H: this.H, index: i, redraw: () => this.request() }); return g;
    });
    this.place();
    this.controls.addEventListener("change", () => { this.fromCamera(); this.request(); });
    this.controls.addEventListener("end", () => this.control.setPose(this.pose()));
    this.bindPick();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(stage);
    control.subscribe((f) => this.frame(f));
  }

  measure() { this.W = Math.max(1, this.stage.clientWidth); this.Hpx = Math.max(1, this.stage.clientHeight); this.H = 1000 * this.Hpx / this.W; }
  cx(i) { return i * PITCH; }
  place() { this.groups.forEach((g, i) => g.position.set(this.cx(i) - 500, 0, -this.H / 2)); }

  resize() {
    const H = this.H; this.measure();
    this.renderer.setPixelRatio(devicePixelRatio); this.renderer.setSize(this.W, this.Hpx, false); this.css.setSize(this.W, this.Hpx);
    this.camera.aspect = this.W / this.Hpx; this.camera.updateProjectionMatrix();
    if (this.H !== H) { this.levels.forEach((L) => L.resize(this.H)); this.place(); }
    if (this.f) this.snap(this.f.focus);
    this.request();
  }

  /** Put the camera straight above a level at the distance where its frame fills the stage. */
  snap(i) {
    const d = this.H / 2 / TAN, x = this.cx(i);
    this.camera.position.set(x, d, 1e-6 * d); this.controls.target.set(x, 0, 0);
    this.quiet = true; this.controls.update(); this.quiet = false;
  }
  setPose(z) { this.camera.position.set(z[0], z[1], z[2]); this.controls.target.set(z[3], z[4], z[5]); this.quiet = true; this.controls.update(); this.quiet = false; }
  pose() { const p = this.camera.position, t = this.controls.target; return [p.x, p.y, p.z, t.x, t.y, t.z]; }

  /** Focus follows the camera: the column under the orbit target, once the camera is close enough to read one level. */
  fromCamera() {
    if (this.quiet || !this.f) return;
    const t = this.controls.target, d = this.camera.position.distanceTo(t);
    if (d > 2.2 * this.H / 2 / TAN) return;
    const i = Math.max(0, Math.min(this.levels.length - 1, Math.round(t.x / PITCH)));
    if (i !== this.f.focus) this.control.focusFromCamera(i);
  }

  frame(f) {
    const first = !this.f; this.f = f;
    if (first && this.control.pose && !f.changed.snap) this.setPose(this.control.pose);
    else if (f.changed.snap) this.snap(f.focus);
    this.draw();
  }

  request() { if (this.pending) return; this.pending = true; requestAnimationFrame(() => { this.pending = false; this.draw(); }); }

  draw() {
    if (!this.f) return;
    const t0 = performance.now(), cam = this.camera, d = Math.max(1e-6, cam.position.distanceTo(this.controls.target));
    cam.near = d * 1e-3; cam.far = d * 1e3; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    const px = this.Hpx / (2 * TAN * Math.max(1e-6, cam.position.y));   // screen px per local unit on the plane, top-down
    let n = 0;
    const label = (wx, wz, text, cls, maxPx) => {
      if (n >= this.pool.length) return false;
      const o = this.pool[n++], e = o.element; o.position.set(wx, 0, wz); o.visible = true;
      if (e._t !== text) { e.textContent = text; e._t = text; }
      if (e._c !== cls) { e.className = `lab ${cls}`; e._c = cls; }
      e.style.maxWidth = `${Math.max(16, maxPx)}px`; return true;
    };
    let nb = 0;
    const button = (wx, wz, text, onClick, aria) => {
      if (nb >= this.buttons.length) return false;
      const o = this.buttons[nb++], e = o.element; o.position.set(wx, 0, wz); o.visible = true; e._on = onClick;
      if (e._t !== text) { e.textContent = text; e._t = text; }
      if (e.getAttribute("aria-label") !== (aria ?? text)) e.setAttribute("aria-label", aria ?? text);
      return true;
    };
    this.levels.forEach((L, i) => {
      const g = this.groups[i], onScreen = this.visible(i);
      g.visible = onScreen;
      const ox = this.cx(i) - 500, oz = -this.H / 2;
      L.frame(this.f, { px, onScreen, index: i,
        label: (x, y, text, cls = "", maxPx = 400) => onScreen && this.inView(ox + x, oz + y) && label(ox + x, oz + y, text, cls, maxPx),
        button: (x, y, text, onClick, aria) => onScreen && this.inView(ox + x, oz + y) && button(ox + x, oz + y, text, onClick, aria) });
    });
    for (let k = n; k < this.pool.length; k++) this.pool[k].visible = false;
    for (let k = nb; k < this.buttons.length; k++) { this.buttons[k].visible = false; this.buttons[k].element._on = null; }
    this.renderer.render(this.scene, cam);
    this.css.render(this.labelScene, cam);
    perf.sample("draw_cpu", performance.now() - t0);
  }

  /** A level column's frame intersects the view frustum. */
  visible(i) {
    const x0 = this.cx(i) - 500, box = this._box ??= new THREE.Box3(), fr = this._fr ??= new THREE.Frustum(), m = this._m ??= new THREE.Matrix4();
    box.min.set(x0, -1, -this.H / 2); box.max.set(x0 + 1000, 1, this.H / 2);
    fr.setFromProjectionMatrix(m.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    return fr.intersectsBox(box);
  }
  inView(wx, wz) { const v = (this._v ??= new THREE.Vector3()).set(wx, 0, wz).project(this.camera); return v.x > -1.05 && v.x < 1.05 && v.y > -1.05 && v.y < 1.05 && v.z < 1; }

  /** Click (not drag) on the canvas: plane hit -> column -> local (x, y) -> the level's analytic pick. */
  bindPick() {
    const el = this.renderer.domElement, ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3();
    let down = null;
    el.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
    el.addEventListener("pointerup", (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_PX) return (down = null);
      down = null;
      const r = el.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
      if (!ray.ray.intersectPlane(plane, hit)) return;
      const i = Math.round(hit.x / PITCH), L = this.levels[i];
      if (!L) return;
      const x = hit.x - (this.cx(i) - 500), y = hit.z + this.H / 2;
      if (x < 0 || x > 1000 || y < 0 || y > this.H) return;
      perf.input("select", e.timeStamp);
      this.control.select(L.pick({ x, y }, this.f));
    });
  }
}
