// The design under test (COMMAND_CENTER_DIMENSIONS.md section 2), shared by every D10 layout so they differ only in
// how they draw. Position = a dimension and one of its tiers, plus one cursor time. Flying changes the position, never
// the cursor. Stepping visits the stops of the focused position. Samples are state, never stops.
import { LADDERS, ALIGN, EXEC, ARCH, HW, TRANSFERS, SAMPLES, END, byId } from "./data.js";

export const DIMS = ["execution", "hardware", "architecture"];
export const PROTOTYPES = [
  ["stacked", "A. Stacked world"], ["stages", "B. Three stages"], ["spine", "C. Execution spine + lenses"], ["cube", "D. Orbit cube"],
];

const archAncestor = (id, tier) => { let x = byId.get(id); while (x && x.tier > tier) x = byId.get(x.parent); return x?.id; };
const units = (tier) => EXEC.filter((u) => u.tier === tier).sort((a, b) => a.t0 - b.t0);
const phases = units(2);
const handoffs = (tier) => {
  const out = []; let last = null;
  for (const p of phases) { const a = archAncestor(p.comp, tier); if (a !== last) out.push({ t: p.t0, ref: p.id, label: byId.get(a)?.name }); last = a; }
  return out;
};

/** Stops per position: [{t, ref, label}] sorted by t. */
const STOPS = {
  execution: LADDERS.execution.map((_, i) => units(i).map((u) => ({ t: u.t0, ref: u.id, label: u.name }))),
  hardware: [
    units(0).map((u) => ({ t: u.t0, ref: u.id, label: "request (steps on the aligned execution tier)" })),
    units(1).map((u) => ({ t: u.t0, ref: u.id, label: u.name + " (steps on the aligned execution tier)" })),
    TRANSFERS.map((x) => ({ t: x.t0, ref: x.id, label: `${x.what}: ${x.bytes} B ${x.from} -> ${x.to}` })),
    units(5).map((u) => ({ t: u.t0, ref: u.id, label: `${u.name} on ${u.gpu.sms} of 36 SMs` })),
    units(5).filter((u) => u.gpu.profiled).map((u) => ({ t: u.t0, ref: u.id, label: `${u.name}: ${u.gpu.dramMB} MB DRAM (profiled)` })),
    units(5).filter((u) => u.gpu.profiled).map((u) => ({ t: u.t0, ref: u.id, label: `${u.name}: open in Nsight Compute` })),
  ],
  architecture: [
    units(0).map((u) => ({ t: u.t0, ref: u.id, label: "request" })), units(0).map((u) => ({ t: u.t0, ref: u.id, label: "request" })),
    handoffs(2), handoffs(3), handoffs(4),
    units(5).map((u) => ({ t: u.cpuT, ref: u.id, label: `toolkit -> ${u.launch} -> ${u.name}` })),
  ],
};
for (const d of DIMS) for (const s of STOPS[d]) s.sort((a, b) => a.t - b.t);

export const state = { dim: "execution", tier: 2, t: 0, sel: null, playing: false };
const subs = new Set();
export const subscribe = (f) => (subs.add(f), f(state), () => subs.delete(f));
const emit = () => subs.forEach((f) => f(state));

export const stops = (dim = state.dim, tier = state.tier) => STOPS[dim][tier];
export const tierName = (dim = state.dim, tier = state.tier) => LADDERS[dim][tier];

export function step(dir, coarser = false) {
  const tier = coarser ? Math.max(0, state.tier - 1) : state.tier;
  const S = stops(state.dim, tier);
  const s = dir > 0 ? S.find((x) => x.t > state.t + 1e-6) : [...S].reverse().find((x) => x.t < state.t - 1e-6);
  if (s) { state.t = s.t; state.sel = s.ref; emit(); }
}
export function fly(d) { state.tier = Math.max(0, Math.min(5, state.tier + d)); emit(); }
export function flyTo(dim, tier) { state.dim = dim; state.tier = tier; emit(); }
/** Cross to another dimension: land on the tier aligned with the current one; the cursor stays. */
export function cross(dim) {
  if (dim === state.dim) return;
  const row = ALIGN.find((r) => r[state.dim] === tierName()) ?? ALIGN[state.tier];
  state.tier = LADDERS[dim].indexOf(row[dim]); state.dim = dim; emit();
}
export function seek(t) { state.t = Math.max(0, Math.min(END, t)); emit(); }
export function select(ref) { const x = byId.get(ref); state.sel = ref; if (x?.t0 != null) state.t = x.t0; emit(); }

/** What is true at the cursor in every dimension, at every tier. */
export function now(t = state.t) {
  const active = EXEC.filter((u) => u.t0 <= t && u.t1 > t);
  const at = (tier) => active.filter((u) => u.tier === tier).at(-1) ?? EXEC.filter((u) => u.tier === tier && u.t0 <= t).at(-1);
  const exec = LADDERS.execution.map((_, i) => at(i));
  const kernel = active.find((u) => u.tier === 5);
  const sample = SAMPLES[Math.min(SAMPLES.length - 1, Math.floor(t / 100))];
  const transfers = TRANSFERS.filter((x) => x.t0 <= t && x.t1 > t);
  const comp = exec[2]?.comp ?? exec[0]?.comp;
  const archPath = []; for (let x = byId.get(kernel ? "sw.device" : comp); x; x = byId.get(x.parent)) archPath.unshift(x.id);
  const hwActive = new Set(active.flatMap((u) => u.hw));
  if (kernel) for (let i = 0; i < kernel.gpu.sms; i++) hwActive.add(`sm${i}`);
  transfers.forEach((x) => { hwActive.add(x.from); hwActive.add(x.to); hwActive.add("pcie"); hwActive.add("ce0"); });
  return { exec, kernel, sample, transfers, archPath, hwActive, comp };
}

export const data = { LADDERS, ALIGN, EXEC, ARCH, HW, TRANSFERS, SAMPLES, END, byId };

// ---------------- one keymap for every layout
export const KEYS = [
  ["← →", "previous / next stop of the focused tier"], ["Shift ← →", "stop one tier coarser"],
  ["↑ ↓", "fly one tier coarser / finer"], ["E H A", "cross to execution / hardware / architecture (aligned tier)"],
  ["1-6", "fly to tier n of the focused dimension"], ["Space", "play stops"], ["[ ]", "previous / next prototype"],
];
export function installKeys(current) {
  let timer = null;
  addEventListener("keydown", (e) => {
    const k = e.key;
    if (k === "ArrowRight") step(+1, e.shiftKey); else if (k === "ArrowLeft") step(-1, e.shiftKey);
    else if (k === "ArrowUp") fly(-1); else if (k === "ArrowDown") fly(+1);
    else if ("ehaEHA".includes(k) && k.length === 1) cross({ e: "execution", h: "hardware", a: "architecture" }[k.toLowerCase()]);
    else if (k >= "1" && k <= "6") flyTo(state.dim, Number(k) - 1);
    else if (k === " ") { state.playing = !state.playing; clearInterval(timer); if (state.playing) timer = setInterval(() => step(+1), 700); emit(); }
    else if (k === "[" || k === "]") { const i = PROTOTYPES.findIndex(([id]) => id === current); const n = PROTOTYPES[(i + (k === "]" ? 1 : PROTOTYPES.length - 1)) % PROTOTYPES.length]; location.href = `../${n[0]}/index.html`; }
    else return;
    e.preventDefault();
  });
}

/** The prototype switcher strip (top) and the position readout every layout shares. */
export function mountChrome(current) {
  const css = document.createElement("style");
  css.textContent = `#d10-nav{position:fixed;top:0;left:0;right:0;height:34px;display:flex;gap:6px;align-items:center;padding:0 10px;
    background:#0b0f16ee;border-bottom:1px solid #263041;font:13px system-ui;color:#c9d3e0;z-index:50}
    #d10-nav a{color:#8fa3bd;text-decoration:none;padding:4px 10px;border-radius:6px} #d10-nav a.on{background:#2b3a52;color:#fff}
    #d10-nav .pos{margin-left:auto;font-weight:600;color:#fff} #d10-nav .pos b{color:#7cc4ff}`;
  document.head.append(css);
  const nav = document.createElement("nav"); nav.id = "d10-nav";
  nav.innerHTML = PROTOTYPES.map(([id, name]) => `<a href="../${id}/index.html" class="${id === current ? "on" : ""}">${name}</a>`).join("") + `<span class="pos"></span>`;
  document.body.append(nav);
  subscribe((s) => { nav.querySelector(".pos").innerHTML = `<b>${s.dim}</b> › ${tierName()} (${s.tier + 1}/6) · t = ${(s.t / 1000).toFixed(3)} ms · ${stops().length} stops here${s.playing ? " · playing" : ""}`; });
  installKeys(current);
}
