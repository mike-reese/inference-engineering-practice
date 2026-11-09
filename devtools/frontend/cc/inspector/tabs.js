// The inspector's tabs, one list. A tab names what it reads from a Frame (deps); the inspector re-renders the open tab
// only when those change, and calls tick() (when a tab has one) for cheap cursor-only updates such as the highlighted
// row. Links inside a tab are data attributes the inspector handles in one place:
//   data-sel="<id>" selects a row; data-seek="<t>,<id>" moves the cursor onto a row; data-open='{"run","path"}' asks the
//   host runner to open a Nsight report; data-raw="<id>" loads a row's raw record; data-light="<id>,<id>" lights those
//   rows on every level while hovered.
// ctx.memo holds a tab's scans of the rows (cleared when live rows arrive); cold detail is the store's one cache.
import { fmtSpan } from "../control/bar.js";
import { fmtBytes, fmtValue } from "../scene/samples.js";
import { nsysWhere } from "./nsight.js";

/**
 * @typedef {{store: import("../store/run.js").RunStore, aux: any, rerender: () => void, memo: Map<string, any>, timer: number}} Ctx
 * @typedef {{key: string, label: string, deps: (f: any, ctx: Ctx) => any[], render: (el: HTMLElement, f: any, ctx: Ctx) => void,
 *   tick?: (el: HTMLElement, f: any, ctx: Ctx) => void}} Tab
 */

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ms = (ns, d = 3) => `${(ns / 1e6).toFixed(d)} ms`;
const tag = (text) => `<span class="tag">${esc(text)}</span>`;
const evidenceWord = (e) => (e ? String(e).split(":")[0] : "");
const rowLink = (s, id, text, attrs = "") => `<button class="link" data-sel="${id}" ${attrs} title="select row ${id}">${esc(text ?? s.nameText(s.field("name", id)))}</button>`;
const seekLink = (s, id) => `<button class="link go" data-seek="${s.startOf[id]},${id}" title="move the cursor to this row" aria-label="move the cursor to row ${id}">↦</button>`;
const openBtn = (target, label, aria) => (target ? `<button class="open" data-open='${esc(JSON.stringify({ run: target.run, path: target.path }))}' aria-label="${esc(aria)}">${esc(label)}</button>` : "");
const json = (o) => `<pre class="json">${esc(JSON.stringify(o, null, 1))}</pre>`;

/** Names from the run's root down to thing i: "host › server-1 (trtllm-serve) › server pid 400 › MainThread". */
function pathOf(s, i) {
  const out = []; for (let k = i; k >= 0; k = s.things[k].parent) out.push(s.things[k].parent < 0 ? "host" : s.things[k].name);
  return out.reverse().join(" › ");
}

/**
 * The cold detail of ids from the store's cache, as {get(id)}, once every id has been fetched; until then null, and
 * the tab re-renders when the store has them. The first render shows hot fields only.
 */
function withDetail(ctx, ids) {
  const s = ctx.store, miss = ids.filter((id) => s.detailCached(id) === undefined);
  if (!miss.length) return { get: (id) => s.detailCached(id) };
  s.detail(miss).then(ctx.rerender).catch((e) => console.error("inspector: detail", e));
  return null;
}

// ------------------------------------------------------------------ Selected
const selected = {
  key: "selected", label: "Selected",
  deps: (f) => [f.sel, f.selRow],
  render(el, f, { store: s }) {
    if (f.sel < 0) { el.innerHTML = `<p class="muted">Nothing selected. Click a row, a box or a tile in any level; Esc clears.</p>`; return; }
    const id = f.sel, d = f.selRow, r = s.row(id);
    const head = `<h3>${esc(r.kindName)}: ${esc(r.nameText)}</h3>`;
    if (!d) { el.innerHTML = `${head}<p class="muted">loading the row's detail…</p>`; return; }
    const lanePath = pathOf(s, r.lane), dur = d.end - d.start;
    const rows = [
      ["eid", `<code>${esc(d.eid)}</code> ${tag(`row ${id}`)}`],
      ["kind · tier", `${esc(d.kind)} · tier ${d.tier} (${esc(s.tiers[d.tier])})${d.term ? ` · ${esc(d.term)}` : ""}`],
      ["lane", esc(lanePath)],
      ["component", d.comp ? esc(d.comp.split("/").pop()) : "–"],
      ["request · iteration", `${esc(d.req ?? "–")} · ${Number.isInteger(d.iter) && d.iter >= 0 ? `iteration ${d.iter}` : "–"}${r.layer >= 0 ? ` · decoder layer ${r.layer} ${tag("Inferred at import")}` : ""}`],
      ["time", `${ms(d.start, 6)} → ${ms(d.end, 6)} · ${dur ? fmtSpan(dur) : "an instant"} ${seekLink(s, id)}`],
      ["what", esc(d.what ?? "–")],
      ["evidence", `${esc(d.evidence ?? "–")} ${tag(d.source ?? "")}`],
    ];
    if (d.corr != null) rows.push(["correlation id", esc(d.corr)]);
    if (d.quirk) rows.push(["quirk", esc(d.quirk)]);
    if (d.parent_rule) rows.push(["parent rule", esc(d.parent_rule)]);
    if (d.parents?.length) rows.push(["parents", d.parents.map((p) => `${rowLink(s, p.id, `${p.kind}: ${p.name}`)}`).join(" ‹ ")]);
    if (d.cause) rows.push(["cause", `${rowLink(s, d.cause.id, `${d.cause.kind}: ${d.cause.name}`)} · ${fmtSpan(d.start - d.cause.start)} from its start to this start`]);
    const others = (d.links ?? []).filter((l) => !(d.cause && l.from === d.cause.id && l.to === id));
    if (others.length) rows.push(["links", others.slice(0, 12).map((l) => `${esc(l.kind)}: ${l.from === id ? "→ " : "← "}${rowLink(s, l.from === id ? l.to : l.from)} ${tag(evidenceWord(l.evidence))}`).join("<br>") + (others.length > 12 ? `<br>+${others.length - 12} more` : "")]);
    if (d.metrics?.length) rows.push(["used by", d.metrics.map((m) => `${esc(m.name)} = ${esc(fmtNum(m.value))} ${esc(m.unit)}`).join("<br>")]);
    if (d.counters) rows.push(["Nsight Compute", d.counters.values.map((v) => `${esc(v.measure)} ${esc(v.unit === "byte" ? fmtBytes(v.value) : v.unit === "ns" ? fmtSpan(v.value) : fmtValue(v.value, v.unit))}`).join(" · ")]);
    const open = [d.open?.nsys && `${openBtn(d.open.nsys, "Nsight Systems ↗", "Open the selected row in Nsight Systems")} <span class="muted">${esc(nsysWhere(d.open.nsys))}</span>`,
      d.open?.ncu && `${openBtn(d.open.ncu, "Nsight Compute ↗", "Open the selected kernel in Nsight Compute")} <span class="muted">profile row ${d.open.ncu.profile_row}</span>`].filter(Boolean);
    if (open.length) rows.push(["open in", open.join("<br>")]);
    el.innerHTML = `${head}<table class="kv">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</table>
      ${d.args ? `<details><summary>args</summary>${json(d.args)}</details>` : ""}
      <details class="raw"><summary>raw record ${d.raw ? `<span class="muted">${esc(d.raw.file)} ${esc(d.raw.pointer)}</span>` : `<span class="muted">(no raw pointer)</span>`}</summary>
        ${d.raw ? `<button data-raw="${id}">load the raw record</button><pre class="json" data-raw-out="${id}"></pre>` : `<p class="muted">Rows imported from Nsight Systems have no raw record in the run folder; open the report instead.</p>`}</details>`;
  },
};

const fmtNum = (v) => (typeof v === "number" ? (Math.abs(v) >= 1e6 ? v.toExponential(3) : +v.toPrecision(6)) : v);

// ------------------------------------------------------------------ At cursor
const MAX_LANES = 24;
const atCursor = {
  key: "cursor", label: "At cursor",
  deps: (f, ctx) => [f.cursor.t, f.sel, ctx.store.N, ctx.store.rev],
  render(el, f, ctx) {
    const s = ctx.store, t = f.cursor.t, act = s.activeBy("lane", t), comp = s.activeBy("comp", t), { request, iteration, device } = f.chain;
    const ids = []; for (let i = 0; i < act.length; i++) if (act[i] >= 0 && (s.things[i].kind === "thread" || s.things[i].kind === "stream")) ids.push(i);
    const ev = (id) => { const d = s.detailCached(id); return d ? `${evidenceWord(d.evidence)} · ${d.source}` : ""; };
    // evidence is a cold field: fetch it once the cursor rests (stepping or playing does not flood the server)
    clearTimeout(ctx.timer);
    const need = ids.map((i) => act[i]).filter((id) => s.detailCached(id) === undefined);
    if (need.length) ctx.timer = setTimeout(() => s.detail(need).then(ctx.rerender).catch((e) => console.error("at cursor: detail", e)), 150);
    const into = (u) => (u ? (u.contains ? `${ms(t - u.win[0])} in, of ${fmtSpan(u.win[1] - u.win[0])}` : `ended ${fmtSpan(t - u.win[1])} before`) : "");
    const chain = [
      request && `<tr><th>request</th><td>${rowLink(s, request.id, s.requests[request.req])} · ${into(request)}</td></tr>`,
      iteration && `<tr><th>iteration</th><td>${rowLink(s, iteration.id, `iteration ${iteration.iter}`)} · ${into(iteration)}</td></tr>`,
      device && `<tr><th>device op</th><td>${rowLink(s, device.id, `${s.kinds[s.field("kind", device.id)]?.label}: ${s.nameText(s.field("name", device.id))}`)} · ${s.startOf[device.id] <= t && t <= s.endOf[device.id] ? "running" : "nearest"}</td></tr>`,
    ].filter(Boolean).join("");
    const comps = s.things.filter((th) => th.kind === "component" && comp[th.i] >= 0).map((th) => th.name);
    const groups = new Map();
    for (const i of ids) { const p = s.things[i].parent; (groups.get(p) ?? groups.set(p, []).get(p)).push(i); }
    let n = 0; const lines = [];
    for (const [p, lanes] of groups) {
      if (n >= MAX_LANES) break;
      lines.push(`<tr class="grp"><th colspan="3">${esc(s.things[p]?.name ?? "run")}</th></tr>`);
      for (const i of lanes) {
        if (n++ >= MAX_LANES) break;
        const id = act[i], k = s.kinds[s.field("kind", id)];
        lines.push(`<tr${id === f.sel ? ` class="on"` : ""}><td>${esc(s.things[i].key.split("/").pop())}</td><td>${esc(k?.label ?? "")}: ${rowLink(s, id)} <span class="muted">${fmtSpan(t - s.startOf[id])} in</span></td><td>${ev(id) ? tag(ev(id)) : ""}</td></tr>`);
      }
    }
    const lanesTotal = s.things.filter((th) => th.kind === "thread" || th.kind === "stream").length;
    el.innerHTML = `<div class="cols"><div><h3>${ms(t, 6)} <span class="muted">from the run's t0</span></h3><table class="kv">${chain}</table>
      <p><b>components busy</b>: ${comps.length ? comps.map(esc).join(", ") : "<span class=muted>none</span>"}</p></div>
      <div><p><b>${ids.length}</b> of ${lanesTotal} threads and streams have an active row${ids.length > MAX_LANES ? ` (first ${MAX_LANES} shown)` : ""}; evidence tags load when the cursor rests.</p>
      <table class="rows">${lines.join("")}</table></div></div>`;
  },
};

// ------------------------------------------------------------------ Metrics
const metrics = {
  key: "metrics", label: "Metrics",
  deps: (f, ctx) => [ctx.aux, f.chain.request?.req],
  render(el, f, ctx) {
    const s = ctx.store, aux = ctx.aux;
    if (!aux) { el.innerHTML = `<p class="muted">loading aux.json…</p>`; return; }
    const cur = f.chain.request ? s.requests[f.chain.request.req] : null, byReq = new Map();
    aux.metrics.forEach((m, i) => { const k = m.request_id ?? "run"; (byReq.get(k) ?? byReq.set(k, []).get(k)).push({ ...m, i }); });
    const input = (m) => [...m.inputs.rows.map((id) => id < s.N ? `${rowLink(s, id, undefined, `data-light="${id}"`)} <span class="muted">${ms(s.startOf[id])}</span>` : `row ${id}`),
      ...m.inputs.samples.slice(0, 3).map(([g, k]) => tag(`${g} #${k}`)), m.inputs.samples.length > 3 ? tag(`+${m.inputs.samples.length - 3} samples`) : "",
      ...m.inputs.unresolved.map((u) => tag(`unresolved ${u}`))].filter(Boolean).join(" ");
    // hovering a metric's row lights all its input rows on every level; hovering one input lights that row
    const lightAll = (m) => { const ids = m.inputs.rows.filter((id) => id < s.N); return ids.length ? ` data-light="${ids.join(",")}"` : ""; };
    const table = (list) => `<table class="rows metrics"><tr><th>metric</th><th>value</th><th>formula</th><th>inputs (hover to light on every level, click to select)</th></tr>${list.map((m) =>
      `<tr${lightAll(m)}><td>${esc(m.name)}</td><td class="num">${esc(fmtNum(m.value))} ${esc(m.unit)}</td><td>${esc(m.formula)}</td><td>${input(m)}</td></tr>`).join("")}</table>`;
    const order = [...byReq.keys()].sort((a, b) => (b === cur) - (a === cur));
    el.innerHTML = `<p class="muted">Metrics as calculated at import (aux.json): each value with its formula and the rows it reads. The request at the cursor comes first.</p>
      ${order.map((k, i) => `<details ${k === cur || (i === 0 && !byReq.has(cur)) ? "open" : ""}><summary><b>${esc(k)}</b> · ${byReq.get(k).length} metrics${k === cur ? " · at the cursor" : !byReq.has(cur) && i === 0 ? ` · the request at the cursor (${esc(cur ?? "none")}) has none` : ""}</summary>${table(byReq.get(k))}</details>`).join("")}
      ${aux.unavailable?.length ? `<details><summary>unavailable (${aux.unavailable.length})</summary><ul>${aux.unavailable.map((u) => `<li>${esc(u.what)}: ${esc(u.why)}</li>`).join("")}</ul></details>` : ""}
      ${aux.measures ? `<details><summary>measures (definitions)</summary><table class="rows">${Object.values(aux.measures).map((m) => `<tr><td>${esc(m.measure)}</td><td>${esc(m.formula)}</td><td>${esc(m.unit)}</td><td>${esc(m.additivity)}</td><td>${tag(evidenceWord(m.evidence))}</td></tr>`).join("")}</table></details>` : ""}`;
  },
};

// ------------------------------------------------------------------ Tokens
/** The request's token events (client SSE events named "event: token"), and its wire frames that carry tokens. */
function tokenRows(s, req) {
  const out = { client: [], wire: [] }, kClient = s.kinds.find((k) => k.name === "client event")?.code, kWire = s.kinds.find((k) => k.name === "network frame")?.code;
  const r = s.chain(s.startOf[req.id]).request, win = r?.win ?? [s.startOf[req.id], s.endOf[req.id]];
  s.scan({ win, maxTier: 2, starts: true }, (id) => {
    if (s.field("req", id) !== req.req) return;
    const k = s.field("kind", id), name = s.nameText(s.field("name", id));
    if (k === kClient && name === "event: token") out.client.push(id);
    else if (k === kWire) { const m = /^(\d+) token event/.exec(name); if (m) for (let i = 0; i < +m[1]; i++) out.wire.push(id); }
  });
  const by = (a, b) => s.startOf[a] - s.startOf[b] || a - b; out.client.sort(by); out.wire.sort(by);
  return out;
}

const tokens = {
  key: "tokens", label: "Tokens",
  deps: (f, ctx) => [f.chain.request?.id, ctx.store.N, ctx.store.rev],
  render(el, f, ctx) {
    const s = ctx.store, req = f.chain.request;
    if (!req) { el.innerHTML = `<p class="muted">No request in this run.</p>`; return; }
    const memo = ctx.memo.get(`tok-${req.id}`) ?? ctx.memo.set(`tok-${req.id}`, tokenRows(s, req)).get(`tok-${req.id}`);
    const { client, wire } = memo, detail = withDetail(ctx, client), send = req.win[0];
    if (!client.length) { el.innerHTML = `<p class="muted">${esc(s.requests[req.req])}: no client token events (the run has no client stamps).</p>`; return; }
    const text = (id) => detail?.get(id)?.args?.content;
    el.innerHTML = `<p><b>${esc(s.requests[req.req])}</b> · ${client.length} token events · ${wire.length} on the wire.
      Text: ${detail ? `<span class="answer">${client.map((id) => `<span data-tok="${id}">${esc(text(id) ?? "")}</span>`).join("")}</span>` : "<span class=muted>loading…</span>"}</p>
      <table class="rows tokens"><tr><th>#</th><th>text</th><th>client event</th><th>gap to previous</th><th>wire frame ${tag("k-th token frame, Inferred")}</th><th></th></tr>
      ${client.map((id, k) => `<tr data-row="${id}"><td>${k + 1}</td><td><code>${esc(JSON.stringify(text(id) ?? "…"))}</code></td><td class="num">${ms(s.startOf[id] - send)}</td>
        <td class="num">${k ? ms(s.startOf[id] - s.startOf[client[k - 1]]) : "TTFT"}</td><td class="num">${wire[k] != null ? ms(s.startOf[wire[k]] - send) : "–"}</td>
        <td>${rowLink(s, id, "select")} ${seekLink(s, id)}</td></tr>`).join("")}</table>`;
    tokens.tick(el, f, ctx);
  },
  tick(el, f) {
    const t = f.cursor.t; let last = null;
    for (const tr of el.querySelectorAll("tr[data-row]")) { const on = Number(tr.querySelector("[data-seek]").dataset.seek.split(",")[0]) <= t; tr.classList.toggle("past", on); if (on) last = tr; }
    el.querySelectorAll("tr.on, span.on").forEach((x) => x.classList.remove("on"));
    if (last) { last.classList.add("on"); el.querySelector(`span[data-tok="${last.dataset.row}"]`)?.classList.add("on"); }
  },
};

// ------------------------------------------------------------------ Kernels
const kernels = {
  key: "kernels", label: "Kernels",
  deps: (f, ctx) => [f.chain.iteration?.id, ctx.store.N, ctx.store.rev],
  render(el, f, ctx) {
    const s = ctx.store, it = f.chain.iteration;
    if (!it) { el.innerHTML = `<p class="muted">No iterations in this run (no scheduler stamps).</p>`; return; }
    const key = `k-${it.id}`, ids = ctx.memo.get(key) ?? ctx.memo.set(key, (() => {
      const out = []; s.scan({ win: it.win, minTier: 5, maxTier: 5, starts: true }, (id) => { if (s.field("iter", id) === it.iter) out.push(id); });
      return out.sort((a, b) => s.startOf[a] - s.startOf[b] || a - b);
    })()).get(key);
    if (!ids.length) { el.innerHTML = `<p class="muted">Iteration ${it.iter}: no device ops (no Nsight Systems capture for it).</p>`; return; }
    const det = withDetail(ctx, ids), c = (id, m) => det?.get(id)?.counters?.values.find((v) => v.measure === m);
    const profiled = det ? ids.filter((id) => det.get(id)?.counters) : [];
    const ncu = profiled.length ? s.tools.ncu : null;
    const cell = (v, f2) => (v ? f2(v.value) : "–");
    el.innerHTML = `<p><b>iteration ${it.iter}</b> · ${ids.length} device ops · ${fmtSpan(it.win[1] - it.win[0])} from its scheduler stamp to the end of its device work ·
      ${det ? `${profiled.length} with Nsight Compute counters` : "loading detail…"}
      ${openBtn(s.tools.nsys, "Nsight Systems ↗", "Open the iteration's report in Nsight Systems")} ${openBtn(ncu, "Nsight Compute ↗", "Open the iteration's kernels in Nsight Compute")}</p>
      <table class="rows kernels"><tr><th>#</th><th>layer</th><th>op</th><th>grid × block</th><th>µs</th><th>DRAM read</th><th>L2</th><th>SM %</th><th>occupancy</th><th></th></tr>
      ${ids.map((id, k) => { const d = det?.get(id), a = d?.args ?? {}, layer = s.field("layer", id);
        return `<tr data-row="${id}"><td>${k + 1}</td><td>${layer >= 0 ? layer : ""}</td><td>${rowLink(s, id, `${s.kinds[s.field("kind", id)]?.label}: ${s.nameText(s.field("name", id))}`)}</td>
          <td>${a.grid ? `${a.grid.join("×")} × ${a.block?.join("×")}` : ""}</td><td class="num">${((s.endOf[id] - s.startOf[id]) / 1e3).toFixed(1)}</td>
          <td class="num">${cell(c(id, "DRAM read"), fmtBytes)}</td><td class="num">${cell(c(id, "L2 traffic"), fmtBytes)}</td>
          <td class="num">${cell(c(id, "SM throughput"), (v) => v.toFixed(1))}</td><td class="num">${cell(c(id, "achieved occupancy"), (v) => v.toFixed(1))}</td><td>${seekLink(s, id)}</td></tr>`; }).join("")}</table>`;
    kernels.tick(el, f);
  },
  tick(el, f) {
    const d = f.chain.device?.id;
    el.querySelectorAll("tr.on").forEach((x) => x.classList.remove("on"));
    el.querySelector(`tr[data-row="${d}"]`)?.classList.add("on");
    el.querySelectorAll("tr.sel").forEach((x) => x.classList.remove("sel"));
    el.querySelector(`tr[data-row="${f.sel}"]`)?.classList.add("sel");
  },
};

// ------------------------------------------------------------------ Run
const RESULTS = ["client TTFT", "client mean ITL", "client end-to-end", "engine TTFT", "engine mean ITL", "perceived TPS"];
const run = {
  key: "run", label: "Run",
  deps: (f, ctx) => [ctx.aux],
  render(el, f, ctx) {
    const s = ctx.store, aux = ctx.aux;
    if (!aux) { el.innerHTML = `<p class="muted">loading aux.json…</p>`; return; }
    const reqs = [...new Set(aux.metrics.map((m) => m.request_id).filter(Boolean))];
    const val = (r, n) => aux.metrics.find((m) => m.request_id === r && m.name === n);
    const facts = aux.facts ?? {}, basis = facts.basis?.value ?? {}, labels = facts.labels?.value ?? {}, ncu = s.tools.ncu?.kernels;
    el.innerHTML = `<div class="cols"><div>
      <h3>${esc(s.run)} <span class="muted">generation ${s.generation} · ${esc(s.status)}</span></h3>
      <table class="rows"><tr><th>request</th>${RESULTS.map((n) => `<th>${esc(n)}</th>`).join("")}</tr>
      ${reqs.map((r) => `<tr><td>${esc(r.replace(`${s.run}-`, ""))}</td>${RESULTS.map((n) => { const m = val(r, n); return `<td class="num">${m ? `${fmtNum(+m.value.toFixed(3))} ${esc(m.unit)}` : "–"}</td>`; }).join("")}</tr>`).join("")}</table>
      ${reqs.length < s.requests.length ? `<p class="muted">${s.requests.length - reqs.length} of ${s.requests.length} requests have no calculated metrics in aux.json.</p>` : ""}
      <p><b>workload</b>: ${s.requests.map((r) => esc(r.replace(`${s.run}-`, ""))).join(", ")} · trace ${esc(labels.trace ?? "–")} · ${labels.measured ? "measured" : "not a measured run (instrumented)"}
        · CUDA graphs ${labels.graphs ? "on" : "off"}${labels.profile_range ? ` · profiled iterations ${esc(labels.profile_range)}` : ""}</p>
      <p>${openBtn(s.tools.nsys, "Nsight Systems report ↗", "Open the run's report in Nsight Systems")} ${ncu ? `<span class="muted">Nsight Compute: ${esc(ncu.tied)} kernels of iteration ${esc(ncu.iteration)} tied (${esc(evidenceWord(ncu.evidence))}); select one in Kernels</span>` : ""}</p>
      ${aux.unavailable?.length ? `<p><b>unavailable</b>: ${aux.unavailable.map((u) => `${esc(u.what.replace(`${s.run}-`, ""))} (${esc(u.why)})`).join("; ")}</p>` : ""}
    </div><div>
      <p><b>config</b> ${tag(facts.config?.source ?? "")}</p><pre class="json">${esc(facts.config?.value ?? "–")}</pre>
      <p><b>basis</b> ${tag(facts.basis?.source ?? "")}: ${esc(basis.gpu?.name ?? "")} · driver ${esc(basis.gpu?.driver_version ?? "–")} · TensorRT-LLM ${esc(basis.version?.version ?? "–")} · torch ${esc(basis.torch ?? "–")} · docker ${esc(basis.docker ?? "–")} · ${esc(basis.utc ?? "")}</p>
      <details><summary>images</summary>${json(basis.images ?? {})}</details>
    </div></div>`;
  },
};

/** @type {Tab[]} */
export const TABS = [selected, atCursor, metrics, tokens, kernels, run];
