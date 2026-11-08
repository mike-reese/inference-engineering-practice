// Boxes and links in a level's local frame (x right, y down), for the levels that draw things rather than rows
// (L1 Infra, L2 Components, L6 Kernel, L7 Hardware). Each set is one mesh. A box is two quads: a border quad and a
// fill quad inset inside it, so a lit or selected border stays visible at any zoom. Positions and colours are
// rewritten in place per update; flush() uploads only what changed.
import * as THREE from "three";

const material = () => new THREE.MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });

function dynamicMesh(verts, order) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage));
  const m = new THREE.Mesh(geo, material()); m.renderOrder = order; m.frustumCulled = false; return m;
}

/** One palette entry per colour a level uses, built once (THREE.Color converts the sRGB hex to linear). */
export const palette = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, new THREE.Color(v)]));

export class Boxes {
  /** @param {number} n boxes @param {{inset?: number, order?: number}} [o] inset: border width in local units */
  constructor(n, { inset = 1.5, order = 2 } = {}) {
    this.n = n; this.inset = inset; this.rects = new Float32Array(n * 4);
    this.mesh = dynamicMesh(n * 12, order);
    this.pos = this.mesh.geometry.attributes.position; this.col = this.mesh.geometry.attributes.color;
  }

  /** Box k at local (x, y), size w x h; w = 0 hides it. */
  place(k, x, y, w, h) {
    this.rects.set([x, y, w, h], k * 4);
    const i = Math.min(this.inset, w / 3, h / 3), a = this.pos.array, o = k * 36;
    quad(a, o, x, y, x + w, y + h, 0); quad(a, o + 18, x + i, y + i, x + w - i, y + h - i, 0.01);
    this.pos.needsUpdate = true;
  }

  /** Fill and border colours of box k (THREE.Color, from palette()). */
  paint(k, fill, border = fill) {
    const a = this.col.array, o = k * 36;
    for (let v = 0; v < 6; v++) { a[o + v * 3] = border.r; a[o + v * 3 + 1] = border.g; a[o + v * 3 + 2] = border.b; }
    for (let v = 0; v < 6; v++) { a[o + 18 + v * 3] = fill.r; a[o + 18 + v * 3 + 1] = fill.g; a[o + 18 + v * 3 + 2] = fill.b; }
    this.col.needsUpdate = true;
  }

  rect(k) { return this.rects.subarray(k * 4, k * 4 + 4); }

  /** The last-placed (topmost) box containing local (x, y), or -1. */
  hit(x, y) {
    const r = this.rects;
    for (let k = this.n - 1; k >= 0; k--) { const o = k * 4; if (r[o + 2] > 0 && x >= r[o] && x <= r[o] + r[o + 2] && y >= r[o + 1] && y <= r[o + 1] + r[o + 3]) return k; }
    return -1;
  }

  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

/** Thick segments with an optional arrowhead at the end: 6 vertices for the shaft, 3 for the head. */
export class Links {
  constructor(n, { order = 1 } = {}) {
    this.n = n; this.mesh = dynamicMesh(n * 9, order);
    this.pos = this.mesh.geometry.attributes.position; this.col = this.mesh.geometry.attributes.color;
  }

  /** Link k from (x1, y1) to (x2, y2), width w; head: arrowhead length (0 = none). Zero length hides it. */
  set(k, x1, y1, x2, y2, w = 2, head = 0) {
    const a = this.pos.array, o = k * 27, dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy);
    if (L < 1e-6) { a.fill(0, o, o + 27); this.pos.needsUpdate = true; return; }
    const ux = dx / L, uy = dy / L, nx = -uy * w / 2, ny = ux * w / 2, hl = Math.min(head, L * 0.6), ex = x2 - ux * hl, ey = y2 - uy * hl;
    const s = [x1 + nx, y1 + ny, ex + nx, ey + ny, ex - nx, ey - ny, x1 - nx, y1 - ny];
    a.set([s[0], s[1], 0, s[2], s[3], 0, s[4], s[5], 0, s[0], s[1], 0, s[4], s[5], 0, s[6], s[7], 0], o);
    const hw = hl ? Math.max(w * 1.6, hl * 0.55) : 0;
    a.set(hl ? [x2, y2, 0, ex - uy * hw, ey + ux * hw, 0, ex + uy * hw, ey - ux * hw, 0] : [0, 0, 0, 0, 0, 0, 0, 0, 0], o + 18);
    this.pos.needsUpdate = true;
  }

  paint(k, c) {
    const a = this.col.array, o = k * 27;
    for (let v = 0; v < 9; v++) { a[o + v * 3] = c.r; a[o + v * 3 + 1] = c.g; a[o + v * 3 + 2] = c.b; }
    this.col.needsUpdate = true;
  }

  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

/** The point where the segment from the centre of rect a toward (tx, ty) leaves rect a ([x, y, w, h]). */
export function exitPoint([x, y, w, h], tx, ty) {
  const cx = x + w / 2, cy = y + h / 2, dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const s = Math.min(dx ? (w / 2) / Math.abs(dx) : Infinity, dy ? (h / 2) / Math.abs(dy) : Infinity);
  return [cx + dx * Math.min(1, s), cy + dy * Math.min(1, s)];
}

function quad(a, o, x0, y0, x1, y1, z) { a.set([x0, y0, z, x1, y0, z, x1, y1, z, x0, y0, z, x1, y1, z, x0, y1, z], o); }
