// D. Orbit cube: one prism, time along its long edge. Front face = execution, floor = hardware, back = architecture.
// Each face holds six translucent layers, coarse at the surface and finer deeper inside. Flying ↓ pushes the camera
// into the face; crossing a dimension orbits the camera round the time axis to that face at the aligned depth.
import * as THREE from "three";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { state, subscribe, now, stops, tierName, mountChrome, data, DIMS } from "../model.js";

const { LADDERS, ALIGN, EXEC, ARCH, HW, TRANSFERS, SAMPLES, END, byId } = data;

const W = 400, S = W / END, R = 0.3 * W, GAP = R / 6.5;
const X = (t) => (t - END / 2) * S;
const FACE = { execution: 0, hardware: Math.PI / 2, architecture: Math.PI };
const HUE = { execution: 0x7cc4ff, hardware: 0xffb454, architecture: 0xc39bff };
const KEY = { execution: "E", hardware: "H", architecture: "A" };
// visible time window per tier, as a fraction of the request
const WIN = { execution: [1.1, .5, .25, .1, .045, .018], hardware: [1.1, 1.1, .4, .1, .045, .03], architecture: [1.1, 1.1, 1.1, 1.1, .5, .045] };
const win = (dim, k) => WIN[dim][k] * END;
const layerZ = (k) => R - k * GAP;
const FOV = 45;

// ---------------- three.js setup
const stage = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setClearColor(0x070a10);
stage.append(renderer.domElement);
const css = new CSS2DRenderer({ element: document.getElementById("labels") });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 5000);
function resize() {
  renderer.setSize(innerWidth, innerHeight); css.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
}
addEventListener("resize", resize); resize();

// ---------------- layers: [{dim, k, group, items, rowLabels, h, factor}]
const LAYERS = [];
const faceGroups = {};
function label(text, cls = "lbl") { const el = document.createElement("div"); el.className = cls; el.textContent = text; return new CSS2DObject(el); }

function makeLayer(dim, k) {
  const g = new THREE.Group(); g.position.z = layerZ(k); faceGroups[dim].add(g);
  const L = { dim, k, group: g, items: [], rowLabels: [], h: (dim === "execution" ? 0.13 : 0.3) * win(dim, k) * S, factor: 0.05 };
  // cursor line on every layer: together they form the slice through the prism
  const cm = new THREE.MeshBasicMaterial({ color: 0x5ef2d6, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  L.cursor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), cm); L.cursor.position.z = 0.05; g.add(L.cursor);
  LAYERS.push(L); return L;
}
function box(L, t0, t1, v, h, color, { base = 0.6, text = null, minW = 0 } = {}) {
  const w = Math.max((t1 - t0) * S * 0.97, minW || 0.02 * WIN[L.dim][L.k]);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, Math.max(h, 0.001)), mat);
  m.position.set(X((t0 + t1) / 2), v, 0); L.group.add(m);
  const it = { mesh: m, mat, base, t0, t1, w, hl: false, color: new THREE.Color(color) };
  if (text) { it.lbl = label(text); it.lbl.position.set(X((t0 + t1) / 2), v, 0.1); it.lbl.visible = false; L.group.add(it.lbl); }
  L.items.push(it); return it;
}
function rows(L, names, every = 1) {
  const rh = L.h / names.length;
  const vs = names.map((_, i) => L.h / 2 - (i + 0.5) * rh);
  names.forEach((n, i) => {
    if (i % every) return;
    const o = label(n, "row-lbl"); o.center.set(0, 0.5); o.position.set(0, vs[i], 0.1); o.visible = false;
    L.group.add(o); L.rowLabels.push(o);
  });
  return { rh, v: vs };
}
const shade = (hex, l) => new THREE.Color(hex).offsetHSL(0, 0, l);
const units = (tier) => EXEC.filter((u) => u.tier === tier).sort((a, b) => a.t0 - b.t0);
const phases = units(2), kernels = units(5);

for (const dim of DIMS) {
  const g = new THREE.Group(); g.rotation.x = FACE[dim]; scene.add(g); faceGroups[dim] = g;
  const f = label(dim.toUpperCase() + " face", "face-lbl"); f.element.style.color = "#" + HUE[dim].toString(16);
  f.position.set(X(0) - 6, R * 0.55, R + 1); f.center.set(1, 0.5); g.add(f); faceGroups[dim].title = f;
}

// ---------------- execution face: nested time bands
for (let k = 0; k < 6; k++) {
  const L = makeLayer("execution", k);
  units(k).forEach((u, i) => box(L, u.t0, u.t1, 0, L.h, shade(HUE.execution, i % 2 ? -0.18 : -0.05), { base: 0.55, text: u.name }));
}

// ---------------- hardware face: system samples > board > device copies > GPU units > kernel traffic > SM internals
{
  const H = HUE.hardware;
  const strip = (L, r, i, val, tag) => SAMPLES.forEach((s) => {
    const v = Math.max(0, Math.min(1, val(s)));
    box(L, s.t, s.t + 100, r.v[i] - r.rh / 2 + (v * r.rh * 0.85) / 2, v * r.rh * 0.85, shade(H, -0.1 + v * 0.15), { base: 0.35 + v * 0.6 });
  });
  let L = makeLayer("hardware", 0);
  const sysRows = [["GPU util", (s) => s.gpuUtil], ["SMs active (of 36)", (s) => s.smActive / 36], ["DRAM bandwidth", (s) => s.dram], ["CPU", (s) => s.cpu], ["PCIe", (s) => s.pcie * 10]];
  let r = rows(L, sysRows.map((x) => x[0] + " · 100 µs samples"));
  sysRows.forEach(([, fn], i) => strip(L, r, i, fn));

  L = makeLayer("hardware", 1);
  const dev = ["cpu", "ram", "pcie", "dmi", "nvme", "nic", "gpu", "vram"];
  r = rows(L, dev.map((id) => byId.get(id).name));
  const on = (id, t0, t1, text) => dev.includes(id) && box(L, t0, t1, r.v[dev.indexOf(id)], r.rh * 0.7, shade(H, -0.1), { base: 0.5, text });
  phases.forEach((p) => p.hw.forEach((id) => on(id, p.t0, p.t1)));
  units(3).forEach((u) => on("vram", u.t0, u.t1, "weights read"));
  TRANSFERS.forEach((x) => [x.from, x.to, "pcie"].forEach((id) => on(id, x.t0, x.t1)));

  L = makeLayer("hardware", 2);
  const d2 = ["cpu", "ram", "pcie", "vram", "gpu", "nic"];
  r = rows(L, d2.map((id) => byId.get(id).name));
  const v2 = (id) => r.v[d2.indexOf(id)];
  phases.forEach((p) => p.hw.forEach((id) => d2.includes(id) && box(L, p.t0, p.t1, v2(id), r.rh * 0.5, shade(H, -0.28), { base: 0.3 })));
  TRANSFERS.forEach((x) => {
    box(L, x.t0, x.t1, v2("pcie"), r.rh * 0.8, 0xffd27a, { base: 0.95, text: `${x.what}: ${x.bytes} B`, minW: 1.2 });
    const a = v2(x.from), b = v2(x.to);
    box(L, x.t0, x.t1, (a + b) / 2, Math.abs(a - b), 0xffd27a, { base: 0.35, minW: 0.4 });
  });

  L = makeLayer("hardware", 3);
  const u3 = ["DRAM bandwidth · sample", ...Array.from({ length: 36 }, (_, i) => `SM ${i}`), "L2 32 MiB", "copy engine 0"];
  r = rows(L, u3, 1);
  L.rowLabels.forEach((o, i) => { if (i > 0 && i < 37 && (i - 1) % 6) o.element.dataset.skip = "1"; });
  strip(L, r, 0, (s) => s.dram);
  kernels.forEach((u) => {
    const top = r.v[1] + r.rh / 2, hh = u.gpu.sms * r.rh;
    box(L, u.t0, u.t1, top - hh / 2, hh, shade(H, 0.05), { base: 0.75, text: `${u.name} · ${u.gpu.sms} of 36 SMs` });
    box(L, u.t0, u.t1, r.v[37], r.rh * 0.7, shade(H, -0.1), { base: 0.5 });
  });
  TRANSFERS.forEach((x) => box(L, x.t0, x.t1, r.v[38], r.rh * 0.7, 0xffd27a, { base: 0.9, text: x.what }));

  L = makeLayer("hardware", 4);
  r = rows(L, ["DRAM bytes (ncu)", "L2 bytes (ncu)"]);
  const lg = (mb) => Math.log1p(mb) / Math.log1p(140);
  kernels.forEach((u) => {
    const p = u.gpu.profiled, base = p ? 0.85 : 0.12;
    [[u.gpu.dramMB, 0], [u.gpu.l2MB, 1]].forEach(([mb, i]) => {
      const hh = lg(mb) * r.rh * 0.9;
      box(L, u.t0, u.t1, r.v[i] - r.rh / 2 + hh / 2, hh, shade(H, i ? -0.15 : 0.05), { base, text: i ? null : p ? `${u.name}: ${u.gpu.dramMB} MB DRAM, ${u.gpu.l2MB} MB L2` : `${u.name}: not profiled` });
    });
  });

  L = makeLayer("hardware", 5);
  r = rows(L, ["warps, shared memory, registers"]);
  kernels.filter((u) => u.gpu.profiled).forEach((u) => box(L, u.t0, u.t1, r.v[0], r.rh * 0.7, shade(H, -0.05), { base: 0.7, text: `${u.name}: open in Nsight Compute (link only)` }));
}

// ---------------- architecture face: containers > processes > boxes > toolkit / runtime / device
{
  const A = HUE.architecture;
  const anc = (id, tier) => { let x = byId.get(id); while (x && x.tier > tier) x = byId.get(x.parent); return x; };
  for (let k = 0; k < 5; k++) {
    const L = makeLayer("architecture", k);
    const things = ARCH.filter((a) => a.tier === k);
    const r = rows(L, things.map((a) => a.name));
    if (k < 2) { box(L, 0, END, r.v[0], r.rh * 0.6, shade(A, -0.1), { base: 0.5, text: "busy for the whole request" }); continue; }
    phases.forEach((p, i) => {
      const a = anc(p.comp, k); const j = things.indexOf(a); if (j < 0) return;
      box(L, p.t0, p.t1, r.v[j], r.rh * 0.75, shade(A, i % 2 ? -0.15 : 0), { base: 0.65, text: p.name });
    });
  }
  const L = makeLayer("architecture", 5);
  const r = rows(L, ["toolkit: TRT-LLM Python, PyTorch ops", "runtime: CUDA runtime + driver", "device code: kernels"]);
  kernels.forEach((u) => {
    box(L, u.cpuT, u.cpuT + 2, r.v[0], r.rh * 0.7, shade(A, 0), { base: 0.7, text: "PyTorch op" });
    box(L, u.cpuT + 2, u.cpuT + 4, r.v[1], r.rh * 0.7, shade(A, -0.1), { base: 0.7, text: u.launch });
    box(L, u.t0, u.t1, r.v[2], r.rh * 0.7, shade(A, 0.08), { base: 0.75, text: u.name });
  });
}

// the slice plane: one plane across the prism at the cursor, cutting all three faces
const slice = new THREE.Group(); scene.add(slice);
const sliceMat = new THREE.MeshBasicMaterial({ color: 0x5ef2d6, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
const sp = new THREE.Mesh(new THREE.PlaneGeometry(2.3 * R, 2.3 * R), sliceMat); sp.rotation.y = Math.PI / 2; slice.add(sp);
const se = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(2.3 * R, 2.3 * R)), new THREE.LineBasicMaterial({ color: 0x5ef2d6, transparent: true, opacity: 0.6 }));
se.rotation.y = Math.PI / 2; slice.add(se);
// prism frame: the four long edges
const prism = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(W * 1.02, 2 * R + 2, 2 * R + 2)), new THREE.LineBasicMaterial({ color: 0x334055 }));
scene.add(prism);

// ---------------- camera: continuous params tweened toward the position
const cam = { theta: FACE[state.dim], x: 0, z: layerZ(state.tier), logd: 0 };
const target = () => {
  const w = win(state.dim, state.tier) * S;
  const d = w / (2 * Math.tan((FOV * Math.PI) / 360) * camera.aspect);
  const half = w / 2; const lo = X(0) + half, hi = X(END) - half;
  const x = lo >= hi ? 0 : Math.max(lo, Math.min(hi, X(state.t)));
  return { theta: FACE[state.dim], x, z: layerZ(state.tier), logd: Math.log(d), w };
};
{ const t = target(); Object.assign(cam, t); }
const AX = new THREE.Vector3(1, 0, 0);
let viewW = target().w;

function landTier(dim) { if (dim === state.dim) return state.tier; const row = ALIGN.find((r) => r[state.dim] === tierName()) ?? ALIGN[state.tier]; return LADDERS[dim].indexOf(row[dim]); }

// ---------------- HUD
const $ = (id) => document.getElementById(id);
const hex = (d) => "#" + HUE[d].toString(16);
function drawHud() {
  const s = state, n = now();
  $("fdim").innerHTML = `<span style="color:${hex(s.dim)}">${s.dim}</span> › ${tierName()}`;
  $("fsub").textContent = `tier ${s.tier + 1} of 6 · depth ${s.tier} inside the ${s.dim} face · cursor fixed while flying`;
  $("ladders").innerHTML = DIMS.map((d) => {
    const lt = landTier(d), c = hex(d);
    return `<div class="lad"><h4 style="color:${c}"><kbd>${KEY[d]}</kbd>${d}${d === s.dim ? " · here" : ` · lands on ${LADDERS[d][lt]}`}</h4><div class="rungs">${LADDERS[d]
      .map((name, i) => `<div class="rung ${d === s.dim && i === s.tier ? "on" : ""} ${d !== s.dim && i === lt ? "land" : ""}" style="${d === s.dim && i === s.tier ? `background:${c}` : d !== s.dim && i === lt ? `color:${c}` : ""}" title="${name}">${name}</div>`).join("")}</div></div>`;
  }).join("");
  // execution
  const ex = LADDERS.execution.map((tn, i) => `<div class="row ${s.dim === "execution" && s.tier === i ? "on" : ""}"><span class="k">${tn}</span><span class="v">${n.exec[i] && n.exec[i].t1 > s.t && n.exec[i].t0 <= s.t ? n.exec[i].name : "<span style='color:#66758a'>none at the cursor</span>"}</span></div>`).join("");
  const sm = Array.from({ length: 36 }, (_, i) => `<i class="${n.kernel && i < n.kernel.gpu.sms ? "on" : ""}"></i>`).join("");
  const meter = (k, v, txt) => `<div class="row"><span class="k">${k}</span><div class="meter"><b style="width:${Math.round(v * 100)}%"></b></div><span style="width:70px;text-align:right">${txt}</span></div>`;
  const devs = ["cpu", "ram", "pcie", "nic", "gpu", "vram"].filter((id) => n.hwActive.has(id)).map((id) => byId.get(id).name.split(" (")[0]).join(", ");
  const hw = `<div class="row"><span class="k">busy</span><span class="v">${devs || "idle"}</span></div>
    ${meter("SMs active", n.sample.smActive / 36, `${n.sample.smActive} / 36`)}${meter("DRAM bw", n.sample.dram, Math.round(n.sample.dram * 100) + " %")}${meter("PCIe", n.sample.pcie * 10, Math.round(n.sample.pcie * 100) + " %")}
    <div class="row"><span class="k">kernel grid</span><span class="v">${n.kernel ? `${n.kernel.name} on ${n.kernel.gpu.sms} SMs` : "no kernel running"}</span></div><div id="sm">${sm}</div>
    ${n.transfers.map((x) => `<div class="row"><span class="k">copy</span><span class="v">${x.what}: ${x.bytes} B</span></div>`).join("")}`;
  const arch = n.archPath.map((id) => byId.get(id)).map((a) => `<div class="row ${s.dim === "architecture" && s.tier === a.tier ? "on" : ""}"><span class="k">${LADDERS.architecture[a.tier]}</span><span class="v">${a.name}</span></div>`).join("");
  $("now").innerHTML = `<h3 style="color:${hex("execution")}">Execution · what runs</h3>${ex}<h3 style="color:${hex("hardware")}">Hardware · where (100 µs sample = state)</h3>${hw}<h3 style="color:${hex("architecture")}">Architecture · who owns it</h3>${arch}`;
  // stops
  const st = stops(), cur = st.find((x) => x.ref === s.sel && Math.abs(x.t - s.t) < 1e-6) ?? [...st].reverse().find((x) => x.t <= s.t);
  $("stopname").innerHTML = `${cur ? (cur.t === s.t ? "" : "last stop before the cursor: ") + cur.label : "before the first stop"} <span>· ${st.length} stops on ${s.dim} › ${tierName()} · t = ${(s.t / 1000).toFixed(3)} ms</span>`;
  $("track").innerHTML = st.map((x) => `<div class="tick ${x === cur ? "sel" : ""}" style="left:${(x.t / END) * 100}%"></div>`).join("") +
    `<div class="win"></div><div class="cur" style="left:${(s.t / END) * 100}%"></div><span class="ax" style="left:0">0 ms</span><span class="ax" style="right:0">${(END / 1000).toFixed(2)} ms</span>`;
}
function drawOrbit() {
  const svg = $("orbitsvg");
  // cross-section seen down the time axis: front (E) at bottom-right... drawn as a square, camera dot on a circle
  const pos = (th, r) => [r * Math.sin(th), r * Math.cos(th)]; // θ=0 → front (down in the sketch), θ=90° → floor
  const lab = DIMS.map((d) => { const [x, y] = pos(FACE[d], 30); return `<text x="${x}" y="${y + 4}" fill="${hex(d)}" font-size="12" font-weight="700" text-anchor="middle">${KEY[d]}</text>`; }).join("");
  const [cx, cy] = pos(cam.theta, 40);
  svg.innerHTML = `<rect x="-20" y="-20" width="40" height="40" fill="none" stroke="#334055"/><circle r="40" fill="none" stroke="#ffffff14"/>${lab}<circle cx="${cx}" cy="${cy}" r="5" fill="#5ef2d6"/>`;
  $("orbittxt").innerHTML = `camera orbit round the time axis<br>E front · H floor · A back`;
}

// ---------------- per state: highlights
function onState() {
  const t = state.t;
  for (const L of LAYERS) for (const it of L.items) it.hl = it.t0 <= t && it.t1 > t;
  drawHud();
}

// ---------------- frame loop
let last = performance.now(), firstDrawn = false;
function frame(ts) {
  const dt = Math.min(0.1, (ts - last) / 1000); last = ts;
  const tg = target(); const a = 1 - Math.exp(-dt * 4.5);
  for (const k of ["x", "z", "logd"]) cam[k] += (tg[k] - cam[k]) * a;
  cam.theta += (tg.theta - cam.theta) * (1 - Math.exp(-dt * 1.8)); // slow orbit, so the pull-back reads
  if (!firstDrawn) Object.assign(cam, tg);
  const turn = Math.min(1, Math.abs(tg.theta - cam.theta) / (Math.PI / 2));
  const d = Math.exp(cam.logd) + turn * W * 0.9; // pull back while orbiting, so the prism and the slice show
  viewW = 2 * d * Math.tan((FOV * Math.PI) / 360) * camera.aspect;
  camera.position.set(cam.x, 0, cam.z + d).applyAxisAngle(AX, cam.theta);
  camera.up.set(0, 1, 0).applyAxisAngle(AX, cam.theta);
  camera.lookAt(new THREE.Vector3(cam.x, 0, cam.z).applyAxisAngle(AX, cam.theta));

  // layer emphasis: focused layer bright, finer layers faint behind it, coarser ones nearly gone, other faces dim
  const xt = X(state.t), thick = Math.max(0.03, viewW * 0.0016);
  for (const L of LAYERS) {
    const focusFace = L.dim === state.dim;
    const tgt = focusFace ? (L.k === state.tier ? 1 : L.k > state.tier ? 0.16 / (L.k - state.tier) : 0.08 * turn)
      : (L.k === landTier(L.dim) ? 0.03 + 0.5 * turn : 0.01 + 0.1 * turn);
    L.factor += (tgt - L.factor) * a;
    const focused = focusFace && L.k === state.tier;
    for (const it of L.items) it.mat.opacity = Math.min(1, (it.hl ? Math.min(1, it.base * 1.6 + 0.2) : it.base) * L.factor);
    L.cursor.position.x = xt; L.cursor.scale.set(thick, L.h * 1.12, 1); L.cursor.material.opacity = Math.min(1, 0.25 + L.factor);
    // labels: the focused layer only; an item label shows when it is wide enough on screen or under the cursor
    const pxPer = innerWidth / viewW, left = cam.x - viewW / 2;
    for (const it of L.items) if (it.lbl) {
      const sx = it.w * pxPer, inView = X(it.t1) > left && X(it.t0) < left + viewW;
      const show = focused && turn < 0.2 && inView && (sx > 110 || it.hl);
      it.lbl.visible = show;
      if (show) { it.lbl.element.style.maxWidth = (it.hl ? Math.max(260, Math.min(sx, 520)) : Math.min(sx - 12, 460)) + "px"; it.lbl.element.style.zIndex = it.hl ? 5 : 1; it.lbl.element.classList.toggle("hl", it.hl); }
    }
    for (const o of L.rowLabels) { o.visible = focused && turn < 0.2 && !o.element.dataset.skip; o.position.x = left + viewW * 0.18; }
  }
  for (const d of DIMS) faceGroups[d].title.visible = turn > 0.25 || state.tier === 0;
  slice.position.x = xt; sliceMat.opacity = 0.14 * turn; se.material.opacity = 0.7 * turn;

  // window bracket on the stop track
  const wl = Math.max(0, (cam.x - viewW / 2) / W + 0.5), wr = Math.min(1, (cam.x + viewW / 2) / W + 0.5);
  const wb = document.querySelector("#track .win"); if (wb) { wb.style.left = wl * 100 + "%"; wb.style.width = Math.max(0, wr - wl) * 100 + "%"; }
  drawOrbit();

  renderer.render(scene, camera); css.render(scene, camera);
  if (!firstDrawn) { firstDrawn = true; window.READY = true; }
  requestAnimationFrame(frame);
}

mountChrome("cube");
subscribe(onState);
requestAnimationFrame(frame);
