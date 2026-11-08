// Execution spine world (COMMAND_CENTER_DIMENSIONS.md section 2): six execution bands with a cursor plane, the sample
// band above them, and the hardware lens over the cursor. Bands zoom to tiers.execution, the lens shows tiers.hardware.
import * as THREE from "three";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { state, subscribe, setTier, select, seek, now, metricInputs, data, DIM_COLOR } from "../model.js";

const { LADDERS, EXEC, SAMPLES, TRANSFERS, METRICS, END, byId, PROCESS_COLOR, processOf } = data;
const X = (t) => (t / END) * 100 - 50;
const T = (x) => ((x + 50) / 100) * END;
const ms = (t) => `${(t / 1000).toFixed(3)} ms`;
const pct = (v) => `${Math.round(v * 100)}%`;
const ROW = (i) => ({ y: 12.6 - i * 2.35, z: -5 + i * 1.7 });
const BAND_COL = ["#5b8def", "#3fc1a5", "#9aa7b8", "#c792ea", "#e6c86e", "#ff6fae"];
const KIND_COL = { gemm: "#ffb547", attn: "#ff6fae", mem: "#4fd1e8" };
const PROC_NAME = { "p.client": "client", "p.bridge": "bridge", "p.http": "trtllm-serve HTTP", "p.worker": "executor worker" };
const HWC = DIM_COLOR.hardware, ARC = DIM_COLOR.architecture;

const CSS = `
.sp-labels { position:absolute; inset:0; pointer-events:none; overflow:hidden; }
.spw .lb { font:13px system-ui, sans-serif; color:#e8eef7; white-space:nowrap; text-shadow:0 0 4px #000, 0 0 2px #000; }
.spw .lb.big { font-size:15px; font-weight:700; }
.spw .lb.title { font-size:16px; font-weight:700; letter-spacing:.3px; }
.spw .lb.sub { font-size:12.5px; color:#a9b8cc; }
.spw .lb.row { pointer-events:auto; cursor:pointer; background:#070a10d8; padding:2px 7px; border-radius:4px; font-size:12.5px;
  text-transform:uppercase; letter-spacing:.6px; border-left:3px solid currentColor; }
.spw .lb.row:hover { background:#1a2333; }
.spw .lb.row.on { font-weight:700; font-size:14px; color:#fff !important; }
.spw .lb.unit { font-size:12px; color:#0a0f18; text-shadow:none; font-weight:600; }
.spw .lb.unit.on { font-weight:800; }
.spw .lb.dark { color:#0a0f18; text-shadow:none; font-weight:700; }
.spw .lb.legend span { margin-left:10px; font-weight:700; }
.spw .lb.bracket { font-size:14px; font-weight:700; color:#fff; background:#0b0f16e0; padding:2px 8px; border-radius:4px; }
.spw .lb.card { white-space:normal; width:340px; background:#101827; border:1px solid ${HWC}; border-radius:6px; padding:10px 12px; }
`;

export function mount(el) {
  const root = document.createElement("div"); root.className = "spw"; root.style.cssText = "position:absolute; inset:0;";
  const style = document.createElement("style"); style.textContent = CSS;
  const labelsEl = document.createElement("div"); labelsEl.className = "sp-labels";
  root.append(style, labelsEl); el.append(root);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(devicePixelRatio); renderer.setClearColor(0x070a10);
  root.prepend(renderer.domElement);
  const css = new CSS2DRenderer({ element: labelsEl });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(24, 1, 0.01, 5000);
  const size = { w: 1, h: 1 };
  const resize = () => {
    size.w = Math.max(1, el.clientWidth); size.h = Math.max(1, el.clientHeight);
    renderer.setSize(size.w, size.h); css.setSize(size.w, size.h); camera.aspect = size.w / size.h; camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize); ro.observe(el); resize();

  const label = (text, cls = "lb", center = [0.5, 0.5]) => {
    const e = document.createElement("div"); e.className = cls; e.textContent = text;
    const o = new CSS2DObject(e); o.center.set(...center); return o;
  };
  const dropLabels = (g) => g.traverse((o) => o.element?.remove());
  const mat = (c, op = 1, extra = {}) => new THREE.MeshBasicMaterial({ color: c, transparent: op < 1, opacity: op, depthWrite: op >= 1, ...extra });

  const rig = new THREE.Group(); scene.add(rig);
  const spine = new THREE.Group(); scene.add(spine);
  const view = { cx: 0, s: 1, tcx: 0, ts: 1 };

  // ---------------- bands
  const unitColor = (u, i) => {
    const c = new THREE.Color(u.tier === 2 ? PROCESS_COLOR[processOf(u.comp)] ?? "#888"
      : u.tier === 1 ? (u.name.includes("prefill") ? "#f0a050" : "#3fc1a5") : u.tier === 5 ? KIND_COL[u.gpu.kind] : BAND_COL[u.tier]);
    return i % 2 ? c.multiplyScalar(0.82) : c;
  };
  const tracks = LADDERS.execution.map((_, i) => {
    const { y, z } = ROW(i);
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat(BAND_COL[i], 0.07));
    m.scale.set(100, 2.1, 1.4); m.position.set(0, y, z - 0.1); m.userData.track = i; spine.add(m); return m;
  });
  const unitMeshes = [], rowCount = [0, 0, 0, 0, 0, 0];
  for (const u of [...EXEC].sort((a, b) => a.t0 - b.t0)) {
    const { y, z } = ROW(u.tier);
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat(unitColor(u, rowCount[u.tier]++), 0.999));
    m.scale.set(Math.max(1e-4, X(u.t1) - X(u.t0)), 1.9, 1.3); m.position.set((X(u.t0) + X(u.t1)) / 2, y, z);
    m.userData.u = u; m.userData.base = m.material.color.clone();
    const lb = label("", "lb unit"); scene.add(lb); m.userData.lb = lb;
    spine.add(m); unitMeshes.push(m);
  }
  const rowLabels = LADDERS.execution.map((n, i) => {
    const o = label(`${i + 1} ${n}`, "lb row", [0, 0.5]); const { y, z } = ROW(i);
    o.position.set(-50, y, z + 0.7); o.element.style.color = BAND_COL[i]; o.element.dataset.band = i;
    o.element.title = `zoom the bands to execution tier ${i + 1} (${n})`;
    o.element.addEventListener("click", (e) => { e.stopPropagation(); setTier("execution", i); });
    rig.add(o); return o;
  });
  {
    const o = label("", "lb legend sub", [1, 0.5]); const { y, z } = ROW(5);
    o.element.innerHTML = "phase colour = process:" + Object.entries(PROCESS_COLOR).map(([p, c]) => `<span style="color:${c}">${PROC_NAME[p]}</span>`).join("");
    o.position.set(50, y - 2, z + 0.7); rig.add(o);
  }
  const selEdge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: "#ffffff" }));
  selEdge.visible = false; spine.add(selEdge);
  const metricEdges = new THREE.Group(); spine.add(metricEdges);

  // ---------------- sample band: 100 µs state, never stops
  {
    const pts = SAMPLES.flatMap((s) => [[X(s.t), s.smActive / 36], [X(Math.min(END, s.t + 100)), s.smActive / 36]]);
    const shape = new THREE.Shape(); shape.moveTo(pts[0][0], 0);
    pts.forEach(([x, v]) => shape.lineTo(x, v * 3)); shape.lineTo(pts.at(-1)[0], 0);
    const area = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat(HWC, 0.28, { side: THREE.DoubleSide }));
    area.position.set(0, 15, -7); spine.add(area);
    const dl = SAMPLES.flatMap((s) => [new THREE.Vector3(X(s.t), s.dram * 3, 0), new THREE.Vector3(X(Math.min(END, s.t + 100)), s.dram * 3, 0)]);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(dl), new THREE.LineBasicMaterial({ color: "#ff7a59", transparent: true, opacity: 0.7 }));
    line.position.set(0, 15, -6.9); spine.add(line);
  }
  const sampleLabel = label("", "lb sub", [0, 0.5]); sampleLabel.position.set(-50, 19, -7); rig.add(sampleLabel);
  const sampleWin = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.1), mat(HWC, 0.2)); spine.add(sampleWin);

  // ---------------- cursor plane
  const cursor = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat("#ffffff", 0.1, { blending: THREE.AdditiveBlending, depthWrite: false }));
  const cursorCore = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat("#ffffff", 0.9));
  spine.add(cursor, cursorCore);

  // ---------------- metric bracket
  const bracket = new THREE.Group(); spine.add(bracket);
  const brBar = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat("#ffffff", 0.95));
  const brL = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat("#ffffff", 0.95));
  const brR = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat("#ffffff", 0.95));
  const brFill = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat("#ffffff", 0.06, { depthWrite: false }));
  const brLabel = label("", "lb bracket", [0, 1]);
  bracket.add(brBar, brL, brR, brFill); rig.add(brLabel);

  // ---------------- hardware lens
  const W = 44, H = 24;
  const L = { g: new THREE.Group(), content: new THREE.Group(), anims: [], parts: [], ro: 0 };
  const lensFrame = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat("#0d1320", 0.97, { depthTest: false })); lensFrame.renderOrder = 99;
  const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([[-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2]].map(([x, y]) => new THREE.Vector3(x, y, 0.01))),
    new THREE.LineBasicMaterial({ color: HWC, depthTest: false }));
  edge.renderOrder = 99;
  const lensTitle = label("", "lb title", [0, 1]); lensTitle.position.set(-W / 2 + 0.6, H / 2 - 0.4, 0.1); lensTitle.element.style.color = HWC;
  L.content.position.z = 0.05; L.g.add(lensFrame, edge, lensTitle, L.content); L.g.position.set(-8, 32.5, 0); rig.add(L.g);
  const beam = new THREE.Mesh(new THREE.BufferGeometry(), mat(HWC, 0.32, { side: THREE.DoubleSide, depthWrite: false }));
  beam.frustumCulled = false; scene.add(beam);
  const archBeam = new THREE.Mesh(new THREE.BufferGeometry(), mat(ARC, 0.35, { side: THREE.DoubleSide, depthWrite: false }));
  archBeam.frustumCulled = false; scene.add(archBeam);
  const archLabel = label("architecture column", "lb sub", [1, 1]); archLabel.element.style.color = ARC; rig.add(archLabel);

  const flat = (m) => { m.material.depthTest = false; m.renderOrder = 100 + L.ro++; };
  function box(x, y, w, h, c, { lit = false, text, cls = "lb", op, pick } = {}) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat(c, op ?? (lit ? 0.95 : 0.3)));
    m.position.set(x, y, 0); flat(m); L.content.add(m);
    if (lit) {
      const e = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([a, b]) => new THREE.Vector3(x + a, y + b, 0.02))),
        new THREE.LineBasicMaterial({ color: "#ffffff", depthTest: false }));
      e.renderOrder = 100 + L.ro++; L.content.add(e);
    }
    if (text) { const o = label(text, cls + (lit ? " dark" : "")); o.position.set(x, y, 0.1); L.content.add(o); }
    if (pick) { m.userData.pick = pick; m.userData.base = m.material.color.clone(); L.parts.push(m); }
    return m;
  }
  const text = (x, y, s, cls = "lb", center = [0, 0.5]) => { const o = label(s, cls, center); o.position.set(x, y, 0.1); L.content.add(o); return o; };
  function link(a, b, lit, c = "#9fb0c6", th = 0.35) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(len, lit ? th * 1.8 : th), mat(lit ? c : "#3a475c", lit ? 0.95 : 0.6));
    m.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, -0.01); m.rotation.z = Math.atan2(b[1] - a[1], b[0] - a[0]); flat(m); L.content.add(m);
    if (!lit) return;
    for (let i = 0; i < 3; i++) {
      const d = new THREE.Mesh(new THREE.CircleGeometry(Math.min(0.75, th * 2.1), 20), mat("#ffffff")); flat(d); L.content.add(d);
      const halo = new THREE.Mesh(new THREE.CircleGeometry(Math.min(1.3, th * 3.7), 20), mat(c, 0.45)); flat(halo); L.content.add(halo);
      L.anims.push((s) => {
        const f = (s * 0.6 + i / 3) % 1, x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f;
        d.position.set(x, y, 0.06); halo.position.set(x, y, 0.05);
      });
    }
  }
  const hwPick = (id, tier) => ({ id, tier });
  function smGrid(x0, y0, litN, c, drill) {
    for (let i = 0; i < 36; i++) box(x0 + (i % 6) * 2.05, y0 - Math.floor(i / 6) * 2.05, 1.75, 1.75, c, { lit: i < litN, op: i < litN ? 0.95 : 0.2, pick: hwPick(`sm${i}`, drill) });
  }
  const sampleLine = (n) => `sample avg ${n.sample.smActive} of 36 SMs over ${ms(n.sample.t)} to ${ms(n.sample.t + 100)} (100 µs state)`;
  const kernelAt = (n) => {
    if (n.kernel) return [n.kernel, "at the cursor"];
    const mod = n.exec[4], next = EXEC.find((u) => u.tier === 5 && u.t0 >= state.t && (!mod || u.parent === mod.id));
    return next ? [next, `next kernel, starts ${ms(next.t0)}`] : [null, ""];
  };

  function board(n, device, x0 = 0, y0 = 0, k = 1) {
    const A = n.hwActive, tr = n.transfers[0];
    const P = (x, y) => [x0 + x * k, y0 + y * k];
    const B = { cpu: [-11, 3, 10, 5.5, "#8a96a8", "CPU i9-9900K"], ram: [-11, -5.5, 10, 3.2, "#8a96a8", "RAM 62 GiB"], gpu: [9, 3, 12, 5.5, HWC, "GPU RTX 5060 Ti"],
      vram: [9, -5.5, 12, 3.2, "#7aa2ff", "VRAM 16 GiB"], nvme: [-1, -8.6, 7, 2.2, "#58d68d", "NVMe SN7100"], nic: [-1, 7.6, 7, 2.2, "#b48ef0", "NIC veth/eth0"] };
    link(P(-6, 3.6), P(3, 3.6), !!tr && tr.from === "ram", HWC, 0.35 * k);
    link(P(3, 2.4), P(-6, 2.4), !!tr && tr.from === "vram", HWC, 0.35 * k);
    link(P(-11, 0.25), P(-11, -3.9), !!tr && tr.from === "ram", "#8a96a8", 0.35 * k);
    link(P(9, 0.25), P(9, -3.9), A.has("vram") || !!tr, "#7aa2ff", 0.35 * k);
    link(P(-6, 1), P(-1, -7.5), false, undefined, 0.35 * k); link(P(-6, 5), P(-1, 6.5), A.has("nic"), "#b48ef0", 0.35 * k);
    const drill = { cpu: 3, ram: 2, gpu: 3, vram: 4, nvme: 2, nic: 2 };
    for (const [id, [x, y, w, h, c, t]] of Object.entries(B))
      box(...P(x, y), w * k, h * k, c, { lit: A.has(id), text: k < 1 ? t.split(" ")[0] : t, cls: k < 1 ? "lb sub" : "lb big", pick: hwPick(id, drill[id]) });
    if (k === 1) {
      text(...P(-1.5, 0.9), "PCIe gen 3 x8", "lb sub", [0.5, 0.5]); text(...P(-3.6, -2.4), "DMI", "lb sub", [0.5, 0.5]);
      text(-21, 10, "MSI MPG Z390M board", "lb sub");
    }
    if (device) {
      const next = TRANSFERS.find((x) => x.t0 > state.t);
      text(-21, -10.6, tr ? `in flight: ${tr.what}, ${tr.bytes} B ${tr.from} -> ${tr.to}` : `no copy in flight · next: ${next ? `${next.what} at ${ms(next.t0)}` : "none"}`, "lb big");
    }
  }

  const HW_LENS = [
    (n) => { // system: the one node, small, with the sample gauges beside it
      box(-12, -0.5, 18, 17, "#2a3446", { op: 0.55, pick: hwPick("sys", 1) });
      text(-20.4, 7.2, "system: 1 node, 1 GPU", "lb big");
      board(n, false, -12, -1.4, 0.36);
      box(-12, -7.2, 15, 1.6, "#2a3446", { op: 0.9, text: "node: MPG Z390M (click to open)", cls: "lb sub", pick: hwPick("board", 1) });
      const s = n.sample;
      text(0, 8.4, "sample at the cursor (100 µs state, not a stop)", "lb sub");
      [["GPU busy", s.gpuUtil, pct(s.gpuUtil)], ["SMs active", s.smActive / 36, `${s.smActive} of 36 (avg)`], ["DRAM bw", s.dram, pct(s.dram)],
        ["PCIe", s.pcie, pct(s.pcie)], ["CPU", s.cpu, pct(s.cpu)], ["VRAM", s.vramGiB / 16, `${s.vramGiB} of 16 GiB`]].forEach(([k, v, t], i) => {
        const y = 5.6 - i * 2.6;
        text(5.6, y, k, "lb", [1, 0.5]);
        box(12, y, 11, 1.4, "#2a3446", { op: 0.9 });
        box(6.5 + 5.5 * v, y, Math.max(0.05, 11 * v), 1.4, HWC, { op: 0.95 });
        text(17.8, y, t, "lb sub");
      });
    },
    (n) => board(n, false),
    (n) => board(n, true),
    (n) => { // unit: inside the GPU
      const [k, when] = kernelAt(n);
      const lit = n.kernel ? n.kernel.gpu.sms : 0;
      text(-21, 9.6, n.kernel ? `kernel grid: ${n.kernel.name} on ${lit} of 36 SMs` : `GPU idle at the cursor${k ? ` · ${when}: ${k.name}` : ""}`, "lb big");
      text(-21, 7.8, sampleLine(n), "lb sub");
      smGrid(-19.5, 5.4, lit, HWC, 4);
      box(-4.8, -0.8, 2.6, 12, "#4fd1e8", { lit: n.hwActive.has("l2"), text: "L2", cls: "lb big", pick: hwPick("l2", 4) });
      for (let i = 0; i < 4; i++) box(-0.6, 3.6 - i * 2.9, 3, 2.4, "#4fd1e8", { lit: !!n.kernel, text: `MC${i}`, pick: hwPick(`mc${i}`, 4) });
      box(4, -0.8, 3, 12, "#7aa2ff", { lit: n.hwActive.has("vram"), text: "VRAM", cls: "lb big", pick: hwPick("vram", 4) });
      box(-4.8, -8.6, 2.6, 1.8, "#58d68d", { lit: n.hwActive.has("ce0"), text: "CE0", pick: hwPick("ce0", 2) });
      box(-0.6, -8.6, 3, 1.8, "#58d68d", { text: "CE1", pick: hwPick("ce1", 2) });
      text(8.6, 5.8, "CPU cores", "lb big");
      for (let i = 0; i < 8; i++) box(9.8 + (i % 4) * 2.6, 3.2 - Math.floor(i / 4) * 2.6, 2.2, 2.2, "#8a96a8", { op: 0.3, pick: hwPick(`core${i}`, 3) });
      text(8.6, -2.2, "per-core use: missing (not collected)", "lb sub");
    },
    (n) => { // kernel traffic
      const [k, when] = kernelAt(n);
      if (!k) { text(0, 1, "no kernel near the cursor: the GPU is idle", "lb big", [0.5, 0.5]); text(0, -1.6, `the request is in: ${n.exec[2]?.name ?? "-"}`, "lb sub", [0.5, 0.5]); return; }
      text(-21, 9.6, `kernel grid: ${k.name}, ${k.gpu.grid} blocks on ${k.gpu.sms} of 36 SMs (${when})`, "lb big");
      text(-21, 7.8, sampleLine(n), "lb sub");
      smGrid(-19.5, 5.4, k.gpu.sms, KIND_COL[k.gpu.kind], 5);
      box(2, -0.8, 3, 12, "#4fd1e8", { lit: true, text: "L2", cls: "lb big", pick: hwPick("l2", 4) });
      box(15, -0.8, 4, 12, "#7aa2ff", { lit: true, text: "VRAM", cls: "lb big", pick: hwPick("vram", 4) });
      link([13, 1], [3.5, 1], true, "#7aa2ff", 0.3 + Math.min(1.2, k.gpu.dramMB / 40));
      link([0.5, 1], [-7, 1], true, "#4fd1e8", 0.3 + Math.min(1.2, k.gpu.l2MB / 40));
      text(8.3, 3.6, `VRAM -> L2: ${k.gpu.dramMB} MB`, "lb big", [0.5, 0.5]);
      text(-3.2, 3.6, `L2 -> SMs: ${k.gpu.l2MB} MB`, "lb big", [0.5, 0.5]);
      text(-21, -8.8, `occupancy ${pct(k.gpu.occ)} · ${k.gpu.profiled ? "profiled by ncu" : "scratch bytes, not profiled (ncu ran on iteration 2 only)"}`, "lb sub");
      text(-21, -10.4, `launched by ${k.launch} at ${ms(k.cpuT)} on the CPU · click an SM for SM internals`, "lb sub");
    },
    (n) => { // SM internals: an Nsight Compute card, the data is not in this prototype
      const [k, when] = kernelAt(n);
      box(-9, 0, 22, 15, "#2a3446", { op: 0.55 });
      text(-19.4, 6.2, `one SM${k ? ` running ${k.name}` : ""}`, "lb big");
      for (let i = 0; i < 4; i++) box(-15.6 + i * 4.4, 1.8, 3.9, 4.4, HWC, { op: 0.28, text: `sched ${i}`, cls: "lb sub" });
      box(-9, -3, 20.4, 1.8, "#c792ea", { op: 0.3, text: "register file" });
      box(-9, -5.4, 20.4, 1.8, "#4fd1e8", { op: 0.3, text: "L1 / shared memory" });
      const card = label("", "lb card", [0, 0.5]); card.position.set(3.4, 0, 0.1); L.content.add(card);
      card.element.innerHTML = `<b style="color:${HWC}">Open in Nsight Compute</b><br>${k ? `${k.name} (${when})` : "no kernel near the cursor"}<br>`
        + `<span style="color:#a9b8cc">Warps, registers and shared memory live in the ncu report${k?.gpu.profiled ? "" : "; this kernel was not profiled (ncu ran on iteration 2 only)"}. Owner ruling: not redrawn here.</span>`;
    },
  ];

  function drawLens(n) {
    dropLabels(L.content); L.content.clear(); L.anims = []; L.parts = []; L.ro = 0; hover.obj = null;
    const ht = state.tiers.hardware, et = state.tiers.execution;
    lensTitle.element.textContent = `HARDWARE LENS · ${ht + 1} ${LADDERS.hardware[ht]}  ·  bands at execution › ${LADDERS.execution[et]}${state.paired ? "" : "  (independent)"}`;
    HW_LENS[ht](n);
  }

  // ---------------- framing: the parent unit of the execution tier around the cursor, or the metric span
  const metricSpan = () => {
    const mt = METRICS.find((x) => x.id === state.metric); if (!mt) return null;
    const us = mt.inputs.map((id) => byId.get(id));
    return [us[0].t0, us.at(-1).t1, mt];
  };
  function winTarget() {
    const span = metricSpan();
    if (span) { const pad = (span[1] - span[0]) * 0.08; return [span[0] - pad, span[1] + pad]; }
    for (let p = state.tiers.execution - 1; p >= 1; p--) {
      const u = EXEC.find((x) => x.tier === p && x.t0 <= state.t && state.t < x.t1);
      if (u) { const pad = (u.t1 - u.t0) * 0.06; return [u.t0 - pad, u.t1 + pad]; }
    }
    return [-END * 0.02, END * 1.02];
  }

  function onState() {
    const n = now(), et = state.tiers.execution, lit = metricInputs();
    const [a, b] = winTarget();
    view.tcx = (X(a) + X(b)) / 2; view.ts = (X(b) - X(a)) / 92;
    for (const m of unitMeshes) {
      const u = m.userData.u, on = u.t0 <= state.t && state.t < u.t1, row = u.tier === et;
      m.userData.k = lit.size ? (lit.has(u.id) ? 1.3 : 0.3) : on ? 1.25 : row ? 0.9 : 0.45;
      m.userData.on = on;
      m.material.color.copy(m.userData.base).multiplyScalar(m.userData.k);
    }
    tracks.forEach((m, i) => { m.material.opacity = i === et ? 0.16 : 0.06; });
    rowLabels.forEach((o, i) => o.element.classList.toggle("on", i === et));
    const sm = unitMeshes.find((m) => m.userData.u.id === state.sel);
    selEdge.visible = !!sm;
    if (sm) { selEdge.position.copy(sm.position); selEdge.scale.copy(sm.scale).multiply(new THREE.Vector3(1, 1.08, 1.1)); }
    metricEdges.clear();
    for (const m of unitMeshes) if (lit.has(m.userData.u.id)) {
      const e = new THREE.LineSegments(selEdge.geometry, new THREE.LineBasicMaterial({ color: "#ffffff" }));
      e.position.copy(m.position); e.scale.copy(m.scale).multiply(new THREE.Vector3(1, 1.1, 1.12)); metricEdges.add(e);
    }
    const span = metricSpan();
    bracket.visible = brLabel.visible = !!span;
    if (span) {
      const [t0, t1, mt] = span, x0 = X(t0), x1 = X(t1), y = ROW(0).y + 1.6, z = ROW(0).z;
      brBar.position.set((x0 + x1) / 2, y, z); brBar.userData.w = x1 - x0;
      brL.position.set(x0, y - 0.5, z); brR.position.set(x1, y - 0.5, z);
      brFill.position.set((x0 + x1) / 2, 7, -1.6); brFill.userData.w = x1 - x0;
      brLabel.userData.x = x0; brLabel.userData.y = y; brLabel.userData.z = z;
      brLabel.element.textContent = `${mt.name}: ${ms(mt.value)} on this scratch timeline (${mt.formula}) · measured ${mt.ref.ms} ms (${mt.ref.src})`;
    }
    const s = n.sample;
    sampleLabel.element.textContent = `samples, 100 µs state, never stops · fill: SMs active avg (${s.smActive} of 36 now) · line: DRAM % (${pct(s.dram)} now)`;
    const sx = X(Math.floor(state.t / 100) * 100), sx1 = X(Math.min(END, Math.floor(state.t / 100) * 100 + 100));
    sampleWin.position.set((sx + sx1) / 2, 16.5, -7.05); sampleWin.userData.w = sx1 - sx;
    drawLens(n);
  }

  // ---------------- picking
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const hover = { obj: null };
  function pick(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const lens = ray.intersectObjects(L.parts, false).sort((p, q) => q.object.renderOrder - p.object.renderOrder)[0];
    if (lens) return { kind: "hw", obj: lens.object };
    const u = ray.intersectObjects(unitMeshes, false)[0];
    if (u) return { kind: "unit", obj: u.object };
    const t = ray.intersectObjects(tracks, false)[0];
    if (t) return { kind: "seek", obj: t.object, x: t.point.x };
    return null;
  }
  function setHover(obj) {
    if (hover.obj === obj) return;
    const prev = hover.obj; hover.obj = obj;
    if (prev?.userData.u) prev.material.color.copy(prev.userData.base).multiplyScalar(prev.userData.k);
    else if (prev?.userData.pick) prev.material.color.copy(prev.userData.base);
    if (obj?.userData.u) obj.material.color.copy(obj.userData.base).multiplyScalar(obj.userData.k * 1.35 + 0.15);
    else if (obj?.userData.pick) obj.material.color.copy(obj.userData.base).lerp(new THREE.Color("#ffffff"), 0.45);
  }
  const onMove = (e) => {
    const p = pick(e);
    setHover(p && p.kind !== "seek" ? p.obj : null);
    renderer.domElement.style.cursor = p ? "pointer" : "default";
    renderer.domElement.title = p?.kind === "unit" ? p.obj.userData.u.name : p?.kind === "hw" ? byId.get(p.obj.userData.pick.id)?.name ?? "" : p ? "seek here" : "";
  };
  const onClick = (e) => {
    const p = pick(e); if (!p) return;
    if (p.kind === "unit") select(p.obj.userData.u.id);
    else if (p.kind === "hw") { select(p.obj.userData.pick.id); setTier("hardware", p.obj.userData.pick.tier); }
    else seek(T(p.x));
  };
  const onLeave = () => setHover(null);
  renderer.domElement.addEventListener("pointermove", onMove);
  renderer.domElement.addEventListener("click", onClick);
  renderer.domElement.addEventListener("pointerleave", onLeave);

  // ---------------- frame loop
  const v3 = new THREE.Vector3(), v4 = new THREE.Vector3(), dir = new THREE.Vector3(0, 4.5, 130).normalize();
  let raf = 0;
  function frame(tms) {
    const k = 0.12;
    view.cx += (view.tcx - view.cx) * k;
    view.s = Math.exp(Math.log(view.s) + (Math.log(view.ts) - Math.log(view.s)) * k);
    const s = view.s;
    rig.position.set(view.cx, 0, 0); rig.scale.setScalar(s); spine.scale.set(1, s, s);
    const th = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const d = Math.max(56 / (th * camera.aspect), 25 / th) * s;
    const look = v3.set(view.cx, 21 * s, 0);
    camera.position.copy(dir).multiplyScalar(d).add(look); camera.lookAt(look);
    camera.near = 0.5 * s; camera.far = d * 4; camera.updateProjectionMatrix();
    const cx = X(state.t);
    cursor.position.set(cx, 8.2, -1.5); cursor.scale.set(0.5 * s, 19.5, 10);
    cursorCore.position.set(cx, 8.2, 4.3); cursorCore.scale.set(0.16 * s, 19.5, 0.05);
    sampleWin.scale.set(sampleWin.userData.w ?? 0, 3.6, 1);
    if (bracket.visible) {
      brBar.scale.set(brBar.userData.w, 0.18, 1); brL.scale.set(0.18 * s, 1.1, 1); brR.scale.set(0.18 * s, 1.1, 1);
      brFill.scale.set(brFill.userData.w, 16, 1);
      brLabel.position.set((brLabel.userData.x - view.cx) / s, brLabel.userData.y + 2.3, brLabel.userData.z);
    }
    L.anims.forEach((f) => f(tms / 1000));
    L.g.updateMatrixWorld();
    const bl = L.g.localToWorld(v3.set(-W / 2 + 2, -H / 2, 0)).clone(), br = L.g.localToWorld(v4.set(W / 2 - 2, -H / 2, 0)).clone();
    const top = 17.95 * s;
    beam.geometry.setFromPoints([bl, br, new THREE.Vector3(cx, top, 3.5 * s), new THREE.Vector3(cx, top, -6.5 * s)]);
    beam.geometry.setIndex([0, 1, 2, 0, 2, 3, 0, 1, 3, 1, 2, 3]);
    const ax = view.cx + 50 * s, ay = 26 * s;
    archBeam.geometry.setFromPoints([new THREE.Vector3(cx, top, -1.5 * s), new THREE.Vector3(ax, ay + 0.35 * s, 0), new THREE.Vector3(ax, ay - 0.35 * s, 0)]);
    archBeam.geometry.setIndex([0, 1, 2]);
    archLabel.position.set(50, 25.4, 0);
    for (const m of unitMeshes) {
      const u = m.userData.u, lb = m.userData.lb;
      const y = m.position.y * s, z = (m.position.z + 0.66) * s;
      const pa = v3.set(X(u.t0), y, z).project(camera), pb = v4.set(X(u.t1), y, z).project(camera);
      const xa = Math.max(-0.8, pa.x), xb = Math.min(1, pb.x), px = ((xb - xa) / 2) * size.w;
      if (px < 60) { lb.visible = false; continue; }
      const chars = Math.floor(px / 8.4);
      const t = u.name.length > chars ? u.name.slice(0, Math.max(3, chars - 1)) + "…" : u.name;
      if (lb.element.textContent !== t) lb.element.textContent = t;
      lb.element.classList.toggle("on", !!m.userData.on);
      const mid = (Math.max(X(u.t0), view.cx - 40 * s) + Math.min(X(u.t1), view.cx + 50 * s)) / 2;
      if (mid < view.cx - 38 * s) { lb.visible = false; continue; }
      lb.visible = true; lb.position.set(mid, y, z);
    }
    renderer.render(scene, camera); css.render(scene, camera);
    if (!window.READY) window.READY = true;
    raf = requestAnimationFrame(frame);
  }

  const unsub = subscribe(onState);
  view.cx = view.tcx; view.s = view.ts;
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf); unsub(); ro.disconnect();
    renderer.domElement.removeEventListener("pointermove", onMove);
    renderer.domElement.removeEventListener("click", onClick);
    renderer.domElement.removeEventListener("pointerleave", onLeave);
    scene.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); o.element?.remove(); });
    renderer.dispose(); renderer.forceContextLoss(); root.remove();
  };
}
