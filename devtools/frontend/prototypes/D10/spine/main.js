// Layout C: the execution timeline is the spine; hardware and architecture are lenses over the cursor.
import * as THREE from "three";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { state, subscribe, now, stops, seek, mountChrome, data, DIMS } from "../model.js";

const { LADDERS, EXEC, ARCH, SAMPLES, END, byId } = data;
const DCOL = { execution: "#7cc4ff", hardware: "#ffb547", architecture: "#c39bff" };
const DESC = {
  execution: ["one request, send to last byte", "one scheduler step: prefill or decode", "executor phases and request hops",
    "one decoder layer (2 of 24 drawn)", "attention, MLP, linear, norm", "one kernel with the CPU call that launched it"],
  hardware: ["utilization of every GPU and host (100 µs samples)", "the board: CPU, RAM, links, GPU, NVMe, NIC",
    "bytes moving between devices", "parts inside a device: SMs, L2, memory controllers, copy engines",
    "one kernel's DRAM and L2 bytes over 36 SMs", "warps, shared memory, registers (Nsight Compute)"],
  architecture: ["the fleet: one host today", "the host and its containers", "containers on the host",
    "processes inside each container", "component boxes inside each process", "toolkit calls runtime calls device code"],
};
/** The execution tier the spine frames for a non-execution position (the ALIGN table read backwards). */
const EXEC_FOR = { hardware: [0, 0, 1, 3, 5, 5], architecture: [0, 0, 0, 1, 2, 5] };
const execTier = () => (state.dim === "execution" ? state.tier : EXEC_FOR[state.dim][state.tier]);
const alignedTier = (dim) => {
  if (dim === state.dim) return state.tier;
  const e = execTier();
  return LADDERS[dim].indexOf(data.ALIGN[e][dim]);
};

// ---------------- three setup
const host = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setClearColor(0x070a10);
host.append(renderer.domElement);
const css = new CSS2DRenderer({ element: document.getElementById("labels") });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(24, 1, 0.01, 5000);
function resize() { renderer.setSize(innerWidth, innerHeight); css.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); drawStrip(); }

const X = (t) => (t / END) * 100 - 50;
const label = (text, cls = "lb", center = [0.5, 0.5]) => {
  const el = document.createElement("div"); el.className = cls; el.textContent = text;
  const o = new CSS2DObject(el); o.center.set(...center); return o;
};
const dropLabels = (g) => g.traverse((o) => o.element?.remove());
const mat = (c, op = 1, extra = {}) => new THREE.MeshBasicMaterial({ color: c, transparent: op < 1, opacity: op, depthWrite: op >= 1, ...extra });

// rig: everything that keeps a constant screen size. Spine: x is world time, y and z follow the rig scale.
const rig = new THREE.Group(); scene.add(rig);
const spine = new THREE.Group(); scene.add(spine);
const view = { cx: 0, s: 1, tcx: 0, ts: 1 };

// ---------------- the spine: nested strata, request at the top back, kernels at the front
const ROW = (i) => ({ y: 12.6 - i * 2.35, z: -5 + i * 1.7 });
const procOf = (comp) => { let x = byId.get(comp); while (x && x.tier > 3) x = byId.get(x.parent); return x?.id; };
const PROC_COL = { "p.client": "#8a96a8", "p.bridge": "#b48ef0", "p.http": "#5aa9ff", "p.worker": "#58d68d" };
const KIND_COL = { gemm: "#ffb547", attn: "#ff6fae", mem: "#4fd1e8" };
function unitColor(u, i) {
  const c = new THREE.Color(
    u.tier === 0 ? "#5b8def" : u.tier === 1 ? (u.name.includes("prefill") ? "#f0a050" : "#3fc1a5")
      : u.tier === 2 ? PROC_COL[procOf(u.comp)] ?? "#888" : u.tier === 3 ? "#c792ea" : u.tier === 4 ? "#e6c86e" : KIND_COL[u.gpu.kind]);
  return i % 2 ? c.multiplyScalar(0.8) : c;
}
const unitMeshes = [];
const rowCount = [0, 0, 0, 0, 0, 0];
for (const u of [...EXEC].sort((a, b) => a.t0 - b.t0)) {
  const { y, z } = ROW(u.tier);
  const w = Math.max(1e-4, X(u.t1) - X(u.t0));
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat(unitColor(u, rowCount[u.tier]++), 0.999));
  m.scale.set(w, 1.9, 1.3); m.position.set((X(u.t0) + X(u.t1)) / 2, y, z);
  m.userData.u = u; m.userData.base = m.material.color.clone();
  const lb = label("", "lb unit"); lb.position.set(0, 0, 0); scene.add(lb); m.userData.lb = lb;
  spine.add(m); unitMeshes.push(m);
}
const rowLabels = LADDERS.execution.map((n, i) => { const o = label(n, "lb row", [0, 0.5]); const { y, z } = ROW(i); o.position.set(-50, y, z + 0.7); rig.add(o); return o; });

// samples: faint area chart behind the strata. State, never stops.
{
  const pts = SAMPLES.flatMap((s) => [[X(s.t), s.smActive / 36], [X(Math.min(END, s.t + 100)), s.smActive / 36]]);
  const shape = new THREE.Shape(); shape.moveTo(pts[0][0], 0);
  pts.forEach(([x, v]) => shape.lineTo(x, v * 3)); shape.lineTo(pts.at(-1)[0], 0);
  const area = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat("#ffb547", 0.22, { side: THREE.DoubleSide }));
  area.position.set(0, 15, -7); spine.add(area);
  const dl = SAMPLES.flatMap((s) => [new THREE.Vector3(X(s.t), s.dram * 3, 0), new THREE.Vector3(X(Math.min(END, s.t + 100)), s.dram * 3, 0)]);
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(dl), new THREE.LineBasicMaterial({ color: "#ff7a59", transparent: true, opacity: 0.55 }));
  line.position.set(0, 15, -6.9); spine.add(line);
  const o = label("samples, 100 µs state: SMs active (fill), DRAM % (line)", "lb sub", [0, 0.5]); o.position.set(-50, 16.6, -7); rig.add(o);
}
const sampleWin = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.1), mat("#ffb547", 0.18)); spine.add(sampleWin);

// cursor: a light plane cutting through every stratum
const cursor = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat("#ffffff", 0.1, { blending: THREE.AdditiveBlending }));
const cursorCore = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat("#ffffff", 0.9));
spine.add(cursor, cursorCore);

// stop ticks of the focused position on a rail in front of the kernels
const rail = new THREE.Group(); spine.add(rail);
const railLabel = label("", "lb sub", [0, 0.5]); railLabel.position.set(-50, -1.4, 5); rig.add(railLabel);

// ---------------- lenses
function makeLens(dim) {
  const g = new THREE.Group();
  const W = 42, H = 23;
  const frame = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat("#0d1320", 0.97, { depthTest: false })); frame.renderOrder = 99;
  const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([[-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2]].map(([x, y]) => new THREE.Vector3(x, y, 0.01))),
    new THREE.LineBasicMaterial({ color: DCOL[dim] }));
  const title = label("", "lb title", [0, 1]); title.position.set(-W / 2 + 0.6, H / 2 - 0.4, 0.1);
  title.element.style.color = DCOL[dim];
  const content = new THREE.Group(); content.position.z = 0.05;
  g.add(frame, edge, title, content);
  const beam = new THREE.Mesh(new THREE.BufferGeometry(), mat(DCOL[dim], 0.5, { side: THREE.DoubleSide }));
  beam.frustumCulled = false; scene.add(beam);
  rig.add(g);
  return { dim, g, W, H, title, content, beam, anims: [] };
}
const lenses = { hardware: makeLens("hardware"), architecture: makeLens("architecture") };
const LENS_POSE = {
  execution: { hardware: [-23, 30.5, 0, 1], architecture: [23, 30.5, 0, 1] },
  hardware: { hardware: [-3, 29, 0, 1.12], architecture: [37, 26, -4, 0.4] },
  architecture: { hardware: [-37, 26, -4, 0.4], architecture: [3, 29, 0, 1.12] },
};

const P = { lit: "#ffffff" };
/** Lens drawings are flat: paint in creation order so a frame never hides the boxes inside it. */
const flat = (L, m) => { m.material.depthTest = false; m.renderOrder = 100 + L.ro++; };
function box(L, x, y, w, h, c, { lit = false, text, minor = false, cls = "lb", op } = {}) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat(c, op ?? (lit ? 0.95 : 0.22)));
  m.position.set(x, y, 0); flat(L, m); L.content.add(m);
  if (lit) { const e = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([a, b]) => new THREE.Vector3(x + a, y + b, 0.02))), new THREE.LineBasicMaterial({ color: P.lit, depthTest: false })); e.renderOrder = 100 + L.ro++; L.content.add(e); }
  if (text) { const o = label(text, cls + (lit ? "" : " dimt")); o.position.set(x, y, 0.1); o.userData.minor = minor; L.content.add(o); if (lit && cls === "lb") o.element.style.color = "#0a0f18", o.element.style.textShadow = "none", o.element.style.fontWeight = 700; }
  return m;
}
function text(L, x, y, s, cls = "lb", center = [0, 0.5]) { const o = label(s, cls, center); o.position.set(x, y, 0.1); L.content.add(o); return o; }
function link(L, a, b, lit, c = "#9fb0c6", th = 0.35) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(len, lit ? th * 1.8 : th), mat(lit ? c : "#3a475c", lit ? 0.95 : 0.6));
  m.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, -0.01); m.rotation.z = Math.atan2(b[1] - a[1], b[0] - a[0]); flat(L, m); L.content.add(m);
  if (lit) { // a packet flowing a -> b explains the direction
    const d = new THREE.Mesh(new THREE.CircleGeometry(0.55, 16), mat("#ffffff")); flat(L, d); L.content.add(d);
    L.anims.push((s) => { const f = (s * 0.7) % 1; d.position.set(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, 0.05); });
  }
}
const pct = (v) => `${Math.round(v * 100)}%`;
const ms = (t) => `${(t / 1000).toFixed(3)} ms`;

function smGrid(L, x0, y0, litN, c) {
  for (let i = 0; i < 36; i++) box(L, x0 + (i % 6) * 2.05, y0 - Math.floor(i / 6) * 2.05, 1.75, 1.75, c, { lit: i < litN, op: i < litN ? 0.95 : 0.18 });
}

const HW_LENS = [
  (L, n) => { // system: gauges of the sample window
    const s = n.sample;
    text(L, -19.5, 7.6, `sample ${ms(s.t)} to ${ms(s.t + 100)}: state at the cursor, not a stop`, "lb sub");
    [["GPU busy", s.gpuUtil, pct(s.gpuUtil)], ["SMs active", s.smActive / 36, `${s.smActive} of 36`], ["DRAM bandwidth", s.dram, pct(s.dram)],
      ["PCIe", s.pcie, pct(s.pcie)], ["CPU (host)", s.cpu, pct(s.cpu)], ["VRAM used", s.vramGiB / 16, `${s.vramGiB} of 16 GiB`]].forEach(([k, v, t], i) => {
      const y = 4.6 - i * 2.6;
      text(L, -6.5, y, k, "lb big", [1, 0.5]);
      box(L, 4, y, 20, 1.5, "#2a3446", { op: 0.9 });
      box(L, -6 + 10 * v, y, Math.max(0.05, 20 * v), 1.5, "#ffb547", { op: 0.95 });
      text(L, 14.6, y, t, "lb big");
    });
  },
  (L, n) => board(L, n, false),
  (L, n) => board(L, n, true),
  (L, n) => { // unit: inside the GPU
    const lit = [...n.hwActive].filter((id) => id.startsWith("sm")).length;
    text(L, -19.5, 8.4, `GPU: ${lit} of 36 SMs running ${n.kernel ? n.kernel.name : "nothing (GPU idle at the cursor)"}`, "lb big");
    smGrid(L, -18.5, 5.4, lit, "#ffb547");
    box(L, -3.8, 0.3, 2.6, 12, "#4fd1e8", { lit: n.hwActive.has("l2"), text: "L2", cls: "lb big" });
    for (let i = 0; i < 4; i++) box(L, 0.4, 4.6 - i * 2.9, 3, 2.4, "#4fd1e8", { lit: !!n.kernel, text: `MC${i}` });
    box(L, 5, 0.3, 3, 12, "#7aa2ff", { lit: n.hwActive.has("vram"), text: "VRAM", cls: "lb big" });
    box(L, -3.8, -7.6, 2.6, 1.8, "#58d68d", { lit: n.hwActive.has("ce0"), text: "CE0" });
    box(L, 0.4, -7.6, 3, 1.8, "#58d68d", { lit: false, text: "CE1" });
    text(L, 9.6, 7, "CPU cores", "lb big");
    for (let i = 0; i < 8; i++) box(L, 10.8 + (i % 4) * 2.4, 4.4 - Math.floor(i / 4) * 2.4, 2, 2, "#8a96a8", { op: 0.25 });
    text(L, 9.6, -0.8, "per-core use: missing", "lb sub");
    text(L, 9.6, -2.6, "(not collected)", "lb sub");
  },
  (L, n) => { // kernel traffic
    const k = n.kernel;
    if (!k) { text(L, 0, 1, "no kernel at the cursor: the GPU is idle", "lb big", [0.5, 0.5]); text(L, 0, -1.6, `the request is in: ${n.exec[2]?.name ?? "-"}`, "lb sub", [0.5, 0.5]); return; }
    text(L, -19.5, 8.4, `${k.name}: grid ${k.gpu.grid} blocks over ${k.gpu.sms} of 36 SMs`, "lb big");
    smGrid(L, -18.5, 5.4, k.gpu.sms, KIND_COL[k.gpu.kind]);
    box(L, 3, 0.3, 3, 12, "#4fd1e8", { lit: true, text: "L2", cls: "lb big" });
    box(L, 15, 0.3, 4, 12, "#7aa2ff", { lit: true, text: "VRAM", cls: "lb big" });
    link(L, [13, 2], [4.5, 2], true, "#7aa2ff", 0.3 + k.gpu.dramMB / 40);
    link(L, [1.5, 2], [-5.5, 2], true, "#4fd1e8", 0.3 + k.gpu.l2MB / 40);
    text(L, 8.8, 4.6, `DRAM ${k.gpu.dramMB} MB`, "lb big", [0.5, 0.5]);
    text(L, -2, 4.6, `L2 ${k.gpu.l2MB} MB`, "lb big", [0.5, 0.5]);
    text(L, -19.5, -8, `occupancy ${pct(k.gpu.occ)} · ${k.gpu.profiled ? "profiled by ncu" : "not profiled (ncu ran on iteration 2 only)"}`, "lb sub");
    text(L, -19.5, -9.8, `launched by ${k.launch} at ${ms(k.cpuT)} on the CPU`, "lb sub");
  },
  (L, n) => { // SM internals
    const k = n.kernel;
    box(L, -4, 0, 26, 15, "#2a3446", { op: 0.6 }).position.z = -0.03;
    text(L, -16.5, 6.4, `one SM${k ? ` running ${k.name}` : ""}`, "lb big");
    for (let i = 0; i < 4; i++) box(L, -13 + i * 6, 1.6, 5.2, 5, "#ffb547", { op: 0.25, text: `warp sched ${i}` });
    box(L, -4, -3.2, 23.2, 1.8, "#c792ea", { op: 0.25, text: "register file" });
    box(L, -4, -5.6, 23.2, 1.8, "#4fd1e8", { op: 0.25, text: "L1 / shared memory" });
    text(L, 10.5, 2, "missing here:", "lb big"); text(L, 10.5, 0, "open in Nsight", "lb sub"); text(L, 10.5, -1.6, "Compute (owner ruling)", "lb sub");
  },
];
function board(L, n, device) {
  const A = n.hwActive;
  text(L, -19.5, 8.6, "MSI MPG Z390M board", "lb sub");
  const B = { cpu: [-11, 3, 10, 5.5, "#8a96a8", "CPU i9-9900K"], ram: [-11, -5.5, 10, 3.2, "#8a96a8", "RAM 62 GiB"], gpu: [9, 3, 12, 5.5, "#ffb547", "GPU RTX 5060 Ti"],
    vram: [9, -5.5, 12, 3.2, "#7aa2ff", "VRAM 16 GiB"], nvme: [-1, -8.6, 7, 2.2, "#58d68d", "NVMe SN7100"], nic: [-1, 7.6, 7, 2.2, "#b48ef0", "NIC veth/eth0"] };
  const tr = n.transfers[0];
  const pcieLit = !!tr;
  link(L, [-6, 3.6], [3, 3.6], pcieLit && tr.from === "ram", "#ffb547");
  link(L, [3, 2.4], [-6, 2.4], pcieLit && tr.from === "vram", "#ffb547");
  link(L, [-11, 0.25], [-11, -3.9], pcieLit && tr.from === "ram", "#8a96a8");
  link(L, [9, 0.25], [9, -3.9], A.has("vram") || pcieLit, "#7aa2ff");
  link(L, [-6, 1], [-1, -7.5], false); link(L, [-6, 5], [-1, 6.5], A.has("nic"), "#b48ef0");
  for (const [id, [x, y, w, h, c, t]] of Object.entries(B)) box(L, x, y, w, h, c, { lit: A.has(id), text: t, cls: "lb big" });
  text(L, -1.5, 0.9, "PCIe gen 3 x8", "lb sub", [0.5, 0.5]);
  text(L, -3.6, -2.4, "DMI", "lb sub", [0.5, 0.5]);
  if (device) {
    const next = data.TRANSFERS.find((x) => x.t0 > state.t);
    text(L, -19.5, -10, tr ? `in flight: ${tr.what}, ${tr.bytes} B ${tr.from} -> ${tr.to}` : `no copy in flight · next: ${next ? `${next.what} at ${ms(next.t0)}` : "none"}`, "lb big", [0, 0.5]);
  }
}

function archLens(L, n, tier) {
  const lit = new Set(n.archPath);
  if (tier === 0) { box(L, 0, 0, 34, 14, "#c39bff", { op: 0.15 }).position.z = -0.03; text(L, 0, 3, "fleet: one host today", "lb big", [0.5, 0.5]); text(L, 0, 0, "a cluster from I27", "lb sub", [0.5, 0.5]); box(L, 0, -3.5, 22, 3, "#c39bff", { lit: true, text: "host: i9-9900K + RTX 5060 Ti", cls: "lb" }); return; }
  const items = ARCH.filter((a) => a.tier === tier);
  const groups = [...new Set(items.map((a) => a.parent))].map((p) => [byId.get(p), items.filter((a) => a.parent === p)]);
  const W = 40, gw = W / groups.length;
  groups.forEach(([par, kids], gi) => {
    const gx = -W / 2 + gw * (gi + 0.5);
    box(L, gx, -1.2, gw - 0.8, 17.6, "#c39bff", { op: lit.has(par.id) ? 0.16 : 0.06 }).position.z = -0.03;
    text(L, gx, 6.9, par.name.length > 34 ? par.name.slice(0, 32) + "…" : par.name, "lb sub", [0.5, 0.5]);
    const row = groups.length === 1 && tier !== 5;
    kids.forEach((k, i) => {
      const [x, y, w, h] = row ? [gx - gw / 2 + (gw / kids.length) * (i + 0.5), 0, gw / kids.length - 1.2, 8] : [gx, 4.4 - i * (tier === 5 ? 5 : 2.5), gw - 2.2, tier === 5 ? 3.6 : 2.0];
      box(L, x, y, w, h, "#c39bff", { lit: lit.has(k.id), text: k.name.length > 30 ? k.name.slice(0, 28) + "…" : k.name });
      if (tier === 5 && i < kids.length - 1) { link(L, [x, y - h / 2], [x, y - 5 + h / 2], lit.has(k.id), "#c39bff", 0.25); text(L, x + 0.8, y - 2.5, i === 0 ? "calls cudaLaunchKernelExC" : "enqueues work on the GPU", "lb sub"); }
    });
  });
  const handoff = stops("architecture", tier).filter((s) => s.t <= state.t).at(-1);
  text(L, -20, -11.2, handoff?.label ? `last hand-off at this tier: ${handoff.label} (${ms(handoff.t)})` : "", "lb sub");
}

function drawLens(L, n) {
  dropLabels(L.content); L.content.clear(); L.anims = []; L.ro = 0;
  const tier = alignedTier(L.dim);
  const focused = state.dim === L.dim;
  L.title.element.textContent = `${L.dim.toUpperCase()} LENS · ${LADDERS[L.dim][tier]}${focused ? "  (↑ ↓ fly its tiers)" : `  (aligned with execution › ${LADDERS.execution[execTier()]})`}`;
  if (L.dim === "hardware") HW_LENS[tier](L, n); else archLens(L, n, tier);
}

// ---------------- HUD
const $ = (s) => document.querySelector(s);
function drawHud(n) {
  $("#focus .t").innerHTML = `<span style="color:${DCOL[state.dim]}">${state.dim}</span> › ${LADDERS[state.dim][state.tier]}`;
  $("#focus .d").textContent = DESC[state.dim][state.tier];
  $("#ladders").innerHTML = DIMS.map((d) => `<span class="dn" style="color:${DCOL[d]}">${d}</span>` + LADDERS[d].map((tn, i) => {
    const on = d === state.dim && i === state.tier, al = d !== state.dim && i === alignedTier(d);
    return `<span class="c ${on ? "on" : al ? "al" : ""}" style="${on ? `background:${DCOL[d]};border-color:${DCOL[d]}` : ""}">${i + 1} ${tn}</span>`;
  }).join("")).join("");
  const active = n.exec.filter((u) => u && u.t0 <= state.t && u.t1 > state.t && u.tier > 0).map((u) => u.name);
  const s = n.sample;
  const hw = `SMs ${s.smActive}/36 · DRAM ${pct(s.dram)} · PCIe ${pct(s.pcie)} · GPU busy ${pct(s.gpuUtil)}${n.kernel ? ` · ${n.kernel.name} on ${n.kernel.gpu.sms} SMs` : " · GPU idle"}${n.transfers.length ? ` · copy: ${n.transfers[0].what}` : ""}`;
  const ar = n.archPath.slice(2).map((id) => byId.get(id).name).join(" › ");
  $("#nowbox").innerHTML = [["execution", active.join(" › ") || "between units"], ["hardware", hw], ["architecture", ar]]
    .map(([d, v]) => `<span class="k" style="color:${DCOL[d]}">${d}</span><span class="v" title="${v}">${v}</span>`).join("");
}
const strip = $("#strip canvas");
function drawStrip() {
  const S = stops(); const w = strip.clientWidth, h = strip.clientHeight; strip.width = w * devicePixelRatio; strip.height = h * devicePixelRatio;
  const g = strip.getContext("2d"); g.scale(devicePixelRatio, devicePixelRatio); g.clearRect(0, 0, w, h);
  const xs = (t) => (t / END) * w;
  g.fillStyle = "#1a2232"; g.fillRect(0, 14, w, 12);
  const [a, b] = winTarget(); g.strokeStyle = "#7cc4ff88"; g.lineWidth = 2; g.strokeRect(xs(a), 8, Math.max(2, xs(b) - xs(a)), 24);
  const cur = S.filter((x) => x.t <= state.t + 1e-6).at(-1);
  g.fillStyle = DCOL[state.dim];
  for (const x of S) { g.globalAlpha = x === cur ? 1 : 0.55; g.fillRect(xs(x.t) - 1, 12, 2, 16); }
  g.globalAlpha = 1; g.fillStyle = "#fff"; g.fillRect(xs(state.t) - 1.5, 0, 3, h);
  const i = cur ? S.indexOf(cur) + 1 : 0;
  $("#strip .lab").innerHTML = `<b style="color:${DCOL[state.dim]}">${S.length} stops</b> of ${state.dim} › ${LADDERS[state.dim][state.tier]} · stop ${i}/${S.length}: ${cur?.label ?? "before the first stop"} · <span style="color:#7d8ba0">box = spine window · white = cursor (${ms(state.t)})</span>`;
}
strip.addEventListener("click", (e) => { const r = strip.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * END); });

// ---------------- the window the spine frames: the parent unit of the focused execution tier around the cursor
function winTarget() {
  const e = execTier();
  for (let p = e - 1; p >= 1; p--) {
    const u = EXEC.find((x) => x.tier === p && x.t0 <= state.t && state.t < x.t1);
    if (u) { const pad = (u.t1 - u.t0) * 0.06; return [u.t0 - pad, u.t1 + pad]; }
  }
  return [-END * 0.02, END * 1.02];
}

function onState() {
  const n = now();
  const [a, b] = winTarget();
  view.tcx = (X(a) + X(b)) / 2; view.ts = (X(b) - X(a)) / 86;
  const et = execTier();
  for (const m of unitMeshes) {
    const u = m.userData.u, on = u.t0 <= state.t && state.t < u.t1, row = u.tier === et;
    m.material.color.copy(m.userData.base).multiplyScalar(on ? 1.25 : row ? 0.85 : 0.42);
    m.userData.on = on; m.userData.row = row;
  }
  rowLabels.forEach((o, i) => { o.element.className = `lb row${i === et ? " on" : ""}`; });
  rail.clear();
  for (const s of stops()) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat(DCOL[state.dim], s.t <= state.t + 1e-6 && s.t > state.t - 1e-6 ? 1 : 0.6));
    m.position.set(X(s.t), -0.9, 5); m.userData.tick = true; rail.add(m);
  }
  railLabel.element.textContent = `stops: ${state.dim} › ${LADDERS[state.dim][state.tier]}`;
  railLabel.element.style.color = DCOL[state.dim];
  const sx = X(Math.floor(state.t / 100) * 100), sx1 = X(Math.min(END, Math.floor(state.t / 100) * 100 + 100));
  sampleWin.position.set((sx + sx1) / 2, 16.5, -7.05); sampleWin.userData.w = sx1 - sx;
  drawLens(lenses.hardware, n); drawLens(lenses.architecture, n);
  drawHud(n); drawStrip();
}

// ---------------- frame loop: smooth flight, constant screen size for the rig
const v3 = new THREE.Vector3(), v4 = new THREE.Vector3();
function frame(ms) {
  const k = 0.1;
  view.cx += (view.tcx - view.cx) * k;
  view.s = Math.exp(Math.log(view.s) + (Math.log(view.ts) - Math.log(view.s)) * k);
  const s = view.s;
  rig.position.set(view.cx, 0, 0); rig.scale.setScalar(s);
  spine.scale.set(1, s, s);
  camera.position.set(view.cx, 25 * s, 130 * s); camera.lookAt(view.cx, 20.5 * s, 0);
  camera.near = 0.5 * s; camera.far = 500 * s; camera.updateProjectionMatrix();
  const cx = X(state.t);
  cursor.position.set(cx, 8.2, -1.5); cursor.scale.set(0.5 * s, 19.5, 10);
  cursorCore.position.set(cx, 8.2, 4.3); cursorCore.scale.set(0.16 * s, 19.5, 0.05);
  sampleWin.scale.set(sampleWin.userData.w ?? 0, 3.6, 1);
  rail.children.forEach((m) => m.scale.set(0.12 * s, 1.1, 1));
  // lenses ease toward the pose of the focused dimension
  for (const L of Object.values(lenses)) {
    const [x, y, z, sc] = LENS_POSE[state.dim][L.dim];
    L.g.position.lerp(v3.set(x, y, z), k); L.g.scale.setScalar(L.g.scale.x + (sc - L.g.scale.x) * k);
    const small = L.g.scale.x < 0.7;
    L.content.traverse((o) => { if (o.isCSS2DObject) o.visible = !small || o.element.classList.contains("big"); });
    L.anims.forEach((f) => f(ms / 1000));
    // beam: from the lens bottom edge down to the top of the cursor plane
    const half = (L.W / 2) * 0.22;
    const bl = L.g.localToWorld(v3.set(-half, -L.H / 2, 0)).clone(), br = L.g.localToWorld(v4.set(half, -L.H / 2, 0)).clone();
    const tip = new THREE.Vector3(cx, 17.9 * s, -1 * s);
    L.beam.geometry.setFromPoints([bl, br, tip]); L.beam.geometry.setIndex([0, 1, 2]);
  }
  // unit labels: only where the unit is wide enough on screen to read
  const pxPerX = innerWidth / (100 * s * 1.15);
  const [w0, w1] = [view.cx - 50 * s, view.cx + 50 * s];
  for (const m of unitMeshes) {
    const u = m.userData.u, lb = m.userData.lb;
    const a = Math.max(X(u.t0), w0), b = Math.min(X(u.t1), w1), px = (b - a) * pxPerX;
    if (px < 70) { lb.visible = false; continue; }
    const chars = Math.floor(px / 8.2);
    const t = u.name.length > chars ? u.name.slice(0, Math.max(3, chars - 1)) + "…" : u.name;
    if (lb.element.textContent !== t) lb.element.textContent = t;
    lb.element.className = `lb unit${m.userData.on ? " on" : ""}`;
    lb.visible = true; lb.position.set((a + b) / 2, m.position.y * s, (m.position.z + 0.66) * s);
  }
  renderer.render(scene, camera); css.render(scene, camera);
  if (!window.READY) window.READY = true;
  requestAnimationFrame(frame);
}

mountChrome("spine");
addEventListener("resize", resize); resize();
subscribe(onState);
view.cx = view.tcx; view.s = view.ts;
requestAnimationFrame(frame);
