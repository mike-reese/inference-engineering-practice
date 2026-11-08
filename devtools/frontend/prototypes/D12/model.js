// The D12 state every part reads (COMMAND_CENTER_DIMENSIONS.md section 2). Each dimension keeps its own tier.
// Paired: a tier change moves the other two dimensions to the aligned tier. Independent: only that dimension moves.
// The cursor (t) and the selection carry over when the world view changes. Samples are state, never stops.
// Playback (owner, 2026-11-08) plays every event, of every tier, inside the bounds of the execution unit at the cursor
// (state.tiers.execution), and loops at the bounds. The tier sets the bounds only, never which events play.
// Like v2's Control (cc/control/control.js): one rAF clock, and at most one emit per frame with the keys that changed.
import { LADDERS, ALIGN, EXEC, ARCH, HW, TRANSFERS, SAMPLES, END, byId, CONTAINERS, METRICS, PAYLOADS,
  PROCESS_COLOR, processOf, REFERENCE_RUN, FLOWS, FLOW_COLOR, flowsOf } from "./data.js";

export const DIMS = ["execution", "hardware", "architecture"];
export const WORLDS = [["stacked", "Stacked world"], ["spine", "Execution spine"], ["architecture", "Architecture"]];
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
  t: 0, sel: null, metric: null, playing: false, pace: "time", rate: 1, bounds: [0, END], playEvent: null,
  dock: { pos: "bottom", tab: "selection", open: true }, nav: { back: 0, fwd: 0 },
};
const KEYS_WATCHED = ["nav", "world", "focus", "tiers", "paired", "t", "sel", "metric", "playing", "pace", "rate", "bounds", "playEvent", "dock"];
const subs = new Set();
let last = {}, pending = false, hashAt = 0;
const snap = () => Object.fromEntries(KEYS_WATCHED.map((k) => [k, JSON.stringify(state[k])]));
/** subscribe(fn): fn(state, changed) once now (every key changed) and then at most once per frame. */
export const subscribe = (f) => (subs.add(f), f(state, Object.fromEntries(KEYS_WATCHED.map((k) => [k, true]))), () => subs.delete(f));
/** Request a frame. Like v2's Control.request/tick: one rAF loop advances playback and then notifies every view in
 *  the same frame, so the cursor and the drawing never drift a frame apart. */
function emit() { if (pending) return; pending = true; requestAnimationFrame(frame); }
function frame(nowMs) {
  pending = false;
  if (state.playing) advance(nowMs);
  const now_ = snap(); const changed = {};
  for (const k of KEYS_WATCHED) changed[k] = now_[k] !== last[k];
  last = now_;
  for (const f of subs) try { f(state, changed); } catch (e) { reportError(e); }   // one view's error must not stop the others
  if (!hashAt) hashAt = setTimeout(() => { hashAt = 0; saveHash(); }, 150);   // v2 writeUrl: trailing, at most every 150 ms
  if (state.playing) emit();
}
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
  state.bounds = boundsAt(state.t);
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
export function seek(t) { state.t = Math.max(0, Math.min(END, t)); rebound(); emit(); }
// Selection history, like a browser's: a click pushes where you were, back and forward walk it.
const trail = { back: [], fwd: [] };
const here = () => ({ sel: state.sel, t: state.t, metric: state.metric, tab: state.dock.tab });
const countNav = () => { state.nav = { back: trail.back.length, fwd: trail.fwd.length }; };
function remember() { trail.back.push(here()); trail.fwd = []; countNav(); }
function walk(from, to) {
  if (!from.length) return;
  to.push(here());
  const { tab, ...at } = from.pop(); Object.assign(state, at); state.dock = { ...state.dock, tab, open: true };
  countNav(); rebound(); emit();
}
export const goBack = () => walk(trail.back, trail.fwd);
export const goForward = () => walk(trail.fwd, trail.back);

/** Select any thing by id (execution unit, hardware thing, architecture thing, transfer, container). */
export function select(ref) {
  if (ref !== state.sel || state.metric) remember();
  const x = byId.get(ref); state.sel = ref; state.metric = null;
  if (x?.t0 != null) state.t = x.t0;
  rebound(); emit();
}
/** Select a metric: its input units light up and the cursor goes to the first input. */
export function selectMetric(id) {
  if (id !== state.metric) remember();
  const mt = METRICS.find((x) => x.id === id); state.metric = id;
  if (mt) { const u = byId.get(mt.inputs[0]); state.t = u.t0; state.sel = mt.inputs.at(-1); }
  rebound(); emit();
}

// ---------------- playback
/** Every event of every tier (execution units and transfers), by start time. Playback visits each one. */
export const EVENTS = [...EXEC, ...TRANSFERS].map((u) => ({ t: u.t0, ref: u.id })).sort((a, b) => a.t - b.t || 0);
const PLAY_BOUNDS_S = 8;   // time pace: the bounds play in 8 s at rate x1 (v2: the window plays in 8 s)
const EVENTS_PER_S = 20;   // events pace: event starts visited per second at rate x1 (v2: 20 rows/s)
/** The bounds at t: the span of the execution unit at the execution tier holding t. Between units of that tier (for
 *  example before the first layer), the nearest coarser unit holding t; the request tier is the whole run. */
export function boundsAt(t) {
  for (let tier = state.tiers.execution; tier > 0; tier--) {
    const u = EXEC.find((x) => x.tier === tier && x.t0 <= t && x.t1 > t);
    if (u) return [u.t0, u.t1];
  }
  return [0, END];
}
const rebound = () => { if (state.t < state.bounds[0] || state.t >= state.bounds[1]) state.bounds = boundsAt(state.t); };
/** Events inside the bounds. */
export const eventsIn = (b = state.bounds) => EVENTS.filter((e) => e.t >= b[0] && e.t < b[1]);
let prevNow = 0, glide = null;
export function togglePlay() { state.playing ? stop() : start(); }
export function setPace(p) { state.pace = p; glide = null; emit(); }
export function setRate(r) { state.rate = r; emit(); }
function start() { state.playing = true; state.bounds = boundsAt(state.t); prevNow = 0; glide = null; emit(); }
function stop() { state.playing = false; state.playEvent = null; emit(); }
/** Time pace (default, v2's): the cursor moves linearly so the bounds play in 8 s at x1, every event passes under it.
 *  Events pace: the cursor visits every event start in the bounds, EVENTS_PER_S per second, moving linearly between. */
function advance(nowMs) {
  const dt = prevNow ? Math.min(100, nowMs - prevNow) : 0; prevNow = nowMs;
  const [b0, b1] = state.bounds, w = b1 - b0;
  const ev = state.pace === "events" ? eventsIn() : null;
  if (!ev || ev.length < 2) {   // one event (a kernel) has nothing to step between: sweep it in time
    let t = state.t + (w / PLAY_BOUNDS_S) * state.rate * dt / 1000;
    if (t >= b1) t = b0 + ((t - b0) % w);
    state.t = t;
    state.playEvent = EXEC.filter((u) => u.t0 <= t && u.t1 > t).at(-1)?.id ?? null;
  } else {
    if (!glide) { const i = ev.findIndex((e) => e.t > state.t + 1e-6); glide = { i: i < 0 ? 0 : i, from: state.t, p: 0 }; }
    glide.p += EVENTS_PER_S * state.rate * dt / 1000;
    while (glide.p >= 1) {
      state.playEvent = ev[glide.i]?.ref ?? null;
      glide.from = ev[glide.i]?.t ?? b0; glide.i = (glide.i + 1) % ev.length; glide.p -= 1;
      if (glide.i === 0) glide.from = b0;
    }
    const to = ev[glide.i]?.t ?? b0;
    state.t = glide.i === 0 && glide.from > to ? b0 : glide.from + (to - glide.from) * glide.p;
  }
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
  // Flows overlap: the decode loop and the stream back to the user can both have a phase at t.
  const phases = active.filter((u) => u.tier === 2);
  const flow = exec[2]?.flow ?? null, flows = new Set(phases.map((u) => u.flow));
  return { exec, kernel, sample, sampleIndex: si, transfers, archPath, hwActive, comp, process, phases, flow, flows };
}

/** Units lit by the selected metric (empty when none). */
export const metricInputs = () => new Set(METRICS.find((x) => x.id === state.metric)?.inputs ?? []);

export const data = { LADDERS, ALIGN, EXEC, ARCH, HW, TRANSFERS, SAMPLES, END, byId, CONTAINERS, METRICS, PAYLOADS,
  PROCESS_COLOR, processOf, REFERENCE_RUN, FLOWS, FLOW_COLOR, flowsOf };

// ---------------- keys (shortcuts; everything is also clickable)
export const KEYS = [
  ["← →", "previous / next stop of the focused tier"], ["Shift ← →", "stop one tier coarser"],
  ["↑ ↓", "fly one tier coarser / finer"], ["E H A", "focus execution / hardware / architecture"],
  ["1-6", "tier n of the focused dimension"], ["P", "paired / independent tiers"], ["W", "switch world view"],
  ["D", "dock bottom / right"], ["Space", "play every event in the bounds, looping"], ["T", "pace: events / time"],
  ["Alt ← →", "back / forward through selections"],
];
addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, textarea, select")) return;
  const k = e.key;
  if (e.altKey && (k === "ArrowLeft" || k === "ArrowRight")) (k === "ArrowLeft" ? goBack : goForward)();
  else if (k === "ArrowRight") step(+1, e.shiftKey); else if (k === "ArrowLeft") step(-1, e.shiftKey);
  else if (k === "ArrowUp") fly(-1); else if (k === "ArrowDown") fly(+1);
  else if ("ehaEHA".includes(k) && k.length === 1) focus({ e: "execution", h: "hardware", a: "architecture" }[k.toLowerCase()]);
  else if (k >= "1" && k <= "6") setTier(state.focus, Number(k) - 1);
  else if (k === "p" || k === "P") setPaired(!state.paired);
  else if (k === "w" || k === "W") setWorld(WORLDS[(WORLDS.findIndex(([id]) => id === state.world) + 1) % WORLDS.length][0]);
  else if (k === "d" || k === "D") setDock({ pos: state.dock.pos === "bottom" ? "right" : "bottom" });
  else if (k === " ") togglePlay();
  else if (k === "t" || k === "T") setPace(state.pace === "time" ? "events" : "time");
  else return;
  e.preventDefault();
});

// ---------------- the state lives in the URL hash, so a reload or a screenshot link keeps the position
function saveHash() {
  const { world, focus: f, tiers, paired, t, sel, metric, dock, pace, rate } = state;
  history.replaceState(null, "", "#" + encodeURIComponent(JSON.stringify({ world, focus: f, tiers, paired, t, sel, metric, dock, pace, rate })));
}
try {
  const { layout, ...saved } = JSON.parse(decodeURIComponent(location.hash.slice(1)));   // layout: D12 variants, now worlds
  Object.assign(state, saved);
  if (!WORLDS.some(([id]) => id === state.world)) state.world = "stacked";
} catch { /* fresh state */ }
state.playing = false; state.bounds = boundsAt(state.t);
