// The D11 state every part reads (COMMAND_CENTER_DIMENSIONS.md section 2). Each dimension keeps its own tier.
// Paired: a tier change moves the other two dimensions to the aligned tier. Independent: only that dimension moves.
// The cursor (t) and the selection carry over when the world view changes. Samples are state, never stops.
import { LADDERS, ALIGN, EXEC, ARCH, HW, TRANSFERS, SAMPLES, END, byId, CONTAINERS, METRICS, PAYLOADS,
  PROCESS_COLOR, processOf, REFERENCE_RUN } from "./data.js";

export const DIMS = ["execution", "hardware", "architecture"];
export const WORLDS = [["stacked", "Stacked world"], ["spine", "Execution spine"]];
export const DIM_COLOR = { execution: "#7cc4ff", hardware: "#f5a623", architecture: "#b58cff" };

const archAncestor = (id, tier) => { let x = byId.get(id); while (x && x.tier > tier) x = byId.get(x.parent); return x?.id; };
const units = (tier) => EXEC.filter((u) => u.tier === tier).sort((a, b) => a.t0 - b.t0);
const handoffs = (tier) => {
  const out = []; let last = null;
  for (const p of units(2)) { const a = archAncestor(p.comp, tier); if (a !== last) out.push({ t: p.t0, ref: p.id, label: byId.get(a)?.name }); last = a; }
  return out;
};

/** Stops per (dimension, tier): [{t, ref, label}] sorted by t. */
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

export const state = {
  world: "stacked", focus: "execution", tiers: { execution: 2, hardware: 2, architecture: 4 }, paired: true,
  t: 0, sel: null, metric: null, playing: false, dock: { pos: "bottom", tab: "selection", open: true },
};
const subs = new Set();
export const subscribe = (f) => (subs.add(f), f(state), () => subs.delete(f));
const emit = () => { saveHash(); subs.forEach((f) => f(state)); };

export const tierOf = (dim = state.focus) => state.tiers[dim];
export const tierName = (dim = state.focus, tier = state.tiers[dim]) => LADDERS[dim][tier];
export const stops = (dim = state.focus, tier = state.tiers[dim]) => STOPS[dim][tier];

/** The tier of `to` aligned with (`from`, its tier), from the alignment table. */
export function aligned(from, tier, to) {
  const name = LADDERS[from][tier];
  const row = ALIGN.find((r) => r[from] === name) ?? ALIGN[Math.min(tier, ALIGN.length - 1)];
  return LADDERS[to].indexOf(row[to]);
}

/** Set one dimension's tier and focus it. Paired: the others follow to the aligned tier. */
export function setTier(dim, tier) {
  tier = Math.max(0, Math.min(5, tier));
  state.focus = dim; state.tiers[dim] = tier;
  if (state.paired) for (const d of DIMS) if (d !== dim) state.tiers[d] = aligned(dim, tier, d);
  emit();
}
export const fly = (d) => setTier(state.focus, state.tiers[state.focus] + d);
/** Focus a dimension. Its tier is kept: paired tiers are already aligned, independent ones are the user's. */
export function focus(dim) { state.focus = dim; emit(); }
export function setPaired(on) { state.paired = on; if (on) setTier(state.focus, state.tiers[state.focus]); else emit(); }
export function setWorld(w) { state.world = w; emit(); }
export function setDock(patch) { Object.assign(state.dock, patch); emit(); }

export function step(dir, coarser = false) {
  const tier = coarser ? Math.max(0, tierOf() - 1) : tierOf();
  const S = stops(state.focus, tier);
  const s = dir > 0 ? S.find((x) => x.t > state.t + 1e-6) : [...S].reverse().find((x) => x.t < state.t - 1e-6);
  if (s) { state.t = s.t; state.sel = s.ref; emit(); }
}
export function seek(t) { state.t = Math.max(0, Math.min(END, t)); emit(); }
/** Select any thing by id (execution unit, hardware thing, architecture thing, transfer, container). */
export function select(ref) {
  const x = byId.get(ref); state.sel = ref; state.metric = null;
  if (x?.t0 != null) state.t = x.t0;
  emit();
}
/** Select a metric: its input units light up and the cursor goes to the first input. */
export function selectMetric(id) {
  const mt = METRICS.find((x) => x.id === id); state.metric = id;
  if (mt) { const u = byId.get(mt.inputs[0]); state.t = u.t0; state.sel = mt.inputs.at(-1); }
  emit();
}
export function togglePlay() {
  state.playing = !state.playing; clearInterval(togglePlay.timer);
  if (state.playing) togglePlay.timer = setInterval(() => step(+1), 700);
  emit();
}

/** What is true at the cursor in every dimension, at every tier. */
export function now(t = state.t) {
  const active = EXEC.filter((u) => u.t0 <= t && u.t1 > t);
  const at = (tier) => active.filter((u) => u.tier === tier).at(-1) ?? EXEC.filter((u) => u.tier === tier && u.t0 <= t).at(-1);
  const exec = LADDERS.execution.map((_, i) => at(i));
  const kernel = active.find((u) => u.tier === 5);
  const si = Math.min(SAMPLES.length - 1, Math.floor(t / 100));
  const sample = SAMPLES[si];
  const transfers = TRANSFERS.filter((x) => x.t0 <= t && x.t1 > t);
  const comp = exec[2]?.comp ?? exec[0]?.comp;
  const archPath = []; for (let x = byId.get(kernel ? "sw.device" : comp); x; x = byId.get(x.parent)) archPath.unshift(x.id);
  const hwActive = new Set(active.filter((u) => u.tier >= 2).flatMap((u) => u.hw)); // request and iteration span everything
  if (kernel) for (let i = 0; i < kernel.gpu.sms; i++) hwActive.add(`sm${i}`);
  transfers.forEach((x) => { hwActive.add(x.from); hwActive.add(x.to); hwActive.add("pcie"); hwActive.add("ce0"); });
  const process = processOf(comp);
  return { exec, kernel, sample, sampleIndex: si, transfers, archPath, hwActive, comp, process };
}

/** Units lit by the selected metric (empty when none). */
export const metricInputs = () => new Set(METRICS.find((x) => x.id === state.metric)?.inputs ?? []);

export const data = { LADDERS, ALIGN, EXEC, ARCH, HW, TRANSFERS, SAMPLES, END, byId, CONTAINERS, METRICS, PAYLOADS,
  PROCESS_COLOR, processOf, REFERENCE_RUN };

// ---------------- keys (shortcuts; everything is also clickable)
export const KEYS = [
  ["← →", "previous / next stop of the focused tier"], ["Shift ← →", "stop one tier coarser"],
  ["↑ ↓", "fly one tier coarser / finer"], ["E H A", "focus execution / hardware / architecture"],
  ["1-6", "tier n of the focused dimension"], ["P", "paired / independent tiers"], ["W", "switch world view"],
  ["D", "dock bottom / right"], ["Space", "play stops"],
];
addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, textarea, select")) return;
  const k = e.key;
  if (k === "ArrowRight") step(+1, e.shiftKey); else if (k === "ArrowLeft") step(-1, e.shiftKey);
  else if (k === "ArrowUp") fly(-1); else if (k === "ArrowDown") fly(+1);
  else if ("ehaEHA".includes(k) && k.length === 1) focus({ e: "execution", h: "hardware", a: "architecture" }[k.toLowerCase()]);
  else if (k >= "1" && k <= "6") setTier(state.focus, Number(k) - 1);
  else if (k === "p" || k === "P") setPaired(!state.paired);
  else if (k === "w" || k === "W") setWorld(WORLDS[(WORLDS.findIndex(([id]) => id === state.world) + 1) % WORLDS.length][0]);
  else if (k === "d" || k === "D") setDock({ pos: state.dock.pos === "bottom" ? "right" : "bottom" });
  else if (k === " ") togglePlay();
  else return;
  e.preventDefault();
});

// ---------------- the state lives in the URL hash, so a reload or a screenshot link keeps the position
function saveHash() {
  const { world, focus: f, tiers, paired, t, sel, metric, dock } = state;
  history.replaceState(null, "", "#" + encodeURIComponent(JSON.stringify({ world, focus: f, tiers, paired, t, sel, metric, dock })));
}
try { Object.assign(state, JSON.parse(decodeURIComponent(location.hash.slice(1)))); } catch { /* fresh state */ }
