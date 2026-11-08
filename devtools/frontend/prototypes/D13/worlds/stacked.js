// Stacked world (COMMAND_CENTER_DIMENSIONS.md section 2): the literal board, with data moving between CPU, RAM, PCIe,
// the GPU's SMs, L2, memory controllers and VRAM. The camera follows the hardware tier, the pulse the execution tier.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { state, subscribe, setTier, select, now, metricInputs, data, DIM_COLOR } from "../model.js";

const { byId, processOf, FLOW_COLOR } = data;
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const short = (u) => (u ? u.name.replace(/ \(.*\)$/, "") : "before the first iteration");
const CSS = `
.sw-lbl { font:600 12px ui-monospace, monospace; color:#d7dae0; background:#0f1115d9; border:1px solid #2a2f3a;
  padding:1px 6px; border-radius:4px; white-space:nowrap; pointer-events:none; }
.sw-lbl.big { font-size:13px; }
.sw-lbl.proc { border-left:4px solid var(--pc); color:#aab1bf; }
.sw-lbl.proc.on { color:#fff; background:#1b2230; border-color:var(--pc); }
.sw-lbl.pulse { color:#fff; border-color:var(--pc); background:#11161fee; font-size:13px; }
.sw-lbl.stat { color:${DIM_COLOR.hardware}; }
.sw-lbl.sel { outline:2px solid ${DIM_COLOR.hardware}; }`;

const BASE = "#262c37", EDGE = "#3a4352", WARM = new THREE.Color("#3a4454");
const GPU_SPOT = V(20, 5, 15);
const PLATES = { "p.client": V(-25, 8, -31), "p.http": V(-25, 8, -24), "p.worker": V(-25, 8, -17), "p.bridge": V(-52, 7, 8) };
const RUNS_ON = { "p.client": "cpu", "p.http": "cpu", "p.worker": "cpu", "p.bridge": "nic" };
const CONTAINER = { "p.client": "client", "p.http": "server", "p.worker": "server", "p.bridge": "network" };

/** Where an execution unit's work happens in this world: on the GPU, or at its process's plate. */
function homeOf(u) {
  if (!u) return PLATES["p.client"].clone().add(V(0, 2.5, 0));
  const gpu = u.tier >= 3 || (u.hw.includes("gpu") && ["b.forward", "b.sampler"].includes(u.comp));
  return gpu ? null : (PLATES[processOf(u.comp)] ?? PLATES["p.client"]).clone().add(V(0, 2.5, 0));
}

export function mount(el) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#0f1115");
  const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 2000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(devicePixelRatio);
  renderer.domElement.dataset.world = "stacked";
  Object.assign(renderer.domElement.style, { position: "absolute", inset: "0", display: "block" });
  const labels = new CSS2DRenderer();
  Object.assign(labels.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none", overflow: "hidden" });
  const style = document.createElement("style"); style.textContent = CSS;
  el.append(style, renderer.domElement, labels.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.3); sun.position.set(-40, 120, 60); scene.add(sun);

  const parts = new Map();
  const pickables = [];
  const LBL = [];
  function label(text, pos, show, cls = "") {
    const e = document.createElement("div"); e.className = `sw-lbl ${cls}`; e.textContent = text;
    const o = new CSS2DObject(e); o.position.copy(pos); scene.add(o);
    const L = { o, el: e, show }; LBL.push(L); return L;
  }
  function reg(id, mesh, mat, edge, glow) {
    const p = parts.get(id) ?? { meshes: [], mats: [], edges: [], glow };
    p.meshes.push(mesh); p.mats.push(mat); if (edge) p.edges.push(edge);
    parts.set(id, p); mesh.userData.pick = { kind: "hw", id }; pickables.push(mesh);
  }
  function part(id, c, s, color = BASE, glow = 0.45) {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1 }); mat.userData.base = new THREE.Color(color);
    const m = new THREE.Mesh(new THREE.BoxGeometry(s.x, s.y, s.z), mat); m.position.copy(c); scene.add(m);
    const em = new THREE.LineBasicMaterial({ color: EDGE }); m.add(new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), em));
    reg(id, m, mat, em, glow); return m;
  }
  function tube(id, curve, r, color) {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5 }); mat.userData.base = new THREE.Color(color);
    const m = new THREE.Mesh(new THREE.TubeGeometry(curve, 60, r, 10), mat); scene.add(m); reg(id, m, mat, null, 0.6);
  }
  const name = (id) => byId.get(id)?.name ?? id;
  const devTier = (t) => t <= 2, unitTier = (t) => t >= 3;

  // ---------------- the board
  const board = new THREE.Mesh(new THREE.BoxGeometry(150, 1, 95), new THREE.MeshStandardMaterial({ color: "#161a21" }));
  board.position.set(0, -0.6, 2); scene.add(board);
  part("cpu", V(-25, 1, -22), V(14, 2, 14), "#2b3342", 0.25);
  label(name("cpu"), V(-25, 2.5, -13), devTier, "big");
  for (let i = 0; i < 8; i++) part(`core${i}`, V(-29.5 + (i % 4) * 3, 2.4, -25 + Math.floor(i / 4) * 5), V(2.4, 0.8, 4), "#323c4d");
  for (let i = 0; i < 4; i++) part("ram", V(-10 + i * 2.6, 1.5, -22), V(1.4, 3, 22));
  label(name("ram"), V(-1, 3, -22), devTier, "big").o.center.set(0, 0.5);
  part("nic", V(-52, 1, 8), V(9, 2, 7));
  label(name("nic"), V(-52, 2.5, 13.5), devTier);
  part("nvme", V(-28, 0.6, 20), V(16, 1.2, 4.5));
  label(name("nvme"), V(-28, 1.5, 24.5), devTier);
  part("gpu", V(35, 1, 15), V(62, 2, 36), "#1d222b", 0.05);
  label(name("gpu"), V(22, 2.5, 35.5), devTier, "big");
  const SM = [];
  for (let i = 0; i < 36; i++) SM.push(part(`sm${i}`, V(10 + (i % 6) * 4, 2.6, 4 + Math.floor(i / 6) * 4.2), V(3.2, 1.2, 3.4)));
  label("36 SMs", V(20, 4, -1.5), unitTier, "big");
  part("l2", V(40, 2.4, 15), V(5, 0.8, 26));
  label(name("l2"), V(40, 3.5, 30), unitTier);
  for (let i = 0; i < 4; i++) { part("vram", V(56, 2.6, 4 + i * 7.5), V(7, 1.2, 6)); part(`mc${i}`, V(48.5, 2.3, 4 + i * 7.5), V(3, 0.6, 4)); }
  label("GDDR7 16 GiB (VRAM)", V(56, 4.5, 33.5), () => true, "big");
  label("4 memory controllers", V(48.5, 3.5, -1.5), unitTier);
  part("ce0", V(8, 2.3, 30), V(3, 0.6, 3)); part("ce1", V(12, 2.3, 30), V(3, 0.6, 3));
  label("copy engines", V(10, 3.5, 33), (t) => t === 3);
  const pciePath = new THREE.CatmullRomCurve3([V(-18, 1, -15), V(-14, 0.6, -6), V(-6, 0.6, 12), V(-2, 0.6, 30), V(3, 1.4, 30), V(6.5, 2.3, 30)]);
  tube("pcie", pciePath, 0.9, "#3a4757");
  label(name("pcie"), V(-8, 2.5, 8), devTier, "big");
  tube("dmi", new THREE.CatmullRomCurve3([V(-26, 1, -15), V(-27, 0.8, 4), V(-28, 0.8, 18)]), 0.5, "#3a3f4a");
  label(name("dmi"), V(-31, 2, 11), (t) => t >= 1 && t <= 2);
  const sysLbl = label("", V(0, 6, 48), (t) => t <= 1, "stat big");
  const smLbl = label("", V(30, 4.5, -7), unitTier, "stat");

  // SM internals, shown on the framed SM at the deepest hardware tier
  const smIn = new THREE.Group(); scene.add(smIn);
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.35, 1.4), new THREE.MeshStandardMaterial({ color: "#46536a" }));
    m.position.set(-0.75 + (i % 2) * 1.5, 0.8, -0.8 + Math.floor(i / 2) * 1.6); smIn.add(m);
  }
  const shm = new THREE.Mesh(new THREE.BoxGeometry(3, 0.2, 0.25), new THREE.MeshStandardMaterial({ color: "#6a5a3a" })); shm.position.set(0, 0.75, 1.6); smIn.add(shm);
  const smInLbl = label("4 sub-partitions (warp schedulers, register files) · L1 / shared memory. Per-warp detail: Nsight Compute",
    V(0, 0, 0), (t) => t === 5, "stat");

  // ---------------- architecture, minimal: which process runs on which hardware, coloured by process
  const plates = {};
  for (const [pid, c] of Object.entries(PLATES)) {
    const pc = "#6b7385"; // neutral: colour means flow, lit below by the flow running on this process
    const mat = new THREE.MeshStandardMaterial({ color: pc, transparent: true, opacity: 0.35, emissive: 0x000000 });
    const m = new THREE.Mesh(new THREE.BoxGeometry(pid === "p.bridge" ? 9 : 13, 0.5, 5), mat); m.position.copy(c); scene.add(m);
    m.userData.pick = { kind: "proc", id: pid }; pickables.push(m);
    const host = parts.get(RUNS_ON[pid]).meshes[0].position;
    const sm = new THREE.LineBasicMaterial({ color: pc, transparent: true, opacity: 0.5 });
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([c.clone().add(V(0, -0.25, 0)), V(c.x, host.y + 1, c.z)]), sm));
    const L = label(`${name(pid).split(/ \(|:/)[0]} [${CONTAINER[pid]}]`, c.clone().add(pid === "p.bridge" ? V(0, 0.3, -2.6) : V(-7, 0.3, 0)), () => true, "proc");
    L.o.center.set(pid === "p.bridge" ? 0.5 : 1, pid === "p.bridge" ? 1 : 0.5);
    L.el.style.setProperty("--pc", pc); L.el.title = name(pid);
    plates[pid] = { mat, L };
  }
  const gpuOwner = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(62.6, 2.2, 36.6)),
    new THREE.LineBasicMaterial({ color: "#6b7385", transparent: true, opacity: 0.45 }));
  gpuOwner.position.set(35, 1, 15); scene.add(gpuOwner);

  // ---------------- execution: the pulse, its trail, kernel traffic, and transfers on PCIe
  const pulseMat = new THREE.MeshBasicMaterial({ color: "#ffffff" });
  const pulse = new THREE.Mesh(new THREE.SphereGeometry(0.9, 24, 16), pulseMat); scene.add(pulse);
  pulse.userData.pick = { kind: "exec" }; pickables.push(pulse);
  const halo = new THREE.Mesh(new THREE.SphereGeometry(1.8, 24, 16), new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.2 })); pulse.add(halo);
  const trail = Array.from({ length: 14 }, () => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0 })); scene.add(m); return m;
  });
  const pulseLbl = label("", V(0, 0, 0), () => true, "pulse");
  pulse.add(pulseLbl.o); pulseLbl.o.position.set(0, 3.2, 0);
  const stream = Array.from({ length: 60 }, (_, i) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0 }));
    m.userData.pick = { kind: "kernel" }; scene.add(m); pickables.push(m); return { m, u: Math.random(), lane: i % 4 };
  });
  const packet = new THREE.Mesh(new THREE.SphereGeometry(1.2, 16, 12), new THREE.MeshBasicMaterial({ color: "#ffffff" }));
  packet.userData.pick = { kind: "transfer" }; scene.add(packet); pickables.push(packet);

  const ghosts = new THREE.Group(); scene.add(ghosts);

  const hoverBox = new THREE.Box3Helper(new THREE.Box3(), 0xffffff); hoverBox.visible = false; scene.add(hoverBox);
  const selBox = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(DIM_COLOR.hardware)); selBox.visible = false; scene.add(selBox);
  const boxOf = (id) => { const b = new THREE.Box3(); parts.get(id).meshes.forEach((m) => b.expandByObject(m)); return b; };

  // ---------------- pulse routing: crossing between host and GPU travels the PCIe cable
  const HOST_END = [PLATES["p.worker"].clone().add(V(0, 2.5, 0)), V(-20, 3, -16), ...pciePath.getPoints(10)];
  let path = [], lastSide = null;
  function gpuSpot(n, u) {
    const k = n.kernel;
    if (!k || (u && u.tier === 5 && u.id !== k.id)) return GPU_SPOT.clone();
    const c = V(0, 0, 0); for (let i = 0; i < k.gpu.sms; i++) c.add(SM[i].position);
    return c.divideScalar(k.gpu.sms).add(V(0, 3, 0));
  }
  function setPulseTarget(n, u, first) {
    const home = homeOf(u), side = home ? "host" : "gpu", pos = home ?? gpuSpot(n, u);
    if (first) { pulse.position.copy(pos); path = []; }
    else if (lastSide && side !== lastSide) path = (side === "gpu" ? HOST_END : [...HOST_END].reverse()).map((p) => p.clone()).concat([pos]);
    else path = [pos];
    lastSide = side;
  }

  // ---------------- camera
  function frame(c, r, dir) {
    const aspect = camera.aspect || 1;
    const d = r / Math.tan((camera.fov * Math.PI) / 360) / Math.min(1, aspect);
    return { target: c, pos: c.clone().add(dir.clone().normalize().multiplyScalar(d)) };
  }
  function view(s) {
    const t = s.tiers.hardware, sel = parts.has(s.sel) ? s.sel : null;
    const smSel = sel && /^sm\d+$/.test(sel) ? sel : "sm0";
    if (t === 5) return frame(parts.get(smSel).meshes[0].position.clone(), 5.5, V(0.25, 1, 0.75));
    if (sel && byId.get(sel).tier === t) {
      const b = boxOf(sel), size = b.getSize(V(0, 0, 0));
      return frame(b.getCenter(V(0, 0, 0)), Math.max(14, Math.max(size.x, size.z) * 0.7), V(0, 1, 0.6));
    }
    return [frame(V(-4, 4, 0), 92, V(0, 1.3, 1)), frame(V(-4, 2, 0), 84, V(0, 1.4, 0.9)), frame(V(-4, 2, 2), 76, V(0, 1, 0.6)),
      frame(V(34, 2, 15), 34, V(0, 1, 0.55)), frame(V(33, 2.6, 15), 27, V(0, 1, 0.45))][t];
  }
  let tween = null, lastTo = null;
  function flyCamera(v, instant) {
    if (lastTo && lastTo.target.distanceTo(v.target) < 0.01 && lastTo.pos.distanceTo(v.pos) < 0.01) return;
    lastTo = v;
    if (instant) { controls.target.copy(v.target); camera.position.copy(v.pos); tween = null; return; }
    tween = { from: { target: controls.target.clone(), pos: camera.position.clone() }, to: v, t0: performance.now(), dur: 900 };
  }

  // ---------------- state -> world
  let cur = null, curUnit = null, first = true;
  function light(id, col) {
    const p = parts.get(id); if (!p) return;
    p.mats.forEach((m) => m.emissive.copy(col).multiplyScalar(p.glow)); p.edges.forEach((e) => e.color.copy(col));
  }
  function apply(s) {
    const n = now(); cur = n;
    const hwT = s.tiers.hardware, exT = s.tiers.execution;
    const u = n.exec[exT]; curUnit = u;
    const col = new THREE.Color(FLOW_COLOR[n.flow] ?? DIM_COLOR.execution);
    for (const p of parts.values()) { p.mats.forEach((m) => { m.color.copy(m.userData.base); m.emissive.setRGB(0, 0, 0); }); p.edges.forEach((e) => e.color.set(EDGE)); }
    for (const id of u?.hw ?? []) if (id !== "vram" && id !== "l2") light(id, col);
    for (const x of n.transfers) for (const id of [x.from, x.to, "pcie", "ce0"]) light(id, col);
    const k = n.kernel;
    SM.forEach((m, i) => {
      if (k && i < k.gpu.sms) { m.material.color.copy(col); m.material.emissive.copy(col).multiplyScalar(0.35); }
      else if (i < n.sample.smActive) m.material.color.copy(WARM);
    });
    if (k) {
      const d = Math.max(0.25, n.sample.dram);
      for (const id of ["vram", "l2", "mc0", "mc1", "mc2", "mc3"]) { light(id, col); parts.get(id).mats.forEach((m) => m.emissive.multiplyScalar(d)); }
    }
    for (const [pid, P] of Object.entries(plates)) {
      const ph = n.phases.find((u) => processOf(u.comp) === pid), on = !!ph;
      P.mat.opacity = on ? 0.9 : 0.3; P.mat.color.set(on ? FLOW_COLOR[ph.flow] : "#6b7385"); P.mat.emissive.set(on ? FLOW_COLOR[ph.flow] : "#000000").multiplyScalar(0.4);
      P.L.el.classList.toggle("on", on); P.L.el.style.setProperty("--pc", on ? FLOW_COLOR[ph.flow] : "#6b7385");
    }
    pulseMat.color.copy(col); halo.material.color.copy(col); trail.forEach((m) => m.material.color.copy(col));
    stream.forEach((p) => p.m.material.color.copy(col)); packet.material.color.copy(col);
    pulseLbl.el.style.setProperty("--pc", `#${col.getHexString()}`);
    pulseLbl.el.textContent = short(u);
    pulseLbl.el.classList.toggle("sel", !!u && s.sel === u.id);

    for (const L of LBL) L.o.visible = !!L.show(hwT);
    sysLbl.el.textContent = `GPU ${Math.round(n.sample.gpuUtil * 100)}% · VRAM ${n.sample.vramGiB} / 16 GiB · CPU ${Math.round(n.sample.cpu * 100)}% (100 µs sample)`;
    smLbl.el.textContent = k ? `${k.name}: ${k.gpu.sms}/36 SMs · ${k.gpu.dramMB} MB from VRAM${k.gpu.profiled ? " (profiled)" : " (inferred, not profiled)"}`
      : `no kernel running · ${n.sample.smActive}/36 SMs active in this 100 µs sample`;
    const smT = parts.get(parts.has(s.sel) && /^sm\d+$/.test(s.sel) ? s.sel : "sm0").meshes[0].position;
    smIn.visible = hwT === 5; smIn.position.copy(smT); smInLbl.o.position.copy(smT).add(V(0, 2.4, -2.6));

    ghosts.children.forEach((g) => { g.geometry.dispose(); g.material.dispose(); }); ghosts.clear();
    const groupsAt = new Map();
    for (const id of metricInputs()) {
      const g = byId.get(id), pos = homeOf(g) ?? GPU_SPOT.clone(), key = pos.toArray().join();
      if (!groupsAt.has(key)) groupsAt.set(key, { pos, units: [] });
      groupsAt.get(key).units.push(g);
    }
    for (const { pos, units } of groupsAt.values()) {
      const pc = FLOW_COLOR[units[0].flow] ?? DIM_COLOR.execution;
      units.forEach((g, i) => {
        const m = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.25, 8, 24), new THREE.MeshBasicMaterial({ color: pc }));
        m.rotation.x = Math.PI / 2; m.position.copy(pos).add(V(0, 0.6 * i, 0)); m.userData.pick = { kind: "unit", id: g.id }; ghosts.add(m);
      });
    }

    selBox.visible = parts.has(s.sel);
    if (selBox.visible) selBox.box.copy(boxOf(s.sel)).expandByScalar(0.4);
    setPulseTarget(n, u, first);
    flyCamera(view(s), first);
    first = false;
  }

  // ---------------- picking
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pickAt(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects([...pickables, ...ghosts.children], true);
    for (const h of hits) {
      if (!h.object.visible || h.object.material?.opacity === 0) continue;
      let o = h.object; while (o && !o.userData.pick) o = o.parent;
      if (!o) continue;
      const p = o.userData.pick;
      if (p.kind === "transfer" && !cur?.transfers.length) continue;
      if (p.kind === "kernel" && !cur?.kernel) continue;
      return { ...p, obj: o };
    }
    return null;
  }
  function onMove(e) {
    const p = pickAt(e);
    renderer.domElement.style.cursor = p ? "pointer" : "";
    hoverBox.visible = !!p;
    if (p) hoverBox.box.copy(p.kind === "hw" ? boxOf(p.id) : new THREE.Box3().setFromObject(p.obj)).expandByScalar(0.25);
  }
  let down = null;
  const onDown = (e) => { down = { x: e.clientX, y: e.clientY }; };
  function onUp(e) {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    down = null;
    const p = pickAt(e); if (!p) return;
    if (p.kind === "hw") { select(p.id); setTier("hardware", byId.get(p.id).tier); }
    else if (p.kind === "proc") select(p.id);
    else if (p.kind === "exec" && curUnit) select(curUnit.id);
    else if (p.kind === "kernel") select(cur.kernel.id);
    else if (p.kind === "transfer") select(cur.transfers[0].id);
    else if (p.kind === "unit") select(p.id);
  }
  const cv = renderer.domElement;
  cv.addEventListener("pointermove", onMove); cv.addEventListener("pointerdown", onDown); cv.addEventListener("pointerup", onUp);
  cv.addEventListener("pointerleave", () => { hoverBox.visible = false; });

  // ---------------- loop
  function resize() {
    const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h); labels.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
    lastTo = null; if (!first) flyCamera(view(state), false);
  }
  const ro = new ResizeObserver(resize); ro.observe(el); resize();
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  let last = performance.now(), raf = 0;
  function tick(t) {
    const dt = Math.max(0, Math.min(0.05, (t - last) / 1000)); last = t;
    if (tween) {
      const u = ease(Math.min(1, (t - tween.t0) / tween.dur));
      controls.target.lerpVectors(tween.from.target, tween.to.target, u); camera.position.lerpVectors(tween.from.pos, tween.to.pos, u);
      if (u >= 1) tween = null;
    }
    controls.update();
    if (path.length) { const p = path[0], d = p.clone().sub(pulse.position), step = 70 * dt; if (d.length() <= step) { pulse.position.copy(p); path.shift(); } else pulse.position.add(d.setLength(step)); }
    trail.forEach((m, i) => { m.position.lerp(i ? trail[i - 1].position : pulse.position, 0.35); m.material.opacity = 0.35 * (1 - i / trail.length); });
    halo.scale.setScalar(1 + 0.15 * Math.sin(t / 180));
    ghosts.children.forEach((g) => g.scale.setScalar(1 + 0.12 * Math.sin(t / 200)));
    const k = cur?.kernel;
    for (const p of stream) {
      p.m.material.opacity = k ? 0.9 : 0;
      if (!k) continue;
      p.u += dt * (0.25 + Math.min(1.5, k.gpu.dramMB / 20)); if (p.u > 1) p.u -= 1;
      const z = 4 + p.lane * 7.5, a = V(56, 3.4, z), b = V(48.5, 2.9, z), c = V(40, 3.1, z);
      const d = SM[(p.lane * 7 + Math.floor(p.u * 97)) % Math.max(1, k.gpu.sms)].position.clone().add(V(0, 0.8, 0));
      p.m.position.copy(p.u < 0.33 ? a.lerp(b, p.u / 0.33) : p.u < 0.66 ? b.lerp(c, (p.u - 0.33) / 0.33) : c.lerp(d, (p.u - 0.66) / 0.34));
    }
    const tr = cur?.transfers?.[0];
    packet.visible = !!tr;
    if (tr) { const u = (t / 1600) % 1; packet.position.copy(pciePath.getPoint(tr.from === "ram" ? u : 1 - u)); }
    renderer.render(scene, camera); labels.render(scene, camera);
    raf = requestAnimationFrame(tick);
  }
  const unsub = subscribe(apply);
  raf = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(raf); unsub(); ro.disconnect(); controls.dispose();
    cv.removeEventListener("pointermove", onMove); cv.removeEventListener("pointerdown", onDown); cv.removeEventListener("pointerup", onUp);
    scene.traverse((o) => { o.geometry?.dispose(); [o.material].flat().forEach((m) => m?.dispose()); });
    renderer.dispose(); renderer.forceContextLoss();
    style.remove(); renderer.domElement.remove(); labels.domElement.remove();
  };
}
