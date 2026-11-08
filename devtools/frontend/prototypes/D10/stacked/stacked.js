import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { state, subscribe, now, stops, tierName, seek, mountChrome, data, DIMS, KEYS } from "../model.js";

const { LADDERS, ALIGN, byId, SAMPLES, END } = data;
const COLOR = { execution: "#ffb347", hardware: "#5fd4a4", architecture: "#7cb8ff" };
const CAPTION = {
  execution: ["The whole request, send to last byte.", "One scheduler step: which requests run, prefill or decode.",
    "Executor phases and request hops. The pulse sits in the component doing the work.", "One decoder layer: its kernels run on the GPU.",
    "One module (attention, MLP, norm): the SMs it lights.", "One kernel: launched from the CPU, runs on N of 36 SMs."],
  hardware: ["Overall utilization of the host and the GPU.", "The board: CPU, RAM, links, GPU, NVMe, NIC.",
    "Bytes moving between devices: PCIe copies, network frames.", "Parts inside the GPU: SMs, L2, VRAM, copy engines.",
    "One kernel's traffic: VRAM to L2 to the SMs it occupies.", "Warps, shared memory, registers. Opens in Nsight Compute."],
  architecture: ["The fleet: one host today, a cluster from I27.", "One host and everything that runs on it.",
    "Containers: client, network, server.", "Processes: HTTP server and the MPI-spawned executor worker.",
    "Component boxes inside each process. The request hands off between them.", "Toolkit calls runtime calls device code."],
};

mountChrome("stacked");

// ---------------- three.js world
const stage = document.getElementById("stage");
const scene = new THREE.Scene();
scene.background = new THREE.Color("#070a10");
const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 2000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
stage.append(renderer.domElement);
const labels = new CSS2DRenderer();
Object.assign(labels.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
stage.append(labels.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(-40, 120, 60); scene.add(sun);

const groups = { hardware: [], architecture: [], execution: [] }; // materials per dimension, dimmed when not focused
const V = (x, y, z) => new THREE.Vector3(x, y, z);
function mat(dim, color, opacity = 1, emissive = 0x000000) {
  const m = new THREE.MeshStandardMaterial({ color, transparent: true, opacity, emissive, roughness: 0.6, metalness: 0.1, depthWrite: opacity > 0.9 });
  m.userData.base = opacity; groups[dim].push(m); return m;
}
function box(dim, c, s, color, opacity = 1) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(s.x, s.y, s.z), mat(dim, color, opacity));
  m.position.copy(c); scene.add(m); return m;
}
function edges(dim, mesh, color) {
  const lm = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }); lm.userData.base = 0.9; groups[dim].push(lm);
  const l = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), lm); mesh.add(l); return lm;
}
function line(dim, pts, color, opacity = 0.7) {
  const lm = new THREE.LineBasicMaterial({ color, transparent: true, opacity }); lm.userData.base = opacity; groups[dim].push(lm);
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lm));
}
const LBL = [];
function label(text, pos, dim, show, cls = "") {
  const el = document.createElement("div"); el.className = `lbl ${dim === "hardware" ? "hw" : dim === "architecture" ? "arch" : "exec"} ${cls}`; el.textContent = text;
  const o = new CSS2DObject(el); o.position.copy(pos); scene.add(o);
  const L = { o, el, dim, show }; LBL.push(L); return L;
}

// ---------------- hardware: the board is the floor
const board = box("hardware", V(0, -0.6, 2), V(150, 1, 95), "#12201a");
const HWP = {}; // id -> {mesh, top}
function hw(id, c, s, color, show) {
  const m = box("hardware", c, s, color); edges("hardware", m, "#3f8f72");
  HWP[id] = { mesh: m, c, top: V(c.x, c.y + s.y / 2, c.z) };
  if (show) label(byId.get(id)?.name ?? id, V(c.x, c.y + s.y / 2 + 1.5, c.z + s.z / 2 + 1.5), "hardware", show, "big");
  return m;
}
const always = () => true;
const unitTier = (s) => (s.dim === "hardware" && s.tier >= 3) || (s.dim === "execution" && s.tier >= 3);
hw("cpu", V(-25, 1, -22), V(14, 2, 14), "#2a3b52", always);
for (let i = 0; i < 8; i++) hw(`core${i}`, V(-29.5 + (i % 4) * 3, 2.4, -25 + Math.floor(i / 4) * 5), V(2.4, 0.8, 4), "#36506f");
for (let i = 0; i < 4; i++) { const m = hw(i ? `ram${i}` : "ram", V(-10 + i * 2.6, 1.5, -22), V(1.4, 3, 22), "#2b4a3c"); }
label("DDR4 62 GiB", V(-6, 4.5, -9), "hardware", always, "big");
hw("nic", V(-52, 1, 8), V(9, 2, 7), "#3a3550", always);
hw("nvme", V(-28, 0.6, 20), V(16, 1.2, 4.5), "#3d3a2a", always);
hw("gpu", V(35, 1, 15), V(62, 2, 36), "#1c2a24", always);
const SM = [];
for (let i = 0; i < 36; i++) {
  const c = V(10 + (i % 6) * 4, 2.6, 4 + Math.floor(i / 6) * 4.2);
  const m = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.2, 3.4), mat("hardware", "#22392f", 1, 0x000000)); m.position.copy(c); scene.add(m);
  SM.push(m); HWP[`sm${i}`] = { mesh: m, c, top: c.clone().add(V(0, 0.6, 0)) };
}
label("36 SMs", V(20, 4, -0.5), "hardware", unitTier, "big");
hw("l2", V(40, 2.4, 15), V(5, 0.8, 26), "#2c3f5e", unitTier);
const VRAM = [];
for (let i = 0; i < 4; i++) { VRAM.push(hw(i ? `vram${i}` : "vram", V(56, 2.6, 4 + i * 7.5), V(7, 1.2, 6), "#4a3b22")); hw(`mc${i}`, V(48.5, 2.3, 4 + i * 7.5), V(3, 0.6, 4), "#3b3550"); }
label("GDDR7 16 GiB (VRAM)", V(56, 4.5, 33.5), "hardware", always, "big");
label("4 memory controllers", V(48.5, 3.5, -1), "hardware", unitTier);
hw("ce0", V(8, 2.3, 29), V(3, 0.6, 3), "#4b3550"); hw("ce1", V(12, 2.3, 29), V(3, 0.6, 3), "#4b3550");
label("copy engines", V(10, 3.5, 32), "hardware", unitTier);
const pciePath = new THREE.CatmullRomCurve3([V(-18, 1.5, -18), V(-5, 1.5, -6), V(8, 2.2, 26), V(10, 2.6, 29)]);
const pcieMat = mat("hardware", "#3d7c66", 1, 0x000000);
scene.add(new THREE.Mesh(new THREE.TubeGeometry(pciePath, 60, 0.9, 10), pcieMat));
label("PCIe gen 3 x8", V(-2, 3, -3), "hardware", always, "big");
const dmiPath = new THREE.CatmullRomCurve3([V(-26, 1, -15), V(-27, 0.8, 4), V(-28, 0.8, 18)]);
scene.add(new THREE.Mesh(new THREE.TubeGeometry(dmiPath, 30, 0.5, 8), mat("hardware", "#4d4a33")));
label("DMI 3.0 x4", V(-25, 2.5, 4), "hardware", (s) => s.dim === "hardware" && s.tier >= 1);
const sysLbl = label("", V(0, 6, 48), "hardware", (s) => s.dim === "hardware" && s.tier <= 1, "big");
const smLbl = label("", V(20, 4.5, 29.5), "hardware", always, "big");

// ---------------- architecture stands on the hardware it runs on
const AP = {}; // id -> {mesh, c, s}
function arch(id, c, s, color, opacity, show, cls = "") {
  const m = box("architecture", c, s, color, opacity); const em = edges("architecture", m, "#5d8fd0");
  AP[id] = { mesh: m, c, s, em };
  const l = label(byId.get(id).name, V(c.x, c.y + s.y / 2 + 0.8, c.z), "architecture", show, cls); AP[id].lbl = l;
  return m;
}
const archShow = (minTier) => (s) => s.dim === "architecture" ? s.tier >= minTier || minTier <= 2 : minTier <= 2;
arch("c.client", V(-62, 34, -22), V(20, 18, 24), "#1b3150", 0.12, always, "big");
arch("c.net", V(-52, 30, 8), V(10, 10, 9), "#1b3150", 0.12, always, "big");
arch("c.server", V(-17, 38, -22), V(36, 26, 30), "#1b3150", 0.1, always, "big");
arch("p.client", V(-62, 32, -22), V(16, 12, 18), "#25466e", 0.15, archShow(3));
arch("p.bridge", V(-52, 29.5, 8), V(7, 6, 6), "#25466e", 0.15, archShow(3));
arch("p.http", V(-26, 36, -22), V(15, 18, 26), "#25466e", 0.15, archShow(3));
arch("p.worker", V(-8, 36, -22), V(15, 18, 26), "#25466e", 0.15, archShow(3));
const COMP = { "p.client": ["b.sdk", "b.transport"], "p.bridge": ["b.eth0"], "p.http": ["b.asgi", "b.tokenizer", "b.llm_api", "b.ipc", "b.detok"],
  "p.worker": ["b.fetch", "b.scheduler", "b.forward", "b.kv", "b.sampler", "b.responses"] };
const compShow = (id) => (s) => (s.dim === "architecture" && s.tier >= 4) || now().comp === id;
for (const [p, ids] of Object.entries(COMP)) {
  const P = AP[p]; const cols = ids.length > 2 ? 2 : 1, rows = Math.ceil(ids.length / cols);
  ids.forEach((id, i) => {
    const cx = P.c.x + (cols === 2 ? (i % 2 ? 3.6 : -3.6) : 0), cz = P.c.z + (rows > 1 ? (Math.floor(i / cols) - (rows - 1) / 2) * 7.5 : 0);
    arch(id, V(cx, P.c.y - 3, cz), V(cols === 2 ? 6 : Math.min(6, P.s.x - 2), 3, 4.5), "#2f5d96", 0.55, compShow(id));
  });
}
const SW = ["sw.toolkit", "sw.runtime", "sw.device"];
const swShow = (s) => (s.dim === "architecture" && s.tier === 5) || (s.dim === "execution" && s.tier === 5);
SW.forEach((id, i) => arch(id, V(-8, 22 - i * 4.5, -22), V(12, 0.8, 9), ["#35609c", "#3d5487", "#4a4785"][i], 0.6, swShow));
// stems: what each process runs on
line("architecture", [V(-62, 25, -22), V(-28, 2.5, -24)], "#6d9ad6");
line("architecture", [V(-52, 25, 8), V(-52, 2, 8)], "#6d9ad6");
line("architecture", [V(-26, 27, -22), V(-27, 2.5, -22)], "#6d9ad6");
line("architecture", [V(-8, 27, -22), V(-8, 13, -22), V(-20, 2.5, -20)], "#6d9ad6");

// ---------------- execution: a pulse that travels the architecture and down the stem as kernels
const pulseMat = new THREE.MeshBasicMaterial({ color: "#ffb347", transparent: true }); pulseMat.userData.base = 1; groups.execution.push(pulseMat);
const pulse = new THREE.Mesh(new THREE.SphereGeometry(0.9, 24, 16), pulseMat); scene.add(pulse);
const halo = new THREE.Mesh(new THREE.SphereGeometry(1.8, 24, 16), new THREE.MeshBasicMaterial({ color: "#ffb347", transparent: true, opacity: 0.18 })); pulse.add(halo);
groups.execution.push(Object.assign(halo.material, { userData: { base: 0.18 } }));
const trail = []; for (let i = 0; i < 14; i++) { const m = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), new THREE.MeshBasicMaterial({ color: "#ffb347", transparent: true, opacity: 0.0 })); scene.add(m); trail.push(m); }
const pulseLbl = label("", V(0, 0, 0), "execution", always);
pulse.add(pulseLbl.o); pulseLbl.o.position.set(0, 3.2, 0);
// weight stream VRAM -> L2 -> SMs (kernel traffic), and a packet on PCIe (transfers)
const stream = []; for (let i = 0; i < 60; i++) { const m = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), new THREE.MeshBasicMaterial({ color: "#ffd27a", transparent: true, opacity: 0 })); scene.add(m); stream.push({ m, u: Math.random(), lane: i % 4 }); }
const packet = new THREE.Mesh(new THREE.SphereGeometry(1.1, 16, 12), new THREE.MeshBasicMaterial({ color: "#ffffff" })); scene.add(packet);

const STEM = [V(-8, 33, -22), V(-8, 22, -22), V(-8, 13, -22), V(-20, 3, -20), ...pciePath.getPoints(12).slice(1), V(20, 4, 15)];
function pulseHome(n) {
  if (n.kernel) return { pos: V(20, 4, 15), route: true };
  const id = n.comp; const P = AP[id];
  return P ? { pos: P.c.clone().add(V(0, 2.6, 0)), route: false } : { pos: V(0, 30, 0), route: false };
}
let path = [], lastRoute = false;
function setPulseTarget(n) {
  const { pos, route } = pulseHome(n);
  if (route && !lastRoute) path = STEM.map((p) => p.clone());
  else if (!route && lastRoute) path = [...STEM].reverse().map((p) => p.clone()).concat([pos]);
  else path = [pos];
  lastRoute = route;
}

// ---------------- camera flying
function frame(c, r, dir) { const d = dir.clone().normalize().multiplyScalar(r / Math.tan((camera.fov * Math.PI) / 360) * 1.0); return { target: c, pos: c.clone().add(d) }; }
const BOARD = V(2, 2, 2), WORLD = V(-5, 18, -2), GPUC = V(32, 2, 15), SMC = V(20, 2.6, 14.5);
const containerOf = (id) => { let x = byId.get(id); while (x && x.tier > 2) x = byId.get(x.parent); return x?.id; };
const processOf = (id) => { let x = byId.get(id); while (x && x.tier > 3) x = byId.get(x.parent); return x?.id; };
function view(s, n) {
  const ap = (id, k = 1, dir = V(0.15, 0.8, 1)) => { const P = AP[id]; return P ? frame(P.c, Math.max(P.s.x, P.s.y, P.s.z) * k, dir) : frame(WORLD, 70, V(0, 0.8, 1)); };
  if (s.dim === "hardware") return [frame(BOARD, 80, V(0, 1.4, 0.9)), frame(BOARD, 66, V(0, 1.1, 0.75)), frame(V(-8, 2, 2), 54, V(0, 1, 0.6)),
    frame(GPUC, 36, V(0, 1, 0.55)), frame(V(30, 2.6, 15), 26, V(0, 1, 0.45)), frame(V(10, 2.6, 4), 5, V(0.3, 1, 0.6))][s.tier];
  if (s.dim === "architecture") {
    if (s.tier <= 1) return frame(WORLD, s.tier ? 72 : 88, V(0.2, 0.7, 1));
    if (s.tier === 2) return ap(containerOf(n.comp), 1.5);
    if (s.tier === 3) return ap(processOf(n.comp), 1.6);
    if (s.tier === 4) return ap(n.comp, 3.2, V(0.3, 0.9, 1));
    return frame(V(-8, 18, -22), 16, V(1, 0.5, 1));
  }
  if (s.tier <= 1) return frame(WORLD, s.tier ? 74 : 88, V(0.1, 0.8, 1));
  if (s.tier === 2) return n.kernel || n.comp === "b.forward" ? frame(V(8, 14, -4), 48, V(0.35, 0.9, 1)) : ap(processOf(n.comp), 1.7, V(0.3, 0.9, 1));
  if (s.tier === 3) return frame(V(8, 10, -2), 44, V(0.2, 1, 0.9));
  return s.tier === 4 ? frame(V(12, 10, 0), 40, V(0.3, 1, 0.8)) : frame(V(14, 8, 2), 34, V(0.25, 1, 0.8));
}
let tween = null, lastTo = null;
function flyCamera(v) {
  if (lastTo && lastTo.target.distanceTo(v.target) < 0.01 && lastTo.pos.distanceTo(v.pos) < 0.01) return;
  lastTo = v; tween = { from: { target: controls.target.clone(), pos: camera.position.clone() }, to: v, t0: performance.now(), dur: 900 };
}

// ---------------- HUD
const $ = (sel) => document.querySelector(sel);
$("#keys").innerHTML = KEYS.map(([k, d]) => `<kbd>${k}</kbd> ${d}`).join("<br>");
const spark = $("#tl .spark"); spark.innerHTML = SAMPLES.map((x) => `<i style="height:${Math.max(4, x.dram * 100)}%"></i>`).join("");
$("#tl .row").addEventListener("click", (e) => { const r = e.currentTarget.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * END); });
const pct = (x) => `<span class="bar"><i style="width:${Math.round(x * 100)}%"></i></span>${Math.round(x * 100)}%`;
const short = (u) => (u ? u.name.replace(/ \(.*\)$/, "") : "before the first iteration");
function hud(s, n) {
  const col = COLOR[s.dim];
  $("#focus h1").innerHTML = `<span style="color:${col}">${s.dim}</span> › ${tierName()}`;
  $("#focus .cap").textContent = CAPTION[s.dim][s.tier];
  const align = ALIGN.find((r) => r[s.dim] === tierName()) ?? ALIGN[s.tier];
  $("#ladders").innerHTML = DIMS.map((d) => `<div class="col"><h3 style="color:${COLOR[d]}">${d.slice(0, 4)}</h3>${LADDERS[d].map((t, i) => {
    const f = d === s.dim && i === s.tier, al = d !== s.dim && align[d] === t;
    return `<div class="${f ? "f" : al ? "al" : ""}" style="${f ? `background:${col}` : ""}">${i + 1} ${t}</div>`; }).join("")}</div>`).join("");
  const ex = n.exec, sm = n.sample, k = n.kernel;
  const tr = n.transfers.map((x) => `${x.what}, ${x.bytes} B`).join("; ");
  const arch = n.archPath.filter((id) => byId.get(id).tier >= 2).map((id) => byId.get(id).name);
  $("#now").innerHTML = `<h2>Now at t = ${(s.t / 1000).toFixed(3)} ms</h2>
    <div class="sec ${s.dim === "execution" ? "focus" : ""}" style="border-color:${COLOR.execution}"><b style="color:${COLOR.execution}">Execution</b>
      <div>${short(ex[1])}</div><div class="k">phase</div><div>${short(ex[2])}</div>
      ${ex[3] && ex[3].t1 > s.t && ex[3].t0 <= s.t ? `<div class="k">layer · module</div><div>${short(ex[3])} · ${short(ex[4])}</div>` : ""}
      ${k ? `<div class="k">kernel</div><div>${k.name} · grid ${k.gpu.grid} · ${(k.t1 - k.t0)} µs</div>` : ""}</div>
    <div class="sec ${s.dim === "hardware" ? "focus" : ""}" style="border-color:${COLOR.hardware}"><b style="color:${COLOR.hardware}">Hardware, 100 µs sample</b>
      <div>SM active ${pct(sm.smActive / 36)} ${sm.smActive}/36</div><div>DRAM bw ${pct(sm.dram)}</div><div>PCIe ${pct(sm.pcie)}</div>
      ${k ? `<div class="k">this kernel</div><div>${k.gpu.sms} SMs · ${k.gpu.dramMB} MB from VRAM${k.gpu.profiled ? "" : " (not profiled, inferred)"}</div>` : ""}
      ${tr ? `<div class="k">transfer in flight</div><div>${tr}</div>` : ""}</div>
    <div class="sec ${s.dim === "architecture" ? "focus" : ""}" style="border-color:${COLOR.architecture}"><b style="color:${COLOR.architecture}">Architecture</b>
      ${arch.map((a, i) => `<div style="padding-left:${i * 10}px">${i ? "└ " : ""}${a}</div>`).join("")}</div>`;
  const S = stops();
  $("#tl .hd .a").innerHTML = `Stops of <b>${s.dim} › ${tierName()}</b>: ${S.length} · bars = DRAM bw samples (state, not stops)`;
  const idx = S.findIndex((x) => Math.abs(x.t - s.t) < 1e-6);
  $("#tl .hd .b").innerHTML = idx >= 0 ? `<b>${idx + 1}/${S.length}</b> ${S[idx].label}` : "between stops";
  const row = $("#tl .row"); row.querySelectorAll(".tick,.cur").forEach((e) => e.remove());
  row.insertAdjacentHTML("beforeend", S.map((x) => `<i class="tick" style="left:${(x.t / END) * 100}%;background:${col}"></i>`).join("") + `<i class="cur" style="left:${(s.t / END) * 100}%"></i>`);
}

// ---------------- state -> world
const HOT = new THREE.Color("#ffb347"), WARM = new THREE.Color("#6fe0b4"), COLD_SM = new THREE.Color("#22392f");
let cur = null;
function apply(s) {
  const n = now(); cur = n;
  for (const [d, mats] of Object.entries(groups)) for (const m of mats) m.opacity = m.userData.base * (d === s.dim ? 1 : d === "execution" ? 0.85 : 0.32);
  board.material.opacity = 1;
  for (const L of LBL) { L.o.visible = !!L.show(s); L.el.classList.toggle("dim", L.dim !== s.dim && L.dim !== "execution"); }
  // samples as state on the hardware
  const k = n.kernel;
  SM.forEach((m, i) => {
    const c = k && i < k.gpu.sms ? HOT : i < n.sample.smActive ? WARM.clone().lerp(COLD_SM, 0.55) : COLD_SM;
    m.material.color.copy(c); m.material.emissive.copy(k && i < k.gpu.sms ? new THREE.Color("#7a4300") : new THREE.Color(0));
  });
  VRAM.forEach((m) => { m.material.emissive.setRGB(0.5 * n.sample.dram, 0.3 * n.sample.dram, 0); });
  pcieMat.emissive.set(n.transfers.length ? "#2a8f6a" : "#000000");
  for (const id of ["cpu", "nic", "nvme", "gpu"]) HWP[id].mesh.material.emissive.set(n.hwActive.has(id) ? "#1a3a2e" : "#000000");
  for (const [id, P] of Object.entries(AP)) {
    const on = n.archPath.includes(id) || (id === "sw.toolkit" || id === "sw.runtime") && n.archPath.includes("sw.device");
    P.mesh.material.emissive.set(on ? "#1e4a80" : "#000000"); P.em.color.set(on ? "#cfe4ff" : "#5d8fd0"); P.lbl.el.classList.toggle("on", on);
  }
  sysLbl.el.textContent = `GPU ${Math.round(n.sample.gpuUtil * 100)}% · VRAM ${n.sample.vramGiB} / 16 GiB · CPU ${Math.round(n.sample.cpu * 100)}%`;
  smLbl.el.textContent = k ? `${k.name}: ${k.gpu.sms}/36 SMs · ${k.gpu.dramMB} MB from VRAM` : `idle GPU · ${n.sample.smActive}/36 SMs active in this sample`;
  const tierUnit = s.dim === "execution" ? n.exec[s.tier] : k ?? n.exec[2];
  pulseLbl.el.textContent = short(tierUnit);
  setPulseTarget(n);
  flyCamera(view(s, n));
  hud(s, n);
}

// ---------------- loop
function resize() { const w = stage.clientWidth, h = stage.clientHeight; renderer.setSize(w, h); labels.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); }
addEventListener("resize", resize); resize();
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
let last = performance.now();
function tick(t) {
  const dt = Math.min(0.05, (t - last) / 1000); last = t;
  if (tween) {
    const u = ease(Math.min(1, (t - tween.t0) / tween.dur));
    controls.target.lerpVectors(tween.from.target, tween.to.target, u); camera.position.lerpVectors(tween.from.pos, tween.to.pos, u);
    if (u >= 1) tween = null;
  }
  controls.update();
  if (path.length) { const p = path[0], d = p.clone().sub(pulse.position), step = 70 * dt; if (d.length() <= step) { pulse.position.copy(p); path.shift(); } else pulse.position.add(d.setLength(step)); }
  trail.forEach((m, i) => { m.position.lerp(i ? trail[i - 1].position : pulse.position, 0.35); m.material.opacity = 0.35 * (1 - i / trail.length) * groups.execution[0].opacity; });
  halo.scale.setScalar(1 + 0.15 * Math.sin(t / 180));
  const k = cur?.kernel;
  for (const p of stream) {
    p.m.material.opacity = k ? 0.9 : 0;
    if (!k) continue;
    p.u += dt * (0.25 + Math.min(1.5, k.gpu.dramMB / 20));
    if (p.u > 1) p.u -= 1;
    const a = V(56, 3.4, 4 + p.lane * 7.5), b = V(40, 3.2, 4 + p.lane * 7.5), c = HWP[`sm${(p.lane * 7 + Math.floor(p.u * 97)) % Math.max(1, k.gpu.sms)}`].top;
    p.m.position.copy(p.u < 0.5 ? a.lerp(b, p.u * 2) : b.lerp(c, (p.u - 0.5) * 2));
  }
  const tr = cur?.transfers?.[0];
  packet.visible = !!tr;
  if (tr) { const u = (t / 1600) % 1; packet.position.copy(pciePath.getPoint(tr.from === "ram" ? u : 1 - u)); }
  renderer.render(scene, camera); labels.render(scene, camera);
  requestAnimationFrame(tick);
}
pulse.position.set(-62, 40, -22);
camera.position.set(0, 140, 140); controls.target.copy(WORLD);
subscribe(apply);
requestAnimationFrame((t) => { tick(t); window.READY = true; });
