// One GPU copy of every resident row, shared by every lanes level: per block one InstancedBufferGeometry over the
// store's instance arrays (uploaded once; each level's Mesh reuses the same attribute buffers). The vertex shader maps
// start/end with float32 hi/lo pairs against the window uniforms, so zoom and pan change uniforms only.
import * as THREE from "three";

const QUAD = new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3);
const MAX_KINDS = 64;

const VERT = /* glsl */ `
attribute vec4 aT;   // startHi, startLo, endHi, endLo (ns from t0)
attribute vec4 aA;   // lane, kind, tier, depth
attribute vec2 aB;   // id, name
uniform vec2 uWin;   // window start hi, lo
uniform float uW;    // window width, ns
uniform float uX0;   // local x of the window start (left of it: the lane-name gutter)
uniform float uXW;   // local width of the time area
uniform float uMinW; // 1 px in local units
uniform float uSel;
uniform float uTiers[7];
uniform vec3 uKind[${MAX_KINDS}];
uniform sampler2D uLanes;   // per lane: y0, sub-row height, last sub-row, visible
uniform float uNLanes;
varying vec3 vColor;
varying float vSel;
void main() {
  float x0 = uX0 + ((aT.x - uWin.x) + (aT.y - uWin.y)) / uW * uXW;
  float x1 = uX0 + ((aT.z - uWin.x) + (aT.w - uWin.y)) / uW * uXW;
  vec4 lane = texture2D(uLanes, vec2((aA.x + 0.5) / uNLanes, 0.5));
  if (uTiers[int(aA.z + 0.5)] < 0.5 || lane.w < 0.5 || x1 < uX0 || x0 > uX0 + uXW) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  x0 = max(x0, uX0); x1 = min(x1, uX0 + uXW);
  if (x1 - x0 < uMinW) x1 = x0 + uMinW;
  float y0 = lane.x + min(aA.w, lane.z) * lane.y;
  vec3 p = vec3(mix(x0, x1, position.x), mix(y0 + 0.07 * lane.y, y0 + 0.93 * lane.y, position.y), 0.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  vColor = uKind[int(aA.y + 0.5)];
  vSel = abs(aB.x - uSel) < 0.5 ? 1.0 : 0.0;
}`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vSel;
void main() { gl_FragColor = vec4(vSel > 0.5 ? vec3(1.0) : vColor, 1.0); }`;

/** @typedef {{material: THREE.ShaderMaterial, group: THREE.Group}} RowsView  one level's rows: one Mesh per block in group */

export class GpuRows {
  /** @param {import("../store/run.js").RunStore} store */
  constructor(store) {
    /** @type {THREE.InstancedBufferGeometry[]} */
    this.geoms = []; /** @type {RowsView[]} */ this.views = []; this.geoOf = new Map();
    // the store calls this now for every resident block and again in flush() for each block a live run appends, and
    // with `changed` for the blocks whose tier and depth a seal set (their attributes upload again)
    store.subscribe(({ added, changed = [] }) => {
      for (const g of added) { const geo = geometry(g); this.geoms.push(geo); this.geoOf.set(g, geo); for (const v of this.views) v.group.add(mesh(geo, v.material)); }
      for (const g of changed) this.geoOf.get(g).attributes.aA.needsUpdate = true;
    });
    if (store.kinds.length > MAX_KINDS) throw new Error(`rows_gpu: ${store.kinds.length} kinds, the shader holds ${MAX_KINDS}`);
    this.kindColors = Array.from({ length: MAX_KINDS }, (_, k) => new THREE.Color(store.kinds[k]?.color ?? "#888888"));
  }

  /**
   * One level's rows: a material (its lane layout texture, its tier range, window uniforms it sets per frame) and a
   * Group with one Mesh per block over the shared geometry, so the GPU buffers are uploaded once whatever the number of
   * levels. A block appended later gets its Mesh in every view's group. @returns {RowsView}
   */
  view(laneTex, nLanes, tiers, x0, xw) {
    const material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      uniforms: {
        uWin: { value: new THREE.Vector2() }, uW: { value: 1 }, uMinW: { value: 1 }, uSel: { value: -1 },
        uTiers: { value: Array.from({ length: 7 }, (_, r) => (r >= tiers[0] && r <= tiers[1] ? 1 : 0)) },
        uKind: { value: this.kindColors }, uLanes: { value: laneTex }, uNLanes: { value: nLanes }, uX0: { value: x0 }, uXW: { value: xw },
      },
    });
    const v = { material, group: new THREE.Group() };   // renderOrder 0, so its meshes sort by their own order among the level's objects
    for (const geo of this.geoms) v.group.add(mesh(geo, material));
    this.views.push(v);
    return v;
  }
}

const ROWS_ORDER = 3;
function mesh(geo, material) { const m = new THREE.Mesh(geo, material); m.frustumCulled = false; m.renderOrder = ROWS_ORDER; return m; }

/** Window uniforms: the start as an exact float32 hi/lo pair, the width as float32 (relative precision is enough). */
export function setWindow(material, [a, b], minW, sel) {
  const u = material.uniforms, hi = Math.fround(a);
  u.uWin.value.set(hi, a - hi); u.uW.value = b - a; u.uMinW.value = minW; u.uSel.value = sel;
}

function geometry(g) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.setAttribute("position", QUAD);
  geo.setAttribute("aT", new THREE.InstancedBufferAttribute(g.time, 4));
  geo.setAttribute("aA", new THREE.InstancedBufferAttribute(g.attr, 4));
  geo.setAttribute("aB", new THREE.InstancedBufferAttribute(g.ident, 2));
  geo.instanceCount = g.n;
  return geo;
}
