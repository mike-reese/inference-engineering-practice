// Trace view: one request of a recorded run, stepped through every level on one clock (CLOCK_MONOTONIC ns).
// Level 0 architecture (the map), 1 network (frames), 2a client, 2b server, 3 hardware and code (kernels, copies).
// One step control drives every level; the lanes show the same time window; metrics light their input spans.
import { escape, getJSON, json, ms, openInTool } from "./util.js";

const W = 1200;
const LANES = [ // [label, test(span)]
  ["client: Locust, SDK", (s) => s.level === "client" && s.component !== "transport"],
  ["client: transport", (s) => s.level === "client" && s.component === "transport"],
  ["wire: server eth0", (s) => s.level === "network"],
  ["server: HTTP (uvicorn)", (s) => s.level === "server" && s.component === "http"],
  ["server: LLM API", (s) => s.level === "server" && s.component === "llm_api"],
  ["server: scheduler", (s) => s.level === "server" && s.component === "scheduler"],
  ["server: executor", (s) => s.level === "server" && s.component === "executor"],
  ["GPU kernels", (s) => s.level === "hardware" && s.component === "gpu" && s.name !== "sample"],
  ["PCIe copies", (s) => s.level === "hardware" && s.component === "pcie"],
];
const LEVELS = {
  "0 architecture": (s) => MILESTONES.some((m) => m(s)),
  "1 network": (s) => s.level === "network",
  "2a client": (s) => s.level === "client",
  "2b server": (s) => s.level === "server",
  "3 hardware and code": (s) => s.level === "hardware" && s.name !== "sample",
  "all but hardware": (s) => s.level !== "hardware",
};
const MILESTONES = [
  (s) => s.component === "sdk" && s.name === "send",
  (s) => s.level === "network" && s.name === "request body",
  (s) => s.level === "server" && s.end_ns == null,
  (s) => s.level === "network" && (s.name === "response headers" || s.attrs.first_token === 1 || s.attrs.done),
  (s) => s.component === "sdk" && (s.name === "response headers" || s.name === "protocol complete"),
  (s) => s.component === "sdk" && s.name === "event: token" && s.attrs.token === 1,
];
const MAP = [ // the architecture map: [component key, label, x, y, w, h]
  ["client", "client container: Locust → send_one → OpenAI SDK", 10, 30, 230, 44],
  ["transport", "httpx transport · socket", 10, 84, 230, 34],
  ["eth0", "Compose bridge → server eth0 (tcpdump)", 270, 56, 210, 44],
  ["http", "uvicorn · HTTP handler · stream generator", 510, 10, 250, 34],
  ["llm_api", "LLM API: template, tokenizer", 510, 52, 250, 30],
  ["scheduler", "MPI worker: scheduler slot", 510, 90, 250, 30],
  ["executor", "executor: iterations", 510, 128, 250, 30],
  ["gpu", "GPU: kernels · KV pool", 800, 70, 170, 44],
  ["pcie", "PCIe copies", 800, 124, 170, 30],
];
const mapKey = (s) => (!s ? null : s.level === "client" ? (s.component === "transport" ? "transport" : "client")
  : s.level === "network" ? "eth0" : s.component === "sample" ? "gpu" : s.component);

export class TraceView {
  constructor(root) {
    this.root = root;
    this.runId = null; this.request = null; this.run = null; this.error = null;
    this.level = "0 architecture"; this.step = 0; this.window = null; this.lit = new Set();
    this.playing = null; this.speed = 5; this.iteration = "all"; this.raw = null; this.source = null; this.dirty = true;
    this.kernel = null; // the Nsight Compute kernel id picked in the strip or table (its sections open in ncu-ui)
    this.files = []; this.opened = null; // the run's files (for the reports); the last open-in-tool status
  }

  open(params, state) {
    const [run, request] = params;
    if (run && run !== this.runId) { this.runId = run; this.run = null; this.kernel = null; this.opened = null; this.request = request ?? null; this.load(); }
    else if (request) { this.request = request; this.reset(); }
    this.dirty = true;
  }

  async load() {
    this.error = null;
    try {
      this.run = await getJSON(`/api/runs/${encodeURIComponent(this.runId)}`);
      this.request ??= this.defaultRequest();
      this.reset();
    } catch (e) { this.error = String(e); }
    this.dirty = true; this.redraw();
  }

  defaultRequest() { // the measured request: not the warm-up
    const req = this.run.spans.filter((s) => s.name === "request" && s.level === "client");
    return (req.find((s) => s.attrs.phase !== "warmup") ?? req[0])?.request_id ?? this.run.requests[0];
  }

  reset() {
    this.step = 0; this.lit = new Set(); this.raw = null; this.source = null;
    const req = this.requestSpan();
    this.window = req ? [req.start_ns - 0.5e6, (req.end_ns ?? req.start_ns) + 1e6] : null;
  }

  requestSpan() { return this.run?.spans.find((s) => s.request_id === this.request && s.name === "request" && s.level === "client"); }

  spans() { // this request's spans, plus unattributed hardware and executor spans inside its window
    const req = this.requestSpan();
    const [a, b] = req ? [req.start_ns, req.end_ns ?? req.start_ns] : [-Infinity, Infinity];
    return this.run.spans.filter((s) => s.request_id === this.request
      || (s.request_id == null && s.start_ns >= a - 1e6 && s.start_ns <= b + 1e6));
  }

  steps() {
    const test = LEVELS[this.level];
    return this.spans().filter((s) => test(s) && (this.iteration === "all" || s.attrs.iteration == null
      || String(s.attrs.iteration) === this.iteration)).sort((x, y) => x.start_ns - y.start_ns);
  }

  go(i) {
    const steps = this.steps();
    this.step = Math.max(0, Math.min(steps.length - 1, i));
    this.raw = null; this.source = null;
    const s = steps[this.step];
    if (s && this.window && (s.start_ns < this.window[0] || s.start_ns > this.window[1])) {
      const width = this.window[1] - this.window[0];
      this.window = [s.start_ns - width / 2, s.start_ns + width / 2];
    }
    this.dirty = true; this.redraw();
  }

  play() {
    if (this.playing) { clearInterval(this.playing); this.playing = null; this.dirty = true; this.redraw(); return; }
    this.playing = setInterval(() => {
      if (this.step >= this.steps().length - 1) return this.play();
      this.go(this.step + 1);
    }, 1000 / this.speed);
  }

  zoom(factor) {
    const s = this.steps()[this.step];
    const [a, b] = this.window;
    const center = s ? s.start_ns : (a + b) / 2, half = ((b - a) * factor) / 2;
    this.window = [center - half, center + half];
    this.dirty = true; this.redraw();
  }

  async showRaw(span) {
    this.raw = span.raw ? await getJSON(`/api/runs/${encodeURIComponent(this.runId)}/raw?file=${encodeURIComponent(span.raw.file)}`
      + `&pointer=${encodeURIComponent(span.raw.pointer ?? "")}`).catch((e) => ({ error: String(e) })) : { note: "no raw source" };
    this.dirty = true; this.redraw();
  }

  async showSource(frame) { // "path/file.py(123): function"
    const m = frame.match(/^(.*\.py)\((\d+)\)/);
    if (!m) return;
    this.source = await getJSON(`/api/runs/${encodeURIComponent(this.runId)}/source?file=${encodeURIComponent(m[1])}&line=${m[2]}`)
      .catch((e) => ({ error: String(e) }));
    this.dirty = true; this.redraw();
  }

  showKernel(id) { this.kernel = id; this.dirty = true; this.redraw(); }

  report(suffix) { return this.files.find((f) => f.endsWith(suffix)); } // trace/kernels.ncu-rep, trace/timeline.nsys-rep

  async openReport(path) {
    this.opened = path ? "…" : "this run has no such report";
    this.dirty = true; this.redraw();
    if (path) { this.opened = await openInTool(this.runId, path); this.dirty = true; this.redraw(); }
  }

  openButton(suffix, tool) {
    const path = this.report(suffix);
    return path ? `<button class="opentool" data-path="${escape(path)}">Open in ${tool}</button>` : "";
  }

  lanes(spans, current) {
    const [a, b] = this.window;
    const x = (ns) => ((ns - a) / (b - a)) * W;
    const rows = LANES.map(([label, test], i) => {
      const y = 20 + i * 26;
      const marks = spans.filter((s) => test(s) && (s.end_ns ?? s.start_ns) >= a && s.start_ns <= b).map((s) => {
        const cls = `${s.id === current?.id ? "cur" : ""} ${this.lit.has(s.id) ? "lit" : ""}`;
        if (s.end_ns == null) return `<line class="mark ${cls}" data-id="${escape(s.id)}" x1="${x(s.start_ns)}" x2="${x(s.start_ns)}" y1="${y}" y2="${y + 18}"><title>${escape(s.name)}</title></line>`;
        const x0 = Math.max(0, x(s.start_ns)), x1 = Math.min(W, x(s.end_ns));
        return `<rect class="span ${cls}" data-id="${escape(s.id)}" x="${x0}" y="${y + 3}" width="${Math.max(1, x1 - x0)}" height="12"><title>${escape(s.name)} ${ms((s.end_ns - s.start_ns) / 1e6, 3)} ms</title></rect>`;
      }).join("");
      return `<text class="lanelabel" x="4" y="${y + 13}">${label}</text>${marks}`;
    }).join("");
    const samples = this.run.spans.filter((s) => s.name === "sample" && s.start_ns >= a && s.start_ns <= b);
    const yg = 20 + LANES.length * 26;
    const line = samples.map((s) => `${x(s.start_ns).toFixed(1)},${(yg + 24 - 0.24 * (s.attrs["utilization.gpu"] ?? 0)).toFixed(1)}`).join(" ");
    const cursor = current ? `<line class="cursor" x1="${x(current.start_ns)}" x2="${x(current.start_ns)}" y1="0" y2="${yg + 30}"/>` : "";
    const send = this.requestSpan()?.start_ns ?? a;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => `<text class="tick" x="${f * W - (f === 1 ? 60 : 0)}" y="12">${ms((a + f * (b - a) - send) / 1e6, 3)} ms</text>`).join("");
    return `<svg class="tracelanes" viewBox="0 0 ${W} ${yg + 32}" preserveAspectRatio="none">${ticks}${rows}
      <text class="lanelabel" x="4" y="${yg + 13}">GPU utilization (nvidia-smi, 0–100 %)</text><polyline class="gpuline" points="${line}"/>${cursor}</svg>`;
  }

  map(current, previous) {
    const key = mapKey(current), prev = mapKey(previous);
    const topo = this.run.topology ?? {};
    const boxes = MAP.map(([k, label, x, y, w, h]) => `<g class="box ${k === key ? "on" : ""} ${k === prev && k !== key ? "prev" : ""}">
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4"/><text x="${x + 6}" y="${y + 19}">${escape(label)}</text></g>`).join("");
    const containers = (topo.containers ?? []).map((c) => `${c.service}: ${c.name} · ${Object.values(c.networks ?? {}).join(",") || c.network_mode} · ${(Object.values(c.ports ?? {}).flat()).join(",")}`).join("  |  ");
    return `<svg class="archmap" viewBox="0 0 980 170">${boxes}
      <text class="lanelabel" x="10" y="166">${escape(containers)} · GPU ${escape(topo.gpu?.name ?? "")}</text></svg>`;
  }

  detail(s) {
    if (!s) return "<p>No step at this level for this request.</p>";
    const send = this.requestSpan()?.start_ns ?? s.start_ns;
    const own = s.level === "server" && s.attrs.seconds != null ? `engine steady clock ${s.attrs.seconds} s`
      : s.level === "network" ? `capture clock (UTC) converted with the client's anchor pair`
        : s.level === "hardware" ? "Nsight/PyTorch profiler clock, joined to CLOCK_MONOTONIC" : `client CLOCK_MONOTONIC ${s.start_ns} ns`;
    const stack = (s.attrs.stack ?? []).map((f) => `<li><a href="#" class="frame" data-frame="${escape(f)}">${escape(f)}</a></li>`).join("");
    const text = s.attrs.text ? `<pre class="payload">${escape(s.attrs.text)}</pre>` : "";
    const attrs = Object.fromEntries(Object.entries(s.attrs).filter(([k]) => !["text", "stack"].includes(k)));
    return `<div class="label">${escape(s.level)} · ${escape(s.component)}</div>
      <h3>${escape(s.name)}</h3>
      <div>at <b>${ms((s.start_ns - send) / 1e6, 3)} ms</b> from send${s.end_ns != null ? `, lasts ${ms((s.end_ns - s.start_ns) / 1e6, 3)} ms` : ""}
        · ${escape(own)}</div>
      ${s.attrs.what ? `<div>what: ${escape(s.attrs.what)} · set at <code>${escape(s.attrs.source)}</code></div>` : ""}
      ${s.attrs.data ? `<div>the request is now: ${escape(s.attrs.data)}</div>` : ""}
      ${s.attrs.op ? `<div>PyTorch op <code>${escape(s.attrs.op)}</code> shapes ${escape(JSON.stringify(s.attrs.shapes))} · launch ${escape(s.attrs.launch)}</div>` : ""}
      ${stack ? `<div class="label">Python stack (click for source)</div><ol class="stack">${stack}</ol>` : ""}
      ${text}${json(attrs)}
      <button class="showraw">raw record (${escape(s.raw?.file ?? "none")})</button>
      ${this.raw ? json(this.raw) : ""}
      ${this.source ? (this.source.lines ? `<pre class="source">${this.source.lines.map((l, i) => {
          const n = this.source.start + i;
          return `<span class="${n === this.source.line ? "here" : ""}">${String(n).padStart(5)}  ${escape(l)}</span>`;
        }).join("\n")}</pre>` : json(this.source)) : ""}`;
  }

  metrics() {
    const list = this.run.metrics.filter((m) => m.request_id === this.request);
    const segments = list.filter((m) => m.name.startsWith("segment "));
    const ttft = segments.filter((m) => !m.name.includes("[DONE]")), total = ttft.reduce((t, m) => t + (m.value ?? 0), 0);
    const colors = ["#58a6ff", "#3fb950", "#d29922", "#bc8cff", "#f778ba", "#39c5cf", "#e3b341", "#8b949e"];
    const bar = total ? `<div class="segbar">${ttft.map((m, i) => `<span class="seg" data-m="${escape(m.name)}"
        style="width:${(100 * m.value) / total}%;background:${colors[i]}" title="${escape(m.name)} ${ms(m.value, 3)} ms">${ms(m.value, 2)}</span>`).join("")}</div>
      <div class="dim">client TTFT ${ms(total, 3)} ms = the ${ttft.length} segments above, each named by its two clocks (click one)</div>` : "";
    const rows = list.map((m) => `<tr data-m="${escape(m.name)}" class="${this.metric === m.name ? "on" : ""}"><td>${escape(m.name)}</td>
      <td><code>${escape(m.formula)}</code></td><td>${m.value == null ? "Unavailable" : ms(m.value, 3)}</td><td>${escape(m.unit)}</td>
      <td>${m.inputs.length}</td></tr>`).join("");
    return `${bar}<table class="metrics"><tr><th>metric</th><th>formula</th><th>value</th><th>unit</th><th>inputs</th></tr>${rows}</table>`;
  }

  tokens() {
    const spans = this.spans();
    const client = spans.filter((s) => s.name === "event: token").sort((a, b) => a.start_ns - b.start_ns);
    const wire = [];
    for (const f of spans.filter((s) => s.attrs.token_events).sort((a, b) => a.start_ns - b.start_ns)) {
      for (let i = 0; i < f.attrs.token_events; i++) wire.push(f);
    }
    const send = this.requestSpan()?.start_ns ?? 0;
    const usage = this.requestSpan()?.attrs.usage?.completion_tokens;
    const n = Math.max(client.length, wire.length, usage ?? 0);
    const rows = Array.from({ length: n }, (_, i) => {
      const c = client[i], w = wire[i];
      const bad = !c || c.attrs.records !== 1;
      return `<tr class="${bad ? "bad" : ""}"><td>${i + 1}</td><td>${c ? escape(JSON.stringify(c.attrs.content)) : "no event"}</td>
        <td>${c?.attrs.records ?? "–"}</td><td>${w ? `#${w.attrs.number} ${ms((w.start_ns - send) / 1e6, 3)}` : "–"}</td>
        <td>${c ? ms((c.start_ns - send) / 1e6, 3) : "–"}</td></tr>`;
    }).join("");
    return `<div class="dim">usage.completion_tokens ${usage ?? "–"} · token events ${client.length} · on the wire ${wire.length}</div>
      <table class="tokens"><tr><th>token</th><th>text</th><th>records</th><th>wire frame, ms</th><th>client event, ms</th></tr>${rows}</table>`;
  }

  kernels() {
    const ncu = this.run.profiles?.ncu;
    if (!ncu) return "<p class=dim>No Nsight Compute profile in this run (TRACE=kernels makes one).</p>";
    const rows = [...ncu.kernels].sort((a, b) => (b.dram_read_bytes ?? 0) - (a.dram_read_bytes ?? 0)).map((k) => `<tr data-k="${k.id}" class="${this.kernel === k.id ? "on" : ""}">
      <td>${k.id}</td><td>${k.layer ?? "–"}</td><td title="${escape(k.name)}">${escape(k.name.slice(0, 70))}</td><td>${escape(k.grid)} × ${escape(k.block)}</td>
      <td>${ms(k.duration, 2)}</td><td>${ms((k.dram_read_bytes ?? 0) / 1e6, 2)}</td><td>${ms((k.l2_bytes ?? 0) / 1e6, 2)}</td>
      <td>${ms(k.dram_pct_of_peak, 1)}</td><td>${ms(k.sm_pct_of_peak, 1)}</td></tr>`).join("");
    return `<div class="dim">iteration ${escape(ncu.iteration)} · ${ncu.kernels.length} kernels · DRAM read ${ms(ncu.dram_read_bytes / 1e6, 1)} MB · ${escape(ncu.note)}</div>
      <div>${this.openButton(".ncu-rep", "ncu-ui")} sections, roofline, warp stalls, source and SASS per kernel ·
        the id column here is the ID column in ncu-ui's Result list ${this.opened ? `<span class="dim">· ${escape(this.opened)}</span>` : ""}</div>
      ${this.kernelStrip(ncu)}
      <table class="ncu"><tr><th>id</th><th>layer</th><th>kernel</th><th>grid × block</th><th>µs</th><th>DRAM read MB</th><th>L2 MB</th>
      <th>DRAM % peak</th><th>SM % peak</th></tr>${rows}</table>`;
  }

  // One executor iteration from Nsight Systems: each CPU launch call, the kernels it started, GPU idle gaps.
  // With CUDA graphs a decode step is one cudaGraphLaunch fanning out to every kernel node; without, one call each.
  iterationGraph() {
    const all = this.spans().filter((s) => s.level === "hardware" && s.component === "gpu" && s.name !== "sample"
      && s.attrs.iteration != null);
    if (!all.length) return "<p class=dim>No kernel timeline in this run (TRACE=timeline records one).</p>";
    const its = [...new Set(all.map((s) => s.attrs.iteration))].sort((a, b) => a - b);
    const it = this.iteration !== "all" && its.includes(+this.iteration) ? +this.iteration : (its[1] ?? its[0]);
    const ks = all.filter((s) => s.attrs.iteration === it).sort((a, b) => a.start_ns - b.start_ns);
    const a = Math.min(...ks.map((k) => k.attrs.launch_ns ?? k.start_ns)), b = Math.max(...ks.map((k) => k.end_ns));
    const Wg = 1200, x = (ns) => ((ns - a) / (b - a)) * Wg;
    const calls = new Map(); // one CPU launch call -> the kernels it started
    for (const k of ks) {
      const key = `${k.attrs.launch_ns}|${k.attrs.launch}`;
      if (!calls.has(key)) calls.set(key, { ns: k.attrs.launch_ns, api: k.attrs.launch ?? "?", kernels: [] });
      calls.get(key).kernels.push(k);
    }
    let busy = 0, idle = [], end = ks[0].start_ns;
    for (const k of ks) {
      if (k.start_ns > end) idle.push([end, k.start_ns]);
      busy += k.end_ns - Math.max(k.start_ns, end > k.start_ns ? Math.min(end, k.end_ns) : k.start_ns);
      end = Math.max(end, k.end_ns);
    }
    const idleNs = idle.reduce((t, [p, q]) => t + q - p, 0);
    const maxLayer = Math.max(...ks.map((k) => k.attrs.layer ?? -1));
    const color = (k) => k.attrs.layer == null ? "#555c6a" : k.attrs.layer === maxLayer ? "#bc8cff" : k.attrs.layer % 2 ? "#3d7ab8" : "#2d5a8a";
    const fan = [...calls.values()].filter((c) => c.ns != null).map((c) => c.kernels.map((k) =>
      `<line class="fan" x1="${x(c.ns)}" y1="40" x2="${x(k.start_ns)}" y2="92"/>`).join("")).join("");
    const ticks = [...calls.values()].filter((c) => c.ns != null).map((c) =>
      `<line class="call ${c.kernels.length > 1 ? "graph" : ""}" x1="${x(c.ns)}" x2="${x(c.ns)}" y1="22" y2="40"><title>${escape(c.api)} → ${c.kernels.length} kernel(s)</title></line>`).join("");
    const rects = ks.map((k) => `<rect class="kern" data-id="${escape(k.id)}" x="${x(k.start_ns)}" y="94" width="${Math.max(0.6, x(k.end_ns) - x(k.start_ns))}" height="26"
      fill="${color(k)}" stroke="${k.attrs.graph_node ? "#e3b341" : "none"}"><title>${escape(k.name)} · layer ${k.attrs.layer ?? "–"} · ${ms(k.attrs.duration_us, 1)} µs${k.attrs.graph_node ? ` · graph node ${k.attrs.graph_node}` : ""}</title></rect>`).join("");
    const gaps = idle.filter(([p, q]) => q - p > 2000).map(([p, q]) => `<rect class="idle" x="${x(p)}" y="124" width="${Math.max(0.6, x(q) - x(p))}" height="8"><title>GPU idle ${ms((q - p) / 1e3, 1)} µs</title></rect>`).join("");
    const bands = [], seen = new Set();
    for (const k of ks) {
      const l = k.attrs.layer;
      if (l == null || seen.has(l)) continue;
      seen.add(l);
      const last = ks.filter((q) => q.attrs.layer === l).at(-1);
      bands.push(`<text class="band" x="${x(k.start_ns) + 1}" y="146">${l === maxLayer ? "head" : `L${l}`}</text><line class="bandline" x1="${x(k.start_ns)}" x2="${x(last.end_ns)}" y1="136" y2="136"/>`);
    }
    const apis = {};
    for (const c of calls.values()) apis[c.api] = (apis[c.api] ?? 0) + 1;
    const graphNodes = ks.filter((k) => k.attrs.graph_node).length;
    const step = this.run.spans.find((s) => s.component === "executor" && s.attrs.iteration === it && s.attrs.label);
    return `<div>${this.openButton(".nsys-rep", "nsys-ui")} the whole capture with GPU metrics rows (runs after 2026-11-03) ·
        this iteration is the NVTX range <code>${escape(step?.attrs.label ?? `_forward_step ${it - 1}`)}</code>
        ${this.opened ? `<span class="dim">· ${escape(this.opened)}</span>` : ""}</div>
      <div class="dim">iteration ${it} (pick another in the top bar) · ${ks.length} kernels, ${graphNodes} of them graph nodes ·
        ${calls.size} CPU launch calls: ${Object.entries(apis).map(([k, v]) => `${escape(k)} ×${v}`).join(", ")}<br>
        launch to last kernel ${ms((b - a) / 1e6, 3)} ms · GPU busy ${ms(busy / 1e6, 3)} ms · GPU idle between kernels ${ms(idleNs / 1e6, 3)} ms
        · layer from the RMSNorm heuristic; "head" = final norm, lm_head, sampling</div>
      <svg class="itergraph" viewBox="0 0 ${Wg} 152" preserveAspectRatio="none">
        <text class="lanelabel" x="2" y="16">CPU: launch calls</text>${ticks}${fan}
        <text class="lanelabel" x="2" y="88">GPU: kernels (gold edge = graph node)</text>${rects}${gaps}${bands.join("")}</svg>`;
  }

  // Nsight Compute: every kernel of the profiled iteration in launch order; width = replay duration,
  // up = DRAM % of peak, down = SM % of peak. Click one to pick it; its sections open in ncu-ui.
  kernelStrip(ncu) {
    const ks = [...ncu.kernels].sort((p, q) => p.id - q.id), Ws = 1200, total = ks.reduce((t, k) => t + (k.duration ?? 0), 0);
    let at = 0;
    const bars = ks.map((k) => {
      const w = ((k.duration ?? 0) / total) * Ws, x0 = at; at += w;
      const up = 0.5 * (k.dram_pct_of_peak ?? 0), down = 0.5 * (k.sm_pct_of_peak ?? 0);
      return `<g class="kbar ${this.kernel === k.id ? "on" : ""}" data-kernel="${k.id}"><rect class="hit" x="${x0}" y="0" width="${Math.max(w, 0.8)}" height="120"/>
        <rect class="dram" x="${x0}" y="${60 - up}" width="${Math.max(w - 0.3, 0.5)}" height="${up}"/>
        <rect class="sm" x="${x0}" y="60" width="${Math.max(w - 0.3, 0.5)}" height="${down}"/>
        ${k.findings ? `<circle class="finding" cx="${x0 + w / 2}" cy="4" r="2.5"/>` : ""}
        <title>#${k.id} layer ${k.layer ?? "–"} · ${escape(k.name.slice(0, 80))}
${ms(k.duration, 2)} µs · DRAM ${ms(k.dram_pct_of_peak, 0)} % · SM ${ms(k.sm_pct_of_peak, 0)} %${k.occupancy_achieved_pct != null ? ` · occupancy ${ms(k.occupancy_achieved_pct, 0)} %` : ""}${k.top_finding ? `
${escape(k.top_finding.name)}: ${escape(k.top_finding.description.slice(0, 160))}` : ""}</title></g>`;
    }).join("");
    return `<svg class="kstrip" viewBox="0 0 ${Ws} 120" preserveAspectRatio="none"><line class="axis" x1="0" x2="${Ws}" y1="60" y2="60"/>${bars}</svg>
      <div class="dim">launch order, width = duration under replay (${ms(total / 1000, 3)} ms in all) · blue up = DRAM % of peak ·
        green down = SM % of peak · dot = a rule finding with advice · CUDA graphs ${ncu.graphs === false ? "off" : ncu.graphs ? "on" : "–"}</div>
      ${this.kernelPick(ncu)}`;
  }

  // The picked kernel: where it sits in the run (layer, iteration, launch order) and where to read it in ncu-ui.
  kernelPick(ncu) {
    const k = ncu.kernels.find((q) => q.id === this.kernel);
    if (!k) return "<p class=dim>Click a kernel above or a row below to pick it.</p>";
    const finding = k.top_finding ? `<div>top rule finding: <b>${escape(k.top_finding.name)}</b>
      ${k.top_finding.speedup_pct != null ? `(estimated speedup ${ms(k.top_finding.speedup_pct, 1)} %)` : ""} · ${escape(k.top_finding.description)}</div>` : "";
    return `<div class="kdetail"><h3>#${k.id} · layer ${k.layer ?? "–"} · iteration ${escape(ncu.iteration)}</h3>
      <div class="dim" title="${escape(k.name)}">${escape(k.name.slice(0, 160))}</div>
      <div>grid ${escape(k.grid)} × block ${escape(k.block)} · ${ms(k.duration, 2)} µs · DRAM ${ms(k.dram_pct_of_peak, 0)} % · SM ${ms(k.sm_pct_of_peak, 0)} %
        ${k.occupancy_achieved_pct != null ? ` · occupancy ${ms(k.occupancy_achieved_pct, 0)} %` : ""}</div>${finding}
      <div>${this.openButton(".ncu-rep", "ncu-ui")} then pick ID ${k.id} in the Result list: Details for every section, Source for SASS</div></div>`;
  }

  render(state) {
    if (!this.runId) {
      const newest = Object.values(state.runs).sort((a, b) => b.mtime - a.mtime)[0];
      if (!newest) { this.root.innerHTML = "<p>No runs yet.</p>"; return; }
      this.runId = newest.run_id; this.load();
    }
    if (this.error) { this.root.innerHTML = `<p class="err">${escape(this.error)}</p>`; return; }
    if (!this.run) { this.root.innerHTML = `<p>Building ${escape(this.runId)} …</p>`; return; }
    this.files = state.runs[this.runId]?.files ?? [];
    if (!this.dirty && this.root.querySelector(".trace")) return; // live messages do not redraw a recording
    this.dirty = false;
    const steps = this.steps();
    const current = steps[this.step], previous = steps[this.step - 1];
    const labels = this.run.labels ?? {};
    const traced = labels.trace && labels.trace !== "off";
    const iterations = [...new Set(this.spans().map((s) => s.attrs.iteration).filter((x) => x != null))].sort((a, b) => a - b);
    const runs = Object.values(state.runs).sort((a, b) => b.mtime - a.mtime);
    this.root.innerHTML = `<div class="trace">
      ${traced ? `<div class="banner">TRACE=${escape(labels.trace)} run: ${labels.profiler === false ? "no profiler" : `profiled, iterations ${escape(labels.profile_range)}`}, CUDA graphs ${labels.graphs ? "on" : "off"}. Not a measured run.</div>` : ""}
      <div class="controls">
        <select class="run">${runs.map((r) => `<option ${r.run_id === this.runId ? "selected" : ""}>${escape(r.run_id)}</option>`).join("")}</select>
        <select class="request">${this.run.requests.map((r) => `<option ${r === this.request ? "selected" : ""}>${escape(r)}</option>`).join("")}</select>
        level <select class="level">${Object.keys(LEVELS).map((l) => `<option ${l === this.level ? "selected" : ""}>${l}</option>`).join("")}</select>
        ${iterations.length ? `iteration <select class="iteration"><option>all</option>${iterations.map((i) => `<option ${String(i) === this.iteration ? "selected" : ""}>${i}</option>`).join("")}</select>` : ""}
        <button class="first">⏮</button><button class="back">◀</button><button class="playb">${this.playing ? "⏸" : "▶ play"}</button>
        <button class="next">▶|</button><button class="last">⏭</button>
        speed <select class="speed">${[1, 5, 20, 100].map((v) => `<option ${v === this.speed ? "selected" : ""}>${v}</option>`).join("")}</select> steps/s
        · step ${steps.length ? this.step + 1 : 0} of ${steps.length}
        · time <button class="zin">zoom in</button><button class="zout">out</button><button class="fit">fit request</button>
      </div>
      ${this.map(current, previous)}
      ${this.lanes(this.spans(), current)}
      <details class="iterpanel" ${this.run.spans.some((s) => s.component === "gpu" && s.attrs?.launch) ? "open" : ""}><summary>one iteration: CPU launches → GPU kernels (Nsight Systems)</summary>${this.iterationGraph()}</details>
      <div class="tracebody"><section class="detail">${this.detail(current)}</section>
        <section class="side">
          <details open><summary>metrics as they are calculated</summary>${this.metrics()}</details>
          <details><summary>tokens: client events, records, wire frames</summary>${this.tokens()}</details>
          <details ${this.run.profiles?.ncu ? "open" : ""}><summary>kernels (Nsight Compute)</summary>${this.kernels()}</details>
          <details><summary>Unavailable (${this.run.unavailable.length})</summary>${json(this.run.unavailable)}</details>
          <details><summary>sources (${this.run.sources.length})</summary>${json(this.run.sources)}</details>
        </section></div></div>`;
    this.bind(steps);
  }

  bind(steps) {
    const $ = (q) => this.root.querySelector(q);
    $(".run").onchange = (e) => { location.hash = `trace/${encodeURIComponent(e.target.value)}`; };
    $(".request").onchange = (e) => { location.hash = `trace/${encodeURIComponent(this.runId)}/${encodeURIComponent(e.target.value)}`; };
    $(".level").onchange = (e) => { this.level = e.target.value; this.go(0); };
    if ($(".iteration")) $(".iteration").onchange = (e) => { this.iteration = e.target.value; this.go(0); };
    $(".speed").onchange = (e) => { this.speed = +e.target.value; if (this.playing) { this.play(); this.play(); } };
    $(".first").onclick = () => this.go(0);
    $(".back").onclick = () => this.go(this.step - 1);
    $(".next").onclick = () => this.go(this.step + 1);
    $(".last").onclick = () => this.go(steps.length - 1);
    $(".playb").onclick = () => this.play();
    $(".zin").onclick = () => this.zoom(0.25);
    $(".zout").onclick = () => this.zoom(4);
    $(".fit").onclick = () => { const s = this.step; this.reset(); this.step = s; this.dirty = true; this.redraw(); };
    $(".showraw").onclick = () => this.showRaw(steps[this.step]);
    this.root.querySelectorAll(".frame").forEach((a) => (a.onclick = (e) => { e.preventDefault(); this.showSource(a.dataset.frame); }));
    this.root.querySelectorAll(".tracelanes [data-id]").forEach((el) => (el.onclick = () => {
      let i = steps.findIndex((s) => s.id === el.dataset.id);
      if (i < 0) { this.level = Object.keys(LEVELS).find((l) => LEVELS[l](this.run.spans.find((s) => s.id === el.dataset.id))) ?? this.level; i = this.steps().findIndex((s) => s.id === el.dataset.id); }
      this.go(i);
    }));
    this.root.querySelectorAll("[data-m]").forEach((el) => (el.onclick = () => {
      const m = this.run.metrics.find((x) => x.name === el.dataset.m && x.request_id === this.request);
      this.metric = m.name; this.lit = new Set(m.inputs);
      this.level = "all but hardware";
      const all = this.steps(), i = all.findIndex((s) => this.lit.has(s.id));
      this.go(i < 0 ? this.step : i);
    }));
    this.root.querySelectorAll("tr[data-k]").forEach((tr) => (tr.onclick = () => this.showKernel(+tr.dataset.k)));
    this.root.querySelectorAll("[data-kernel]").forEach((g) => (g.onclick = () => this.showKernel(+g.dataset.kernel)));
    this.root.querySelectorAll("button.opentool").forEach((b) => (b.onclick = () => this.openReport(b.dataset.path)));
    this.root.querySelectorAll(".itergraph [data-id]").forEach((el) => (el.onclick = () => {
      this.level = "3 hardware and code";
      this.iteration = String(this.run.spans.find((s) => s.id === el.dataset.id)?.attrs.iteration ?? this.iteration);
      this.go(this.steps().findIndex((s) => s.id === el.dataset.id));
    }));
    document.onkeydown = (e) => {
      if (!this.root.querySelector(".trace") || e.target.tagName === "SELECT") return;
      if (e.key === "ArrowRight") this.go(this.step + 1);
      if (e.key === "ArrowLeft") this.go(this.step - 1);
    };
  }
}
