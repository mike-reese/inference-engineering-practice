// Stacked world (COMMAND_CENTER.md 2.2): the board as floor, architecture standing on its hardware, execution as a
// moving pulse. D13's scene on the shown run (7.2): every part is a hardware thing of the manifest, every plate a
// process whose lanes carry phase rows, the pulse sits where RunStore.dims.ranOn says the row ran, and the gauges
// are the run's samples. The camera follows the hardware tier, the pulse the execution tier.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { state, subscribe, setTier, select, now, store, units, metricInputs, DIM_COLOR, FLOW_COLOR } from "../control/control.js";
import { fmtValue, fmtBytes } from "../sidebar/samples.js";
import { NONE16 } from "../store/columns.js";
import { perf } from "../perf.js";

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const CSS = `
.sw-lbl { font:600 12px ui-monospace, monospace; color:#d7dae0; background:#0f1115d9; border:1px solid #2a2f3a;
  padding:1px 6px; border-radius:4px; white-space:nowrap; pointer-events:none; }
.sw-lbl.big { font-size:13px; }
.sw-lbl.proc { border-left:4px solid var(--pc); color:#aab1bf; }
.sw-lbl.proc.on { color:#fff; background:#1b2230; border-color:var(--pc); }
.sw-lbl.pulse { color:#fff; border-color:var(--pc); background:#11161fee; font-size:13px; }
.sw-lbl.stat { color:${DIM_COLOR.hardware}; }
.sw-lbl.sel { outline:2px solid ${DIM_COLOR.hardware}; }`;

const BASE = "#262c37", EDGE = "#3a4352", WARM = new THREE.Color("#3a4454"), NEUTRAL = "#6b7385";
const GPU_SPOT = V(20, 5, 15);
/** Where each hardware kind stands on the board (D13's layout) and the hardware tier a click on it opens (D13's
 *  tiers: board 1, devices 2, parts of a device 3). Counts come from the run's things. */
const PLACE = {
  chipset: { tier: 1, at: V(-28, 0.8, 5), size: V(6, 1.2, 6) },
  cpu: { tier: 2, at: V(-25, 1, -22), size: V(14, 2, 14), color: "#2b3342", glow: 0.25 },
  "host memory": { tier: 2, at: V(-6.1, 1.5, -22), size: V(9.2, 3, 22) },
  network: { tier: 2, at: V(-52, 1, 8), size: V(9, 2, 7) },
  nvme: { tier: 2, at: V(-28, 0.6, 20), size: V(16, 1.2, 4.5) },
  gpu: { tier: 2, at: V(35, 1, 15), size: V(62, 2, 36), color: "#1d222b", glow: 0.05 },
  VRAM: { tier: 2 }, "bus link": { tier: 2 },
  SM: { tier: 3 }, "L2 cache": { tier: 3, at: V(40, 2.4, 15), size: V(5, 0.8, 26) }, "memory controller": { tier: 3 }, "copy engine": { tier: 3 },
};
const PCIE_GPU = [V(-18, 1, -15), V(-14, 0.6, -6), V(-6, 0.6, 12), V(-2, 0.6, 30), V(3, 1.4, 30), V(6.5, 2.3, 30)];
const PLATE_Y = 8, PLATE_Z0 = -31, PLATE_DZ = 7;
const byIndex = (a, b) => Number(a.key.match(/(\d+)$/)?.[1] ?? 0) - Number(b.key.match(/(\d+)$/)?.[1] ?? 0);
const stripName = (s) => String(s).replace(/ \(.*\)$/, "");
const shortName = (s) => String(s).replace(/\s*\([^)]*\)/g, "");   // a board label without the inventory's parentheticals
const tail = (key) => String(key).split("/").pop();

/** The run's hardware, plates and gauges: rebuilt only when the run, its things, its catalog or the processes that
 *  carry phase rows change. */
function boardOf(S) {
  const T = S.things, of = (k) => T.filter((t) => t.kind === k), one = (k) => of(k)[0] ?? null;
  const gpu = one("gpu"), cpu = one("cpu");
  const metric = (name, thing) => (thing ? S.metrics.findIndex((m) => m.metric === name && m.thing === thing.i) : -1);
  const first = (thing, ...names) => { for (const n of names) { const i = metric(n, thing); if (i >= 0) return i; } return -1; };
  // plates: the processes whose lanes carry phase rows, standing on the hardware those rows ran on
  const P = S.dims.ladders.execution.indexOf("phase"), L = S.dims.laneLevel, seen = new Map();
  if (P >= 0) for (const id of units(P).ids) { const p = L.process[S.field("lane", id)]; if (p >= 0 && !seen.has(p)) seen.set(p, id); }
  const plates = [...seen].map(([p, id]) => {
    const proc = T[p], on = S.dims.ranOn(id), container = proc.parent >= 0 ? T[proc.parent] : null;
    const role = proc.attrs?.role?.name, name = role ? role.split(/ \(|:/)[0] : container?.kind === "network" ? container.name : stripName(proc.name);
    return { proc, on: on >= 0 ? T[on] : null, label: `${name} [${tail(container?.key ?? "")}]` };
  }).sort((a, b) => (a.on?.kind === "network") - (b.on?.kind === "network") || (a.proc.parent - b.proc.parent) || ((a.proc.attrs?.pid ?? 0) - (b.proc.attrs?.pid ?? 0)));
  // a phase whose box drives the box that runs the kernels sits on the GPU (D13: model forward, sampler)
  const kernelKind = S.kinds.findIndex((k) => k.name === "kernel"), drives = T.find((t) => t.kind === "component map")?.attrs?.drives ?? {};
  const want = new Set(Object.values(drives)), kernelBoxes = new Set();
  for (const id of kernelKind >= 0 ? S.dims.byKind[kernelKind] ?? [] : []) {
    if (kernelBoxes.size === want.size) break;
    const c = S.field("comp", id), key = c === NONE16 ? null : T[c]?.attrs?.key;
    if (key && want.has(key)) kernelBoxes.add(key);
  }
  const gpuBoxes = new Set(Object.entries(drives).filter(([, b]) => kernelBoxes.has(b)).map(([a]) => a));
  return {
    key: `${S.run}|${S.generation}|${T.length}|${S.metrics.length}|${plates.map((x) => x.proc.i).join()}`,
    gpu, cpu, ram: one("host memory"), vram: one("VRAM"), l2: one("L2 cache"), nvme: one("nvme"), chipset: one("chipset"),
    nets: of("network"), links: of("bus link"), sms: of("SM").sort(byIndex), mcs: of("memory controller").sort(byIndex),
    copies: of("copy engine").sort(byIndex), plates, gpuBoxes,
    m: { util: first(gpu, "utilization.gpu"), vram: first(gpu, "nvml.memory.used", "memory.used"), cpu: first(cpu, "host.cpu.busy"),
      smActive: first(gpu, "SMs Active [Throughput %]", "nvml.gpm.sm_util"), dram: first(gpu, "DRAM Read Bandwidth [Throughput %]", "nvml.gpm.dram_bw_util", "utilization.memory"),
      ce0: first(gpu, "Async Copy Engine Active 0 [Throughput %]") },
  };
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
  const floor = new THREE.Mesh(new THREE.BoxGeometry(150, 1, 95), new THREE.MeshStandardMaterial({ color: "#161a21" }));
  floor.position.set(0, -0.6, 2); scene.add(floor);

  // ---------------- the run's board: rebuilt per run into `root`
  const root = new THREE.Group(); scene.add(root);
  let S = null, B = null, parts = new Map(), pickables = [], LBL = [], SM = [], plates = [], pcieCurve = null, mcLanes = [];
  let sysLbl = null, smLbl = null, smIn = null, smInLbl = null, cpuTop = V(-25, 3, -22), netTop = null;
  function label(text, pos, show, cls = "", parent = root) {
    const e = document.createElement("div"); e.className = `sw-lbl ${cls}`; e.textContent = text;
    const o = new CSS2DObject(e); o.position.copy(pos); parent.add(o);
    const L = { o, el: e, show }; LBL.push(L); return L;
  }
  function reg(thing, mesh, mat, edge, glow) {
    const p = parts.get(thing.key) ?? { thing, tier: PLACE[thing.kind]?.tier ?? 2, meshes: [], mats: [], edges: [] };
    mat.userData.glow = glow; p.meshes.push(mesh); p.mats.push(mat); if (edge) p.edges.push(edge);
    parts.set(thing.key, p); mesh.userData.pick = { kind: "hw", key: thing.key }; pickables.push(mesh);
  }
  function part(thing, c, s, color = BASE, glow = 0.45) {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1 }); mat.userData.base = new THREE.Color(color);
    const m = new THREE.Mesh(new THREE.BoxGeometry(s.x, s.y, s.z), mat); m.position.copy(c); root.add(m);
    const em = new THREE.LineBasicMaterial({ color: EDGE }); m.add(new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), em));
    reg(thing, m, mat, em, glow); return m;
  }
  function tube(thing, curve, r, color) {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5 }); mat.userData.base = new THREE.Color(color);
    const m = new THREE.Mesh(new THREE.TubeGeometry(curve, 60, r, 10), mat); root.add(m); reg(thing, m, mat, null, 0.6);
  }
  const placed = (thing) => thing && PLACE[thing.kind]?.at;
  const devTier = (t) => t <= 2, unitTier = (t) => t >= 3;

  function clearBoard() {
    root.traverse((o) => { o.geometry?.dispose(); [o.material].flat().forEach((m) => m?.dispose()); if (o.isCSS2DObject) o.element.remove(); });
    root.clear(); parts = new Map(); pickables = []; LBL = []; SM = []; plates = []; pcieCurve = null; mcLanes = []; netTop = null;
    sysLbl = smLbl = smIn = smInLbl = null;
  }

  function buildBoard() {
    clearBoard();
    if (!B) return;
    const { cpu, ram, gpu, vram, l2, nvme, chipset } = B;
    const P = (thing) => PLACE[thing.kind];
    if (cpu) {
      part(cpu, P(cpu).at, P(cpu).size, P(cpu).color, P(cpu).glow);
      const cores = cpu.attrs?.cores ?? 0;   // the inventory has the count, not core things: a core click opens the CPU
      for (let i = 0; i < cores; i++) part(cpu, V(-29.5 + (i % 4) * 3, 2.4, -25 + Math.floor(i / 4) * 5), V(2.4, 0.8, 4), "#323c4d");
      const ct = cpu.attrs?.threads ? ` (${cores}C/${cpu.attrs.threads}T)` : "";
      label(`${cpu.name}${ct}`, V(-25, 2.5, -13), devTier, "big");
      cpuTop = V(-25, 3, -22);
    }
    if (ram) { part(ram, P(ram).at, P(ram).size); label(ram.name, V(-1, 3, -22), devTier, "big").o.center.set(0, 0.5); }
    for (const [k, n] of B.nets.entries()) {
      const at = P(n).at.clone().add(V(0, 0, -10 * k)); part(n, at, P(n).size); netTop = netTop ?? at.clone();
      label(n.name, at.clone().add(V(0, 1.5, 5.5)), devTier).o.center.set(0.5, 0);
    }
    if (nvme) { part(nvme, P(nvme).at, P(nvme).size); label(nvme.name, V(-28, 1.5, 24.5), devTier); }
    if (chipset) { part(chipset, P(chipset).at, P(chipset).size); label(shortName(chipset.name), V(-31.5, 1.5, 5), (t) => t >= 1 && t <= 2).o.center.set(1, 0.5); }
    if (gpu) {
      part(gpu, P(gpu).at, P(gpu).size, P(gpu).color, P(gpu).glow);
      label(gpu.name, V(13, 2.5, 35.5), devTier, "big");   // left of D13's spot: the inventory name is longer than D13's
      B.sms.forEach((t, i) => SM.push(part(t, V(10 + (i % 6) * 4, 2.6, 4 + Math.floor(i / 6) * 4.2), V(3.2, 1.2, 3.4))));
      if (B.sms.length) label(`${B.sms.length} SMs`, V(20, 4, -1.5), unitTier, "big");
      if (l2) { part(l2, P(l2).at, P(l2).size); label(l2.name, V(40, 3.5, 30), unitTier); }
      // one VRAM chip per memory controller (each drives a 32-bit slice of the bus)
      const lanes = Math.max(B.mcs.length, vram ? 1 : 0);
      for (let i = 0; i < lanes; i++) {
        const z = 4 + i * 7.5; mcLanes.push(z);
        if (vram) part(vram, V(56, 2.6, z), V(7, 1.2, 6));
        if (B.mcs[i]) part(B.mcs[i], V(48.5, 2.3, z), V(3, 0.6, 4));
      }
      if (vram) label(`${vram.name} (VRAM)`, V(56, 4.5, 33.5), () => true, "big");
      if (B.mcs.length) label(`${B.mcs.length} memory controllers`, V(48.5, 3.5, -1.5), unitTier);
      B.copies.forEach((t, i) => part(t, V(8 + i * 4, 2.3, 30), V(3, 0.6, 3)));
      if (B.copies.length) label("copy engines", V(10, 3.5, 33), (t) => t === 3);
      const own = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(62.6, 2.2, 36.6)),
        new THREE.LineBasicMaterial({ color: NEUTRAL, transparent: true, opacity: 0.45 }));
      own.position.copy(P(gpu).at); root.add(own);
    }
    // bus links between the parts their inventory ends name; the CPU <-> GPU link lands on the copy engines
    const at = (key) => { const p = parts.get(key); return p ? p.meshes[0].position : null; };
    for (const link of B.links) {
      const [a, b] = link.attrs?.ends ?? [], A = at(a), Bp = at(b);
      if (!A || !Bp) continue;
      const toGpu = gpu && (a === gpu.key || b === gpu.key);
      const curve = new THREE.CatmullRomCurve3(toGpu ? PCIE_GPU : [A.clone().setY(1), A.clone().lerp(Bp, 0.5).setY(0.8), Bp.clone().setY(0.8)]);
      tube(link, curve, toGpu ? 0.9 : 0.5, toGpu ? "#3a4757" : "#3a3f4a");
      if (toGpu) { pcieCurve = curve; label(shortName(link.name), V(-8, 2.5, 8), devTier, "big"); }
      else label(shortName(link.name), curve.getPoint(A.z <= Bp.z ? 0.7 : 0.3).add(V(2.5, 1.2, 0)), (t) => t >= 1 && t <= 2).o.center.set(0, 0.5);   // right of the tube, toward its front end
    }
    sysLbl = label("", V(0, 6, 48), (t) => t <= 1, "stat big");
    smLbl = label("", V(30, 4.5, -7), unitTier, "stat");
    // SM internals on the framed SM at the deepest hardware tier: what the inventory records per SM
    smIn = new THREE.Group(); root.add(smIn);
    const rf = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.35, 2.4), new THREE.MeshStandardMaterial({ color: "#46536a" })); rf.position.set(0, 0.8, -0.3); smIn.add(rf);
    const shm = new THREE.Mesh(new THREE.BoxGeometry(3, 0.2, 0.25), new THREE.MeshStandardMaterial({ color: "#6a5a3a" })); shm.position.set(0, 0.75, 1.6); smIn.add(shm);
    const a0 = B.sms[0]?.attrs ?? {};
    smInLbl = label(`registers ${a0.regs_per_sm ?? "not recorded"} · shared memory ${a0.smem_per_sm != null ? fmtBytes(a0.smem_per_sm) : "not recorded"} · `
      + `${a0.max_threads_per_sm ?? "–"} threads max per SM · warps and source lines: Nsight Compute`, V(0, 0, 0), (t) => t === 5, "stat");
    // plates: one per process that carries phase rows, over the CPU (or the network part its frames ran on)
    let k = 0;
    for (const pl of B.plates) {
      const onNet = pl.on?.kind === "network" && netTop;
      const c = onNet ? netTop.clone().add(V(0, 6, 0)) : V(-25 + 14 * Math.floor(k / 4), PLATE_Y, PLATE_Z0 + PLATE_DZ * (k++ % 4));
      const mat = new THREE.MeshStandardMaterial({ color: NEUTRAL, transparent: true, opacity: 0.35, emissive: 0x000000 });
      const m = new THREE.Mesh(new THREE.BoxGeometry(onNet ? 9 : 13, 0.5, 5), mat); m.position.copy(c); root.add(m);
      m.userData.pick = { kind: "proc", key: pl.proc.key }; pickables.push(m);
      const host = onNet ? netTop : cpuTop;
      const sm = new THREE.LineBasicMaterial({ color: NEUTRAL, transparent: true, opacity: 0.5 });
      root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([c.clone().add(V(0, -0.25, 0)), V(c.x, host.y, c.z)]), sm));
      const L = label(pl.label, c.clone().add(onNet ? V(0, 0.3, -2.6) : V(-7, 0.3, 0)), () => true, "proc");
      L.o.center.set(onNet ? 0.5 : 1, onNet ? 1 : 0.5);
      L.el.style.setProperty("--pc", NEUTRAL); L.el.title = `${pl.proc.name}${pl.proc.attrs?.role ? ` · ${pl.proc.attrs.role.name}` : ""}`;
      plates.push({ ...pl, pos: c, mat, L });
    }
  }

  // ---------------- execution: the pulse, its trail, kernel traffic, and transfers on PCIe
  const pulseMat = new THREE.MeshBasicMaterial({ color: "#ffffff" });
  const pulse = new THREE.Mesh(new THREE.SphereGeometry(0.9, 24, 16), pulseMat); scene.add(pulse);
  pulse.userData.pick = { kind: "exec" };
  const halo = new THREE.Mesh(new THREE.SphereGeometry(1.8, 24, 16), new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.2 })); pulse.add(halo);
  const trail = Array.from({ length: 14 }, () => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0 })); scene.add(m); return m;
  });
  const pulseEl = document.createElement("div"); pulseEl.className = "sw-lbl pulse";
  const pulseLbl = new CSS2DObject(pulseEl); pulse.add(pulseLbl); pulseLbl.position.set(0, 3.2, 0);
  const stream = Array.from({ length: 60 }, (_, i) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0 }));
    m.userData.pick = { kind: "kernel" }; scene.add(m); return { m, u: Math.random(), lane: i % 4 };
  });
  const packet = new THREE.Mesh(new THREE.SphereGeometry(1.2, 16, 12), new THREE.MeshBasicMaterial({ color: "#ffffff" }));
  packet.userData.pick = { kind: "transfer" }; scene.add(packet);
  const always = [pulse, ...stream.map((p) => p.m), packet];
  const ghosts = new THREE.Group(); scene.add(ghosts);

  const hoverBox = new THREE.Box3Helper(new THREE.Box3(), 0xffffff); hoverBox.visible = false; scene.add(hoverBox);
  const selBox = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(DIM_COLOR.hardware)); selBox.visible = false; scene.add(selBox);
  const boxOf = (key) => { const b = new THREE.Box3(); parts.get(key).meshes.forEach((m) => b.expandByObject(m)); return b; };

  // ---------------- where a row's work happens: on the GPU (null), or at its process's plate
  const underGpu = (h) => { for (let x = h; x >= 0; x = S.things[x].parent) if (x === B.gpu?.i) return true; return false; };
  function homeOf(id) {
    if (id == null || !S) return plates[0]?.pos.clone().add(V(0, 2.5, 0)) ?? cpuTop.clone();
    const h = S.dims.ranOn(id), c = S.field("comp", id), box = c === NONE16 ? null : S.things[c]?.attrs?.key;
    if ((h >= 0 && underGpu(h)) || (box && B.gpuBoxes.has(box))) return null;
    const proc = S.dims.laneLevel.process[S.field("lane", id)], pl = plates.find((x) => x.proc.i === proc);
    if (pl) return pl.pos.clone().add(V(0, 2.5, 0));
    if (h >= 0 && S.things[h].kind === "network" && netTop) return netTop.clone().add(V(0, 3, 0));
    return cpuTop.clone();
  }
  const asked = new Set();
  /** SMs a kernel can occupy: min(SM count, grid blocks) from the kernel's cold args (inferred), null until they load. */
  function smsUsed(k) {
    const d = k && S.detailCached(k.id);
    if (d === undefined && k && !asked.has(k.id)) { asked.add(k.id); S.detail([k.id]).then(() => { if (curKernel?.id === k.id) apply(state); }, (e) => console.error(e)); }
    const g = d?.args?.grid; return g ? Math.min(SM.length, g.reduce((a, b) => a * b, 1)) : null;
  }
  let path = [], lastSide = null;
  const hostEnd = () => (pcieCurve ? [V(-20, 3, -16), ...pcieCurve.getPoints(10)] : []);
  function gpuSpot(k, u, used, atKernelTier) {
    if (!k || !used || (atKernelTier && u && u.id !== k.id)) return GPU_SPOT.clone();
    const c = V(0, 0, 0); for (let i = 0; i < used; i++) c.add(SM[i].position);
    return c.divideScalar(used).add(V(0, 3, 0));
  }
  function setPulseTarget(u, k, used, atKernelTier, first) {
    const home = homeOf(u?.id), side = home ? "host" : "gpu", pos = home ?? gpuSpot(k, u, used, atKernelTier);
    if (first) { pulse.position.copy(pos); path = []; }
    else if (lastSide && side !== lastSide) { const h = hostEnd(); path = (side === "gpu" ? h : h.reverse()).concat([pos]); }
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
    const sm = sel && parts.get(sel).thing.kind === "SM" ? sel : B?.sms[0]?.key;
    if (t === 5 && sm && parts.has(sm)) return frame(parts.get(sm).meshes[0].position.clone(), 5.5, V(0.25, 1, 0.75));
    if (sel && parts.get(sel).tier === t) {
      const b = boxOf(sel), size = b.getSize(V(0, 0, 0));
      return frame(b.getCenter(V(0, 0, 0)), Math.max(14, Math.max(size.x, size.z) * 0.7), V(0, 1, 0.6));
    }
    return [frame(V(-4, 4, 0), 92, V(0, 1.3, 1)), frame(V(-4, 2, 0), 84, V(0, 1.4, 0.9)), frame(V(-4, 2, 2), 76, V(0, 1, 0.6)),
      frame(V(34, 2, 15), 34, V(0, 1, 0.55)), frame(V(33, 2.6, 15), 27, V(0, 1, 0.45)), frame(V(33, 2.6, 15), 27, V(0, 1, 0.45))][t];
  }
  let tween = null, lastTo = null;
  function flyCamera(v, instant) {
    if (lastTo && lastTo.target.distanceTo(v.target) < 0.01 && lastTo.pos.distanceTo(v.pos) < 0.01) return;
    lastTo = v;
    if (instant) { controls.target.copy(v.target); camera.position.copy(v.pos); tween = null; return; }
    tween = { from: { target: controls.target.clone(), pos: camera.position.clone() }, to: v, t0: performance.now(), dur: 900 };
  }

  // ---------------- state -> world
  let cur = null, curUnit = null, curKernel = null, streamSMs = 0, toGpu = null, first = true, traffic = 0;
  function refresh() {
    const s_ = store(), b = s_ ? boardOf(s_) : null;
    if (s_ === S && b?.key === B?.key) return;
    S = s_; B = b; buildBoard(); first = true; lastTo = null;
  }
  function light(key, col, scale = 1) {
    const p = key && parts.get(key); if (!p) return;
    p.mats.forEach((m) => m.emissive.copy(col).multiplyScalar(m.userData.glow * scale)); p.edges.forEach((e) => e.color.copy(col));
  }
  const pct = (v) => (Number.isFinite(v) ? fmtValue(v, "%") : "–");
  function apply(s) {
    if (!S || store() !== S) { pulse.visible = false; cur = curUnit = curKernel = null; return; }
    pulse.visible = true;
    const n = now(); cur = n;
    const hwT = s.tiers.hardware, E = S.dims.ladders.execution, K = E.indexOf("kernel");
    const u = n.exec[s.tiers.execution]; curUnit = u;
    const val = (i) => (i >= 0 ? n.sample[i] : NaN);
    const col = new THREE.Color(FLOW_COLOR[n.flow] ?? DIM_COLOR.execution);
    for (const p of parts.values()) { p.mats.forEach((m) => { m.color.copy(m.userData.base); m.emissive.setRGB(0, 0, 0); }); p.edges.forEach((e) => e.color.set(EDGE)); }
    if (u) {
      const h = S.dims.ranOn(u.id), c = S.field("comp", u.id), box = c === NONE16 ? null : S.things[c]?.attrs?.key;
      if (h >= 0) light(S.things[h].key, col);
      if (box && B.gpuBoxes.has(box)) light(B.gpu?.key, col);
    }
    toGpu = null;
    for (const x of n.transfers) {   // a copy's direction is its name (nsys copy kind)
      const dir = S.nameText(S.field("name", x.id)), h2d = /host to device/i.test(dir), d2h = /device to host/i.test(dir);
      if (h2d || d2h) { toGpu ??= h2d; light(B.ram?.key, col); light(B.links.find((l) => l.attrs?.ends?.includes(B.gpu?.key))?.key, col); }
      light(B.vram?.key, col);
    }
    if (val(B.m.ce0) > 0) light(B.copies[0]?.key, col);
    const k = n.kernel && S.kinds[S.field("kind", n.kernel.id)]?.name === "kernel" ? n.kernel : null, used = k ? smsUsed(k) : null;
    curKernel = k; streamSMs = used ?? 0;
    const activePct = val(B.m.smActive), warm = Number.isFinite(activePct) ? Math.round((SM.length * activePct) / 100) : 0;
    SM.forEach((m, i) => {
      if (k && used != null && i < used) { m.material.color.copy(col); m.material.emissive.copy(col).multiplyScalar(0.35); }
      else if (i < warm) m.material.color.copy(WARM);
    });
    const dram = val(B.m.dram), counters = k ? S.detailCached(k.id)?.counters : null;
    const dramRead = counters?.values?.find((v) => v.measure === "DRAM read")?.value;
    traffic = k ? (dramRead != null ? Math.min(1.5, dramRead / 20e6) : Number.isFinite(dram) ? (1.5 * dram) / 100 : 0) : 0;
    if (k) for (const key of [B.vram?.key, B.l2?.key, ...B.mcs.map((x) => x.key)]) light(key, col, Math.max(0.25, Number.isFinite(dram) ? dram / 100 : 0));
    for (const P of plates) {
      const ph = n.phases.find((x) => S.dims.laneLevel.process[S.field("lane", x.id)] === P.proc.i), on = !!ph;
      const fc = on ? FLOW_COLOR[S.dims.flowOf(ph.id)] ?? DIM_COLOR.execution : NEUTRAL;
      P.mat.opacity = on ? 0.9 : 0.3; P.mat.color.set(fc); P.mat.emissive.set(on ? fc : "#000000").multiplyScalar(0.4);
      P.L.el.classList.toggle("on", on); P.L.el.style.setProperty("--pc", fc);
    }
    pulseMat.color.copy(col); halo.material.color.copy(col); trail.forEach((m) => m.material.color.copy(col));
    stream.forEach((p) => p.m.material.color.copy(col)); packet.material.color.copy(col);
    pulseEl.style.setProperty("--pc", `#${col.getHexString()}`);
    pulseEl.textContent = u ? stripName(S.nameText(S.field("name", u.id))) : `before the first ${E[s.tiers.execution]}`;
    pulseEl.classList.toggle("sel", !!u && s.sel === u.id);

    for (const L of LBL) L.o.visible = !!L.show(hwT);
    const vramGiB = B.gpu?.attrs?.vram_bytes ? (B.gpu.attrs.vram_bytes / 2 ** 30).toFixed(2) : "–";
    const vu = val(B.m.vram);
    if (sysLbl) sysLbl.el.textContent = `GPU ${pct(val(B.m.util))} · VRAM ${Number.isFinite(vu) ? (vu / 1024).toFixed(2) : "–"} / ${vramGiB} GiB · CPU ${pct(val(B.m.cpu))} (samples at the cursor)`;
    if (smLbl) smLbl.el.textContent = k
      ? `${S.nameText(S.field("name", k.id))}: ${used != null ? `${used}/${SM.length} SMs (inferred from the grid)` : S.detailCached(k.id) ? "no grid recorded" : "loading the grid"}`
        + ` · ${dramRead != null ? `${fmtBytes(dramRead)} read from VRAM (Nsight Compute)` : "DRAM bytes: not profiled"}`
      : `no kernel running · SMs active ${Number.isFinite(activePct) ? `${pct(activePct)} (about ${warm}/${SM.length})` : "not recorded in this run"}`;
    const smKey = parts.has(s.sel) && parts.get(s.sel).thing.kind === "SM" ? s.sel : B.sms[0]?.key, smT = smKey && parts.get(smKey)?.meshes[0].position;
    if (smIn) { smIn.visible = hwT === 5 && !!smT; if (smT) { smIn.position.copy(smT); smInLbl.o.position.copy(smT).add(V(0, 2.4, -2.6)); } }

    ghosts.children.forEach((g) => { g.geometry.dispose(); g.material.dispose(); }); ghosts.clear();
    const groupsAt = new Map();
    for (const id of metricInputs()) {
      if (typeof id !== "number" || id >= S.N) continue;
      const pos = homeOf(id) ?? GPU_SPOT.clone(), key = pos.toArray().join();
      if (!groupsAt.has(key)) groupsAt.set(key, { pos, ids: [] });
      groupsAt.get(key).ids.push(id);
    }
    for (const { pos, ids } of groupsAt.values()) {
      const pc = FLOW_COLOR[S.dims.flowOf(ids[0])] ?? DIM_COLOR.execution;
      ids.slice(0, 24).forEach((id, i) => {
        const m = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.25, 8, 24), new THREE.MeshBasicMaterial({ color: pc }));
        m.rotation.x = Math.PI / 2; m.position.copy(pos).add(V(0, 0.6 * i, 0)); m.userData.pick = { kind: "unit", id }; ghosts.add(m);
      });
    }

    selBox.visible = parts.has(s.sel);
    if (selBox.visible) selBox.box.copy(boxOf(s.sel)).expandByScalar(0.4);
    setPulseTarget(u, k, used, s.tiers.execution === K, first);
    flyCamera(view(s), first);
    first = false;
  }

  // ---------------- picking
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pickAt(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects([...always, ...pickables, ...ghosts.children], true);
    for (const h of hits) {
      if (!h.object.visible || h.object.material?.opacity === 0) continue;
      let o = h.object; while (o && !o.userData.pick) o = o.parent;
      if (!o) continue;
      const p = o.userData.pick;
      if (p.kind === "transfer" && !cur?.transfers.length) continue;
      if (p.kind === "kernel" && !curKernel) continue;
      if (p.kind === "exec" && !curUnit) continue;
      return { ...p, obj: o };
    }
    return null;
  }
  function onMove(e) {
    const p = pickAt(e);
    renderer.domElement.style.cursor = p ? "pointer" : "";
    hoverBox.visible = !!p;
    if (p) hoverBox.box.copy(p.kind === "hw" ? boxOf(p.key) : new THREE.Box3().setFromObject(p.obj)).expandByScalar(0.25);
  }
  let down = null;
  const onDown = (e) => { down = { x: e.clientX, y: e.clientY }; };
  function onUp(e) {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    down = null;
    const p = pickAt(e); if (!p) return;
    if (p.kind === "hw") { select(p.key); setTier("hardware", parts.get(p.key).tier); }
    else if (p.kind === "proc") select(p.key);
    else if (p.kind === "exec") select(curUnit.id);
    else if (p.kind === "kernel") select(curKernel.id);
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
    lastTo = null; if (!first && B) flyCamera(view(state), false);
  }
  const ro = new ResizeObserver(resize); ro.observe(el); resize();
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  let last = performance.now(), raf = 0;
  function tick(t) {
    const c0 = performance.now();
    perf.sample("stacked_interval", t - last);   // frame to frame, what the viewer sees as smoothness
    const dt = Math.max(0, Math.min(0.05, (t - last) / 1000)); last = t;
    if (tween) {
      const u = ease(Math.min(1, (t - tween.t0) / tween.dur));
      controls.target.lerpVectors(tween.from.target, tween.to.target, u); camera.position.lerpVectors(tween.from.pos, tween.to.pos, u);
      if (u >= 1) tween = null;
    }
    controls.update();
    if (path.length) { const p = path[0], d = p.clone().sub(pulse.position), step = 70 * dt; if (d.length() <= step) { pulse.position.copy(p); path.shift(); } else pulse.position.add(d.setLength(step)); }
    trail.forEach((m, i) => { m.position.lerp(i ? trail[i - 1].position : pulse.position, 0.35); m.material.opacity = pulse.visible ? 0.35 * (1 - i / trail.length) : 0; });
    halo.scale.setScalar(1 + 0.15 * Math.sin(t / 180));
    ghosts.children.forEach((g) => g.scale.setScalar(1 + 0.12 * Math.sin(t / 200)));
    const used = streamSMs, flowing = !!curKernel && used > 0 && mcLanes.length > 0;
    for (const p of stream) {
      p.m.material.opacity = flowing ? 0.9 : 0;
      if (!flowing) continue;
      p.u += dt * (0.25 + traffic); if (p.u > 1) p.u -= 1;
      const z = mcLanes[p.lane % mcLanes.length], a = V(56, 3.4, z), b = V(48.5, 2.9, z), c = V(40, 3.1, z);
      const d = SM[(p.lane * 7 + Math.floor(p.u * 97)) % used].position.clone().add(V(0, 0.8, 0));
      p.m.position.copy(p.u < 0.33 ? a.lerp(b, p.u / 0.33) : p.u < 0.66 ? b.lerp(c, (p.u - 0.33) / 0.33) : c.lerp(d, (p.u - 0.66) / 0.34));
    }
    packet.visible = toGpu != null && !!pcieCurve;
    if (packet.visible) { const u = (t / 1600) % 1; packet.position.copy(pcieCurve.getPoint(toGpu ? u : 1 - u)); }
    renderer.render(scene, camera); labels.render(scene, camera);
    perf.sample("stacked_tick", performance.now() - c0);   // main-thread time of this frame's animation and draw calls
    raf = requestAnimationFrame(tick);
  }
  const unsub = subscribe((s, ch) => { const t0 = performance.now(); if (ch.rev || store() !== S) refresh(); apply(s); perf.sample("stacked_apply", performance.now() - t0); });
  refresh(); apply(state);
  raf = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(raf); unsub(); ro.disconnect(); controls.dispose();
    cv.removeEventListener("pointermove", onMove); cv.removeEventListener("pointerdown", onDown); cv.removeEventListener("pointerup", onUp);
    clearBoard();
    scene.traverse((o) => { o.geometry?.dispose(); [o.material].flat().forEach((m) => m?.dispose()); });
    renderer.dispose(); renderer.forceContextLoss();
    style.remove(); renderer.domElement.remove(); labels.domElement.remove();
  };
}
