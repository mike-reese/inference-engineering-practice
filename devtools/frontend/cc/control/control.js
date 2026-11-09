// The command center's one state and every action that changes it (COMMAND_CENTER.md 2.3, 2.5, 3.4, 6.4, 6.5): D13's
// model.js interface, backed by RunStore. Views read `state` and the queries; they change it only through the actions.
// One rAF clock, as D13: the live merge and playback advance first, then every subscriber runs once with the keys
// that changed, so the cursor and the drawing never drift a frame apart.
//
// | export | contract (times are ns from the shown run's t0; a tier is an index into ladders()[dim]) |
// | --- | --- |
// | state | world, focus, tiers {dim: tier}, paired, t, sel, metric, playing, pace, rate, bounds [a, b], playEvent, dock {pos, tab, open}, nav {back, fwd}, session, head, follow, rev |
// | state.sel | null, a row id of store() (number), or a thing key (string: manifest things[].key) |
// | state.session | {mode: "replay" or "live" or "compare", rep, run, runB, side: "A" or "B", live: null or {action, options, job, dry_run, state, note, done}} |
// | state.playEvent | the row id playback is at, or null |
// | state.rev | bumps when the shown store opens or changes (A/B side, live merge, aux.json) |
// | subscribe(fn) | fn(state, changed) now with every key true, then at most once per frame; returns unsubscribe |
// | store(), storeError() | the RunStore the worlds show (compare: side A or B), null while none is open; why the last open failed |
// | openedStore(run) | Promise of the RunStore of a run the session holds (compare: A and B) once it opens; null when it holds no such run or the open failed |
// | ladders(), tierOf(dim), tierName(dim, tier), aligned(from, tier, to) | the manifest's ladders; tier; tier name; aligned tier |
// | stops(dim, tier) | {ids: Uint32Array, t: Float64Array}: stop rows of (dimension, tier) and their times, by (t, id) |
// | units(tier) | {ids, start, end, reach, long}: units of an execution tier by start (layer: one per (iter, layer) group, id = its first kernel); reach: the longest duration outside the longest 1%; long: the indexes of those longer units (a query at t reads the starts in [t - reach, t] and long) |
// | now(t) | {exec[6], kernel, phases, flow, flows, comp, process, archPath, software, sample, sampleIndex, transfers, hwActive} |
// | archName(S, i) | a thing's name on the architecture ladder: a process by its component-map role |
// | boundsAt(t), eventsIn(b) | playback bounds at t; Uint32Array of every row starting in [b0, b1), by (start, id) |
// | metrics(), metricInputs() | aux.json metrics [{id, name, value, unit, request, rows}]; Set of row ids the selected one reads |
// | actions | setTier, fly, focus, setPaired, setWorld, setDock, step, walkRow, seek, select, selectMetric, goBack, goForward, togglePlay, setPace, setRate, loadRun, launch, compareRuns, setSide, setFollow |
// | constants | DIMS, WORLDS, DIM_COLOR, FLOW_COLOR; KEYS and bindKeys come from keys.js |
//
// now(t): exec[i] is the unit of execution tier i holding t, else the last one started before t, as {id, t0, t1} or
// null; kernel the kernel-tier unit holding t; phases every phase holding t; flow the flow name of exec[phase] and
// flows those of phases; comp the component thing of the first phase at t in exec[phase]'s process that has one
// (exec[phase] first: an NVTX range has none, a component stamp holding it does), else of the request, -1 when none;
// archPath the architecture ladder at exec[phase], from the host down: its lane's container and process, then that
// phase component (never the request's: that one runs in another process); software, while a kernel unit holds t
// whose launch call sits under exec[phase] (the GPU runs behind the CPU, so a kernel at t may belong to an earlier
// phase), the finest architecture tier its kind is placed at (kinds.json), as {tier, name, id: the kernel}, else null; process
// the process thing on archPath, or -1; sample is
// RunStore.samplesAt(t) (aligned with store().metrics; NaN = no fresh sample) and sampleIndex changes exactly when
// one of those samples does; transfers (memcpy and memset units holding t) and hwActive (the hardware things the
// rows at t ran on, with their ancestors) are computed when read.
import { openRun } from "../store/run.js";
import { Units } from "../store/units.js";
import { NONE16 } from "../store/columns.js";
import { readHash, writeHash } from "./url.js";
import { SESSION, runsOf, reloadSession } from "../session.js";
import { perf } from "../perf.js";

export const DIMS = ["execution", "hardware", "architecture"];
export const WORLDS = [["rep", "Rep"], ["stacked", "Stacked world"], ["spine", "Execution spine"], ["architecture", "Architecture"]];
export const DIM_COLOR = { execution: "#7cc4ff", hardware: "#f5a623", architecture: "#b58cff" };
/** Colour means logical flow (2.3), keyed by the manifest's flow names. */
export const FLOW_COLOR = { "request in": "#5aa9ff", prefill: "#ff7b72", decode: "#3fd0a0", "stream out": "#f778ba" };
const DRY_RUN = new URLSearchParams(location.search).get("dry_run") === "1";   // regress.sh: Launch starts nothing
const PLAY_BOUNDS_S = 8;   // time pace: the bounds play in 8 s at rate x1
const EVENTS_PER_S = 20;   // events pace: event starts visited per second at rate x1
const KEEP_STORES = 3;     // open runs kept for a quick switch back (6.6 budget: 160 MB per open run)
const POLL_MS = 1000;      // a launched job and its store run are polled once a second until the run streams
const NO_STOPS = { ids: new Uint32Array(0), t: new Float64Array(0) };

export const state = {
  world: "rep", focus: "execution", tiers: { execution: 2, hardware: 2, architecture: 4 }, paired: false,   // independent by default (owner, 2026-11-08)
  t: 0, sel: null, metric: null, playing: false, pace: "time", rate: 1, bounds: [0, 0], playEvent: null,
  dock: { pos: "bottom", tab: "selection", open: true }, nav: { back: 0, fwd: 0 },
  session: { mode: "replay", rep: null, run: null, runB: null, side: "A", live: null },
  head: 0, follow: true, rev: 0,
};
const KEYS_WATCHED = ["session", "head", "follow", "nav", "world", "focus", "tiers", "paired", "t", "sel", "metric", "playing", "pace", "rate", "bounds", "playEvent", "dock", "rev"];
const subs = new Set();
let last = {}, pending = false, hashAt = 0, ready = false;
const snap = () => Object.fromEntries(KEYS_WATCHED.map((k) => [k, JSON.stringify(state[k])]));
/** subscribe(fn): fn(state, changed) once now (every key changed) and then at most once per frame. */
export const subscribe = (f) => (subs.add(f), f(state, Object.fromEntries(KEYS_WATCHED.map((k) => [k, true]))), () => subs.delete(f));
function emit() { if (pending) return; pending = true; requestAnimationFrame(frame); }
function frame(nowMs) {
  pending = false;
  const S = store();
  if (S?.live) liveTick(S);
  if (state.playing) advance(nowMs);
  const now_ = snap(); const changed = {};
  for (const k of KEYS_WATCHED) changed[k] = now_[k] !== last[k];
  last = now_;
  for (const f of subs) try { f(state, changed); } catch (e) { reportError(e); }   // one view's error must not stop the others
  S?.live && S.painted();
  perf.frameDone();
  if (!hashAt) hashAt = setTimeout(() => { hashAt = 0; saveHash(); }, 150);   // trailing, at most every 150 ms
  // ccv waits for READY: the first frame drawn with the session's store open (or nothing to open)
  if (!ready && (S || openError || !shownRun())) { ready = true; window.READY = true; perf.mark("ready"); }
  if (state.playing || (S?.live && !S.live.ended)) emit();
}

// ---------------- stores: one RunStore per open run, A and B in compare; a few kept for switching back
const cache = new Map();   // run -> {s: RunStore | null, used, open: Promise of the RunStore}
const unitsOf = new WeakMap(), auxOf = new WeakMap();
let useClock = 0, openError = null;
const shownRun = () => (state.session.mode === "compare" && state.session.side === "B" ? state.session.runB : state.session.run);
export const store = () => cache.get(shownRun())?.s ?? null;
export const storeError = () => openError;
export const openedStore = (run) => cache.get(run)?.open.then((s) => s, () => null) ?? Promise.resolve(null);
const U = (S) => { let u = unitsOf.get(S); if (!u) unitsOf.set(S, (u = new Units(S))); return u; };

function need(run) {
  if (!run) return null;
  let e = cache.get(run);
  if (!e) {
    e = { s: null, used: 0, open: openRun(run) };
    cache.set(run, e);
    e.open.then((s) => { if (cache.get(run) === e) { e.s = s; opened(run, s); } else s.live?.ws?.close(); },
      (err) => { if (cache.get(run) === e) cache.delete(run); openError = `${run}: ${err.message ?? err}`; console.error(err); emit(); });
  }
  e.used = ++useClock;
  const keep = new Set([state.session.run, state.session.runB]);
  for (const [r, x] of [...cache].sort((a, b) => a[1].used - b[1].used)) {
    if (cache.size <= KEEP_STORES) break;
    if (!keep.has(r)) { x.s?.live?.ws?.close(); cache.delete(r); }
  }
  return e.s;
}
function openSession() { need(state.session.run); need(state.session.runB); const S = store(); if (S) adopt(S); }

function opened(run, s) {
  if (s.live) { s.on("wake", emit); s.on("generation", () => finalRun(run)); s.on("reload", () => reopen(run)); }
  s.aux().then((a) => {
    auxOf.set(s, (a.metrics ?? []).map((m) => ({ id: `${m.request_id}/${m.name}`, name: m.name, value: m.value, unit: m.unit, request: m.request_id, rows: m.inputs?.rows ?? [] })));
    if (store() === s) { state.rev++; emit(); }
  }, (err) => console.error(err));
  if (store() === s) adopt(s);
  emit();
}
/** The shown store is open: the head, the cursor inside its extent, a selection waiting for it, the bounds. */
function adopt(S) {
  openError = null;
  state.head = S.head();
  state.t = Math.max(S.extent[0], Math.min(state.head, state.t));
  if (typeof state.sel === "number" && !(state.sel < S.N)) state.sel = null;
  if (typeof state.sel === "string" && !S.things.some((x) => x.key === state.sel)) state.sel = null;
  if (pendingSel) {   // from the hash or a final reload: an eid resolves in any generation, a row id only in its own
    const p = pendingSel; pendingSel = null;
    // a selection from the URL also moves the cursor to its row, as select() does; a final reload keeps t (6.5)
    const take = (id) => { state.sel = id; if (p.seek) state.t = S.startOf[id]; };
    if (p.eid) S.resolve(p.eid).then((id) => { if (id != null && store() === S && state.sel == null) { take(id); rebound(); emit(); } }, (err) => console.error(err));
    else if (p.generation === S.generation && p.id < S.N) take(p.id);
  }
  state.bounds = boundsAt(state.t);
  state.rev++;
}
/** The final import wrote the next generation (6.5): reload it as a replay, keeping t, the world and the selection. */
function finalRun(run) {
  const S = cache.get(run)?.s, sel = typeof state.sel === "number" ? S?.detailCached(state.sel)?.eid : null;
  if (sel) pendingSel = { eid: sel };
  if (state.session.run === run && state.session.mode === "live") state.session = { ...state.session, mode: "replay", live: { ...state.session.live, done: true } };
  reloadSession().then(() => reopen(run), (err) => { console.error(err); reopen(run); });
}
function reopen(run) { const e = cache.get(run); e?.s?.live?.ws?.close(); cache.delete(run); if (typeof state.sel === "number") state.sel = null; openSession(); emit(); }

// ---------------- tiers, focus, worlds, dock
let lad = null, align = null;   // the manifest's ladders and alignment table (every run carries the registry's)
export const ladders = () => { const S = store(); if (S) { lad = S.dims.ladders; align = S.dims.d.align; } return lad; };
export const tierOf = (dim = state.focus) => state.tiers[dim];
export const tierName = (dim = state.focus, tier = state.tiers[dim]) => ladders()?.[dim]?.[tier] ?? "";
/** The tier of `to` aligned with (`from`, tier), from the manifest's alignment table (3.4). */
export function aligned(from, tier, to) {
  const L = ladders(); if (!L) return state.tiers[to];
  const row = align.find((r) => r[from] === L[from][tier]) ?? align[Math.min(tier, align.length - 1)];
  return L[to].indexOf(row[to]);
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

// ---------------- stops, steps, the every-row walk, seek
export function stops(dim = state.focus, tier = state.tiers[dim]) { const S = store(); return S ? S.dims.stops(dim, S.dims.ladders[dim][tier]) : NO_STOPS; }
export function units(tier) { const S = store(); return S ? U(S).of(tier) : { ids: new Uint32Array(0), start: new Float64Array(0), end: new Float64Array(0), reach: 0, long: new Uint32Array(0) }; }
/** The cursor for RunStore.step / walk: the selected row breaks ties at t, else the step leaves t (3.4). */
const cursor = (S, dir) => ({ t: state.t, id: typeof state.sel === "number" && S.startOf[state.sel] === state.t ? state.sel : dir > 0 ? 0xffffffff : -1 });
export function step(dir, coarser = false) {
  const S = store(); if (!S) return;
  const tier = coarser ? Math.max(0, tierOf() - 1) : tierOf();
  const r = S.step(state.focus, S.dims.ladders[state.focus][tier], cursor(S, dir), dir);
  if (r && r.t <= state.head) { state.t = r.t; state.sel = r.id; rebound(); emit(); }
}
/** Alt ← →: the previous / next row of the focused tier, every row in time order across every process. */
export function walkRow(dir) {
  const S = store(); if (!S) return;
  const r = S.walk(state.focus, S.dims.ladders[state.focus][tierOf()], cursor(S, dir), dir);
  if (r && r.t <= state.head) { state.t = r.t; state.sel = r.id; rebound(); emit(); }
}
export function seek(t) {
  const S = store();
  state.t = Math.max(S ? S.extent[0] : 0, Math.min(state.head, t));
  if (state.session.mode === "live") state.follow = false;
  rebound(); emit();
}

// ---------------- session (the shell): replay, live, compare
let pendingSel = null;   // {eid} or {id, generation}: a row selection waiting for its store to open
const reset = () => { stop(); trail.back = []; trail.fwd = []; countNav(); state.t = 0; state.sel = null; state.metric = null; state.follow = true; state.head = 0; pendingSel = null; };
/** Replay a stored run of a rep. Opens on the Rep world, cursor at the run's t0. */
export function loadRun(rep, run) {
  reset(); state.session = { mode: "replay", rep, run, runB: null, side: "A", live: null };
  state.world = "rep"; openSession(); rebound(); emit();
}
/** Compare two runs (of one rep or two); the replay worlds show side A or B. */
export function compareRuns(rep, run, runB) {
  reset(); state.session = { mode: "compare", rep, run, runB, side: "A", live: null };
  state.world = "rep"; openSession(); rebound(); emit();
}
/** Compare: which run the replay worlds show. A row selection belongs to one run; a thing key carries over. */
export function setSide(side) {
  state.session = { ...state.session, side };
  if (typeof state.sel === "number") state.sel = null;
  const S = store(); if (S) adopt(S); else need(shownRun());
  emit();
}
export function setFollow(on) { state.follow = on; if (on) { state.t = state.head; rebound(); } emit(); }
/**
 * Launch a rep action through the runner (POST /runner/jobs) and follow its run live: the job names its run, RunWatcher
 * opens it in the store, the stream merges each frame, and the final generation reloads as a replay (6.5). With
 * ?dry_run=1 the runner checks the action and options and starts nothing. Resolves {ok, job} or {ok: false, error}.
 */
export async function launch(rep, action, options = {}) {
  const r = await fetch("/runner/jobs", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ rep, action: action.id, options, dry_run: DRY_RUN }) });
  if (!r.ok) return { ok: false, error: `${r.status}: ${await r.text()}` };
  const job = await r.json();
  reset(); state.session = { mode: "live", rep, run: job.run_id ?? null, runB: null, side: "A",
    live: { action: { id: action.id, label: action.label }, options, job: job.id ?? null, dry_run: !!job.dry_run, state: job.state, note: job.note ?? null } };
  if (state.world === "rep") state.world = "spine";
  rebound(); emit();
  if (job.id != null) followJob(job.id);
  return { ok: true, job };
}
async function followJob(id) {
  const mine = () => state.session.mode === "live" && state.session.live?.job === id;
  while (mine() && !store()) {
    const j = await (await fetch(`/runner/jobs/${id}`)).json();
    if (!mine()) return;
    state.session = { ...state.session, run: j.run_id ?? state.session.run, live: { ...state.session.live, state: j.state, note: j.note ?? null } };
    if (state.session.run && !cache.has(state.session.run)) {
      const runs = await (await fetch("/api/v3/runs")).json();
      if (runs.runs.some((x) => x.run === state.session.run)) openSession();
    }
    emit();
    if (j.ended_ns != null && !cache.has(state.session.run)) return;   // the job ended before its run reached the store
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
}
function liveTick(S) {
  if (S.flush()) state.rev++;
  state.head = S.head();
  if (state.follow && !state.playing) { state.t = state.head; state.bounds = boundsAt(state.t); }
}

// ---------------- selection history, like a browser's: a click pushes where you were, back and forward walk it
const trail = { back: [], fwd: [] };
const here = () => ({ sel: state.sel, t: state.t, metric: state.metric, tab: state.dock.tab, run: shownRun() });
const countNav = () => { state.nav = { back: trail.back.length, fwd: trail.fwd.length }; };
function remember() { trail.back.push(here()); trail.fwd = []; countNav(); }
function walk(from, to) {
  if (!from.length) return;
  to.push(here());
  const { tab, run, ...at } = from.pop();
  if (run !== shownRun() && typeof at.sel === "number") at.sel = null;   // a row id of the other compare side
  Object.assign(state, at); state.dock = { ...state.dock, tab, open: true };
  countNav(); rebound(); emit();
}
export const goBack = () => walk(trail.back, trail.fwd);
export const goForward = () => walk(trail.fwd, trail.back);

/** Select a row (id; a digit string from a data attribute counts) or a thing (key). A row moves the cursor to it. */
export function select(ref) {
  if (typeof ref === "string" && /^\d+$/.test(ref)) ref = Number(ref);
  if (ref !== state.sel || state.metric) remember();
  state.sel = ref ?? null; state.metric = null;
  const S = store();
  if (typeof ref === "number" && S && ref < S.N) { state.t = S.startOf[ref]; S.detail([ref]).catch((e) => console.error(e)); }   // the eid, for the URL
  rebound(); emit();
}
/** Select a metric: its input rows light up and the cursor goes to the first input. */
export function selectMetric(id) {
  if (id !== state.metric) remember();
  const mt = metrics().find((x) => x.id === id), S = store(); state.metric = id;
  if (mt?.rows.length && S) { state.t = S.startOf[mt.rows[0]]; state.sel = mt.rows.at(-1); }
  rebound(); emit();
}
export const metrics = () => auxOf.get(store()) ?? [];
/** Rows read by the selected metric (empty when none). */
export const metricInputs = () => new Set(metrics().find((x) => x.id === state.metric)?.rows ?? []);

// ---------------- playback (owner, 2026-11-08): every event of every tier inside the bounds, looping
/** The bounds at t: the unit of the execution tier holding t; between units of that tier, the nearest coarser unit
 *  holding t; the request tier is the whole run, from its t0 (as D13). Rows recorded before t0 (capture frames from
 *  before the run) stay reachable by stepping but never stretch the bounds. */
export function boundsAt(t) {
  const S = store(); if (!S) return [0, 0];
  for (let e = state.tiers.execution; e > 0; e--) { const k = U(S).at(e, t); if (k >= 0) { const u = U(S).of(e); return [u.start[k], u.end[k]]; } }
  return wholeRun(S);
}
const wholeRun = (S) => [0, Math.max(S.extent[1], 1)];
/** Recompute the bounds when t leaves them, or while they are the whole-run fallback: a run opens at t0, before any
 *  unit, so the first seek or selection must find its unit. */
const rebound = () => {
  const S = store(), [b0, b1] = state.bounds, whole = S && b0 === 0 && b1 === wholeRun(S)[1];
  if (whole || state.t < b0 || state.t >= b1) state.bounds = boundsAt(state.t);
};
/** Every row starting inside the bounds, by (start, id). */
export const eventsIn = (b = state.bounds) => { const S = store(); return S ? U(S).rowsIn(b) : new Uint32Array(0); };
let prevNow = 0, glide = null;
export function togglePlay() { state.playing ? stop() : start(); }
export function setPace(p) { state.pace = p; glide = null; emit(); }
export function setRate(r) { state.rate = r; emit(); }
function start() { if (!store()) return; state.playing = true; state.bounds = boundsAt(state.t); prevNow = 0; glide = null; emit(); }
function stop() { state.playing = false; state.playEvent = null; emit(); }
/** Time pace: the cursor moves linearly so the bounds play in 8 s at x1. Events pace: the cursor visits every row
 *  start in the bounds, EVENTS_PER_S per second, moving linearly between. Live: never past the head. */
function advance(nowMs) {
  const S = store(); if (!S) return;
  const dt = prevNow ? Math.min(100, nowMs - prevNow) : 0; prevNow = nowMs;
  const b0 = state.bounds[0], b1 = Math.min(state.bounds[1], Math.max(b0 + 1, state.head)), w = b1 - b0;
  const ev = state.pace === "events" ? eventsIn() : null;
  if (!ev || ev.length < 2) {   // one event has nothing to step between: sweep it in time
    let t = state.t + (w / PLAY_BOUNDS_S) * state.rate * dt / 1000;
    if (t >= b1) t = b0 + ((t - b0) % w);
    state.t = t;
    state.playEvent = deepest(S, t);
  } else {
    const at = (i) => S.startOf[ev[i]];
    if (!glide) { let lo = 0, hi = ev.length; while (lo < hi) { const k = (lo + hi) >>> 1; if (at(k) <= state.t) lo = k + 1; else hi = k; } glide = { i: lo % ev.length, from: state.t, p: 0 }; }
    glide.p += EVENTS_PER_S * state.rate * dt / 1000;
    while (glide.p >= 1) {
      state.playEvent = ev[glide.i];
      glide.from = at(glide.i); glide.i = (glide.i + 1) % ev.length; glide.p -= 1;
      if (glide.i === 0) glide.from = b0;
    }
    const to = at(glide.i);
    state.t = glide.i === 0 && glide.from > to ? b0 : glide.from + (to - glide.from) * glide.p;
  }
}
/** The finest execution unit holding t (the event playback is at), or null. */
function deepest(S, t) { for (let e = S.dims.ladders.execution.length - 1; e >= 0; e--) { const k = U(S).at(e, t); if (k >= 0) return U(S).of(e).ids[k]; } return null; }

// ---------------- what is true at the cursor
let nowKey = "", nowVal = null;
const EMPTY_NOW = { exec: [null, null, null, null, null, null], kernel: null, phases: [], flow: null, flows: new Set(), comp: -1, process: -1,
  archPath: [], software: null, sample: new Float64Array(0), sampleIndex: 0, transfers: [], hwActive: new Set() };
/** A thing's name on the architecture ladder: a process by its role in the component map, else its recorded name. */
export const archName = (S, i) => { const x = S.things[i], role = x?.attrs?.role?.name; return role ? role.split(/ \(|:/)[0] : x?.name ?? ""; };
/** What is true at the cursor in every dimension, at every tier (contract in the table above). */
export function now(t = state.t) {
  const S = store(), key = `${S?.run}|${state.rev}|${t}`;
  if (key !== nowKey) { nowKey = key; nowVal = S ? nowOf(S, t) : EMPTY_NOW; }
  return nowVal;
}
function nowOf(S, t) {
  const u = U(S), E = S.dims.ladders.execution, P = E.indexOf("phase"), K = E.indexOf("kernel");
  const unit = (e, k) => { const x = u.of(e); return { id: x.ids[k], t0: x.start[k], t1: x.end[k] }; };
  const exec = E.map((_, e) => { let k = u.at(e, t); if (k < 0) k = u.last(e, t); return k < 0 ? null : unit(e, k); });
  const kk = u.at(K, t), kernel = kk < 0 ? null : unit(K, kk);
  const phases = u.holding(P, t).map((k) => unit(P, k));
  const flow = exec[P] ? S.dims.flowOf(exec[P].id) : null;
  const flows = new Set(phases.map((x) => S.dims.flowOf(x.id)).filter(Boolean));
  const compOf = (x) => { const c = x ? S.field("comp", x.id) : NONE16; return c === NONE16 ? -1 : c; };
  const procOf = (x) => S.dims.laneLevel.process[S.field("lane", x.id)];
  const own = !exec[P] ? -1 : [exec[P], ...phases].filter((x) => procOf(x) === procOf(exec[P])).map(compOf).find((c) => c >= 0) ?? -1;
  const comp = own >= 0 ? own : compOf(exec[0]);
  const launchedHere = (k) => { for (let x = S.dims.launchOf(k), n = 0; x >= 0 && n < 400; n++, x = S.field("parent", x)) if (x === exec[P].id) return true; return false; };
  const A = S.dims.ladders.architecture, place = kernel && exec[P] && launchedHere(kernel.id) ? S.kinds[S.field("kind", kernel.id)].place.architecture : "";
  const layer = /^(.*) \((.*)\)$/.exec(place), software = layer?.[1] === A[A.length - 1] ? { tier: layer[1], name: layer[2], id: kernel.id } : null;
  const archPath = [];
  if (exec[P]) {
    const lane = S.field("lane", exec[P].id), L = S.dims.laneLevel;
    for (let x = S.things[L.container[lane]]; x; x = x.parent >= 0 ? S.things[x.parent] : null) archPath.unshift(x.i);
    if (L.process[lane] >= 0) archPath.push(L.process[lane]);
    if (own >= 0) archPath.push(own);
  }
  const process = archPath.find((i) => S.things[i].kind === "process") ?? -1;
  let sampleIndex = 0;
  for (const g of S.sampleGroups) { let lo = 0, hi = g.n; while (lo < hi) { const k = (lo + hi) >>> 1; if (g.ts[k] <= t) lo = k + 1; else hi = k; } sampleIndex += lo; }
  let transfers, hwActive;
  return { exec, kernel, phases, flow, flows, comp, process, archPath, software, sample: S.samplesAt(t), sampleIndex,
    get transfers() {
      if (!transfers) { const dev = new Set(S.dims.d.stops.hardware.device?.kinds ?? []);
        transfers = u.holding(K, t).filter((k) => dev.has(S.kinds[S.field("kind", u.of(K).ids[k])]?.name)).map((k) => unit(K, k)); }
      return transfers;
    },
    get hwActive() {
      if (!hwActive) {
        hwActive = new Set();
        S.scan({ win: [t, t] }, (id) => {
          if (!(S.startOf[id] <= t && S.endOf[id] > t)) return;
          for (let h = S.dims.ranOn(id); h >= 0 && !hwActive.has(h); h = S.things[h].parent ?? -1) hwActive.add(h);
        });
      }
      return hwActive;
    } };
}

// ---------------- the view lives in the URL hash, so a reload or a pasted link keeps the position (2.3)
function saveHash() {
  const { world, focus: f, tiers, paired, t, sel, metric, dock, pace, rate, session } = state;
  // a row by its eid once its detail is fetched; until then by id, valid only in the generation it came from
  const S = store(), eid = typeof sel === "number" ? S?.detailCached(sel)?.eid : null;
  writeHash({ session, world, focus: f, tiers, paired, t, sel: eid ? { eid } : typeof sel === "number" ? { id: sel, generation: S?.generation } : sel, metric, dock, pace, rate });
}
/** Bytes of every ArrayBuffer reachable from x through objects, arrays, maps and sets, each buffer counted once. */
function reachableTyped(x) {
  const seen = new Set(), bufs = new Set(), todo = [x];
  while (todo.length) {
    const v = todo.pop();
    if (v == null || typeof v !== "object" || seen.has(v)) continue;
    seen.add(v);
    if (ArrayBuffer.isView(v)) bufs.add(v.buffer);
    else if (v instanceof ArrayBuffer) bufs.add(v);
    else if (!(v instanceof EventTarget)) for (const y of v instanceof Map || v instanceof Set ? v.values() : Object.values(v)) if (y && typeof y === "object") todo.push(y);
  }
  let n = 0; for (const b of bufs) n += b.byteLength;
  return n;
}
/** The newest run of the newest run's rep that holds both a timeline (nsys) and its kernel counters (ncu): the
 *  reference run (7.3, R1); else that rep's newest run. */
async function defaultSession() {
  const rep = SESSION.runs[0]?.rep ?? SESSION.reps[0]?.id ?? null, runs = rep ? runsOf(rep) : [];
  let run = runs[0]?.id ?? null;
  for (const r of runs) {
    const m = await fetch(`/api/v3/runs/${encodeURIComponent(r.id)}/manifest`);
    if (m.ok && (await m.json().then((x) => x.tools?.nsys && x.tools?.ncu))) { run = r.id; break; }
  }
  return { mode: "replay", rep, run, runB: null, side: "A", live: null };
}
{
  const saved = readHash() ?? {};
  for (const k of ["session", "world", "focus", "tiers", "paired", "t", "sel", "metric", "dock", "pace", "rate"]) if (saved[k] !== undefined) state[k] = saved[k];
  if (!WORLDS.some(([id]) => id === state.world)) state.world = "rep";
  if (state.session.mode === "live") state.session = { ...state.session, mode: "replay" };   // a live session reloads as a replay
  if (!state.session.run) state.session = await defaultSession();
  state.session = { side: "A", runB: null, live: null, ...state.session };
  if (state.sel != null && typeof state.sel !== "string") { pendingSel = typeof state.sel === "object" ? { ...state.sel, seek: true } : null; state.sel = null; }
  state.playing = false;
  // Per open store: RunStore.bytes() (every typed-array buffer the store holds, by part, and total_mb) and typed_mb,
  // every typed-array buffer reachable from the store and its units, each counted once (adds the units' own lists).
  // js_heap_mb: Chrome's usedJSHeapSize, which excludes typed arrays, counts garbage not yet collected, and without
  // --enable-precise-memory-info is bucketed and refreshed at most every 20 minutes; a hint, not a measurement.
  perf.provide("memory_mb", () => {
    const stores = {};
    for (const [run, e] of cache) if (e.s) stores[run] = { ...e.s.bytes(), typed_mb: reachableTyped([e.s, unitsOf.get(e.s)]) / 2 ** 20 };
    return { stores, js_heap_mb: performance.memory ? performance.memory.usedJSHeapSize / 2 ** 20 : null };
  });
  openSession();
}
