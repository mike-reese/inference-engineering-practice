import * as THREE from "three";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { state, subscribe, now, stops, tierName, seek, mountChrome, data, DIMS } from "../model.js";

const { LADDERS, ALIGN, EXEC, ARCH, HW, END, byId } = data;
const DIMCOL = { execution: "#7cc4ff", hardware: "#ffb15c", architecture: "#b892ff" };
const PROC_COL = { "p.client": "#4f8fe0", "p.bridge": "#7d8797", "p.http": "#2bb3a3", "p.worker": "#9a6cf0" };
const KIND_COL = { gemm: "#f08a3c", attn: "#e05aa8", mem: "#4fbf6a" };
const W = 170, H = 110;

const ancestor = (id, tier) => { let x = byId.get(id); while (x && x.tier > tier) x = byId.get(x.parent); return x; };
const procOf = (comp) => ancestor(comp, 3)?.id;
const activeAt = (tier, t) => EXEC.find((u) => u.tier === tier && u.t0 <= t && u.t1 > t);
const shownTier = (dim) => {
  if (dim === state.dim) return state.tier;
  const row = ALIGN.find((r) => r[state.dim] === tierName()) ?? ALIGN[state.tier];
  return LADDERS[dim].indexOf(row[dim]);
};
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const fmtT = (us) => `${(us / 1000).toFixed(3)} ms`;

// ---------------- scene
const host = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setClearColor(0x070a10);
host.append(renderer.domElement);
const css = new CSS2DRenderer({ element: document.getElementById("labels") });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, 1, 5000);
const grid = new THREE.GridHelper(1400, 70, 0x1a2230, 0x121925); grid.position.y = -80; scene.add(grid);

function resize() {
  const r = host.getBoundingClientRect();
  renderer.setSize(r.width, r.height); css.setSize(r.width, r.height);
  camera.aspect = r.width / r.height; camera.updateProjectionMatrix();
}
addEventListener("resize", resize);

// Three stages on a carousel. The focused one stands front and center; the other two wait in side slots, turned toward
// the viewer. Swinging (E/H/A) turns the carousel, so a stage travels around the back to its new slot.
const CAM = new THREE.Vector3(0, 46, 330);
const ringPos = (th, out) => out.set(300 * Math.sin(th), 0, -107 * (1 - Math.cos(th)));
const stages = {};
for (const dim of DIMS) {
  const root = new THREE.Group();
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(W + 16, H + 26), new THREE.MeshBasicMaterial({ color: 0x0c121c, transparent: true, opacity: 0.92 }));
  plate.position.set(0, 4, -1); root.add(plate);
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(W + 16, H + 26)), new THREE.LineBasicMaterial({ color: DIMCOL[dim] }));
  edge.position.copy(plate.position); root.add(edge);
  const titleEl = document.createElement("div"); titleEl.className = "lbl title"; titleEl.style.color = DIMCOL[dim];
  const title = new CSS2DObject(titleEl); title.position.set(0, H / 2 + 12, 0); root.add(title);
  scene.add(root);
  stages[dim] = { dim, root, edge, titleEl, content: null, key: null, items: new Map(), anchor: null, scale: 1 };
}

// ---------------- building blocks
function box(g, items, id, x, y, w, h, color, { z = 0, depth = 2, label, cls = "lbl", lit = true, lpos } = {}) {
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 });
  const m = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.2, w), Math.max(0.2, h), depth), mat);
  m.position.set(x + w / 2, y + h / 2, z + depth / 2); g.add(m);
  const ol = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color: 0xffd84a, transparent: true, opacity: 0 }));
  m.add(ol);
  let el = null;
  if (label) { el = document.createElement("div"); el.className = cls; el.textContent = label; const o = new CSS2DObject(el); o.position.set(...(lpos ?? [0, 0, depth])); m.add(o); }
  if (id) items.set(id, { m, ol, base: new THREE.Color(color), el, lit });
  return m;
}
function text(g, str, x, y, cls = "lbl soft") {
  const el = document.createElement("div"); el.className = cls; el.textContent = str;
  const o = new CSS2DObject(el); o.position.set(x, y, 2); g.add(o); return el;
}
function line(g, pts, color, opacity = 1) {
  const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(...p))), new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
  g.add(l); return l;
}

// ---------------- execution: nested time bands, a window around the cursor
const WIN_TIER = [0, 0, 1, 1, 2, 3];
function execKey(tier, t) {
  let w = null;
  for (let k = WIN_TIER[tier]; k >= 0 && !w; k--) w = activeAt(k, t);
  w = w ?? EXEC[0];
  return { key: `${tier}|${w.id}`, win: w };
}
function buildExec(g, items, tier, focused, t) {
  const { win } = execKey(tier, t);
  const rows = []; for (let r = win.tier; r <= tier; r++) rows.push(r);
  const x0 = -W / 2, span = win.t1 - win.t0;
  const X = (tt) => x0 + ((tt - win.t0) / span) * W;
  const rowH = Math.min(26, (H - 20) / rows.length);
  rows.forEach((r, i) => {
    const y = H / 2 - 14 - (i + 1) * rowH;
    text(g, LADDERS.execution[r], x0 - 4, y + rowH / 2, "lbl soft").style.transform = "translateX(-60%)";
    const us = r === win.tier ? [win] : EXEC.filter((u) => u.tier === r && u.t1 > win.t0 && u.t0 < win.t1);
    if (!us.length) text(g, `no ${LADDERS.execution[r]} inside this ${LADDERS.execution[win.tier]} (CPU-side work)`, 0, y + rowH / 2, "lbl soft");
    for (const u of us) {
      const a = Math.max(u.t0, win.t0), b = Math.min(u.t1, win.t1);
      const col = u.gpu ? KIND_COL[u.gpu.kind] : PROC_COL[procOf(u.comp)] ?? "#5577aa";
      const wpx = X(b) - X(a);
      const deep = r === tier;
      const label = (deep && focused && wpx > 16) || (r === win.tier) ? short(u.name, Math.max(14, Math.floor(wpx / 1.6))) : null;
      box(g, items, u.id, X(a) + 0.15, y + 1, Math.max(0.3, wpx - 0.3), rowH - 3, col, { depth: deep ? 4 : 1.5, label, cls: deep ? "lbl big" : "lbl" });
    }
  });
  const cur = line(g, [[0, -H / 2, 6], [0, H / 2 - 12, 6]], 0xffd84a);
  g.userData.cursor = (tt) => { const inside = tt >= win.t0 && tt <= win.t1; cur.visible = inside; cur.position.x = X(tt); };
  text(g, `${fmtT(win.t0)}`, x0, -H / 2 - 4, "lbl soft");
  text(g, `${fmtT(win.t1)}`, W / 2, -H / 2 - 4, "lbl soft");
  text(g, `window: ${short(win.name, 50)}`, 0, -H / 2 - 4, "lbl soft");
}

// ---------------- hardware: system gauges, the board, GPU units, one kernel's traffic, one SM
function smGrid(g, items, x, y, size, label = true) {
  const c = size / 6;
  for (let i = 0; i < 36; i++) box(g, items, `sm${i}`, x + (i % 6) * c, y + size - (Math.floor(i / 6) + 1) * c, c * 0.85, c * 0.85, "#3a3020", { depth: 2 });
  if (label) text(g, "36 SMs", x + size / 2, y + size + 4, "lbl");
}
function buildHw(g, items, tier, focused, nw) {
  const lab = (s) => (focused || tier <= 2 ? s : null);
  if (tier === 0) {
    text(g, "system: 1 node, 1 GPU (state at the cursor's 100 µs sample)", 0, H / 2 - 10, "lbl");
    const gauges = [["gpuUtil", "GPU busy"], ["smActive", "SMs active"], ["dram", "DRAM bandwidth"], ["pcie", "PCIe"], ["cpu", "CPU"], ["vramGiB", "VRAM used"]];
    gauges.forEach(([k, name], i) => {
      const y = H / 2 - 30 - i * 15;
      box(g, items, null, -30, y, 90, 9, "#1c2433", { depth: 1 });
      const bar = box(g, items, `g.${k}`, -30, y, 90, 9, "#ffb15c", { depth: 2 });
      bar.geometry.translate(-45, 0, 0); bar.position.x -= 45;
      const el = text(g, name, -36, y + 4.5, "lbl"); el.style.transform = "translate(-100%,-50%)";
      bar.userData.gauge = k; bar.userData.el = text(g, "", 66, y + 4.5, "lbl big");
    });
    g.userData.gauges = true;
  } else if (tier <= 2) {
    box(g, items, "board", -W / 2, -H / 2, W, H - 6, "#121a26", { depth: 1, label: tier === 1 ? "node: MSI MPG Z390M board" : null, lpos: [0, H / 2 - 10, 1] });
    box(g, items, "cpu", -75, 5, 40, 26, "#3a4a66", { label: "CPU i9-9900K" });
    box(g, items, "ram", -75, -35, 30, 16, "#3a4a66", { label: "RAM 62 GiB" });
    box(g, items, "nvme", -40, -47, 28, 12, "#3a4a66", { label: lab("NVMe SN7100") });
    box(g, items, "nic", -25, 30, 28, 12, "#3a4a66", { label: lab("NIC veth / eth0") });
    box(g, items, "gpu", 20, -25, 60, 62, "#4a3a22", { label: "GPU RTX 5060 Ti", lpos: [0, 24, 2] });
    box(g, items, "vram", 26, -20, 48, 14, "#5a4628", { z: 2, label: lab("VRAM 16 GiB") });
    box(g, items, "pcie", -35, 16, 55, 3, "#334055", { label: tier === 2 ? "PCIe gen 3 x8" : null, lpos: [0, 5, 2] });
    box(g, items, "dmi", -27.5, -35, 3, 40, "#334055", { label: tier === 2 ? "DMI" : null });
    line(g, [[-58, 5, 1], [-58, -19, 1]], 0x55657d);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(3.2), new THREE.MeshBasicMaterial({ color: 0xffd84a, transparent: true }));
    dot.visible = false; g.add(dot); g.userData.dot = dot;
    if (tier === 2) g.userData.xferEl = text(g, "", 0, H / 2 - 4, "lbl big");
  } else if (tier === 3) {
    box(g, items, "cpu", -84, -10, 30, 50, "#2a3448", { depth: 1, label: "CPU", lpos: [0, 28, 1] });
    for (let i = 0; i < 8; i++) box(g, items, `core${i}`, -81 + (i % 2) * 13, 26 - Math.floor(i / 2) * 10, 11, 8, "#3a4a66", { z: 1 });
    box(g, items, "l3", -81, -6, 24, 6, "#334055", { z: 1, label: focused ? "L3 (missing)" : null });
    box(g, items, "gpu", -45, -50, 130, 100, "#1a1610", { depth: 1, label: "GPU RTX 5060 Ti", lpos: [0, 54, 1] });
    smGrid(g, items, -38, -10, 52);
    box(g, items, "l2", 22, -8, 14, 48, "#5a4628", { label: "L2 32 MiB" });
    for (let i = 0; i < 4; i++) box(g, items, `mc${i}`, 44, 30 - i * 12, 14, 9, "#5a4628", { label: i === 0 && focused ? "memory ctrl ×4" : null, lpos: [16, 0, 2] });
    box(g, items, "vram", -38, -44, 110, 14, "#5a4628", { label: "VRAM GDDR7 16 GiB" });
    box(g, items, "ce0", 44, -22, 14, 7, "#334055", { label: focused ? "copy engines" : null, lpos: [16, 0, 2] });
    box(g, items, "ce1", 44, -26 - 4, 14, 7, "#334055");
  } else {
    const k = nw.kernel ?? EXEC.find((u) => u.tier === 5 && u.t0 > state.t) ?? EXEC.filter((u) => u.tier === 5).at(-1);
    const exact = nw.kernel === k;
    if (tier === 4) {
      smGrid(g, items, -78, -38, 72, false);
      for (let i = 0; i < 36; i++) if (i < k.gpu.sms) items.get(`sm${i}`).base.set(KIND_COL[k.gpu.kind]).multiplyScalar(0.55);
      box(g, items, "l2", 12, -38, 14, 72, "#5a4628", { label: "L2", lpos: [0, 40, 2] });
      box(g, items, "vram", 50, -38, 30, 72, "#5a4628", { label: "VRAM", lpos: [0, 40, 2] });
      line(g, [[50, 0, 5], [26, 0, 5]], 0xffd84a); line(g, [[12, 0, 5], [-6, 0, 5]], 0xffd84a);
      text(g, `DRAM ${k.gpu.dramMB} MB`, 38, 8, "lbl big"); text(g, `L2 ${k.gpu.l2MB} MB`, 3, -8, "lbl big");
      text(g, `${short(k.name, 34)} · grid ${k.gpu.grid} blocks on ${k.gpu.sms} of 36 SMs · occupancy ${Math.round(k.gpu.occ * 100)}%`, 0, H / 2 - 6, "lbl big");
      text(g, exact ? (k.gpu.profiled ? "profiled kernel (ncu)" : "not profiled: bytes are scratch estimates") : "no kernel at the cursor; showing the next one", 0, -H / 2 - 4, "lbl soft");
    } else {
      box(g, items, "sm0", -60, -40, 120, 80, "#3a3020", { depth: 2, label: "one SM", lpos: [0, 44, 2] });
      for (let i = 0; i < 4; i++) box(g, items, null, -52 + i * 28, 0, 24, 30, "#4a3a22", { z: 2, label: `warp sched ${i}` });
      box(g, items, null, -52, -32, 104, 22, "#334055", { z: 2, label: "shared memory / L1 · registers" });
      text(g, `${short(k.name, 30)}: open in Nsight Compute (link only)`, 0, H / 2 - 4, "lbl big");
    }
  }
  if (tier >= 1) {
    g.userData.sampleEl = text(g, "", 0, -H / 2 - 12, "lbl");
  }
}

// ---------------- architecture: containers > processes > components > software layers
function buildArch(g, items, tier, focused) {
  if (tier === 5) {
    box(g, items, "c.server", -W / 2, -H / 2, W, H - 4, "#16121f", { depth: 1, label: "server container › executor worker › model forward", lpos: [0, H / 2 - 8, 1] });
    const L = [["sw.toolkit", "toolkit: TRT-LLM Python, PyTorch ops", "#3d2f5c"], ["sw.runtime", "runtime: CUDA runtime + driver (cudaLaunchKernelExC)", "#4a3a70"], ["sw.device", "device code: the kernel on the GPU", "#5d4790"]];
    L.forEach(([id, name], i) => box(g, items, id, -70, 22 - i * 30, 140, 20, L[i][2], { label: name, cls: "lbl big" }));
    line(g, [[0, 22, 4], [0, 12, 4]], 0xb892ff); line(g, [[0, -8, 4], [0, -18, 4]], 0xb892ff);
    g.userData.kernelEl = text(g, "", 0, -H / 2 + 6, "lbl big");
    return;
  }
  const rootId = tier === 0 ? "fleet" : "host";
  const kids = (id) => ARCH.filter((a) => a.parent === id);
  const leaves = (id) => { const k = kids(id).filter((c) => c.tier <= Math.max(tier, 2)); return k.length ? k.reduce((s, c) => s + leaves(c.id), 0) : 1; };
  const lay = (a, x, y, w, h) => {
    const col = a.tier >= 3 ? PROC_COL[a.tier === 3 ? a.id : a.parent] : a.tier === 2 ? "#221c33" : "#141020";
    const isLeaf = a.tier === Math.max(tier, 2) || !kids(a.id).length;
    const showLabel = a.tier <= 2 || a.tier === tier || focused;
    box(g, items, a.id, x, y, w, h, col, { depth: 1 + a.tier, z: a.tier * 0.6, label: showLabel ? short(a.name, Math.floor(w / 1.3)) : null, cls: a.tier === tier ? "lbl big" : "lbl", lpos: isLeaf ? [0, 0, 2 + a.tier] : [0, h / 2 - 5, 2 + a.tier] });
    if (isLeaf) return;
    const ch = kids(a.id); const pad = 3, top = 10;
    if (a.tier === 3) {
      const hh = (h - top - pad) / ch.length;
      ch.forEach((c, i) => lay(c, x + pad, y + h - top - (i + 1) * hh, w - 2 * pad, hh - 1));
    } else {
      const total = ch.reduce((s, c) => s + leaves(c.id), 0);
      let cx = x + pad;
      for (const c of ch) { const cw = ((w - pad * (ch.length + 1)) * leaves(c.id)) / total; lay(c, cx, y + pad, cw, h - top - pad); cx += cw + pad; }
    }
  };
  lay(byId.get(rootId), -W / 2, -H / 2, W, H - 4);
}

// ---------------- stage lifecycle: rebuild on key change with a zoom-like transition, highlight on every cursor move
function stageKey(dim, tier, nw) {
  if (dim === "execution") return execKey(tier, state.t).key;
  if (dim === "hardware" && tier >= 4) return `${tier}|${(nw.kernel ?? EXEC.find((u) => u.tier === 5 && u.t0 > state.t))?.id}`;
  return `${tier}`;
}
const fades = [];
function setOpacity(g, o) {
  g.traverse((x) => {
    if (x.material) x.material.opacity = (x.userData.baseOpacity ??= x.material.opacity) * o;
    if (x.isCSS2DObject) x.element.style.opacity = o;
  });
}
function rebuild(S, tier, focused, nw, key) {
  const old = S.content;
  const prevTier = S.tier;
  const g = new THREE.Group(); const items = new Map();
  if (S.dim === "execution") buildExec(g, items, tier, focused, state.t);
  else if (S.dim === "hardware") buildHw(g, items, tier, focused, nw);
  else buildArch(g, items, tier, focused);
  S.root.add(g); S.content = g; S.items = items; S.key = key; S.tier = tier; S.focused = focused;
  const dir = prevTier == null ? 0 : Math.sign(tier - prevTier);
  if (dir !== 0) {
    fades.push({ g, t0: performance.now(), from: dir > 0 ? 0.55 : 1.6, o0: 0, o1: 1 });
  }
  if (old) {
    if (dir !== 0) fades.push({ g: old, t0: performance.now(), from: 1, to: dir > 0 ? 1.8 : 0.5, o0: 1, o1: 0, kill: true });
    else dispose(old);
  }
}
function dispose(g) { g.traverse((x) => { if (x.isCSS2DObject) x.element.remove(); x.geometry?.dispose(); x.material?.dispose(); }); g.removeFromParent(); }

function highlight(S, nw) {
  const lit = new Set();
  if (S.dim === "execution") { nw.exec.forEach((u) => u && u.t0 <= state.t && u.t1 > state.t && lit.add(u.id)); }
  else if (S.dim === "hardware") { nw.hwActive.forEach((id) => lit.add(id)); if (S.tier >= 4 && nw.kernel) for (let i = 0; i < nw.kernel.gpu.sms; i++) lit.add(`sm${i}`); }
  else nw.archPath.forEach((id) => lit.add(id));
  let anchor = null;
  for (const [id, it] of S.items) {
    const on = lit.has(id);
    it.m.material.color.copy(it.base).multiplyScalar(on ? 1.9 : 0.55);
    it.ol.material.opacity = on ? 1 : 0; it.ol.userData.baseOpacity = it.ol.material.opacity;
    if (it.el) { it.el.classList.toggle("hot", on); it.el.style.display = S.focused || on ? "" : "none"; }
    if (on) anchor = pickAnchor(S, id, anchor);
  }
  S.anchor = anchor ? S.items.get(anchor).m : null;
  const u = S.content.userData;
  u.cursor?.(state.t);
  if (u.gauges) for (const it of S.items.values()) {
    const k = it.m.userData.gauge; if (!k) continue;
    const v = nw.sample[k]; const f = k === "smActive" ? v / 36 : k === "vramGiB" ? v / 16 : v;
    it.m.scale.x = Math.max(0.01, f);
    it.m.userData.el.textContent = k === "smActive" ? `${v} / 36` : k === "vramGiB" ? `${v} / 16 GiB` : `${Math.round(v * 100)}%`;
  }
  if (u.sampleEl) u.sampleEl.textContent = `sample ${fmtT(nw.sample.t)}: SMs ${nw.sample.smActive}/36 · DRAM ${Math.round(nw.sample.dram * 100)}% · PCIe ${Math.round(nw.sample.pcie * 100)}%`;
  if (u.xferEl) u.xferEl.textContent = nw.transfers.length ? nw.transfers.map((x) => `${x.what}: ${x.bytes} B ${x.from} → ${x.to}`).join(" · ") : "no transfer in flight";
  if (u.dot) { u.dot.visible = nw.transfers.length > 0; u.dot.userData.dir = nw.transfers[0]?.to === "vram" ? 1 : -1; }
  if (u.kernelEl) u.kernelEl.textContent = nw.kernel ? `launched: ${nw.kernel.name}` : `no kernel at the cursor: CPU-side work in ${byId.get(nw.comp)?.name}`;
}
const ANCHOR_RANK = { execution: (id) => byId.get(id)?.tier ?? -1, architecture: (id) => byId.get(id)?.tier ?? -1,
  hardware: (id) => ({ sm0: 9, pcie: 8, gpu: 5, nic: 4, cpu: 3 })[id] ?? (id.startsWith("g.") ? 1 : 0) };
function pickAnchor(S, id, cur) { const r = ANCHOR_RANK[S.dim]; return cur == null || r(id) > r(cur) ? id : cur; }

// ---------------- connecting lines between the stages: what runs, where, and which software owns it
const links = ["hardware", "architecture"].map((d) => {
  const geo = new THREE.BufferGeometry().setFromPoints(Array.from({ length: 32 }, () => new THREE.Vector3()));
  const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffd84a, transparent: true, opacity: 0.85 }));
  scene.add(l); return { d, l };
});
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpM = new THREE.Vector3();
function updateLinks() {
  for (const { d, l } of links) {
    const a = stages.execution.anchor, b = stages[d].anchor;
    l.visible = !!(a && b); if (!l.visible) continue;
    a.getWorldPosition(tmpA); b.getWorldPosition(tmpB);
    tmpM.addVectors(tmpA, tmpB).multiplyScalar(0.5); tmpM.y += 70; tmpM.z += 40;
    const p = l.geometry.attributes.position;
    for (let i = 0; i < 32; i++) {
      const s = i / 31, q = 1 - s;
      p.setXYZ(i, q * q * tmpA.x + 2 * q * s * tmpM.x + s * s * tmpB.x, q * q * tmpA.y + 2 * q * s * tmpM.y + s * s * tmpB.y, q * q * tmpA.z + 2 * q * s * tmpM.z + s * s * tmpB.z);
    }
    p.needsUpdate = true;
  }
}

// ---------------- camera: swing to the focused stage
let ring = 0, ringGoal = 0;
function cameraGoal() {
  const want = (-DIMS.indexOf(state.dim) * 2 * Math.PI) / 3;
  let d = (want - ringGoal) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
  ringGoal += d;
}
function placeStages() {
  DIMS.forEach((dim, i) => {
    const S = stages[dim]; ringPos(ring + (i * 2 * Math.PI) / 3, S.root.position);
    S.root.rotation.y = Math.atan2(CAM.x - S.root.position.x, CAM.z - S.root.position.z) * 0.6;
  });
}

// ---------------- HUD
const focusEl = document.getElementById("focus"), laddersEl = document.getElementById("ladders"), nowEl = document.getElementById("now");
const tlCanvas = document.querySelector("#tl canvas");
function drawHud(nw) {
  focusEl.innerHTML = `<span style="color:${DIMCOL[state.dim]}">${state.dim}</span> › ${tierName()}<small>the other stages show their aligned tier at the same cursor</small>`;
  laddersEl.innerHTML = DIMS.map((d) => `<div class="ladder ${d === state.dim ? "focus" : ""}"><h4 style="color:${DIMCOL[d]}">${d}</h4>${LADDERS[d].map((n, i) =>
    `<div class="${i === shownTier(d) ? "on" : ""}" style="${i === shownTier(d) ? `background:${DIMCOL[d]}` : ""}">${i + 1} ${n}</div>`).join("")}</div>`).join("");
  const e = nw.exec, k = nw.kernel;
  const arch = nw.archPath.map((id) => byId.get(id).name.split(":")[0].split(" (")[0]).slice(2).join(" › ");
  nowEl.innerHTML = `<h4>now · t = ${fmtT(state.t)}</h4>
    <div class="row"><b style="color:${DIMCOL.execution}">execution</b><span>${short(e[1]?.name ?? "before the first iteration", 40)}<br>${short(e[2]?.name ?? "", 46)}${k ? `<br>kernel ${short(k.name, 34)}` : ""}</span></div>
    <div class="row"><b style="color:${DIMCOL.hardware}">hardware</b><span>${k ? `GPU · ${k.gpu.sms} of 36 SMs` : `CPU-side (${[...nw.hwActive].filter((x) => !x.startsWith("sm")).join(", ")})`}<br>sample: SMs ${nw.sample.smActive}/36 · DRAM ${Math.round(nw.sample.dram * 100)}% · PCIe ${Math.round(nw.sample.pcie * 100)}%${nw.transfers.length ? `<br>in flight: ${nw.transfers[0].what}` : ""}</span></div>
    <div class="row"><b style="color:${DIMCOL.architecture}">architecture</b><span>${short(arch, 60)}</span></div>`;
  const r = tlCanvas.getBoundingClientRect(); tlCanvas.width = r.width * devicePixelRatio; tlCanvas.height = r.height * devicePixelRatio;
  const c = tlCanvas.getContext("2d"); c.scale(devicePixelRatio, devicePixelRatio);
  const X = (t) => 16 + (t / END) * (r.width - 32);
  c.fillStyle = "#121925"; c.fillRect(16, 26, r.width - 32, 12);
  for (const u of EXEC.filter((u) => u.tier === 1)) { c.fillStyle = "#1d2a3d"; c.fillRect(X(u.t0), 26, X(u.t1) - X(u.t0) - 1, 12); }
  c.strokeStyle = DIMCOL[state.dim]; c.globalAlpha = 0.8;
  for (const s of stops()) { c.beginPath(); c.moveTo(X(s.t) + 0.5, 20); c.lineTo(X(s.t) + 0.5, 44); c.stroke(); }
  c.globalAlpha = 1; c.fillStyle = "#ffd84a"; c.fillRect(X(state.t) - 1.5, 10, 3, 44);
  c.font = "13px system-ui"; c.fillStyle = "#8fa3bd";
  c.fillText(`${stops().length} stops: ${state.dim} › ${tierName()}`, 16, 15);
  c.fillText(fmtT(END), r.width - 80, 15);
}
document.getElementById("tl").addEventListener("click", (ev) => { const r = tlCanvas.getBoundingClientRect(); seek(((ev.clientX - r.left - 16) / (r.width - 32)) * END); });

// ---------------- draw on every model change
function draw() {
  const nw = now();
  for (const dim of DIMS) {
    const S = stages[dim], tier = shownTier(dim), focused = dim === state.dim;
    const key = stageKey(dim, tier, nw) + (focused ? "|f" : "");
    if (key !== S.key) rebuild(S, tier, focused, nw, key);
    S.titleEl.textContent = `${dim} · ${LADDERS[dim][tier]}`;
    S.titleEl.style.fontSize = focused ? "24px" : "17px";
    S.edge.material.color.set(focused ? DIMCOL[dim] : "#3a4658");
    S.scale = focused ? 1.12 : 0.72;
    highlight(S, nw);
  }
  cameraGoal();
  drawHud(nw);
}

// ---------------- loop
let last = performance.now();
function frame(t) {
  const dt = Math.min(0.05, (t - last) / 1000); last = t;
  const k = 1 - Math.exp(-dt * 5);
  ring += (ringGoal - ring) * k; placeStages();
  for (const S of Object.values(stages)) { const s = THREE.MathUtils.lerp(S.root.scale.x, S.scale, k); S.root.scale.setScalar(s); }
  for (let i = fades.length - 1; i >= 0; i--) {
    const f = fades[i]; const p = Math.min(1, (t - f.t0) / 450); const e = 1 - (1 - p) ** 3;
    f.g.scale.setScalar(THREE.MathUtils.lerp(f.from, f.to ?? 1, e)); setOpacity(f.g, THREE.MathUtils.lerp(f.o0, f.o1, e));
    if (p >= 1) { fades.splice(i, 1); if (f.kill) dispose(f.g); }
  }
  const dot = stages.hardware.content?.userData.dot;
  if (dot?.visible) { const s = ((t / 900) % 1); const a = dot.userData.dir > 0 ? s : 1 - s; dot.position.set(-35 + 55 * a, 17.5, 5); }
  updateLinks();
  renderer.render(scene, camera); css.render(scene, camera);
  requestAnimationFrame(frame);
}

mountChrome("stages");
resize();
subscribe(draw);
ring = ringGoal; camera.position.copy(CAM); camera.lookAt(0, 0, -40);
for (const S of Object.values(stages)) S.root.scale.setScalar(S.scale);
requestAnimationFrame((t) => { frame(t); window.READY = true; });
