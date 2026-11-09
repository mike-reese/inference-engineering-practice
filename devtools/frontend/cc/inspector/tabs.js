// The bottom bar's six tabs (COMMAND_CENTER.md 2.1), D13's Selected, At cursor, Metrics, Tokens, Kernels and Run,
// drawn from the shown RunStore (hot columns, cold detail, raw records), its aux.json, the manifest's things, places
// and tools, and /api/v3/reps. A tab is {key, label, deps(s), render(el, s, again), tick?(el, s)}: the bar renders the
// open tab when its deps change and calls tick when only the cursor or the selection moved. A render that needs cold
// detail or aux.json draws what is held, asks for the rest, and calls again() when it arrives.
// Links are data attributes the bar handles in one place: data-sel (a row id or a thing key), data-seek (a time),
// data-m (a metric id), data-world, data-run (load a run of the rep), data-open (a Nsight report), data-raw (a row's
// raw record).
import { state, store, storeError, now, archName, launchComponentOf, units, selRow, selKey, DIM_COLOR, FLOW_COLOR } from "../control/control.js";
import { NONE16 } from "../store/columns.js";
import { roleOf, fmtValue, fmtBytes, fmtSpan, periodOf, why } from "../sidebar/samples.js";
import { repOf, runOf, kindOf as runKind, whenOf, incompleteText, esc } from "../session.js";
import { nsysWhere } from "./nsight.js";

const ms = (ns, d = 3) => (ns / 1e6).toFixed(d);
const tag = (t) => `<span class="tag">${esc(t)}</span>`;
const word = (e) => (e ? String(e).split(":")[0] : "");   // "Observed: nvidia-smi" -> "Observed"
const json = (o) => `<pre class="json">${esc(JSON.stringify(o, null, 2))}</pre>`;
const num = (v) => (typeof v === "number" ? (Math.abs(v) >= 1e6 ? v.toExponential(3) : String(+v.toPrecision(6))) : esc(v));
const nm = (S, id) => S.nameText(S.field("name", id));
const short = (S, name) => String(name ?? "").replace(`${S.run}-`, "");
const seekLink = (t) => `<a class="seek" data-seek="${t}" title="move the cursor here">↦</a>`;
const link = (S, id, text, sel = id) => `<a class="go ${selKey(sel) === selKey(state.sel) ? "on" : ""}" data-sel="${selKey(sel)}">${esc(text ?? nm(S, id))}</a>`;
const thingLink = (S, i, text) => { const x = S.things[i]; return `<a class="go ${x.key === state.sel ? "on" : ""}" data-sel="${esc(x.key)}">${esc(text ?? x.name)}</a>`; };
const openBtn = (o, label, aria) => (o ? `<button class="b-open" data-open="${esc(JSON.stringify({ run: o.run, path: o.path }))}" aria-label="${esc(aria)}" title="asks the runner to open the report on the desktop">${esc(label)}</button>` : "");
const meter = (v, unit) => `<span class="meter"><span style="width:${Math.max(0, Math.min(100, v))}%"></span></span> ${fmtValue(v, unit)}`;
const lower = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const k = (lo + hi) >>> 1; if (a[k] < x) lo = k + 1; else hi = k; } return lo; };
const upper = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const k = (lo + hi) >>> 1; if (a[k] <= x) lo = k + 1; else hi = k; } return lo; };
const noRun = () => `<p class="muted">${esc(storeError() ?? (state.session.run ? "loading the run…" : "No run open. Use Load in the header."))}</p>`;

/** D13's flow lines, keyed by the manifest's flow names (2.3). */
const FLOW_TEXT = { "request in": "request in: client to the engine queue", prefill: "prefill: build the KV cache, first token",
  decode: "decode loop: one token per pass", "stream out": "stream out: token back to the user" };
const SEG_COLORS = ["#58a6ff", "#3fb950", "#d29922", "#bc8cff", "#f778ba"];   // D13's split colours, by position
/** Thing kinds of the architecture dimension; every other thing is hardware (the registry has no tier per thing kind). */
const ARCH_KINDS = new Set(["container", "process", "thread", "network", "component map", "boundary", "component"]);
/** The hardware tier of a hardware thing kind, for the Selected heading: D13's tiers (data.js) for the same parts. */
const HW_TIER = { host: "node", board: "node", cpu: "device", gpu: "device", VRAM: "device", "host memory": "device", nvme: "device",
  chipset: "device", "bus link": "device", SM: "unit", "copy engine": "unit", "L2 cache": "unit", "memory controller": "unit" };
const MAX_LIST = 200;

// ---------------------------------------------------------------- per-store lookups, rebuilt when rows change
const idxs = new WeakMap();
function idx(S) {
  const key = `${S.N}/${S.rev}`; let m = idxs.get(S);
  if (!m || m.key !== key) {
    m = { key, req: new Map(), iter: new Map(), kind: new Map(S.kinds.map((k) => [k.name, k.code])), memo: new Map() };
    for (const id of S.reqRows) m.req.set(S.field("req", id), id);
    for (const id of S.iterRows) m.iter.set(S.field("iter", id), id);
    idxs.set(S, m);
  }
  return m;
}
const memo = (S, key, make) => { const c = idx(S).memo; if (!c.has(key)) c.set(key, make()); return c.get(key); };
/** name index -> value, for the names whose text gives a truthy value. */
const namesWhere = (S, key, test) => memo(S, `names:${key}`, () => { const out = new Map(); S.names.forEach((_, i) => { const v = test(S.nameText(i)); if (v) out.set(i, v); }); return out; });
const tierIndex = (S, name) => S.dims.ladders.execution.indexOf(name);
const isDevice = (S, id) => S.dims.ex[id] === tierIndex(S, "kernel") && !S.dims.side[id];
const isCopy = (S, id) => { const k = S.kinds[S.field("kind", id)]?.name; return k === "memcpy" || k === "memset"; };
const hasModules = (S) => memo(S, "modules", () => S.dims.stops("execution", "module").ids.length > 0);
const hasInferred = (S) => memo(S, "inferred", () => S.dims.byKind[idx(S).kind.get("inferred module")]?.length > 0);

/** Cold detail of ids from the store's one cache: a getter once every id is held, else null (again() on arrival). */
function withDetail(S, ids, again) {
  const miss = ids.filter((id) => S.detailCached(id) === undefined);
  if (!miss.length) return (id) => S.detailCached(id);
  S.detail(miss).then(() => again(), (e) => console.error("bar: detail", e));
  return null;
}
const auxes = new WeakMap();
/** The store's aux.json once fetched, else null (again() on arrival). */
function auxOf(S, again) {
  if (auxes.has(S)) return auxes.get(S);
  S.aux().then((a) => { const first = !auxes.has(S); auxes.set(S, a); if (first) again?.(); }, (e) => console.error("bar: aux.json", e));
  return null;
}

/** The execution tier a row is placed at (kinds.json), "kernel (CPU side)" for a launch call, or "detail". */
function execLabel(S, id) { if (S.dims.side[id]) return "kernel (CPU side)"; const e = S.dims.ex[id]; return e >= 0 ? S.dims.ladders.execution[e] : "detail"; }

/** A unit's label at its execution tier: a request by its name, a layer unit (keyed by its first kernel row) by its
 *  layer and iteration, a copy on the kernel tier marked as one. */
export function unitText(S, tier, id) {
  const r = S.field("req", id);
  if (tier === "request" && r !== NONE16 && S.requests[r]) return short(S, S.requests[r]);
  if (tier === "layer") return `layer ${S.field("layer", id)} of iteration ${S.field("iter", id)}`;
  return isCopy(S, id) ? `${nm(S, id)} (copy)` : nm(S, id);
}

/** The layer unit (one per (iteration, layer) group of kernel stops) holding a kernel row, or -1. */
function layerUnit(S, id) {
  const u = units(tierIndex(S, "layer")), k = upper(u.start, S.startOf[id]) - 1;
  return k >= 0 && S.field("iter", u.ids[k]) === S.field("iter", id) && S.field("layer", u.ids[k]) === S.field("layer", id) ? u.ids[k] : -1;
}

/**
 * The execution units above a row, coarsest first, then the row: its request and iteration (hot req and iter), the
 * rows of an execution tier on the parent chain of the call that launched it (phase, a code run's module frames, the
 * call), its own parent chain (a graphs-on device row's inferred modules, M2) just above that call, and the layer
 * unit of its (iteration, layer). A device row with no module row above it says so (3.1, M2). A module takes its
 * request and iteration from the first device row it holds (dims.held) and sits in the layer of its device rows that
 * carry one; an inferred module (M2) also climbs from that row's launch call, without the call.
 */
function ladderOf(S, id) {
  const X = idx(S), L = S.dims.ladders.execution, ex = S.dims.ex, out = [], inf = S.dims.inferred(id);
  const held = ex[id] === tierIndex(S, "module") ? S.dims.held(id) : null, via = held?.[0] ?? id;
  const r = S.field("req", via), it = S.field("iter", via);
  if (r !== NONE16 && X.req.has(r) && X.req.get(r) !== id) out.push([L[0], X.req.get(r), unitText(S, L[0], X.req.get(r))]);
  if (it >= 0 && X.iter.has(it) && X.iter.get(it) !== id) out.push([L[1], X.iter.get(it)]);
  const climb = (x) => { const a = []; for (let n = 0; x >= 0 && n < 400; n++, x = S.field("parent", x)) if (S.dims.side[x] || ex[x] >= 2) a.push([execLabel(S, x), x]); return a.reverse(); };
  const launch = climb(S.dims.launchOf(id)), own = climb(S.field("parent", id));
  const call = launch.findIndex(([, y]) => S.dims.side[y]), up = call < 0 ? [...launch, ...own] : [...launch.slice(0, call), ...own, ...(inf ? [] : launch.slice(call))];
  const inner = up.findIndex(([, y]) => ex[y] > tierIndex(S, "layer") || S.dims.side[y]), at = inner < 0 ? up.length : inner;
  const extra = [], lr = held ? held.find((x) => S.field("layer", x) >= 0) ?? -1 : id;
  if (lr >= 0 && S.field("layer", lr) >= 0 && it >= 0) { const lu = layerUnit(S, lr); if (lu >= 0) extra.push([L[3], lu, unitText(S, L[3], lu)]); }
  if (isDevice(S, id) && S.dims.moduleOf(id) < 0) extra.push([L[4], null, !hasModules(S) ? "missing: this run has no module frames (M2)"
    : hasInferred(S) ? "none: no inferred module holds this kernel (M2)" : "none: no module frame above this kernel's launch call"]);
  up.splice(at, 0, ...extra);
  return [...out, ...up, [execLabel(S, id), id, unitText(S, execLabel(S, id), id)]];
}
/** The mark an inferred module row (M2) carries wherever the inspector names it. */
const infMark = (S, id) => (id != null && S.dims.inferred(id) ? ` ${tag("inferred (M2)")}` : "");
const pathHtml = (S, items) => `<ol class="path">${items.map(([tier, id, text]) => `<li><span class="dim">${esc(tier)}</span> ${id == null ? `<span class="muted">${esc(text)}</span>` : link(S, id, text, tier === "layer" ? { layer: id } : id)}${infMark(S, id)}</li>`).join("")}</ol>`;

/** Where a row runs on the architecture ladder: the container and process of its lane (a row on a stream, a device
 *  row or an inferred module: of the thread that launched it, dims.launchOf), then its component box. */
function whereHtml(S, id) {
  const T = S.things, c = S.dims.launchOf(id), own = S.field("comp", id), L = S.dims.laneLevel;
  const comp = own !== NONE16 ? own : launchComponentOf(id), mark = own === NONE16 && comp >= 0 ? ` ${tag("inferred")}` : "";
  let lane = S.field("lane", id);
  if (T[lane]?.kind === "stream" && c >= 0) lane = S.field("lane", c);
  const path = [L.container[lane], L.process[lane]].filter((i) => i >= 0);
  return `<ol class="path">${path.map((i) => `<li><span class="dim">${esc(T[i].kind)}</span> ${thingLink(S, i, archName(S, i))}</li>`).join("")}${comp >= 0 && comp !== NONE16 && T[comp] ? `<li><span class="dim">component</span> ${thingLink(S, comp)}${mark}</li>` : ""}</ol>`;
}

/** A payload drawn as D13 drew it: token ids as chips, texts and bodies as text, SSE events as text, lists of records
 *  (the requests a scheduler stamp lists) as tables, the rest as JSON. */
function inspect(p) {
  const chips = (a) => `<div class="chips">${a.map((t) => `<span>${esc(t)}</span>`).join("")}</div>`;
  const parts = [], rest = { ...p };
  delete rest.span_id;
  for (const key of ["token_ids", "prompt_token_ids", "new_token_ids"]) if (Array.isArray(p[key])) { parts.push(`<div class="label">${key} (${p[key].length})</div>${chips(p[key])}`); delete rest[key]; }
  for (const key of ["text", "body", "new_text", "content", "headers"]) if (typeof p[key] === "string") { parts.push(`<div class="label">${key}</div><pre class="payload">${esc(p[key])}</pre>`); delete rest[key]; }
  if (Array.isArray(p.events) && p.events.length && p.events.every((x) => typeof x === "string")) { parts.push(`<div class="label">SSE events</div><pre class="payload">${esc(p.events.join(""))}</pre>`); delete rest.events; }
  for (const [key, v] of Object.entries(rest)) {
    if (!Array.isArray(v) || !v.length || !v.every((r) => r && typeof r === "object" && !Array.isArray(r))) continue;
    const cols = [...new Set(v.flatMap((r) => Object.keys(r)))], cell = (x) => (x && typeof x === "object" ? JSON.stringify(x) : x ?? "");
    parts.push(`<div class="label">${esc(key)} (${v.length})</div><table class="sched"><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>
      ${v.map((r) => `<tr>${cols.map((c) => `<td>${esc(cell(r[c]))}</td>`).join("")}</tr>`).join("")}</table>`);
    delete rest[key];
  }
  if (Object.keys(rest).length) parts.push(json(rest));
  return parts.join("");
}

// ---------------------------------------------------------------- containers: lifecycle, Docker stats, topology
/** The last container event (lane = the container) at or before t, and the last health event. */
function lifecycle(S, ci, t) {
  const evs = memo(S, `life:${ci}`, () => {
    const k = idx(S).kind.get("container event"), out = [];
    if (k != null) for (const id of S.dims.byKind[k]) if (S.field("lane", id) === ci) out.push([S.startOf[id], nm(S, id)]);
    return out;
  });
  let at = null, health = null;
  for (const [t0, name] of evs) { if (t0 > t) break; if (name.startsWith("health_status")) health = name.replace(/^health_status:\s*/, ""); else at = name; }
  return { state: at, health };
}
/** The index of the newest sample of metric i at or before t (it changes when the metric's value does), or -1. */
function sampleAt(S, i, t) { const g = i >= 0 ? S.groupOf(i) : null; return g ? upper(g.ts, t) - 1 : -1; }
/** D13's container card: name, lifecycle, image and project, CPU, memory, network and GPU memory per process. */
function card(S, ci, t) {
  const c = S.things[ci], v = S.samplesAt(t), at = (role, thing = ci) => { const i = S.metricFor(role, thing); return i < 0 ? NaN : v[i]; };
  const life = lifecycle(S, ci, t), a = c.attrs ?? {}, mib = (b) => (Number.isNaN(b) ? "–" : (b / 2 ** 20).toFixed(0));
  const limit = a.mem_limit ? ` / ${mib(a.mem_limit)}` : "image" in a ? " (no limit)" : "";
  const cpu = at("container.cpu"), rx = at("container.rx"), tx = at("container.tx");
  const gpu = S.things.filter((p) => p.kind === "process" && p.pre >= c.pre && p.post <= c.post)
    .map((p) => [p, at("process.gpu", p.i)]).filter(([, m]) => !Number.isNaN(m));
  return `<div class="card"><div class="title">${thingLink(S, ci)}<span class="state">${esc(life.state ?? "no lifecycle event yet")}${life.health ? ` · ${esc(life.health)}` : ""}</span></div>
    <div class="image">${[esc(a.image ?? "image not recorded"), esc(a.project ?? "")].filter(Boolean).join(" · ")}</div>
    <div>cpu ${Number.isNaN(cpu) ? "–" : cpu.toFixed(1)}% · RAM ${mib(at("container.ram"))}${limit} MiB${Number.isNaN(rx) ? "" : ` · rx ${rx.toFixed(0)} tx ${Number.isNaN(tx) ? "–" : tx.toFixed(0)} B/s`}</div>
    ${gpu.map(([p, m]) => `<div style="color:#9fc3ff">GPU held: ${m.toFixed(0)} MiB · ${esc(p.attrs?.role?.name ?? p.name)} pid ${esc(p.attrs?.pid ?? "–")}</div>`).join("")}</div>`;
}
/** Phase stops whose lane or component sits under thing i (D13's "phases here"). */
const phasesHere = (S, i) => memo(S, `phases:${i}`, () => {
  const T = S.things, x = T[i], under = (j) => j !== NONE16 && T[j] && T[j].pre >= x.pre && T[j].post <= x.post, out = [];
  for (const id of S.dims.stops("execution", "phase").ids) if (under(S.field("lane", id)) || under(S.field("comp", id))) out.push(id);
  return out;
});

// ---------------------------------------------------------------- Selected
/** Kernel facts (D13's kernel table): cold args (nsys), Nsight Compute counters of profiled kernels, the class rule. */
function kernelHtml(S, id, d) {
  const a = d?.args ?? {}, sm = S.dims.smsUsed(a.grid), prof = S.dims.profiled.has(id), c = S.field("cause", id);
  const blocks = Array.isArray(a.grid) ? a.grid.reduce((x, y) => x * y, 1) : null, cv = (m) => d?.counters?.values?.find((v) => v.measure === m);
  const wait = d ? "–" : "…", ncu = (m, f) => { const v = cv(m); return v ? f(v.value, v.unit) : prof && !d ? "…" : "not profiled"; };
  const vals = d?.counters?.values ?? [];
  return `<table class="kv">
    <tr><td>grid</td><td>${blocks != null ? `${a.grid.join("×")} = ${blocks} blocks · block ${esc(a.block?.join("×") ?? "–")}` : wait}</td></tr>
    <tr><td>SMs</td><td>${sm ? `${sm.used} of ${sm.of} ${tag("Inferred: min(SMs, grid blocks)")}` : wait}</td></tr>
    <tr><td>registers</td><td>${a.registers != null ? `${a.registers} per thread · ${fmtBytes(a.shared_memory)} shared memory per block` : wait}</td></tr>
    <tr><td>DRAM</td><td>${ncu("DRAM read", (v) => `read ${fmtBytes(v)}`)}${cv("DRAM write") ? ` · write ${fmtBytes(cv("DRAM write").value)}` : ""}</td></tr>
    <tr><td>L2</td><td>${ncu("L2 traffic", (v) => fmtBytes(v))}</td></tr>
    <tr><td>occupancy</td><td>${ncu("achieved occupancy", (v, u) => meter(v, u))}</td></tr>
    <tr><td>kind</td><td>${esc(S.dims.kernelClass(id) ?? "–")} ${tag("Inferred: kinds.json kernel_class")}</td></tr>
    <tr><td>profiled</td><td>${prof ? `yes (Nsight Compute${d?.counters ? `, profile row ${d.counters.profile_row}` : ""})` : "no"}</td></tr>
    <tr><td>launch call</td><td>${c >= 0 ? `<code>${esc(nm(S, c))}</code> at ${ms(S.startOf[c])} ms (CPU), runs ${fmtSpan(S.startOf[id] - S.startOf[c])} later` : "–"}</td></tr></table>
    ${vals.length ? `<details><summary>Nsight Compute counters (${vals.length}) ${tag(word(d.counters.evidence))}</summary><table class="kv">${vals.map((v) =>
      `<tr><td>${esc(v.measure)}</td><td>${v.unit === "byte" ? fmtBytes(v.value) : v.unit === "ns" ? fmtSpan(v.value) : `${num(v.value)} ${esc(v.unit)}`}</td><td class="dim">${esc(v.metric)}</td></tr>`).join("")}</table></details>` : ""}`;
}
const opens = (d) => [d?.open?.nsys && `${openBtn(d.open.nsys, "Nsight Systems ↗", "Open the selected row in Nsight Systems")} <span class="muted">${esc(nsysWhere(d.open.nsys))}</span>`,
  d?.open?.ncu && `${openBtn(d.open.ncu, "Nsight Compute ↗", "Open the selected kernel in Nsight Compute")} <span class="muted">profile row ${esc(d.open.ncu.profile_row)}</span>`].filter(Boolean).join("<br>");

function rowView(S, s, again) {
  const id = s.sel, get = withDetail(S, [id], again), d = get ? get(id) : null, k = S.kinds[S.field("kind", id)];
  const flow = S.dims.flowOf(id), hw = S.dims.ranOn(id);
  const tier = execLabel(S, id), title = tier === "request" ? `${nm(S, id)} ${unitText(S, tier, id)}` : nm(S, id);
  const left = [`<div class="label" style="color:${DIM_COLOR.execution}">execution · ${esc(tier)}</div><h3>${esc(title)}</h3>${whenHtml(S, id, S.startOf[id], S.endOf[id])}`];
  if (isDevice(S, id) && !isCopy(S, id)) left.push(`<div class="label">kernel</div>${kernelHtml(S, id, d)}`);
  if (isCopy(S, id)) {
    const c = S.field("cause", id);
    left.push(`<div class="label">transfer</div><table class="kv"><tr><td>bytes</td><td>${fmtBytes(S.field("bytes", id))}</td></tr>
      <tr><td>ran on</td><td>${hw >= 0 ? thingLink(S, hw) : "–"}</td></tr>
      <tr><td>launch call</td><td>${c >= 0 ? `<code>${esc(nm(S, c))}</code> at ${ms(S.startOf[c])} ms (CPU)` : "–"}</td></tr></table>`);
  }
  left.push(`<div class="label">up the execution ladder</div>${pathHtml(S, ladderOf(S, id))}`);
  if (flow) left.push(`<div class="label">flow</div><div><span class="pdot" style="background:${FLOW_COLOR[flow] ?? "#8a90a0"}"></span>${esc(FLOW_TEXT[flow] ?? flow)}</div>`);
  left.push(`<div class="label">architecture: where it runs</div>${whereHtml(S, id)}`);
  left.push(`<div class="label">hardware it ran on</div><div>${hw >= 0 ? thingLink(S, hw) : `<span class="muted">none placed (kinds.json: ${esc(k?.place?.hardware ?? "-")})</span>`}</div>`);
  const open = opens(d);
  if (open) left.push(`<div class="label">open in</div><div>${open}</div>`);

  const right = [];
  const a = d?.args, stamp = a?.stamp && typeof a.stamp === "object" ? a.stamp : null;
  if (a && !isDevice(S, id)) {
    const comp = S.field("comp", id), where = comp !== NONE16 && S.things[comp] ? S.things[comp].name : S.things[S.field("lane", id)]?.name;
    const by = stamp ? `<table class="kv">${[["recorded by", a.owner], ["box", a.box], ["process", a.proc != null ? `${a.proc} pid ${a.pid ?? "–"}` : null], ["thread", a.thread]]
      .filter(([, v]) => v != null).map(([key, v]) => `<tr><td>${key}</td><td class="wrap">${esc(v)}</td></tr>`).join("")}</table>` : "";
    const body = stamp ? inspect(stamp) : inspect(a);
    if (by || body) right.push(`<div class="label">payload at ${esc(where ?? "–")} ${tag(word(d.evidence))}</div>${by}${body}`);
  }
  const links = S.linksOf(id).filter((l) => l.kind !== "cause" || l.from !== S.field("cause", id));
  const p = k?.place ?? {};
  right.push(`<div class="label">row</div><table class="kv">
    <tr><td>kind</td><td class="wrap">${esc(k?.label ?? "")}${d?.term ? ` · ${esc(d.term)}` : ""}</td></tr>
    <tr><td>eid</td><td class="wrap"><code>${esc(d?.eid ?? (get ? "–" : "…"))}</code> ${tag(`row ${id}`)}</td></tr>
    <tr><td>evidence</td><td class="wrap">${esc(d?.evidence ?? (get ? "–" : "…"))} ${d?.source ? tag(d.source) : ""}</td></tr>
    ${d?.what ? `<tr><td>what</td><td class="wrap">${esc(d.what)}</td></tr>` : ""}
    ${d?.code ? `<tr><td>code</td><td class="wrap"><code>${esc(d.code.where ?? "")}</code> ${tag(d.code.origin ?? "")}</td></tr>` : ""}
    <tr><td>placed</td><td class="wrap">${["execution", "hardware", "architecture"].map((dim) => `<span style="color:${DIM_COLOR[dim]}">${dim}</span> ${esc(typeof p[dim] === "string" ? p[dim] : execLabel(S, id))}`).join(" · ")}</td></tr>
    ${d?.corr != null ? `<tr><td>correlation id</td><td>${esc(d.corr)}</td></tr>` : ""}
    ${links.length ? `<tr><td>links</td><td class="wrap">${links.slice(0, 8).map((l) => `${esc(l.kind)} ${l.from === id ? `→ ${link(S, l.to)}` : `← ${link(S, l.from)}`}`).join("<br>")}${links.length > 8 ? `<br>+${links.length - 8} more` : ""}</td></tr>` : ""}
    ${d?.metrics?.length ? `<tr><td>used by</td><td class="wrap">${d.metrics.map((m) => `${esc(m.name)} = ${num(m.value)} ${esc(m.unit)}`).join("<br>")}</td></tr>` : ""}</table>
    <details><summary>raw record ${d?.raw ? `<span class="muted">${esc(d.raw.file)} ${esc(d.raw.pointer ?? "")}</span>` : ""}</summary>${d?.raw
      ? `<button class="b-open" data-raw="${id}">load the raw record</button><pre class="json" data-raw-out="${id}" hidden></pre>`
      : `<p class="muted">${d ? "This row has no raw record in the run folder (Nsight Systems rows: open the report)." : "…"}</p>`}</details>
    ${d ? `<details><summary>every detail field</summary>${json(d)}</details>` : ""}`);
  return `<div class="cols"><div>${left.join("")}</div><div>${right.join("")}</div></div>`;
}

/** When a row or unit runs: from the run's t0 and from its request's send, and how long. */
function whenHtml(S, id, t0, t1) {
  const r = S.field("req", id), send = r !== NONE16 && idx(S).req.has(r) ? S.startOf[idx(S).req.get(r)] : null;
  return `<div>at <b>${ms(t0)} ms</b> from the run's t0${send != null ? ` · ${ms(t0 - send)} ms from its request's send` : ""}${t1 > t0 ? `, lasts <b>${ms(t1 - t0)} ms</b> (${fmtSpan(t1 - t0)})` : ""} ${seekLink(t0)}</div>`;
}

/** A layer unit (D13): one (iteration, layer) group of kernel stops with no row of its own, keyed by its first
 *  kernel. Its span from units(layer), the ladder above it cut at the layer, and its first kernel's flow, place and
 *  hardware. */
function layerView(S, s) {
  const id = s.sel.layer, u = units(tierIndex(S, "layer"));
  let k = upper(u.start, S.startOf[id]) - 1;
  while (k >= 0 && u.ids[k] !== id && u.start[k] === S.startOf[id]) k--;
  if (k < 0 || u.ids[k] !== id) return `<p class="muted">Row ${id} starts no layer unit of this run.</p>`;
  const lad = ladderOf(S, id), cut = lad.findIndex(([tier, x]) => tier === "layer" && x === id), flow = S.dims.flowOf(id), hw = S.dims.ranOn(id);
  return `<div class="cols"><div><div class="label" style="color:${DIM_COLOR.execution}">execution · layer</div><h3>${esc(unitText(S, "layer", id))}</h3>${whenHtml(S, id, u.start[k], u.end[k])}
    <div class="label">up the execution ladder</div>${pathHtml(S, lad.slice(0, cut + 1))}
    ${flow ? `<div class="label">flow</div><div><span class="pdot" style="background:${FLOW_COLOR[flow] ?? "#8a90a0"}"></span>${esc(FLOW_TEXT[flow] ?? flow)}</div>` : ""}
    <div class="label">architecture: where it runs</div>${whereHtml(S, id)}
    <div class="label">hardware it ran on</div><div>${hw >= 0 ? thingLink(S, hw) : "–"}</div></div></div>`;
}

function thingView(S, s) {
  const i = S.things.findIndex((x) => x.key === s.sel), x = S.things[i];
  if (!x) return `<p class="muted">${esc(s.sel)} is not a thing of this run.</p>`;
  const dim = ARCH_KINDS.has(x.kind) ? "architecture" : "hardware", T = S.things;
  const up = []; for (let p = x.parent; p != null && p >= 0; p = T[p].parent) up.unshift(p);
  const attrs = Object.entries(x.attrs ?? {}).filter(([key]) => !["x", "y", "w", "h", "edges", "size"].includes(key));
  const left = [`<div class="label" style="color:${DIM_COLOR[dim]}">${dim} · ${esc(dim === "hardware" ? HW_TIER[x.kind] ?? x.kind : x.kind)}</div><h3>${esc(x.name)}</h3>`, `<div class="dim">${esc(x.evidence ?? "")}</div>`];
  if (attrs.length) left.push(`<table class="kv">${attrs.map(([key, v]) => `<tr><td>${esc(key)}</td><td class="wrap">${v && typeof v === "object" ? esc(v.name ?? JSON.stringify(v)) : esc(v ?? "–")}</td></tr>`).join("")}</table>`);
  if (up.length) left.push(`<div class="label">parents</div><ol class="path">${up.map((p) => `<li><span class="dim">${esc(T[p].kind)}</span> ${thingLink(S, p)}</li>`).join("")}</ol>`);
  const right = [];
  if (x.kind === "container") right.push(card(S, i, s.t));
  if (x.kind === "process") {
    const m = S.metricFor("process.gpu", i), v = m < 0 ? NaN : S.samplesAt(s.t)[m];
    if (m >= 0) right.push(`<div class="label">GPU memory held at the cursor</div><div>${Number.isNaN(v) ? `– <span class="dim">${esc(why(S, m))}</span>` : `${v.toFixed(0)} MiB`} <span class="dim">${esc(periodOf(S, m))}</span></div>`);
  }
  if (dim === "architecture") {
    const ph = phasesHere(S, i);
    if (ph.length) right.push(`<div class="label">phases here (${ph.length}${ph.length > MAX_LIST ? `, first ${MAX_LIST}` : ""})</div><div>${ph.slice(0, MAX_LIST).map((id) => link(S, id, `${ms(S.startOf[id])} ${nm(S, id)}`)).join("<br>")}</div>`);
  }
  return `<div class="cols"><div>${left.join("")}</div><div>${right.join("")}</div></div>`;
}

const selected = {
  key: "selected", label: "Selected",
  deps: (s) => {
    const S = store(); if (!S) return [null, s.sel];
    const i = typeof s.sel === "string" ? S.things.findIndex((x) => x.key === s.sel) : -1;   // a thing's card reads samples at t
    return [S, s.sel, s.rev, i >= 0 ? sampleAt(S, S.metrics.findIndex((m) => m.thing === i), s.t) : 0, i >= 0 ? lifecycle(S, i, s.t).state : null];
  },
  render(el, s, again) {
    const S = store();
    if (s.sel == null) { el.innerHTML = `<p class="muted">Nothing selected. Step with ← →, click a stop on the timeline, a tier, or a thing in the world.</p>`; return; }
    if (!S) { el.innerHTML = noRun(); return; }
    el.innerHTML = typeof s.sel === "number" ? rowView(S, s, again) : s.sel.layer != null ? layerView(S, s) : thingView(S, s);
  },
};

// ---------------------------------------------------------------- At cursor
const SAMPLE_ROWS = [["SMs active", "sm_active"], ["GPU utilization", "gpu_util"], ["DRAM read", "dram_read"], ["DRAM write", "dram_write"],
  ["PCIe RX", "pcie_rx"], ["PCIe TX", "pcie_tx"], ["host CPU busy", null, "host.cpu.busy"], ["GPU memory used", "mem_used"]];
function sampleBlock(S, n) {
  const rows = [], missing = [];
  for (const [label, role, metric] of SAMPLE_ROWS) {
    const i = role ? roleOf(S, role) : S.metrics.findIndex((m) => m.metric === metric);
    if (i < 0) { missing.push(label); continue; }
    const m = S.metrics[i], v = n.sample[i], pct = m.unit === "%" || m.unit === "Throughput %";
    const val = Number.isNaN(v) ? `<span class="dim" title="${esc(why(S, i))}">–</span>` : pct ? meter(v, m.unit) : m.unit === "MiB" ? fmtBytes(v * 2 ** 20) : fmtValue(v, m.unit);
    rows.push(`<tr><td title="${esc(m.metric)}">${esc(label)}</td><td>${val}</td><td class="dim">${esc(periodOf(S, i))}</td></tr>`);
  }
  const ci = n.archPath.find((i) => S.things[i]?.kind === "container");
  return `<div class="label" style="color:${DIM_COLOR.hardware}">hardware · sample ${n.sampleIndex} (state, not a stop)</div>
    <table class="kv">${rows.join("")}</table>${missing.length ? `<div class="dim">not recorded in this run: ${esc(missing.join(", "))}</div>` : ""}
    ${ci != null ? card(S, ci, state.t) : ""}`;
}
const atCursor = {
  key: "cursor", label: "At cursor",
  deps: (s) => {
    const S = store(); if (!S) return [null];
    const n = now();
    return [S, s.sel, s.rev, n.phases.map((u) => u.id).join(), n.exec.map((u) => u?.id).join(), n.kernel?.id, n.transfers.map((x) => x.id).join(), n.archPath.join()];
  },
  render(el, s) {
    const S = store(); if (!S) { el.innerHTML = noRun(); return; }
    const n = now(), L = S.dims.ladders.execution;
    const exec = n.exec.map((u, i) => `<tr><td>${esc(L[i])}</td><td>${u ? link(S, u.id, unitText(S, L[i], u.id), L[i] === "layer" ? { layer: u.id } : u.id) + infMark(S, u.id) : "–"}</td></tr>`).join("");
    el.innerHTML = `<div class="cols"><div>
        <h3><span class="ac-t">${ms(s.t)}</span> ms <span class="muted">from the run's t0 · everything true at the cursor</span></h3>
        <div class="label" style="color:${DIM_COLOR.execution}">execution</div><table class="kv">${exec}</table>
        <div class="label">flows running now</div><div>${n.phases.slice(0, 24).map((u) => { const f = S.dims.flowOf(u.id);
          return `<div><span class="pdot" style="background:${FLOW_COLOR[f] ?? "#8a90a0"}"></span>${link(S, u.id)} <span class="dim">${esc(f ?? "no flow")}</span></div>`; }).join("") || "–"}${n.phases.length > 24 ? `<div class="dim">+${n.phases.length - 24} more</div>` : ""}</div>
        <div class="label" style="color:${DIM_COLOR.architecture}">architecture</div>
        <ol class="path">${n.archPath.map((i) => `<li><span class="dim">${esc(S.things[i].kind)}</span> ${thingLink(S, i, archName(S, i))}</li>`).join("")}${n.software
          ? `<li><span class="dim">${esc(n.software.tier)}</span> ${esc(n.software.name)}: ${link(S, n.software.id)}</li>` : ""}</ol>
      </div><div>
        <table class="kv"><tr><td>kernel</td><td>${n.kernel ? link(S, n.kernel.id) : "none running"}</td></tr>
          <tr><td>transfer</td><td>${n.transfers.map((x) => link(S, x.id, `${nm(S, x.id)}, ${fmtBytes(S.field("bytes", x.id))}`)).join("<br>") || "none in flight"}</td></tr></table>
        <div class="ac-smp" data-i="${n.sampleIndex}">${sampleBlock(S, n)}</div></div></div>`;
  },
  tick(el, s) {
    const t = el.querySelector(".ac-t"), S = store(); if (!t || !S) return;
    t.textContent = ms(s.t);
    const box = el.querySelector(".ac-smp"), n = now();
    if (box && Number(box.dataset.i) !== n.sampleIndex) { box.dataset.i = n.sampleIndex; box.innerHTML = sampleBlock(S, n); }
  },
};

// ---------------------------------------------------------------- Metrics
/** The request a tab shows: the selected metric's; else the one holding the cursor; else the rep's measured request
 *  (moments.toml `request`); else the last one started before the cursor. -1 when the run has none. */
function shownReq(S, s) {
  if (!S || !S.requests.length) return -1;
  if (s.metric) { const r = S.requests.indexOf(s.metric.slice(0, s.metric.indexOf("/"))); if (r >= 0) return r; }
  const c = S.chain(s.t).request;
  if (c?.contains) return c.req;
  const want = repOf(runOf(S.run)?.rep ?? s.session.rep)?.moments?.request, k = want ? S.requests.findIndex((q) => q.endsWith(`-${want}`)) : -1;
  return k >= 0 ? k : c?.req ?? 0;
}
const reqPicker = (S, r) => `requests: ${S.requests.map((name, i) => { const id = idx(S).req.get(i);
  return i === r ? `<b>${esc(short(S, name))}</b>` : id != null ? link(S, id, short(S, name)) : esc(short(S, name)); }).join(" · ")}`;
const mid = (m) => `${m.request_id}/${m.name}`;
const valueText = (m) => (m.unit === "ms" ? `${(+m.value).toFixed(3)} ms <span class="dim">(${(m.value * 1000).toFixed(0)} µs)</span>` : `${num(m.value)} ${esc(m.unit)}`);
/** The TTFT split: aux.json's "segment N" metrics of the request up to the client's first token event (the rule of
 *  session.js ttftSegments for latency.json), each with its formula, value and input rows. */
function split(list) {
  const segs = list.filter((m) => /^segment \d+:/.test(m.name)).sort((a, b) => parseInt(a.name.slice(8)) - parseInt(b.name.slice(8)));
  const end = segs.findIndex((m) => /client first token event/.test(m.name));
  return end < 0 ? [] : segs.slice(0, end + 1).map((m, i) => ({ ...m, color: SEG_COLORS[i % SEG_COLORS.length] }));
}
function segbar(title, segs, ttft) {
  const total = segs.reduce((a, x) => a + Math.max(0, x.value), 0);
  return `<div class="label">${title}</div><div class="segbar">${segs.map((x) => `<span class="seg ${state.metric === mid(x) ? "on" : ""}" data-m="${esc(mid(x))}"
      style="width:${(100 * Math.max(0, x.value)) / total}%;background:${x.color}" title="${esc(x.name)} = ${esc(x.formula)}: ${(+x.value).toFixed(3)} ms">${(+x.value).toFixed(3)} ms</span>`).join("")}</div>
    <div class="dim">${ttft ? `client TTFT ${(+ttft.value).toFixed(3)} ms (aux.json); ` : ""}the ${segs.length} segments above sum to ${total.toFixed(3)} ms (click one)</div>`;
}
/** The input rows of metrics that the store holds, each once. */
const inputRows = (S, list) => [...new Set(list.flatMap((m) => (m.inputs?.rows ?? []).filter((id) => id < S.N)))];
/** Where a metric's inputs come from: the recorded source of each input row (row detail) and each sample block. */
const sourcesOf = (S, m, get) => [...new Set([...inputRows(S, [m]).map((id) => get?.(id)?.source), ...(m.inputs?.samples ?? []).map((x) => x[0])].filter(Boolean))];
/** The metric table, with each metric's inputs and their sources. */
function metricRows(S, s, list, again) {
  const get = withDetail(S, inputRows(S, list), again);
  const inputs = (m) => [...(m.inputs?.rows ?? []).map((id) => (id < S.N ? link(S, id, nm(S, id).slice(0, 28)) : `row ${id}`)),
    ...(m.inputs?.samples?.length ? [tag(`${m.inputs.samples.length} samples`)] : []), ...(m.inputs?.unresolved ?? []).map((u) => tag(`unresolved ${u}`))].join("<br>");
  const source = (m) => (get || !inputRows(S, [m]).length ? sourcesOf(S, m, get).join(" · ") || "–" : "…");
  return `<table class="metrics"><tr><th>metric</th><th>clock</th><th>formula</th><th>value</th><th>inputs (click)</th><th>source</th></tr>${list.map((m) => `<tr data-m="${esc(mid(m))}" class="${s.metric === mid(m) ? "on" : ""}">
    <td>${esc(m.name)}</td><td>${esc(m.clock ?? "–")}</td><td><code>${esc(m.formula)}</code></td><td>${valueText(m)}</td><td class="inp">${inputs(m) || "–"}</td><td class="dim">${esc(source(m))}</td></tr>`).join("")}</table>`;
}
const metricsTab = {
  key: "metrics", label: "Metrics",
  deps: (s) => { const S = store(); return [S, s.metric, s.sel, s.rev, shownReq(S, s), S ? auxes.has(S) : false]; },
  render(el, s, again) {
    const S = store(); if (!S) { el.innerHTML = noRun(); return; }
    const aux = auxOf(S, again);
    if (!aux) { el.innerHTML = `<p class="muted">loading aux.json…</p>`; return; }
    const r = shownReq(S, s), rid = S.requests[r], list = aux.metrics.filter((m) => m.request_id != null && m.request_id === rid);
    const runLevel = aux.metrics.filter((m) => m.request_id == null), segs = split(list), ttft = list.find((m) => m.name === "client TTFT");
    const gone = (aux.unavailable ?? []).filter((u) => !u.what.includes(": ") || (rid && u.what.startsWith(`${rid}: `)));
    el.innerHTML = `<p class="muted">Metrics as they are calculated at import (aux.json), with the rows each one reads. Click a metric or a split segment: its inputs light on the timeline and in the world.
      The run's results, lessons and key moments: <a class="go" data-world="rep">Rep world ▸</a></p>
      <p>${S.requests.length ? reqPicker(S, r) : "no requests in this run"}</p>
      ${segs.length ? `<div class="cols"><div>${segbar(`TTFT split · <span style='color:#3fb950'>measured</span> (run ${esc(S.run)})`, segs, ttft)}</div></div>
        <div class="segleg">${segs.map((x) => `<span><i style="background:${x.color}"></i>${esc(x.name)} = ${esc(x.formula)}</span>`).join("")}</div>` : ""}
      ${list.length ? metricRows(S, s, list, again) : `<p class="muted">aux.json has no metrics for ${esc(short(S, rid) || "this run's requests")}.</p>`}
      ${runLevel.length ? `<div class="label">run-level (no request)</div>${metricRows(S, s, runLevel, again)}` : ""}
      ${gone.length ? `<div class="label">not calculated</div><ul>${gone.map((u) => `<li>${esc(short(S, u.what))}: ${esc(u.why)}</li>`).join("")}</ul>` : ""}`;
  },
};

// ---------------------------------------------------------------- Tokens
/** The token path of request r, each list in time order: the client's token events, the wire frames that carry token
 *  events (a frame of n events counts n times), and the worker's "sampled tokens appended" and "sampling launched"
 *  stamps. */
const tokenParts = (S, r) => memo(S, `tokens:${r}`, () => {
  const req = idx(S).req.get(r); if (req == null) return null;
  const K = idx(S).kind, out = { client: [], wire: [], appended: [], launched: [] };
  const tok = namesWhere(S, "event: token", (n) => n === "event: token"), frames = namesWhere(S, "token frames", (n) => +(/^(\d+) token event/.exec(n)?.[1] ?? 0));
  const app = namesWhere(S, "appended", (n) => n === "sampled tokens appended"), lau = namesWhere(S, "launched", (n) => n === "sampling launched");
  const kc = K.get("client event"), kn = K.get("network frame"), ks = K.get("component stamp");
  S.scan({ win: [S.startOf[req], S.endOf[req]], starts: true }, (id) => {
    if (S.field("req", id) !== r) return;
    const k = S.field("kind", id), n = S.field("name", id);
    if (k === kc && tok.has(n)) out.client.push(id);
    else if (k === kn && frames.has(n)) for (let j = 0; j < frames.get(n); j++) out.wire.push(id);
    else if (k === ks && app.has(n)) out.appended.push(id);
    else if (k === ks && lau.has(n)) out.launched.push(id);
  });
  const by = (a, b) => S.startOf[a] - S.startOf[b] || a - b;
  for (const v of Object.values(out)) v.sort(by);
  return { ...out, req };
});
/** decoding_iter of a worker stamp that lists one request (the stamp's requests table), else null. */
const decIter = (d) => { const q = d?.args?.stamp?.requests; return Array.isArray(q) && q.length === 1 && Number.isInteger(q[0].decoding_iter) ? q[0].decoding_iter : null; };
const tokensTab = {
  key: "tokens", label: "Tokens",
  deps: (s) => { const S = store(); return [S, s.sel, s.rev, shownReq(S, s)]; },
  render(el, s, again) {
    const S = store(); if (!S) { el.innerHTML = noRun(); return; }
    const r = shownReq(S, s), p = r >= 0 ? tokenParts(S, r) : null;
    if (!p) { el.innerHTML = `<p class="muted">No request in this run.</p>`; return; }
    const head = `<p>${reqPicker(S, r)}</p>`;
    if (!p.client.length) { el.innerHTML = `${head}<p class="muted">${esc(short(S, S.requests[r]))}: no client token events.</p>`; return; }
    const get = withDetail(S, [...p.client, ...p.appended, ...p.launched], again);
    const send = S.startOf[p.req], T = (id) => S.startOf[id];
    // token k: the client event with args.token k (else the k-th), the stamp that appended decoding_iter k, and the
    // iteration whose sampling stamp launched decoding_iter k - 1
    const client = new Map(), engine = new Map(), iter = new Map();
    p.client.forEach((id, j) => client.set((get && get(id)?.args?.token) ?? j + 1, id));
    if (get) {
      for (const id of p.appended) { const k = decIter(get(id)); if (k != null && !engine.has(k)) engine.set(k, id); }
      for (const id of p.launched) { const k = decIter(get(id)); if (k != null && !iter.has(k + 1)) iter.set(k + 1, S.field("iter", id)); }
    }
    const n = Math.max(...client.keys()), text = get ? p.client.map((id) => get(id)?.args?.content ?? "").join("") : null;
    const cell = (id) => (id != null ? link(S, id, `${ms(T(id) - send)} ms`) : "–");
    const diff = (a, b) => (a != null && b != null ? `${ms(T(a) - T(b))} ms` : "–");
    const rows = [];
    for (let k = 1; k <= n; k++) {
      const c = client.get(k), e = engine.get(k), w = p.wire[k - 1], it = iter.get(k), itRow = it != null ? idx(S).iter.get(it) : null, prev = client.get(k - 1);
      const at = T(e ?? w ?? c);
      rows.push(`<tr data-row="${c ?? ""}" data-t="${at}"><td>${k}</td><td><code>${get && c != null ? esc(JSON.stringify(get(c)?.args?.content ?? "")) : "…"}</code></td>
        <td>${itRow != null ? link(S, itRow, `iteration ${it}`) : get ? "–" : "…"}</td>
        <td class="num">${e != null ? cell(e) : get ? "–" : "…"}</td><td class="num">${cell(w)}</td><td class="num">${cell(c)}</td>
        <td class="num">${k === 1 ? "TTFT" : diff(c, prev)}</td><td class="num">${diff(w, e)}</td><td class="num">${diff(c, w)}</td><td>${seekLink(at)}</td></tr>`);
    }
    el.innerHTML = `${head}<p><b>${esc(short(S, S.requests[r]))}</b> · ${n} tokens · each read on three clocks: engine (the worker appends the sampled token: "sampled tokens appended"),
        wire (the k-th token frame on eth0, matched in order ${tag("Inferred")}), client (the SDK's token event).
        Text: ${text != null ? `<code>${esc(JSON.stringify(text))}</code>` : "…"}</p>
      <table class="rows tokens"><tr><th>#</th><th>text</th><th>iteration</th><th class="num">engine: token appended</th><th class="num">wire: token frame</th><th class="num">client: token event</th>
        <th class="num">client gap to previous</th><th class="num">wire − engine</th><th class="num">client − wire</th><th></th></tr>${rows.join("")}</table>
      <p class="muted">Times from the request's send. The iteration is the one whose sampling stamp launched the token. The row lights when the cursor has reached the token's engine time (else its wire or client time).${p.appended.length ? "" : " This run has no worker stamps (\"sampled tokens appended\"), so the engine clock and the iteration are empty."}${p.wire.length ? "" : " This run's wire frames carry no token count, so the wire clock is empty."}</p>`;
  },
  tick(el, s) {
    let last = null;
    for (const tr of el.querySelectorAll("tr[data-t]")) { const on = Number(tr.dataset.t) <= s.t; tr.classList.toggle("past", on); tr.classList.remove("on"); if (on) last = tr; }
    last?.classList.add("on");
  },
};

// ---------------------------------------------------------------- Kernels
/** The iteration the tab lists: the selected row's (hot iter), else the one at the cursor; in a run without scheduler
 *  stamps (the code run), the iter of the last device row at or before the cursor; else null. */
function shownIter(S, s) {
  if (!S) return null;
  if (selRow(s.sel) != null && selRow(s.sel) < S.N) { const it = S.field("iter", selRow(s.sel)); if (it >= 0) return it; }
  if (S.iterRows.length) return S.chain(s.t).iteration?.iter ?? null;
  const st = S.dims.stops("execution", "kernel"), k = upper(st.t, s.t) - 1;
  return k >= 0 && lastIter(S)[k] >= 0 ? lastIter(S)[k] : null;
}
/** Per kernel stop k: the iter of the last stop up to k that has one, else -1. */
const lastIter = (S) => memo(S, "lastIter", () => {
  const st = S.dims.stops("execution", "kernel"), out = new Int32Array(st.ids.length);
  for (let k = 0, it = -1; k < out.length; k++) { const x = S.field("iter", st.ids[k]); if (x >= 0) it = x; out[k] = it; }
  return out;
});
/** Device rows (kernel stops: kernels, copies, memsets) of iteration `it`, by start: the kernel stops with that iter
 *  inside its derived span (its scheduler stamp to the end of its last own row), or anywhere when the run has no
 *  scheduler stamp for it. */
const iterDevice = (S, it) => memo(S, `dev:${it}`, () => {
  const row = idx(S).iter.get(it), st = S.dims.stops("execution", "kernel"), out = [];
  const b = row == null ? Infinity : S.endOf[row];
  for (let k = row == null ? 0 : lower(st.t, S.startOf[row]); k < st.t.length && st.t[k] <= b; k++) if (S.field("iter", st.ids[k]) === it) out.push(st.ids[k]);
  return out;
});
/** A link to iteration `it`: its scheduler stamp, else its first device row; "" when it has neither. */
const iterLink = (S, it, text) => { const row = idx(S).iter.get(it) ?? iterDevice(S, it)[0]; return row != null ? link(S, row, text) : ""; };
/** A kernels-level run's counters sit on its timeline run: the manifest's tools.ncu.timeline (the import's tie) names
 *  that run and the tied rows by eid; this is that run's detail of them. Cached per run. */
const ties = new Map();
// A GET detail asks at most 256 rows (the route's limit) in a request line under the server's 8,190 bytes (aiohttp's
// max_line_size): eids are free text, so the tied rows go in requests cut by length as well as count.
const DETAIL_ROWS = 256, LINE_MAX = 8190 - "GET  HTTP/1.1".length;
function eidQueries(path, eids) {
  const out = []; let q = [], len = path.length + 1;
  for (const x of eids) {
    const p = `eids=${encodeURIComponent(x)}`;
    if (q.length && (q.length === DETAIL_ROWS || len + p.length + 1 > LINE_MAX)) { out.push(`${path}?${q.join("&")}`); q = []; len = path.length + 1; }
    q.push(p); len += p.length + 1;
  }
  if (q.length) out.push(`${path}?${q.join("&")}`);
  return out;
}
function tiedTo(S, again) {
  let e = ties.get(S.run);
  if (!e) {
    const tl = S.tools.ncu?.timeline;
    e = { state: tl ? "looking" : "none" }; ties.set(S.run, e);
    if (tl) (async () => {
      const rows = [];
      for (const url of eidQueries(`/api/v3/runs/${encodeURIComponent(tl.run)}/detail`, tl.event_eids)) {
        const d = await fetch(url);
        if (!d.ok) throw new Error(`GET detail of ${tl.run}: HTTP ${d.status}`);
        rows.push(...(await d.json()).rows);
      }
      Object.assign(e, { state: "found", run: tl.run, ncu: tl, rows: rows.sort((a, b) => a.start - b.start) });
    })().catch((err) => { e.state = "failed"; e.error = String(err.message ?? err); console.error("bar: ncu tie", err); }).finally(() => again());
  }
  return e;
}
function tiedHtml(S, again) {
  const e = tiedTo(S, again), ncu = S.tools.ncu;
  const head = `<p><b>This run holds no kernel rows.</b> It is the Nsight Compute capture (<code>${esc(ncu.path)}</code>): ncu replays each profiled kernel, so the
    run keeps the request's client, wire and engine rows but no timeline of the GPU. ${openBtn(ncu, "Nsight Compute ↗", "Open this run's Nsight Compute report")}</p>`;
  if (e.state === "looking") return `${head}<p class="muted">looking for the timeline run that ties these counters…</p>`;
  if (e.state !== "found") return `${head}<p class="muted">${e.state === "failed" ? `could not read the tie: ${esc(e.error)}` : "No timeline run ties these counters (the manifest's tools.ncu names no timeline run)."}</p>`;
  const k = e.ncu.kernels ?? {}, cv = (d, m) => d.counters?.values?.find((v) => v.measure === m);
  const cell = (d, m, f) => { const v = cv(d, m); return v ? f(v.value) : "–"; };
  return `${head}<p>Its counters are tied to <b>${e.rows.length} kernels of iteration ${esc(k.iteration ?? "–")}</b> of timeline run <code>${esc(e.run)}</code>
      (${esc(k.tied ?? e.rows.length)} tied: ${esc(k.rule ?? "")} ${tag(word(k.evidence))}). These rows belong to that run:
      <a class="go" data-run="${esc(e.run)}">Load ${esc(e.run)} ▸</a> to select them on its timeline.</p>
    <table class="rows kernels"><tr><th>#</th><th>layer</th><th>kernel</th><th class="num">µs (replay)</th><th class="num">grid</th><th class="num">DRAM read</th><th class="num">DRAM write</th>
      <th class="num">L2</th><th class="num">SM %</th><th class="num">occupancy</th><th class="num">profile row</th></tr>
    ${e.rows.map((d, i) => `<tr><td>${i + 1}</td><td>${d.layer ?? "–"}</td><td>${esc(d.name)}</td><td class="num">${cell(d, "duration (replay)", (v) => (v / 1e3).toFixed(1))}</td>
      <td class="num">${Array.isArray(d.args?.grid) ? d.args.grid.reduce((x, y) => x * y, 1) : "–"}</td><td class="num">${cell(d, "DRAM read", fmtBytes)}</td><td class="num">${cell(d, "DRAM write", fmtBytes)}</td>
      <td class="num">${cell(d, "L2 traffic", fmtBytes)}</td><td class="num">${cell(d, "SM throughput", (v) => v.toFixed(1))}</td><td class="num">${cell(d, "achieved occupancy", (v) => v.toFixed(1))}</td>
      <td class="num">${esc(d.counters?.profile_row ?? "–")}</td></tr>`).join("")}</table>`;
}
const kernelsTab = {
  key: "kernels", label: "Kernels",
  deps: (s) => { const S = store(); return [S, s.rev, shownIter(S, s)]; },
  render(el, s, again) {
    const S = store(); if (!S) { el.innerHTML = noRun(); return; }
    const noDevice = S.dims.stops("execution", "kernel").ids.length === 0;
    if (noDevice && S.tools.ncu && !S.tools.ncu.event_ids) { el.innerHTML = tiedHtml(S, again); return; }
    if (noDevice) { el.innerHTML = `<p class="muted">This run holds no kernel rows (no Nsight Systems or profiler capture of the GPU).</p>`; return; }
    const it = shownIter(S, s), ids = it == null ? [] : iterDevice(S, it);
    const ncu = S.tools.ncu, pit = ncu?.kernels?.iteration, toProfiled = pit != null && pit !== it ? iterLink(S, pit, `iteration ${pit} ▸`) : "";
    const nav = [it != null ? iterLink(S, it - 1, `◀ iteration ${it - 1}`) : "", it != null ? iterLink(S, it + 1, `iteration ${it + 1} ▶`) : "",
      toProfiled ? `profiled: ${toProfiled}` : ""].filter(Boolean).join(" · ");
    if (!ids.length) {
      const first = it == null ? (S.iterRows.length ? S.field("iter", S.iterRows[0]) : lastIter(S).find((x) => x >= 0)) : undefined;
      el.innerHTML = `<p class="muted">${it == null ? "No iteration has started at the cursor." : `Iteration ${it}: no device rows.`}</p>
        <p>${first != null ? `first: ${iterLink(S, first, `iteration ${first} ▸`)}` : nav}</p>`;
      return;
    }
    const get = withDetail(S, ids, again), cv = (id, m) => get?.(id)?.counters?.values?.find((v) => v.measure === m);
    const sms = S.dims.gpuSms(), mods = hasModules(S), copies = ids.filter((id) => isCopy(S, id)).length;
    const modOf = new Map(mods ? ids.map((id) => [id, S.dims.moduleOf(id)]) : []), free = mods ? ids.filter((id) => modOf.get(id) < 0).length : 0;
    const prof = ids.filter((id) => S.dims.profiled.has(id)).length;
    const cell = (id, m, f) => { const v = cv(id, m); return v ? f(v.value) : S.dims.profiled.has(id) && !get ? "…" : "–"; };
    el.innerHTML = `<p><b>iteration ${it}</b> · ${ids.length} device rows (${ids.length - copies} kernels, ${copies} copies and memsets) ·
        ${prof} profiled${prof && ncu?.kernels ? ` (Nsight Compute run ${esc(short(S, ncu.run))}, tied by launch order and name ${tag(word(ncu.kernels.evidence))})` : ""}
        ${!mods ? "· module missing: no module frames in this run (M2)" : hasInferred(S) ? `· modules inferred (M2): ${free} of ${ids.length} device rows in no module` : ""} · click a row to select it
        ${openBtn(S.tools.nsys, "Nsight Systems ↗", "Open the run's report in Nsight Systems")} ${prof ? openBtn(ncu, "Nsight Compute ↗", "Open the profiled kernels in Nsight Compute") : ""}</p>
      ${nav ? `<p>${nav}</p>` : ""}
      <table class="rows kernels"><tr><th>#</th><th>iteration</th><th>layer</th><th>module</th><th>kernel</th><th class="num">µs</th><th class="num">grid</th><th class="num">SMs</th>
        <th class="num">DRAM</th><th class="num">L2</th><th class="num">occupancy</th><th>profiled</th><th>launch</th><th></th></tr>
      ${ids.map((id, i) => { const a = get?.(id)?.args, blocks = Array.isArray(a?.grid) ? a.grid.reduce((x, y) => x * y, 1) : null, sm = S.dims.smsUsed(a?.grid), layer = S.field("layer", id), c = S.field("cause", id);
        const mod = modOf.get(id) ?? -1, dram = cv(id, "DRAM read"), dw = cv(id, "DRAM write");
        return `<tr data-sel="${id}" data-row="${id}"><td>${i + 1}</td><td>${it}</td><td>${layer >= 0 ? layer : "–"}</td><td>${mod >= 0 ? esc(nm(S, mod)) + infMark(S, mod) : "–"}</td>
          <td>${esc(nm(S, id))}</td><td class="num">${((S.endOf[id] - S.startOf[id]) / 1e3).toFixed(1)}</td><td class="num">${blocks ?? (get || isCopy(S, id) ? "–" : "…")}</td>
          <td class="num">${sm ? `${sm.used}/${sm.of}` : "–"}</td>
          <td class="num">${dram ? fmtBytes(dram.value + (dw?.value ?? 0)) : cell(id, "DRAM read", fmtBytes)}</td><td class="num">${cell(id, "L2 traffic", fmtBytes)}</td>
          <td class="num">${cell(id, "achieved occupancy", (v) => `${v.toFixed(1)}%`)}</td><td>${S.dims.profiled.has(id) ? "yes" : "no"}</td>
          <td><code>${c >= 0 ? esc(nm(S, c)) : "–"}</code>${c >= 0 ? ` <span class="muted">@ ${ms(S.startOf[c])} ms</span>` : ""}</td><td>${seekLink(S.startOf[id])}</td></tr>`; }).join("")}</table>
      <p class="muted">SMs: min(${sms || "SMs"}, grid blocks) ${tag("Inferred")} · DRAM: read + write bytes · DRAM, L2 and occupancy come from Nsight Compute, on profiled kernels only.</p>`;
  },
  tick(el, s) {
    const cur = now().kernel?.id;
    for (const tr of el.querySelectorAll("tr[data-row]")) { tr.classList.toggle("on", Number(tr.dataset.row) === cur); tr.classList.toggle("sel", Number(tr.dataset.row) === s.sel); }
  },
};

// ---------------------------------------------------------------- Run
/** D13's reference rows, as aux.json names them: TTFT on each clock, the queue, the prefill forward (the split segment
 *  from first_scheduled_time to first_token_time, which is engine TTFT minus the queue), mean ITL and end-to-end. */
const RESULTS = [["client TTFT"], ["wire TTFT"], ["engine TTFT"], ["engine queue"], ["prefill forward", (n) => n.endsWith(": first_scheduled_time → first_token_time")],
  ["client mean ITL"], ["client end-to-end"]];
function sessionHtml(s) {
  const ss = s.session, rep = repOf(ss.rep);
  const run = (id, label) => { const r = runOf(id); return `<tr><td>${label}</td><td><code>${esc(id)}</code> ${r ? `${esc(runKind(r))} · ${whenOf(r)}${r.result ? "" : " · results not computed"}${r.incomplete ? ` · ${esc(incompleteText(r))}` : ""}` : ""}</td></tr>`; };
  return `<table class="kv"><tr><td>mode</td><td>${esc(ss.mode)}${ss.mode === "live" ? ` · ${esc(ss.live?.state ?? "")} · head at ${ms(s.head)} ms` : ""}</td></tr>
    <tr><td>rep</td><td>${esc(ss.rep)} · ${esc(rep?.title)}</td></tr>
    ${ss.mode === "compare" ? run(ss.run, "run A") + run(ss.runB, "run B") : run(ss.run, "run")}
    ${ss.live ? `<tr><td>action</td><td>${esc(ss.live.action?.label)} ${esc(JSON.stringify(ss.live.options ?? {}))}${ss.live.dry_run ? " · dry run, nothing started" : ""}</td></tr>` : ""}</table>
    <p><a class="go" data-world="rep">Rep world ▸</a> <span class="muted">results, lessons, key moments</span></p>`;
}
const runTab = {
  key: "run", label: "Run",
  deps: (s) => { const S = store(); return [S, s.session, s.rev, S ? auxes.has(S) : false]; },
  render(el, s, again) {
    const S = store(), ph = (name, what) => `<div class="ph"><b>${name}</b><span class="tg">placeholder · visuals TBD (owner)</span><div class="dim">${what}</div></div>`;
    const tail = `<div class="label">session · opened from the header (Load, Launch, Compare)</div><div class="b-cp">${sessionHtml(s)}</div>
      <div class="label">outside the world: still placeholders</div><div class="b-cp">
        ${ph("Logs", "container logs at the cursor")}${ph("Tools", "Grafana, Prometheus, Nsight Systems / Compute")}${ph("Lifecycle", "container start, health, stop")}</div>`;
    if (!S) { el.innerHTML = `${noRun()}${tail}`; return; }
    const aux = auxOf(S, again), r = runOf(S.run), L = S.dims.ladders.execution, K = idx(S).kind;
    const flows = new Map(); for (const id of S.iterRows) { const f = S.dims.flowOf(id) ?? "no flow"; flows.set(f, (flows.get(f) ?? 0) + 1); }
    const copies = ["memcpy", "memset"].reduce((a, n) => a + (K.has(n) ? S.dims.byKind[K.get(n)].length : 0), 0);
    const samples = S.sampleGroups.reduce((a, g) => a + g.n, 0), labels = r?.labels ?? {};
    const reqs = aux ? [...new Set(aux.metrics.map((m) => m.request_id).filter(Boolean))] : [];
    const found = RESULTS.map(([label, test]) => [label, reqs.map((q) => aux.metrics.find((m) => m.request_id === q && (test ? test(m.name) : m.name === label)))]).filter(([, per]) => per.some(Boolean));
    const get = found.length ? withDetail(S, inputRows(S, found.flatMap(([, per]) => per.filter(Boolean))), again) : null;
    const basis = aux?.facts?.basis?.value, gpu = basis?.gpu ?? basis?.gpu_start;
    el.innerHTML = `<div class="cols"><div>
        <h3>${esc(S.run)} <span class="muted">generation ${S.generation} · ${esc(S.status)}${r ? ` · ${esc(runKind(r))} · ${whenOf(r)}` : ""}</span></h3>
        <table class="kv"><tr><td>requests</td><td class="wrap">${S.requests.map((q) => esc(short(S, q))).join(", ") || "–"}</td></tr>
          <tr><td>iterations</td><td>${S.iterRows.length}${flows.size ? ` (${[...flows].map(([f, n]) => `${n} ${esc(f)}`).join(", ")})` : ""}</td></tr>
          <tr><td>length</td><td>${fmtSpan(S.extent[1] - S.extent[0])}</td></tr>
          <tr><td>units</td><td class="wrap">${L.map((name, i) => `${units(i).ids.length} ${esc(name)}`).join(" · ")}</td></tr>
          <tr><td>transfers</td><td>${copies} copies and memsets</td></tr>
          <tr><td>samples</td><td>${samples} in ${S.sampleGroups.length} groups, ${S.metrics.length} metrics (state, not stops)</td></tr>
          <tr><td>containers</td><td class="wrap">${S.things.filter((x) => x.kind === "container").map((x) => thingLink(S, x.i)).join(", ") || "–"}</td></tr>
          <tr><td>trace</td><td class="wrap">${esc(labels.trace ?? "–")} · ${labels.measured ? "measured" : "not a measured run (instrumented)"}${labels.graphs != null ? ` · CUDA graphs ${labels.graphs ? "on" : "off"}` : ""}${labels.profile_range ? ` · profile range ${esc(labels.profile_range)}` : ""}</td></tr>
          ${gpu ? `<tr><td>basis</td><td class="wrap">${esc(gpu.name ?? "")} · driver ${esc(gpu.driver_version ?? "–")} · docker ${esc(basis.docker ?? "–")} ${tag(aux.facts.basis.source ?? "")}</td></tr>` : ""}
          <tr><td>reports</td><td>${openBtn(S.tools.nsys, "Nsight Systems ↗", "Open the run's report in Nsight Systems") || (S.tools.ncu ? "" : "–")} ${openBtn(S.tools.ncu, "Nsight Compute ↗", "Open the run's Nsight Compute report")}</td></tr></table>
      </div><div>
        <h3>results <span class="muted">aux.json, calculated at import</span></h3>
        ${!aux ? `<p class="muted">loading aux.json…</p>` : found.length ? `<table class="rows"><tr><th>metric</th>${reqs.map((q) => `<th class="num">${esc(short(S, q))}</th>`).join("")}<th>source</th></tr>
          ${found.map(([label, per]) => `<tr><td>${esc(label)}</td>${per.map((m) => `<td class="num">${m ? `${num(+(+m.value).toFixed(3))} ${esc(m.unit)}` : "–"}</td>`).join("")}
            <td>${get ? [...new Set(per.filter(Boolean).flatMap((m) => sourcesOf(S, m, get)))].map(tag).join(" ") : "…"}</td></tr>`).join("")}</table>`
          : `<p class="muted">${reqs.length ? `aux.json has none of ${RESULTS.map(([label]) => label).join(", ")} for this run's requests (see Metrics)` : `aux.json has no per-request metrics for this run${aux.metrics.length ? ` (${aux.metrics.length} run-level ones: see Metrics)` : ""}`}.</p>`}
        ${aux?.facts?.config?.value ? `<details><summary>config ${tag(aux.facts.config.source ?? "")}</summary><pre class="json">${esc(aux.facts.config.value)}</pre></details>` : ""}
      </div></div>${tail}`;
  },
};

export const TABS = [selected, atCursor, metricsTab, tokensTab, kernelsTab, runTab];
