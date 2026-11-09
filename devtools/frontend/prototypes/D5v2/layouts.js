// The side-by-side layout: a thin module over the one base (base/*.js). A layout only says where each level sits
// ({ cx, cy, z, s }: world = (cx + s·x, z, cy + s·y), z is height), how visible it is from the camera, and, where needed,
// the plane the orbit target stays on, extra views or links. Data, camera, controls, picking and labels are the base's.
import * as THREE from "three";
import { FOV } from "./base/scene.js";

const clamp = (x) => Math.max(0, Math.min(1, x));
const height = (sc, p, cam = sc.camera) => cam.position.y - p.z;
const wpx = (sc, p, cam = sc.camera, h = sc.H) => 1000 * p.s * (h / 2 / Math.tan(FOV / 2 * Math.PI / 180)) / Math.max(1e-300, height(sc, p, cam));
export const opts = { fade: "fade", sib: "dim", follow: true };

// Side by side: every level is a column on one plane; panning right goes one level deeper; links parent -> child.
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
