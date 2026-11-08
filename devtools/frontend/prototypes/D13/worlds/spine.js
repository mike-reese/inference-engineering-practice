// Execution spine world, static 2D (owner item 5): a lens window on top (Architecture | Hardware | Split) and the six
// execution bands below, in SVG. Wheel zooms time around the mouse, drag pans, double-click fits the play bounds.
// The lens takes about 55% of the height (owner: D12 variant 1). Each pane (architecture, hardware, the bands) zooms on its own.
import { state, subscribe, setTier, select, seek, now, metricInputs, data, DIM_COLOR } from "../model.js";
import { mountArch } from "../arch.js";
import { panZoom } from "../zoom.js";

const { LADDERS, EXEC, SAMPLES, TRANSFERS, METRICS, END, byId, FLOWS, FLOW_COLOR } = data;
const NS = "http://www.w3.org/2000/svg";
const ms = (t) => `${(t / 1000).toFixed(3)} ms`;
const pct = (v) => `${Math.round(v * 100)}%`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const BAND_COL = ["#5b8def", "#3fc1a5", "#9aa7b8", "#c792ea", "#e6c86e", "#ff6fae"];
const KIND_COL = { gemm: "#ffb547", attn: "#ff6fae", mem: "#4fd1e8" };
const PROC_NAME = { "p.client": "client", "p.bridge": "bridge", "p.http": "trtllm-serve HTTP", "p.worker": "executor worker" };
const HWC = DIM_COLOR.hardware, ARC = DIM_COLOR.architecture;
const GL = 118, GR = 10, HEAD = 20, AXIS = 20, XFER = 12;
const MODES = [["arch", "Architecture"], ["hw", "Hardware"], ["split", "Split"]];

const CSS = `
.sp2 { position:absolute; inset:0; display:flex; flex-direction:column; background:#0b0e14; font:12px system-ui, sans-serif; }
.sp2 .lens { flex:none; display:flex; flex-direction:column; min-height:0; border-bottom:1px solid var(--line); background:var(--panel); }
.sp2 .lhead { display:flex; align-items:center; gap:8px; padding:3px 8px; border-bottom:1px solid var(--line); font:12px ui-monospace, monospace; }
.sp2 .lhead button { background:none; border:1px solid var(--line); color:var(--dim); font:inherit; padding:2px 10px; border-radius:4px; cursor:pointer; }
.sp2 .lhead button:hover { color:var(--text); }
.sp2 .lhead button.on { color:var(--text); background:#ffffff14; border-color:var(--dim); }
.sp2 .lhead .ctx { color:var(--dim); margin-left:6px; } .sp2 .lhead .note { margin-left:auto; color:#e3b341; }
.sp2 .lbody { flex:1; min-height:0; display:flex; }
.sp2 .pane { min-width:0; min-height:0; display:flex; flex-direction:column; }
.sp2 .pane .ptitle { flex:none; padding:2px 8px; font:11px ui-monospace, monospace; text-transform:uppercase; letter-spacing:.5px; }
.sp2 .pane .pbody { flex:1; min-height:0; overflow:auto; position:relative; }
.sp2 .pane .zc { position:absolute; inset:0; overflow:visible; }
.sp2 .pane .ztag { float:right; color:var(--dim); text-transform:none; letter-spacing:0; }
.sp2 .vdiv { flex:none; width:6px; cursor:col-resize; background:var(--line); }
.sp2 .hdiv { flex:none; height:6px; cursor:row-resize; background:var(--line); }
.sp2 .vdiv:hover, .sp2 .hdiv:hover { background:var(--dim); }
.sp2 .hwsvg { position:absolute; inset:0; width:100%; height:100%; display:block; }
.sp2 .hwsvg text { fill:#e8eef7; font-family:system-ui, sans-serif; font-size:.85px; dominant-baseline:central; pointer-events:none; }
.sp2 .hwsvg text.big { font-size:1.05px; font-weight:700; } .sp2 .hwsvg text.sub { font-size:.72px; fill:#a9b8cc; }
.sp2 .hwsvg text.dark { fill:#0a0f18; font-weight:700; }
.sp2 .hwsvg .pk { cursor:pointer; } .sp2 .hwsvg .pk:hover rect { filter:brightness(1.5); }
.sp2 .hwsvg .pk.sel rect { stroke:${ARC}; stroke-width:.22; }
.sp2 .flow { stroke-linecap:round; stroke-dasharray:.01 1.6; animation:spflow .9s linear infinite; }
@keyframes spflow { to { stroke-dashoffset:-1.61; } }
.sp2 .spine { flex:1; min-height:0; position:relative; }
.sp2 .spine svg { position:absolute; inset:0; width:100%; height:100%; display:block; user-select:none; touch-action:none; }
.sp2 .spine svg.drag { cursor:grabbing; }
.sp2 .u { cursor:pointer; opacity:.5; } .sp2 .u.row { opacity:.85; } .sp2 .u.on { opacity:1; }
.sp2 .u:hover { opacity:1; stroke:#fff; stroke-width:1; }
.sp2 svg.mt .u { opacity:.22; } .sp2 svg.mt .u.lit { opacity:1; stroke:#fff; stroke-width:1.5; }
.sp2 .u.sel { opacity:1; stroke:#fff; stroke-width:2; }
.sp2 .u.pe, .sp2 .xf.pe { stroke:#e3b341; stroke-width:3; opacity:1; }
.sp2 .ut { fill:#0a0f18; font-size:11.5px; font-weight:600; pointer-events:none; dominant-baseline:central; text-anchor:middle; }
.sp2 .ut.on { font-weight:800; }
.sp2 .track { fill:#ffffff08; } .sp2 .track.cur { fill:#ffffff14; }
.sp2 .rl { position:absolute; left:4px; width:${GL - 10}px; display:flex; align-items:center; padding:0 6px; cursor:pointer; border-radius:4px;
  font:11.5px ui-monospace, monospace; text-transform:uppercase; letter-spacing:.3px; border-left:3px solid currentColor; background:#070a10; white-space:nowrap; overflow:hidden; }
.sp2 .rl:hover { background:#1a2333; } .sp2 .rl.on { font-weight:700; color:#fff !important; background:#ffffff1a; }
.sp2 .hl { position:absolute; left:${GL}px; right:${GR}px; height:${HEAD}px; display:flex; gap:12px; align-items:center; overflow:hidden;
  white-space:nowrap; font-size:11.5px; color:#a9b8cc; pointer-events:none; }
.sp2 .hl b { color:#fff; background:#ffffff14; padding:0 6px; border-radius:3px; }
.sp2 .axl { fill:#8a90a0; font:10.5px ui-monospace, monospace; dominant-baseline:central; }
.sp2 .legend { position:absolute; right:${GR}px; bottom:2px; font-size:11px; color:#a9b8cc; pointer-events:none; background:#0b0e14; padding:0 4px; }
.sp2 .legend span { margin-left:8px; font-weight:700; }
.sp2 .hl .hint { margin-left:auto; color:#5d6575; }
`;

const ls = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* none */ } } };
const svgEl = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  parent?.append(e); return e;
};
const shade = (hex, k) => {
  const n = parseInt(hex.slice(1), 16), f = (v) => Math.round(Math.min(255, v * k)).toString(16).padStart(2, "0");
  return `#${f(n >> 16)}${f((n >> 8) & 255)}${f(n & 255)}`;
};
const unitColor = (u, i) => {
  const c = u.tier === 1 || u.tier === 2 ? FLOW_COLOR[u.flow] ?? "#888888" : u.tier === 5 ? KIND_COL[u.gpu.kind] : BAND_COL[u.tier];
  return i % 2 ? shade(c, 0.82) : c;
};
const metricSpan = () => {
  const mt = METRICS.find((x) => x.id === state.metric); if (!mt) return null;
  const us = mt.inputs.map((id) => byId.get(id));
  return [us[0].t0, us.at(-1).t1, mt];
};
const kernelAt = (n) => {
  if (n.kernel) return [n.kernel, "at the cursor"];
  const mod = n.exec[4], next = EXEC.find((u) => u.tier === 5 && u.t0 >= state.t && (!mod || u.parent === mod.id));
  return next ? [next, `next kernel, starts ${ms(next.t0)}`] : [null, ""];
};

// ---------------- hardware lens: D11's lens redrawn as SVG in a 44 x 23 box (y down)
function hardwareSvg(n) {
  const out = [];
  const anchor = (c) => (c === 0 ? "start" : c === 1 ? "end" : "middle");
  const text = (x, y, s, cls = "", c = 0, fill) => out.push(`<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor(c)}"${fill ? ` style="fill:${fill}"` : ""}>${esc(s)}</text>`);
  function box(x, y, w, h, c, { lit = false, label, cls = "", op, pick } = {}) {
    const p = pick ? ` class="pk${pick[0] === state.sel ? " sel" : ""}" data-hw="${pick[0]}" data-tier="${pick[1]}"` : "";
    out.push(`<g${p}><title>${esc(byId.get(pick?.[0])?.name ?? label ?? "")}</title><rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx=".25" fill="${c}"
      fill-opacity="${op ?? (lit ? 0.95 : 0.3)}" ${lit ? 'stroke="#fff" stroke-width=".1"' : ""}/>`);
    if (label) out.push(`<text x="${x}" y="${y}" class="${cls}${lit ? " dark" : ""}" text-anchor="middle">${esc(label)}</text>`);
    out.push("</g>");
  }
  function link([x1, y1], [x2, y2], lit, c = "#9fb0c6", th = 0.35) {
    out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${lit ? c : "#3a475c"}" stroke-width="${lit ? th * 1.8 : th}" stroke-opacity="${lit ? 0.95 : 0.6}"/>`);
    if (lit) out.push(`<line class="flow" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#fff" stroke-width="${Math.min(1.3, th * 3)}"/>`);
  }
  const smGrid = (x0, y0, litN, c, drill) => {
    for (let i = 0; i < 36; i++) box(x0 + (i % 6) * 2.05, y0 + Math.floor(i / 6) * 2.05, 1.75, 1.75, c, { lit: i < litN, op: i < litN ? 0.95 : 0.2, pick: [`sm${i}`, drill] });
  };
  const sampleLine = `sample avg ${n.sample.smActive} of 36 SMs over ${ms(n.sample.t)} to ${ms(n.sample.t + 100)} (100 µs state)`;
  function board(device, x0 = 0, y0 = 0, k = 1) {
    const A = n.hwActive, tr = n.transfers[0];
    const P = (x, y) => [x0 + x * k, y0 - y * k];
    const B = { cpu: [-11, 3, 10, 5.5, "#8a96a8", "CPU i9-9900K"], ram: [-11, -5.5, 10, 3.2, "#8a96a8", "RAM 62 GiB"], gpu: [9, 3, 12, 5.5, HWC, "GPU RTX 5060 Ti"],
      vram: [9, -5.5, 12, 3.2, "#7aa2ff", "VRAM 16 GiB"], nvme: [-1, -8.6, 7, 2.2, "#58d68d", "NVMe SN7100"], nic: [-1, 7.6, 7, 2.2, "#b48ef0", "NIC veth/eth0"] };
    link(P(-6, 3.6), P(3, 3.6), !!tr && tr.from === "ram", HWC, 0.35 * k);
    link(P(3, 2.4), P(-6, 2.4), !!tr && tr.from === "vram", HWC, 0.35 * k);
    link(P(-11, 0.25), P(-11, -3.9), !!tr && tr.from === "ram", "#8a96a8", 0.35 * k);
    link(P(9, 0.25), P(9, -3.9), A.has("vram") || !!tr, "#7aa2ff", 0.35 * k);
    link(P(-6, 1), P(-1, -7.5), false, undefined, 0.35 * k); link(P(-6, 5), P(-1, 6.5), A.has("nic"), "#b48ef0", 0.35 * k);
    const drill = { cpu: 3, ram: 2, gpu: 3, vram: 4, nvme: 2, nic: 2 };
    for (const [id, [x, y, w, h, c, t]] of Object.entries(B))
      box(...P(x, y), w * k, h * k, c, { lit: A.has(id), label: k < 1 ? t.split(" ")[0] : t, cls: k < 1 ? "sub" : "big", pick: [id, drill[id]] });
    if (k === 1) { text(...P(-1.5, 0.9), "PCIe gen 3 x8", "sub", 0.5); text(...P(-3.6, -2.4), "DMI", "sub", 0.5); text(-21, -10.2, "MSI MPG Z390M board", "sub"); }
    if (device) {
      const next = TRANSFERS.find((x) => x.t0 > state.t);
      text(-21, 10.6, tr ? `in flight: ${tr.what}, ${tr.bytes} B ${tr.from} -> ${tr.to}` : `no copy in flight · next: ${next ? `${next.what} at ${ms(next.t0)}` : "none"}`, "big");
    }
  }
  const TIERS = [
    () => {
      box(-12, 0.5, 18, 17, "#2a3446", { op: 0.55, pick: ["sys", 1] });
      text(-20.4, -7.2, "system: 1 node, 1 GPU", "big");
      board(false, -12, 1.4, 0.36);
      box(-12, 7.2, 15, 1.6, "#2a3446", { op: 0.9, label: "node: MPG Z390M (click to open)", cls: "sub", pick: ["board", 1] });
      const s = n.sample;
      text(0, -8.4, "sample at the cursor (100 µs state, not a stop)", "sub");
      [["GPU busy", s.gpuUtil, pct(s.gpuUtil)], ["SMs active", s.smActive / 36, `${s.smActive} of 36 (avg)`], ["DRAM bw", s.dram, pct(s.dram)],
        ["PCIe", s.pcie, pct(s.pcie)], ["CPU", s.cpu, pct(s.cpu)], ["VRAM", s.vramGiB / 16, `${s.vramGiB} of 16 GiB`]].forEach(([k, v, t], i) => {
        const y = -5.6 + i * 2.6;
        text(5.6, y, k, "", 1); box(12, y, 11, 1.4, "#2a3446", { op: 0.9 });
        box(6.5 + 5.5 * v, y, Math.max(0.05, 11 * v), 1.4, HWC, { op: 0.95 }); text(17.8, y, t, "sub");
      });
    },
    () => board(false),
    () => board(true),
    () => {
      const [k, when] = kernelAt(n), lit = n.kernel ? n.kernel.gpu.sms : 0;
      text(-21, -9.6, n.kernel ? `kernel grid: ${n.kernel.name} on ${lit} of 36 SMs` : `GPU idle at the cursor${k ? ` · ${when}: ${k.name}` : ""}`, "big");
      text(-21, -7.8, sampleLine, "sub");
      smGrid(-19.5, -5.4, lit, HWC, 4);
      box(-4.8, 0.8, 2.6, 12, "#4fd1e8", { lit: n.hwActive.has("l2"), label: "L2", cls: "big", pick: ["l2", 4] });
      for (let i = 0; i < 4; i++) box(-0.6, -3.6 + i * 2.9, 3, 2.4, "#4fd1e8", { lit: !!n.kernel, label: `MC${i}`, pick: [`mc${i}`, 4] });
      box(4, 0.8, 3, 12, "#7aa2ff", { lit: n.hwActive.has("vram"), label: "VRAM", cls: "big", pick: ["vram", 4] });
      box(-4.8, 8.6, 2.6, 1.8, "#58d68d", { lit: n.hwActive.has("ce0"), label: "CE0", pick: ["ce0", 2] });
      box(-0.6, 8.6, 3, 1.8, "#58d68d", { label: "CE1", pick: ["ce1", 2] });
      text(8.6, -5.8, "CPU cores", "big");
      for (let i = 0; i < 8; i++) box(9.8 + (i % 4) * 2.6, -3.2 + Math.floor(i / 4) * 2.6, 2.2, 2.2, "#8a96a8", { op: 0.3, pick: [`core${i}`, 3] });
      text(8.6, 2.2, "per-core use: missing (not collected)", "sub");
    },
    () => {
      const [k, when] = kernelAt(n);
      if (!k) { text(0, -1, "no kernel near the cursor: the GPU is idle", "big", 0.5); text(0, 1.6, `the request is in: ${n.exec[2]?.name ?? "-"}`, "sub", 0.5); return; }
      text(-21, -9.6, `kernel grid: ${k.name}, ${k.gpu.grid} blocks on ${k.gpu.sms} of 36 SMs (${when})`, "big");
      text(-21, -7.8, sampleLine, "sub");
      smGrid(-19.5, -5.4, k.gpu.sms, KIND_COL[k.gpu.kind], 5);
      box(2, 0.8, 3, 12, "#4fd1e8", { lit: true, label: "L2", cls: "big", pick: ["l2", 4] });
      box(15, 0.8, 4, 12, "#7aa2ff", { lit: true, label: "VRAM", cls: "big", pick: ["vram", 4] });
      link([13, -1], [3.5, -1], true, "#7aa2ff", 0.3 + Math.min(1.2, k.gpu.dramMB / 40));
      link([0.5, -1], [-7, -1], true, "#4fd1e8", 0.3 + Math.min(1.2, k.gpu.l2MB / 40));
      text(8.3, -3.6, `VRAM -> L2: ${k.gpu.dramMB} MB`, "big", 0.5);
      text(-3.2, -3.6, `L2 -> SMs: ${k.gpu.l2MB} MB`, "big", 0.5);
      text(-21, 8.8, `occupancy ${pct(k.gpu.occ)} · ${k.gpu.profiled ? "profiled by ncu" : "scratch bytes, not profiled (ncu ran on iteration 2 only)"}`, "sub");
      text(-21, 10.4, `launched by ${k.launch} at ${ms(k.cpuT)} on the CPU · click an SM for SM internals`, "sub");
    },
    () => {
      const [k, when] = kernelAt(n);
      box(-9, 0, 22, 15, "#2a3446", { op: 0.55 });
      text(-19.4, -6.2, `one SM${k ? ` running ${k.name}` : ""}`, "big");
      for (let i = 0; i < 4; i++) box(-15.6 + i * 4.4, -1.8, 3.9, 4.4, HWC, { op: 0.28, label: `sched ${i}`, cls: "sub" });
      box(-9, 3, 20.4, 1.8, "#c792ea", { op: 0.3, label: "register file" });
      box(-9, 5.4, 20.4, 1.8, "#4fd1e8", { op: 0.3, label: "L1 / shared memory" });
      out.push(`<rect x="3.4" y="-6" width="18.2" height="12" rx=".3" fill="#101827" stroke="${HWC}" stroke-width=".1"/>`);
      text(4.2, -4.6, "Open in Nsight Compute", "big", 0, HWC);
      text(4.2, -3, k ? `${k.name} (${when})` : "no kernel near the cursor");
      ["Warps, registers and shared memory", "live in the ncu report.", ...(k?.gpu.profiled ? [] : ["This kernel was not profiled", "(ncu ran on iteration 2 only)."]), "Owner ruling: not redrawn here."]
        .forEach((l, i) => text(4.2, -1.3 + i * 1.3, l, "sub"));
    },
  ];
  TIERS[state.tiers.hardware]();
  return out.join("");
}

export function mount(el) {
  const key = (k) => `d12.spine.top.${k}`;
  const root = document.createElement("div"); root.className = "sp2";
  root.innerHTML = `<style>${CSS}</style>
    <div class="lens"><div class="lhead">${MODES.map(([id, n]) => `<button data-mode="${id}">${n}</button>`).join("")}<span class="ctx"></span><span class="note"></span></div>
      <div class="lbody"></div></div>
    <div class="hdiv" title="drag to resize the lens"></div>
    <div class="spine"><svg></svg><div class="hl"></div><div class="legend">colour = flow:${FLOWS
      .map(([f, n]) => `<span style="color:${FLOW_COLOR[f]}" title="${n}">${n.split(":")[0]}</span>`).join("")}</div></div>`;
  el.append(root);
  const lensEl = root.querySelector(".lens"), lbody = root.querySelector(".lbody"), ctxEl = root.querySelector(".ctx"), noteEl = root.querySelector(".note");
  const spineEl = root.querySelector(".spine"), svg = spineEl.querySelector("svg"), hl = spineEl.querySelector(".hl");

  // ---------------- lens window
  let lensMode = ls.get(key("tab"), "split"); if (!MODES.some(([m]) => m === lensMode)) lensMode = "split";
  let lensFrac = +ls.get(key("frac"), 0.55), splitFrac = +ls.get(key("split"), 0.5);
  const applyFrac = () => { lensEl.style.height = `${(lensFrac * 100).toFixed(1)}%`; };
  applyFrac();
  let archDispose = null, hwSvg = null, hwKey = "", hwTitle = null, splitLeft = null, zooms = [];
  const views = Object.fromEntries(["arch", "hw"].map((p) => {
    try { return [p, JSON.parse(ls.get(key(`zoom.${p}`), "")) ]; } catch { return [p, { k: 1, x: 0, y: 0 }]; }
  }));
  /** Give a pane its own zoom: the content moves inside the pane body; the title shows the zoom and how to reset. */
  function zoomable(pane, id, content) {
    const body = pane.querySelector(".pbody"), tag = document.createElement("span"); tag.className = "ztag";
    pane.querySelector(".ptitle").append(tag); body.style.overflow = "hidden"; body.append(content);
    const z = panZoom(body, content, views[id], (v) => {
      tag.textContent = v.k === 1 && !v.x && !v.y ? "wheel zoom · drag pan" : `×${v.k.toFixed(1)} · double-click resets`;
      ls.set(key(`zoom.${id}`), JSON.stringify(v));
    });
    zooms.push(z);
  }
  function buildLens() {
    archDispose?.(); archDispose = null; hwSvg = null; hwKey = ""; lbody.replaceChildren();
    zooms.forEach((z) => z.dispose()); zooms = [];
    root.querySelectorAll(".lhead button").forEach((b) => b.classList.toggle("on", b.dataset.mode === lensMode));
    const pane = (title, color) => {
      const p = document.createElement("div"); p.className = "pane";
      p.innerHTML = `<div class="ptitle" style="color:${color}">${title}</div><div class="pbody"></div>`;
      lbody.append(p); return p;
    };
    let a = null, h = null;
    if (lensMode !== "hw") { a = pane("architecture", ARC); a.style.flex = "1"; }
    if (lensMode === "split") {
      const d = document.createElement("div"); d.className = "vdiv"; d.title = "drag to resize"; lbody.append(d);
      dragDivider(d, (e) => { const r = lbody.getBoundingClientRect(); splitFrac = Math.max(0.15, Math.min(0.85, (e.clientX - r.left) / r.width)); a.style.flex = `0 0 ${splitFrac * 100}%`; },
        () => ls.set(key("split"), splitFrac));
      a.style.flex = `0 0 ${splitFrac * 100}%`;
    }
    if (lensMode !== "arch") {
      h = pane("hardware", HWC); h.style.flex = "1"; hwTitle = h.querySelector(".ptitle");
      hwSvg = svgEl("svg", { class: "hwsvg", viewBox: "-22 -11.5 44 23", preserveAspectRatio: "xMidYMid meet" });
      zoomable(h, "hw", hwSvg);
      hwSvg.addEventListener("click", (e) => {
        const g = e.target.closest("[data-hw]"); if (!g) return;
        select(g.dataset.hw); setTier("hardware", Number(g.dataset.tier));
      });
    }
    splitLeft = a;
    if (a) {
      const c = document.createElement("div"); c.className = "zc"; zoomable(a, "arch", c);
      const r = mountArch(c, { size: "full" }); archDispose = typeof r === "function" ? r : null;
    }
  }
  root.querySelector(".lhead").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]"); if (!b || b.dataset.mode === lensMode) return;
    lensMode = b.dataset.mode; ls.set(key("tab"), lensMode); buildLens(); drawHw(true);
  });
  function drawHw(force) {
    if (!hwSvg) return;
    const n = now(), [k] = kernelAt(n);
    const k2 = [state.tiers.hardware, n.exec.map((u) => u?.id).join(), k?.id, n.transfers[0]?.id, TRANSFERS.find((x) => x.t0 > state.t)?.id,
      state.tiers.hardware === 0 || state.tiers.hardware >= 3 ? n.sampleIndex : "", state.sel].join("|");
    if (!force && k2 === hwKey) return;
    hwKey = k2; hwSvg.innerHTML = hardwareSvg(n);
    hwTitle.textContent = `hardware · ${state.tiers.hardware + 1} ${LADDERS.hardware[state.tiers.hardware]}`;
  }
  function dragDivider(d, move, done) {
    d.addEventListener("pointerdown", (e) => {
      e.preventDefault(); d.setPointerCapture(e.pointerId);
      const mv = (ev) => move(ev), up = () => { d.removeEventListener("pointermove", mv); d.removeEventListener("pointerup", up); done(); };
      d.addEventListener("pointermove", mv); d.addEventListener("pointerup", up);
    });
  }
  dragDivider(root.querySelector(".hdiv"), (e) => {
    const r = root.getBoundingClientRect(); lensFrac = Math.max(0.12, Math.min(0.8, (e.clientY - r.top) / r.height)); applyFrac();
  }, () => ls.set(key("frac"), lensFrac));
  buildLens();

  // ---------------- spine: structure built once, positions on view or size change, classes on state change
  const size = { w: 1, h: 1 };
  const view = { a: 0, b: END };
  const clip = svgEl("clipPath", { id: `spclip${Math.random().toString(36).slice(2, 8)}` }, svgEl("defs", {}, svg));
  const clipRect = svgEl("rect", {}, clip);
  const gClip = svgEl("g", { "clip-path": `url(#${clip.id})` }, svg);
  const tracks = LADDERS.execution.map((_, i) => svgEl("rect", { class: "track" }, gClip));
  const samplePath = svgEl("path", { fill: HWC, "fill-opacity": 0.3 }, gClip);
  const dramPath = svgEl("path", { fill: "none", stroke: "#ff7a59", "stroke-opacity": 0.8, "stroke-width": 1.2 }, gClip);
  const sampleWin = svgEl("rect", { fill: HWC, "fill-opacity": 0.22 }, gClip);
  const xfers = TRANSFERS.map((x) => { const r = svgEl("rect", { class: "xf u", fill: "#58d68d", "data-id": x.id }, gClip); svgEl("title", {}, r).textContent = `${x.what}: ${x.bytes} B ${x.from} -> ${x.to}`; return [x, r]; });
  const units = [], cnt = [0, 0, 0, 0, 0, 0];
  for (const u of [...EXEC].sort((a, b) => a.t0 - b.t0)) {
    const r = svgEl("rect", { class: "u", fill: unitColor(u, cnt[u.tier]++), "data-id": u.id }, gClip);
    svgEl("title", {}, r).textContent = u.name;
    const t = svgEl("text", { class: "ut" }, gClip);
    units.push({ u, r, t, label: "" });
  }
  const shadeL = svgEl("rect", { fill: "#000", "fill-opacity": 0.38, "pointer-events": "none" }, gClip);
  const shadeR = svgEl("rect", { fill: "#000", "fill-opacity": 0.38, "pointer-events": "none" }, gClip);
  const bEdges = [0, 1].map(() => svgEl("line", { stroke: "#e3b341", "stroke-opacity": 0.7, "stroke-dasharray": "4 3", "pointer-events": "none" }, gClip));
  const brFill = svgEl("rect", { fill: "#fff", "fill-opacity": 0.06, "pointer-events": "none" }, gClip);
  const brPath = svgEl("path", { fill: "none", stroke: "#fff", "stroke-width": 2, "pointer-events": "none" }, gClip);
  const cursor = svgEl("line", { stroke: "#fff", "stroke-width": 1.5, "pointer-events": "none" }, gClip);
  const cursorGlow = svgEl("rect", { fill: "#fff", "fill-opacity": 0.08, "pointer-events": "none" }, gClip);
  // Live: everything past the head has not been recorded yet.
  const future = svgEl("rect", { fill: "#0b0f16", "fill-opacity": 0.82, "pointer-events": "none" }, gClip);
  const futureLbl = svgEl("text", { fill: "#ff7b72", "font-size": 12, "pointer-events": "none" }, gClip);
  const axisG = svgEl("g", {}, svg);
  const rowLabels = LADDERS.execution.map((n, i) => {
    const d = document.createElement("div"); d.className = "rl"; d.textContent = `${i + 1} ${n}`; d.style.color = BAND_COL[i]; d.dataset.band = i;
    d.title = `zoom the bands to execution tier ${i + 1} (${n})`; d.onclick = () => setTier("execution", i); spineEl.append(d); return d;
  });
  const sampleLbl = document.createElement("div"); sampleLbl.className = "rl"; sampleLbl.style.cssText = `color:${HWC};cursor:default;font-size:10.5px;text-transform:none`;
  sampleLbl.textContent = "samples"; sampleLbl.title = "100 µs samples, state not stops: fill SMs active avg, line DRAM %"; spineEl.append(sampleLbl);
  const xferLbl = document.createElement("div"); xferLbl.className = "rl"; xferLbl.style.cssText = "color:#58d68d;cursor:default;font-size:10px;text-transform:none";
  xferLbl.textContent = "copies"; spineEl.append(xferLbl);

  let rows = [], sTop = 0, sH = 0, xTop = 0;
  const X = (t) => GL + ((t - view.a) / (view.b - view.a)) * (size.w - GL - GR);
  const T = (x) => view.a + ((x - GL) / (size.w - GL - GR)) * (view.b - view.a);
  const cx = (x) => Math.max(GL - 20, Math.min(size.w + 20, x));

  function measure() {
    size.w = Math.max(200, spineEl.clientWidth); size.h = Math.max(120, spineEl.clientHeight);
    sH = Math.max(22, Math.round(size.h * 0.14)); sTop = HEAD; xTop = sTop + sH + 2;
    const bandTop = xTop + XFER + 3, bandH = (size.h - bandTop - AXIS) / 6;
    rows = LADDERS.execution.map((_, i) => ({ y: bandTop + i * bandH + 1.5, h: Math.max(6, bandH - 3) }));
    clipRect.setAttribute("x", GL); clipRect.setAttribute("y", 0); clipRect.setAttribute("width", size.w - GL - GR); clipRect.setAttribute("height", size.h);
    rows.forEach((r, i) => Object.assign(rowLabels[i].style, { top: `${r.y}px`, height: `${r.h}px` }));
    Object.assign(sampleLbl.style, { top: `${sTop}px`, height: `${sH}px` }); Object.assign(xferLbl.style, { top: `${xTop}px`, height: `${XFER}px` });
    hl.style.top = "0px";
  }

  function layout() {
    rows.forEach((r, i) => { const t = tracks[i]; t.setAttribute("x", GL); t.setAttribute("y", r.y); t.setAttribute("width", size.w - GL - GR); t.setAttribute("height", r.h); });
    for (const o of units) {
      // Phase band: stream out gets the lower half, so it shows running beside the engine loop.
      const R = rows[o.u.tier], r = o.u.tier !== 2 ? R : { y: o.u.flow === "f.out" ? R.y + R.h / 2 : R.y, h: R.h / 2 - 0.5 };
      const x0 = cx(X(o.u.t0)), x1 = cx(X(o.u.t1)), w = Math.max(1, x1 - x0);
      o.r.setAttribute("x", x0); o.r.setAttribute("y", r.y); o.r.setAttribute("width", w); o.r.setAttribute("height", r.h);
      const vx0 = Math.max(GL, x0), vx1 = Math.min(size.w - GR, x1), vw = vx1 - vx0;
      const chars = Math.floor((vw - 8) / 7);
      const s = vw < 34 || chars < 3 || r.h < 11 ? "" : o.u.name.length > chars ? o.u.name.slice(0, chars - 1) + "…" : o.u.name;
      if (s !== o.label) { o.t.textContent = s; o.label = s; }
      if (s) { o.t.setAttribute("x", (vx0 + vx1) / 2); o.t.setAttribute("y", r.y + r.h / 2); }
    }
    for (const [x, r] of xfers) {
      const x0 = cx(X(x.t0)); r.setAttribute("x", x0); r.setAttribute("y", xTop); r.setAttribute("width", Math.max(3, cx(X(x.t1)) - x0)); r.setAttribute("height", XFER);
    }
    const base = sTop + sH, Y = (v) => base - v * (sH - 2);
    let d = `M${cx(X(0))},${base}`, l = "";
    for (const s of SAMPLES) {
      const a = cx(X(s.t)), b = cx(X(Math.min(END, s.t + 100)));
      d += `L${a},${Y(s.smActive / 36)}L${b},${Y(s.smActive / 36)}`;
      l += `${l ? "L" : "M"}${a},${Y(s.dram)}L${b},${Y(s.dram)}`;
    }
    samplePath.setAttribute("d", d + `L${cx(X(END))},${base}Z`); dramPath.setAttribute("d", l);
    const [b0, b1] = state.bounds, xb0 = cx(X(b0)), xb1 = cx(X(b1));
    shadeL.setAttribute("x", GL - 20); shadeL.setAttribute("width", Math.max(0, xb0 - GL + 20));
    shadeR.setAttribute("x", xb1); shadeR.setAttribute("width", Math.max(0, size.w - xb1));
    for (const s of [shadeL, shadeR]) { s.setAttribute("y", sTop); s.setAttribute("height", size.h - sTop - AXIS); }
    bEdges.forEach((e, i) => { const x = i ? xb1 : xb0; e.setAttribute("x1", x); e.setAttribute("x2", x); e.setAttribute("y1", sTop); e.setAttribute("y2", size.h - AXIS); });
    const span = metricSpan();
    brFill.style.display = brPath.style.display = span ? "" : "none";
    if (span) {
      const x0 = cx(X(span[0])), x1 = cx(X(span[1])), y = rows[0].y - 2;
      brFill.setAttribute("x", x0); brFill.setAttribute("width", Math.max(1, x1 - x0)); brFill.setAttribute("y", y); brFill.setAttribute("height", size.h - AXIS - y);
      brPath.setAttribute("d", `M${x0},${y + 8}V${y}H${x1}V${y + 8}`);
    }
    axisG.replaceChildren();
    const w = view.b - view.a, step = [1, 2, 5].flatMap((m) => [1, 10, 100, 1000, 10000].map((p) => m * p)).sort((a, b) => a - b)
      .find((s) => (s / w) * (size.w - GL - GR) > 90) ?? 10000;
    for (let t = Math.ceil(view.a / step) * step; t <= view.b; t += step) {
      const x = X(t); if (x < GL || x > size.w - GR - 470) continue;
      svgEl("line", { x1: x, x2: x, y1: size.h - AXIS, y2: size.h - AXIS + 4, stroke: "#5d6575" }, axisG);
      svgEl("text", { x: x + 3, y: size.h - AXIS / 2 + 1, class: "axl" }, axisG).textContent = step >= 1000 ? `${(t / 1000).toFixed(step >= 10000 ? 0 : 1)} ms` : ms(t);
    }
    placeCursor();
  }

  let sampleIdx = -1, onIds = new Set();
  function placeCursor() {
    const x = X(state.t), y0 = sTop, y1 = size.h - AXIS;
    cursor.setAttribute("x1", x); cursor.setAttribute("x2", x); cursor.setAttribute("y1", y0); cursor.setAttribute("y2", y1);
    cursorGlow.setAttribute("x", x - 4); cursorGlow.setAttribute("width", 8); cursorGlow.setAttribute("y", y0); cursorGlow.setAttribute("height", y1 - y0);
    const live = state.head < END, hx = Math.max(GL, X(state.head));
    future.setAttribute("x", hx); future.setAttribute("y", 0); future.setAttribute("width", live ? Math.max(0, size.w - hx) : 0); future.setAttribute("height", size.h);
    futureLbl.setAttribute("x", hx + 8); futureLbl.setAttribute("y", sTop + 14); futureLbl.textContent = live && size.w - hx > 140 ? "not recorded yet ▸" : "";
    const si = Math.min(SAMPLES.length - 1, Math.floor(state.t / 100));
    const a = cx(X(si * 100)), b = cx(X(Math.min(END, si * 100 + 100)));
    sampleWin.setAttribute("x", a); sampleWin.setAttribute("width", Math.max(1, b - a)); sampleWin.setAttribute("y", sTop); sampleWin.setAttribute("height", sH);
  }

  function onT() {
    placeCursor();
    const on = new Set(EXEC.filter((u) => u.t0 <= state.t && state.t < u.t1).map((u) => u.id));
    for (const o of units) {
      const was = onIds.has(o.u.id), is = on.has(o.u.id);
      if (was !== is) { o.r.classList.toggle("on", is); o.t.classList.toggle("on", is); }
    }
    onIds = on;
    const si = Math.min(SAMPLES.length - 1, Math.floor(state.t / 100));
    if (si !== sampleIdx) { sampleIdx = si; headline(); }
    drawHw(false);
  }
  function headline() {
    const span = metricSpan(), s = SAMPLES[sampleIdx] ?? SAMPLES[0];
    hl.innerHTML = span
      ? `<b>${esc(span[2].name)}: ${ms(span[2].value)} on this scratch timeline (${esc(span[2].formula)}) · measured ${span[2].ref.ms} ms (${esc(span[2].ref.src)})</b>`
      : `<span>t = ${ms(state.t)}</span><span style="color:${HWC}">samples, 100 µs state, never stops · fill: SMs active avg (${s.smActive} of 36 now) · line: DRAM % (${pct(s.dram)} now)</span>
         <span style="color:#e3b341">play bounds ${ms(state.bounds[0])} to ${ms(state.bounds[1])}</span><span class="hint">wheel zoom · drag pan · double-click fit</span>`;
  }

  function onStructure() {
    const et = state.tiers.execution, lit = metricInputs();
    svg.classList.toggle("mt", lit.size > 0);
    for (const o of units) {
      o.r.classList.toggle("row", o.u.tier === et); o.r.classList.toggle("lit", lit.has(o.u.id));
      o.r.classList.toggle("sel", o.u.id === state.sel); o.r.classList.toggle("pe", o.u.id === state.playEvent);
    }
    for (const [x, r] of xfers) { r.classList.toggle("sel", x.id === state.sel); r.classList.toggle("pe", x.id === state.playEvent); }
    tracks.forEach((t, i) => t.classList.toggle("cur", i === et));
    rowLabels.forEach((d, i) => d.classList.toggle("on", i === et));
    ctxEl.textContent = `bands at execution › ${LADDERS.execution[et]} · hardware › ${LADDERS.hardware[state.tiers.hardware]} · architecture › ${LADDERS.architecture[state.tiers.architecture]}${state.paired ? "" : " (independent)"}`;
    headline();
  }

  // ---------------- view: follows the play bounds (or the metric span); wheel, drag and double-click
  let tween = 0;
  function fitTo([a, b], animate = true) {
    const pad = (b - a) * 0.06; a -= pad; b += pad;
    cancelAnimationFrame(tween);
    if (!animate) { view.a = a; view.b = b; layout(); return; }
    const fa = view.a, fb = view.b, t0 = performance.now();
    const go = (now_) => {
      const p = Math.min(1, (now_ - t0) / 220), e = p * p * (3 - 2 * p);
      view.a = fa + (a - fa) * e; view.b = fb + (b - fb) * e; layout();
      if (p < 1) tween = requestAnimationFrame(go);
    };
    tween = requestAnimationFrame(go);
  }
  const target = () => { const s = metricSpan(); return s ? [s[0], s[1]] : state.bounds; };
  svg.addEventListener("wheel", (e) => {
    e.preventDefault(); cancelAnimationFrame(tween);
    const r = svg.getBoundingClientRect(), tm = T(e.clientX - r.left), f = Math.exp(e.deltaY * 0.0015);
    let w = (view.b - view.a) * f; w = Math.max(3, Math.min(END * 1.3, w));
    const k = w / (view.b - view.a);
    view.a = tm - (tm - view.a) * k; view.b = view.a + w; layout();
  }, { passive: false });
  let drag = null;
  svg.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, a: view.a, b: view.b, moved: false }; svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 4) return;
    drag.moved = true; svg.classList.add("drag"); cancelAnimationFrame(tween);
    const dt = (dx / (size.w - GL - GR)) * (drag.b - drag.a);
    view.a = drag.a - dt; view.b = drag.b - dt; layout();
  });
  svg.addEventListener("pointerup", (e) => {
    const d = drag; drag = null; svg.classList.remove("drag");
    if (!d || d.moved) return;
    const r = svg.getBoundingClientRect(), x = e.clientX - r.left;
    if (x < GL) return;
    const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest?.("[data-id]");
    if (hit) select(hit.dataset.id); else seek(T(x));
  });
  svg.addEventListener("dblclick", () => fitTo(target()));

  let lastTier = state.tiers.execution;
  const ro = new ResizeObserver(() => { measure(); layout(); }); ro.observe(spineEl);
  measure();
  const unsub = subscribe((s, ch) => {
    const tierMoved = s.tiers.execution !== lastTier; lastTier = s.tiers.execution;
    if (ch.sel || ch.metric || ch.tiers || ch.paired || ch.playEvent || ch.bounds || ch.world) onStructure();
    if (ch.tiers) drawHw(true); else if (ch.sel) drawHw(true);
    if (tierMoved || ch.bounds || (ch.metric && s.metric)) fitTo(target(), !ch.world);
    else if (ch.metric) layout();
    if (ch.t) onT(); else if (ch.head) placeCursor();
  });
  if (!window.READY) window.READY = true;

  return () => {
    cancelAnimationFrame(tween); unsub(); ro.disconnect(); archDispose?.(); root.remove();
  };
}
