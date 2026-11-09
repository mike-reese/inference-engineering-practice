// The bottom bar's six tabs (COMMAND_CENTER.md 2.1), D13's Selected, At cursor, Metrics, Tokens, Kernels and Run,
// drawn from the shown RunStore (hot columns, cold detail, raw records), its aux.json, the manifest's things, places
// and tools, and /api/v3/reps. A tab is {key, label, deps(s), render(el, s, again), tick?(el, s)}: the bar renders the
// open tab when its deps change and calls tick when only the cursor or the selection moved. A render that needs cold
// detail or aux.json draws what is held, asks for the rest, and calls again() when it arrives.
// Links are data attributes the bar handles in one place: data-sel (a row id or a thing key), data-seek (a time),
// data-m (a metric id), data-world, data-run (load a run of the rep), data-open (a Nsight report), data-raw (a row's
// raw record).
import { state, store, storeError, now, units, DIM_COLOR, FLOW_COLOR } from "../control/control.js";
import { NONE16 } from "../store/columns.js";
import { roleOf, fmtValue, fmtBytes, fmtSpan, periodOf, why } from "../sidebar/samples.js";
import { SESSION, repOf, runOf, kindOf as runKind, whenOf, esc } from "../session.js";
import { nsysWhere } from "./nsight.js";

const ms = (ns, d = 3) => (ns / 1e6).toFixed(d);
const tag = (t) => `<span class="tag">${esc(t)}</span>`;
const word = (e) => (e ? String(e).split(":")[0] : "");   // "Observed: nvidia-smi" -> "Observed"
const json = (o) => `<pre class="json">${esc(JSON.stringify(o, null, 2))}</pre>`;
const num = (v) => (typeof v === "number" ? (Math.abs(v) >= 1e6 ? v.toExponential(3) : String(+v.toPrecision(6))) : esc(v));
const nm = (S, id) => S.nameText(S.field("name", id));
const short = (S, name) => String(name ?? "").replace(`${S.run}-`, "");
const seekLink = (t) => `<a class="seek" data-seek="${t}" title="move the cursor here">↦</a>`;
const link = (S, id, text) => `<a class="go ${id === state.sel ? "on" : ""}" data-sel="${id}">${esc(text ?? nm(S, id))}</a>`;
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
const gpuSms = (S) => Number(S.things.find((x) => x.kind === "gpu")?.attrs?.sms) || null;

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
function unitText(S, tier, id) {
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
 * rows of an execution tier on its parent chain (a device row climbs from the call that launched it), and the layer
 * unit of its (iteration, layer). A device row of a run with no module frames says module is missing (3.1, M2).
 */
function ladderOf(S, id) {
  const X = idx(S), L = S.dims.ladders.execution, ex = S.dims.ex, out = [];
  const r = S.field("req", id), it = S.field("iter", id);
  if (r !== NONE16 && X.req.has(r) && X.req.get(r) !== id) out.push([L[0], X.req.get(r), unitText(S, L[0], X.req.get(r))]);
  if (it >= 0 && X.iter.has(it) && X.iter.get(it) !== id) out.push([L[1], X.iter.get(it)]);
  const up = [];
  let x = S.field("parent", id);
  if (x < 0) { const c = S.field("cause", id); if (c >= 0 && S.dims.side[c]) x = c; }
  for (let n = 0; x >= 0 && n < 400; n++, x = S.field("parent", x)) if (S.dims.side[x] || ex[x] >= 2) up.push([execLabel(S, x), x]);
  up.reverse();
  const inner = up.findIndex(([, y]) => ex[y] > tierIndex(S, "layer") || S.dims.side[y]), at = inner < 0 ? up.length : inner;
  const extra = [];
  if (S.field("layer", id) >= 0 && it >= 0) { const lu = layerUnit(S, id); if (lu >= 0) extra.push([L[3], lu, unitText(S, L[3], lu)]); }
  if (isDevice(S, id) && !hasModules(S)) extra.push([L[4], null, "missing: this run has no module frames (M2)"]);
  up.splice(at, 0, ...extra);
  return [...out, ...up, [execLabel(S, id), id]];
}
const pathHtml = (S, items) => `<ol class="path">${items.map(([tier, id, text]) => `<li><span class="dim">${esc(tier)}</span> ${id == null ? `<span class="muted">${esc(text)}</span>` : link(S, id, text)}</li>`).join("")}</ol>`;

/** Where a row runs in the architecture: the container, process and thread of its lane (a device row: of the thread
 *  that launched it), then its component box. */
function whereHtml(S, id) {
  const T = S.things, c = S.field("cause", id), comp = S.field("comp", id);
  let lane = S.field("lane", id);
  if (T[lane]?.kind === "stream" && c >= 0) lane = S.field("lane", c);
  const path = []; for (let x = T[lane]; x && x.parent >= 0; x = T[x.parent]) path.unshift(x.i);
  return `<ol class="path">${path.map((i) => `<li><span class="dim">${esc(T[i].kind)}</span> ${thingLink(S, i)}</li>`).join("")}${comp !== NONE16 && T[comp] ? `<li><span class="dim">component</span> ${thingLink(S, comp)}</li>` : ""}</ol>`;
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
/** The container's docker inspect record in aux.json facts.topology (topology.json), or null. */
function inspected(S, c, again) {
  const a = auxOf(S, again), name = `/${c.attrs?.docker ?? c.name}`;
  return a?.facts?.topology?.value?.containers?.find((x) => x.Name === name) ?? null;
}
const metricOf = (S, metric, thing) => S.metrics.findIndex((m) => m.metric === metric && m.thing === thing);
/** The index of the newest sample of metric i at or before t (it changes when the metric's value does), or -1. */
function sampleAt(S, i, t) { const g = i >= 0 ? S.groupOf(i) : null; return g ? upper(g.ts, t) - 1 : -1; }
/** D13's container card: name, lifecycle, image and project, CPU, memory, network and GPU memory per process. */
function card(S, ci, t, again) {
  const c = S.things[ci], v = S.samplesAt(t), at = (metric, thing = ci) => { const i = metricOf(S, metric, thing); return i < 0 ? NaN : v[i]; };
  const life = lifecycle(S, ci, t), ins = inspected(S, c, again), mib = (b) => (Number.isNaN(b) ? "–" : (b / 2 ** 20).toFixed(0));
  const limit = ins?.HostConfig?.Memory ? ` / ${mib(ins.HostConfig.Memory)}` : ins ? " (no limit)" : "";
  const cpu = at("docker.cpu_pct"), rx = at("docker.rx_rate"), tx = at("docker.tx_rate");
  const gpu = S.things.filter((p) => p.kind === "process" && p.pre >= c.pre && p.post <= c.post)
    .map((p) => [p, at("gpu.app.memory.used", p.i)]).filter(([, m]) => !Number.isNaN(m));
  return `<div class="card"><div class="title">${thingLink(S, ci)}<span class="state">${esc(life.state ?? "no lifecycle event yet")}${life.health ? ` · ${esc(life.health)}` : ""}</span></div>
    <div class="image">${esc(ins?.Config?.Image ?? (auxes.has(S) ? "image not in topology.json" : "…"))} · ${esc(c.attrs?.project ?? "")}</div>
    <div>cpu ${Number.isNaN(cpu) ? "–" : cpu.toFixed(1)}% · mem ${mib(at("docker.mem_bytes"))}${limit} MiB${Number.isNaN(rx) ? "" : ` · rx ${rx.toFixed(0)} tx ${Number.isNaN(tx) ? "–" : tx.toFixed(0)} B/s`}</div>
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
  const a = d?.args ?? {}, sms = gpuSms(S), prof = S.dims.profiled.has(id), c = S.field("cause", id);
  const blocks = Array.isArray(a.grid) ? a.grid.reduce((x, y) => x * y, 1) : null, cv = (m) => d?.counters?.values?.find((v) => v.measure === m);
  const wait = d ? "–" : "…", ncu = (m, f) => { const v = cv(m); return v ? f(v.value, v.unit) : prof && !d ? "…" : "not profiled"; };
  const vals = d?.counters?.values ?? [];
  return `<table class="kv">
    <tr><td>grid</td><td>${blocks != null ? `${a.grid.join("×")} = ${blocks} blocks · block ${esc(a.block?.join("×") ?? "–")}` : wait}</td></tr>
    <tr><td>SMs</td><td>${blocks != null && sms ? `${Math.min(sms, blocks)} of ${sms} ${tag("Inferred: min(SMs, grid blocks)")}` : wait}</td></tr>
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
  const t0 = S.startOf[id], t1 = S.endOf[id], r = S.field("req", id), send = r !== NONE16 && idx(S).req.has(r) ? S.startOf[idx(S).req.get(r)] : null;
  const flow = S.dims.flowOf(id), hw = S.dims.ranOn(id);
  const when = `<div>at <b>${ms(t0)} ms</b> from the run's t0${send != null ? ` · ${ms(t0 - send)} ms from its request's send` : ""}${t1 > t0 ? `, lasts <b>${ms(t1 - t0)} ms</b> (${fmtSpan(t1 - t0)})` : ""} ${seekLink(t0)}</div>`;
  const left = [`<div class="label" style="color:${DIM_COLOR.execution}">execution · ${esc(execLabel(S, id))}</div><h3>${esc(nm(S, id))}</h3>${when}`];
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

function thingView(S, s, again) {
  const i = S.things.findIndex((x) => x.key === s.sel), x = S.things[i];
  if (!x) return `<p class="muted">${esc(s.sel)} is not a thing of this run.</p>`;
  const dim = ARCH_KINDS.has(x.kind) ? "architecture" : "hardware", T = S.things;
  const up = []; for (let p = x.parent; p != null && p >= 0; p = T[p].parent) up.unshift(p);
  const attrs = Object.entries(x.attrs ?? {}).filter(([key]) => !["x", "y", "w", "h", "edges", "size"].includes(key));
  const left = [`<div class="label" style="color:${DIM_COLOR[dim]}">${dim} · ${esc(x.kind)}</div><h3>${esc(x.name)}</h3>`, `<div class="dim">${esc(x.evidence ?? "")}</div>`];
  if (attrs.length) left.push(`<table class="kv">${attrs.map(([key, v]) => `<tr><td>${esc(key)}</td><td class="wrap">${v && typeof v === "object" ? esc(v.name ?? JSON.stringify(v)) : esc(v ?? "–")}</td></tr>`).join("")}</table>`);
  if (up.length) left.push(`<div class="label">parents</div><ol class="path">${up.map((p) => `<li><span class="dim">${esc(T[p].kind)}</span> ${thingLink(S, p)}</li>`).join("")}</ol>`);
  const right = [];
  if (x.kind === "container") right.push(card(S, i, s.t, again));
  if (x.kind === "process") {
    const m = metricOf(S, "gpu.app.memory.used", i), v = m < 0 ? NaN : S.samplesAt(s.t)[m];
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
    el.innerHTML = typeof s.sel === "number" ? rowView(S, s, again) : thingView(S, s, again);
  },
};

// ---------------------------------------------------------------- At cursor
const SAMPLE_ROWS = [["SMs active", "sm_active"], ["GPU utilization", "gpu_util"], ["DRAM read", "dram_read"], ["DRAM write", "dram_write"],
  ["PCIe RX", "pcie_rx"], ["PCIe TX", "pcie_tx"], ["host CPU busy", null, "host.cpu.busy"], ["GPU memory used", "mem_used"]];
function sampleBlock(S, n, again) {
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
    ${ci != null ? card(S, ci, state.t, again) : ""}`;
}
const atCursor = {
  key: "cursor", label: "At cursor",
  deps: (s) => {
    const S = store(); if (!S) return [null];
    const n = now();
    return [S, s.sel, s.rev, n.phases.map((u) => u.id).join(), n.exec.map((u) => u?.id).join(), n.kernel?.id, n.transfers.map((x) => x.id).join(), n.archPath.join()];
  },
  render(el, s, again) {
    const S = store(); if (!S) { el.innerHTML = noRun(); return; }
    const n = now(), L = S.dims.ladders.execution;
    const exec = n.exec.map((u, i) => `<tr><td>${esc(L[i])}</td><td>${u ? link(S, u.id, unitText(S, L[i], u.id)) : "–"}</td></tr>`).join("");
    el.innerHTML = `<div class="cols"><div>
        <h3><span class="ac-t">${ms(s.t)}</span> ms <span class="muted">from the run's t0 · everything true at the cursor</span></h3>
        <div class="label" style="color:${DIM_COLOR.execution}">execution</div><table class="kv">${exec}</table>
        <div class="label">flows running now</div><div>${n.phases.slice(0, 24).map((u) => { const f = S.dims.flowOf(u.id);
          return `<div><span class="pdot" style="background:${FLOW_COLOR[f] ?? "#8a90a0"}"></span>${link(S, u.id)} <span class="dim">${esc(f ?? "no flow")}</span></div>`; }).join("") || "–"}${n.phases.length > 24 ? `<div class="dim">+${n.phases.length - 24} more</div>` : ""}</div>
        <div class="label" style="color:${DIM_COLOR.architecture}">architecture</div>
        <ol class="path">${n.archPath.map((i) => `<li><span class="dim">${esc(S.things[i].kind)}</span> ${thingLink(S, i)}</li>`).join("")}${n.comp >= 0 ? `<li><span class="dim">component</span> ${thingLink(S, n.comp)}</li>` : ""}</ol>
      </div><div>
        <table class="kv"><tr><td>kernel</td><td>${n.kernel ? link(S, n.kernel.id) : "none running"}</td></tr>
          <tr><td>transfer</td><td>${n.transfers.map((x) => link(S, x.id, `${nm(S, x.id)}, ${fmtBytes(S.field("bytes", x.id))}`)).join("<br>") || "none in flight"}</td></tr></table>
        <div class="ac-smp" data-i="${n.sampleIndex}">${sampleBlock(S, n, again)}</div></div></div>`;
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
function metricRows(S, s, list) {
  const inputs = (m) => [...(m.inputs?.rows ?? []).map((id) => (id < S.N ? link(S, id, nm(S, id).slice(0, 28)) : `row ${id}`)),
    ...(m.inputs?.samples?.length ? [tag(`${m.inputs.samples.length} samples`)] : []), ...(m.inputs?.unresolved ?? []).map((u) => tag(`unresolved ${u}`))].join("<br>");
  return `<table class="metrics"><tr><th>metric</th><th>formula</th><th>value</th><th>inputs (click)</th></tr>${list.map((m) => `<tr data-m="${esc(mid(m))}" class="${s.metric === mid(m) ? "on" : ""}">
    <td>${esc(m.name)}</td><td><code>${esc(m.formula)}</code></td><td>${valueText(m)}</td><td class="inp">${inputs(m) || "–"}</td></tr>`).join("")}</table>`;
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
      ${segs.length ? `<div class="cols"><div>${segbar(`TTFT split · <span style='color:#3fb950'>measured</span> (this run, ${esc(short(S, rid))})`, segs, ttft)}</div></div>
        <div class="segleg">${segs.map((x) => `<span><i style="background:${x.color}"></i>${esc(x.name)} = ${esc(x.formula)}</span>`).join("")}</div>` : ""}
      ${list.length ? metricRows(S, s, list) : `<p class="muted">aux.json has no metrics for ${esc(short(S, rid) || "this run's requests")}.</p>`}
      ${runLevel.length ? `<div class="label">run-level (no request)</div>${metricRows(S, s, runLevel)}` : ""}
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
  if (typeof s.sel === "number" && s.sel < S.N) { const it = S.field("iter", s.sel); if (it >= 0) return it; }
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
/** The module row (execution / module) above a device row: up the parents of the call that launched it. */
function moduleOf(S, id) {
  const M = tierIndex(S, "module");
  for (let x = S.field("cause", id), n = 0; x >= 0 && n < 400; x = S.field("parent", x), n++) if (S.dims.ex[x] === M) return x;
  return -1;
}
/** A run whose kernel counters sit on another run: the newest timeline run of the rep whose manifest ties this run's
 *  Nsight Compute capture (tools.ncu.run), and that run's detail of the tied rows. Cached per run. */
const ties = new Map();
function tiedTo(S, again) {
  let e = ties.get(S.run);
  if (!e) {
    e = { state: "looking" }; ties.set(S.run, e);
    const rep = runOf(S.run)?.rep ?? state.session.rep;
    (async () => {
      const runs = SESSION.runs.filter((x) => x.rep === rep && x.id !== S.run && x.labels?.trace === "timeline").sort((a, b) => (b.started ?? "").localeCompare(a.started ?? ""));
      for (const x of runs) {
        const r = await fetch(`/api/v3/runs/${encodeURIComponent(x.id)}/manifest`); if (!r.ok) continue;
        const ncu = (await r.json()).tools?.ncu;
        if (ncu?.run !== S.run || !ncu.event_ids?.length) continue;
        const rows = [];
        for (let i = 0; i < ncu.event_ids.length; i += 256) {
          const d = await fetch(`/api/v3/runs/${encodeURIComponent(x.id)}/detail?ids=${ncu.event_ids.slice(i, i + 256).join(",")}`);
          if (!d.ok) throw new Error(`GET detail of ${x.id}: HTTP ${d.status}`);
          rows.push(...(await d.json()).rows);
        }
        Object.assign(e, { state: "found", run: x.id, ncu, rows: rows.sort((a, b) => a.start - b.start) }); return;
      }
      e.state = "none";
    })().catch((err) => { e.state = "failed"; e.error = String(err.message ?? err); console.error("bar: ncu tie", err); }).finally(() => again());
  }
  return e;
}
function tiedHtml(S, again) {
  const e = tiedTo(S, again), ncu = S.tools.ncu;
  const head = `<p><b>This run holds no kernel rows.</b> It is the Nsight Compute capture (<code>${esc(ncu.path)}</code>): ncu replays each profiled kernel, so the
    run keeps the request's client, wire and engine rows but no timeline of the GPU. ${openBtn(ncu, "Nsight Compute ↗", "Open this run's Nsight Compute report")}</p>`;
  if (e.state === "looking") return `${head}<p class="muted">looking for the timeline run that ties these counters…</p>`;
  if (e.state !== "found") return `${head}<p class="muted">${e.state === "failed" ? `could not read the tie: ${esc(e.error)}` : "No timeline run of this rep ties these counters (no manifest names this run in tools.ncu)."}</p>`;
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
    const sms = gpuSms(S), mods = hasModules(S), copies = ids.filter((id) => isCopy(S, id)).length;
    const prof = ids.filter((id) => S.dims.profiled.has(id)).length;
    const cell = (id, m, f) => { const v = cv(id, m); return v ? f(v.value) : S.dims.profiled.has(id) && !get ? "…" : "–"; };
    el.innerHTML = `<p><b>iteration ${it}</b> · ${ids.length} device rows (${ids.length - copies} kernels, ${copies} copies and memsets) ·
        ${prof} profiled${prof && ncu?.kernels ? ` (Nsight Compute run ${esc(short(S, ncu.run))}, tied by launch order and name ${tag(word(ncu.kernels.evidence))})` : ""}
        ${mods ? "" : "· module missing: no module frames in this run (M2)"} · click a row to select it
        ${openBtn(S.tools.nsys, "Nsight Systems ↗", "Open the run's report in Nsight Systems")} ${prof ? openBtn(ncu, "Nsight Compute ↗", "Open the profiled kernels in Nsight Compute") : ""}</p>
      ${nav ? `<p>${nav}</p>` : ""}
      <table class="rows kernels"><tr><th>#</th><th>iteration</th><th>layer</th><th>module</th><th>kernel</th><th class="num">µs</th><th class="num">grid</th><th class="num">SMs</th>
        <th class="num">DRAM</th><th class="num">L2</th><th class="num">occupancy</th><th>profiled</th><th>launch</th><th></th></tr>
      ${ids.map((id, i) => { const a = get?.(id)?.args, blocks = Array.isArray(a?.grid) ? a.grid.reduce((x, y) => x * y, 1) : null, layer = S.field("layer", id), c = S.field("cause", id);
        const mod = mods ? moduleOf(S, id) : -1, dram = cv(id, "DRAM read"), dw = cv(id, "DRAM write");
        return `<tr data-sel="${id}" data-row="${id}"><td>${i + 1}</td><td>${it}</td><td>${layer >= 0 ? layer : "–"}</td><td>${mod >= 0 ? esc(nm(S, mod)) : "–"}</td>
          <td>${esc(nm(S, id))}</td><td class="num">${((S.endOf[id] - S.startOf[id]) / 1e3).toFixed(1)}</td><td class="num">${blocks ?? (get || isCopy(S, id) ? "–" : "…")}</td>
          <td class="num">${blocks != null && sms ? `${Math.min(sms, blocks)}/${sms}` : "–"}</td>
          <td class="num">${dram ? fmtBytes(dram.value + (dw?.value ?? 0)) : cell(id, "DRAM read", fmtBytes)}</td><td class="num">${cell(id, "L2 traffic", fmtBytes)}</td>
          <td class="num">${cell(id, "achieved occupancy", (v) => `${v.toFixed(1)}%`)}</td><td>${S.dims.profiled.has(id) ? "yes" : "no"}</td>
          <td><code>${c >= 0 ? esc(nm(S, c)) : "–"}</code>${c >= 0 ? ` <span class="muted">@ ${ms(S.startOf[c])} ms</span>` : ""}</td><td>${seekLink(S.startOf[id])}</td></tr>`; }).join("")}</table>
      <p class="muted">SMs: min(${sms ?? "SMs"}, grid blocks) ${tag("Inferred")} · DRAM: read + write bytes · DRAM, L2 and occupancy come from Nsight Compute, on profiled kernels only.</p>`;
  },
  tick(el, s) {
    const cur = now().kernel?.id;
    for (const tr of el.querySelectorAll("tr[data-row]")) { tr.classList.toggle("on", Number(tr.dataset.row) === cur); tr.classList.toggle("sel", Number(tr.dataset.row) === s.sel); }
  },
};

// ---------------------------------------------------------------- Run
const RESULTS = ["client TTFT", "client mean ITL", "client end-to-end", "engine TTFT", "engine mean ITL", "perceived TPS"];
function sessionHtml(s) {
  const ss = s.session, rep = repOf(ss.rep);
  const run = (id, label) => { const r = runOf(id); return `<tr><td>${label}</td><td><code>${esc(id)}</code> ${r ? `${esc(runKind(r))} · ${whenOf(r)}${r.result ? "" : " · results not computed"}` : ""}</td></tr>`; };
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
    const val = (q, n) => aux.metrics.find((m) => m.request_id === q && m.name === n);
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
        ${!aux ? `<p class="muted">loading aux.json…</p>` : reqs.length ? `<table class="rows"><tr><th>request</th>${RESULTS.map((n) => `<th class="num">${esc(n)}</th>`).join("")}</tr>
          ${reqs.map((q) => `<tr><td>${esc(short(S, q))}</td>${RESULTS.map((n) => { const m = val(q, n); return `<td class="num">${m ? `${num(+(+m.value).toFixed(3))} ${esc(m.unit)}` : "–"}</td>`; }).join("")}</tr>`).join("")}</table>`
          : `<p class="muted">aux.json has no per-request metrics for this run${aux.metrics.length ? ` (${aux.metrics.length} run-level ones: see Metrics)` : ""}.</p>`}
        ${aux?.facts?.config?.value ? `<details><summary>config ${tag(aux.facts.config.source ?? "")}</summary><pre class="json">${esc(aux.facts.config.value)}</pre></details>` : ""}
      </div></div>${tail}`;
  },
};

export const TABS = [selected, atCursor, metricsTab, tokensTab, kernelsTab, runTab];
