// The four layouts: thin modules over the one base (base/*.js). A layout only says where each level sits
// ({ cx, cy, z, s }: world = (cx + s·x, z, cy + s·y), z is height), how visible it is from the camera, and, where needed,
// the plane the orbit target stays on, extra views or links. Data, camera, controls, picking and labels are the base's.
import * as THREE from "three";
import { frameDist, FOV } from "./base/scene.js";

const clamp = (x) => Math.max(0, Math.min(1, x));
const height = (sc, p, cam = sc.camera) => cam.position.y - p.z;
const wpx = (sc, p, cam = sc.camera, h = sc.H) => 1000 * p.s * (h / 2 / Math.tan(FOV / 2 * Math.PI / 180)) / Math.max(1e-300, height(sc, p, cam));
const openAt = (P, L, i) => { const b = L[i].open, p = P[i]; return b ? { b, x: p.cx + (b.x0 + b.x1) / 2 * p.s, y: p.cy + (b.y0 + b.y1) / 2 * p.s } : { b: null, x: p.cx, y: p.cy }; };
export const opts = { fade: "fade", sib: "dim", follow: true };

// 1. Flat layers, zoom down through them: each level is a plane under its parent's open item; the camera descends.
export const flat = {
  place(L, sc) { const P = [{ cx: 0, cy: 0, z: 0, s: 10 }], a = sc.aspect();
    for (let i = 1; i < L.length; i++) { const o = openAt(P, L, i - 1), p = { cx: o.x, cy: o.y, s: P[i - 1].s / 5, z: 0 }; p.z = P[i - 1].z - 1.3 * frameDist(p, a); P.push(p); } return P; },
  vis(i, P, sc) { const p = P[i], dd = height(sc, p), fd = frameDist(p, sc.aspect()); if (dd <= 0) return 0;
    const appear = i === 0 ? 1 : clamp((8 * fd - dd) / (3 * fd)), m = opts.fade;
    const pass = m === "cut" ? (dd > 0.5 * fd ? 1 : 0) : m === "outline" ? (dd > 0.6 * fd ? 1 : 0.1) : clamp(dd / (0.6 * fd)); return appear * pass; },
  order: (i) => 10 - i,
  zoomRef(P, sc) { let r = 0, best = 1e9; P.forEach((p, i) => { const dd = height(sc, p); if (dd <= 0) return; const e = Math.abs(Math.log(dd / frameDist(p, sc.aspect()))); if (e < best) { best = e; r = i; } }); return r; },
  focus(P, sc) { return flat.zoomRef(P, sc); },
};

// 2. Side by side: every level is a column on one plane; panning right goes one level deeper; links parent -> child.
export const side = {
  place(L) { return L.map((_, i) => ({ cx: i * 11500, cy: 0, z: 0, s: 10 })); },
  vis(i, P, sc) { return clamp((wpx(sc, P[i]) - 20) / 60); },
  focus(P, sc) { let r = 0, best = 1e18; P.forEach((p, i) => { const d = Math.abs(p.cx - sc.controls.target.x); if (d < best) { best = d; r = i; } }); return r; },
  decorate(sc) { const pts = [];
    for (let i = 0; i + 1 < sc.levels.length; i++) { const b = sc.levels[i].open, p = sc.P[i], q = sc.P[i + 1]; if (!b) continue;
      pts.push(p.cx + b.x1 * p.s, 0, p.cy + (b.y0 + b.y1) / 2 * p.s, q.cx - 500 * q.s, 0, q.cy); }
    const g = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(pts, 3)),
      new THREE.LineBasicMaterial({ color: "#ffd36b", depthTest: false, transparent: true, opacity: 0.8 }));
    (sc._side ??= []).forEach((o) => { sc.scene.remove(o); o.geometry.dispose(); });
    g.renderOrder = 99; g.frustumCulled = false; sc.scene.add(g); sc._side = [g]; },
};

// 3. Nested containment ("powers of ten"): each level is drawn inside its parent's open item, scaled to fit it.
export const nested = {
  place(L, sc, last = L.length) { const P = [{ cx: 0, cy: 0, z: 0, s: 10 }];
    for (let i = 1; i < last; i++) { const o = openAt(P, L, i - 1), b = o.b, s = b ? P[i - 1].s * Math.min((b.x1 - b.x0) / 1000, (b.y1 - b.y0) / 600) * 0.92 : P[i - 1].s * 1e-4;
      P.push({ cx: o.x, cy: o.y, z: 0, s }); } return P; },
  vis(i, P, sc) { return i === 0 ? 1 : clamp((wpx(sc, P[i]) - 40) / 80); },
  focus(P, sc) { let r = 0; P.forEach((p, i) => { if (wpx(sc, p) >= sc.W * 0.35) r = i; }); return r; },
};

// 4. Split: logical levels nested (as 3) on the left; the hardware level always visible on the right, its own camera.
const L60 = (W) => Math.round(W * 0.6);
export const split = {
  views: () => [{ camera: "main", levels: [0, 1, 2, 3, 4, 5], rect: (W, H) => ({ x: 0, y: 0, w: L60(W), h: H }) },
                { camera: "hw", levels: [6], rect: (W, H) => ({ x: L60(W) + 2, y: 0, w: W - L60(W) - 2, h: H }) }],
  place(L, sc) { const P = nested.place(L, sc, L.length - 1); P.push({ cx: 0, cy: 0, z: 0, s: 1 }); return P; },
  vis(i, P, sc) { return i === 6 ? 1 : nested.vis(i, P, sc); },
  focus(P, sc) { let r = 0; P.slice(0, 6).forEach((p, i) => { if (wpx(sc, p) >= sc.W * 0.6 * 0.35) r = i; }); return r; },
  decorate(sc) { const p = sc.P[6], d = frameDist(p, sc.aspect("hw")); sc.cams.hw.position.set(p.cx, p.z + d, p.cy + d * 1e-6); sc.cams.hw.lookAt(p.cx, p.z, p.cy); },
  snap(i, sc) { if (i === 6) { sc.stage.animate([{ outline: "3px solid #ffd36b" }, { outline: "0" }], 600); return false; } },
};
