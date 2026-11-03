// Trace view: one request of a recorded run, stepped through every level on one clock (CLOCK_MONOTONIC ns).
// Level 0 architecture (the map), 1 network (frames), 2a client, 2b server, 3 hardware and code (kernels, copies).
// One step control drives every level; the lanes show the same time window; metrics light their input spans.
import { escape, getJSON, json, ms } from "./util.js";

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
  }

  open(params, state) {
    const [run, request] = params;
    if (run && run !== this.runId) { this.runId = run; this.run = null; this.request = request ?? null; this.load(); }
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

  async showSass(kernel) {
    if (!kernel.sass_file) { this.source = { error: "no SASS exported for this kernel" }; }
    else {
      const text = await (await fetch(`/api/runs/${encodeURIComponent(this.runId)}/file?path=${encodeURIComponent(kernel.sass_file)}`)).text();
      this.source = { file: kernel.sass_file, sass: text };
    }
    this.dirty = true; this.redraw();
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
      ${this.source ? (this.source.sass ? `<pre class="source">${escape(this.source.sass.slice(0, 200000))}</pre>`
        : this.source.lines ? `<pre class="source">${this.source.lines.map((l, i) => {
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
    const rows = [...ncu.kernels].sort((a, b) => (b.dram_read_bytes ?? 0) - (a.dram_read_bytes ?? 0)).map((k) => `<tr data-k="${k.id}">
      <td>${k.id}</td><td>${k.layer ?? "–"}</td><td title="${escape(k.name)}">${escape(k.name.slice(0, 70))}</td><td>${escape(k.grid)} × ${escape(k.block)}</td>
      <td>${ms(k.duration, 2)}</td><td>${ms((k.dram_read_bytes ?? 0) / 1e6, 2)}</td><td>${ms((k.l2_bytes ?? 0) / 1e6, 2)}</td>
      <td>${ms(k.dram_pct_of_peak, 1)}</td><td>${ms(k.sm_pct_of_peak, 1)}</td></tr>`).join("");
    return `<div class="dim">iteration ${escape(ncu.iteration)} · ${ncu.kernels.length} kernels · DRAM read ${ms(ncu.dram_read_bytes / 1e6, 1)} MB · ${escape(ncu.note)}</div>
      <table class="ncu"><tr><th>id</th><th>layer</th><th>kernel</th><th>grid × block</th><th>µs</th><th>DRAM read MB</th><th>L2 MB</th>
      <th>DRAM % peak</th><th>SM % peak</th></tr>${rows}</table>`;
  }

  render(state) {
    if (!this.runId) {
      const newest = Object.values(state.runs).sort((a, b) => b.mtime - a.mtime)[0];
      if (!newest) { this.root.innerHTML = "<p>No runs yet.</p>"; return; }
      this.runId = newest.run_id; this.load();
    }
    if (this.error) { this.root.innerHTML = `<p class="err">${escape(this.error)}</p>`; return; }
    if (!this.run) { this.root.innerHTML = `<p>Building ${escape(this.runId)} …</p>`; return; }
    if (!this.dirty && this.root.querySelector(".trace")) return; // live messages do not redraw a recording
    this.dirty = false;
    const steps = this.steps();
    const current = steps[this.step], previous = steps[this.step - 1];
    const labels = this.run.labels ?? {};
    const traced = labels.trace && labels.trace !== "off";
    const iterations = [...new Set(this.spans().map((s) => s.attrs.iteration).filter((x) => x != null))].sort((a, b) => a - b);
    const runs = Object.values(state.runs).sort((a, b) => b.mtime - a.mtime);
    this.root.innerHTML = `<div class="trace">
      ${traced ? `<div class="banner">TRACE=${escape(labels.trace)} run: profiled, CUDA graphs ${labels.graphs ? "on" : "off"}, iterations ${escape(labels.profile_range)}. Not a measured run.</div>` : ""}
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
    this.root.querySelectorAll("tr[data-k]").forEach((tr) => (tr.onclick = () => this.showSass(this.run.profiles.ncu.kernels.find((k) => String(k.id) === tr.dataset.k))));
    document.onkeydown = (e) => {
      if (!this.root.querySelector(".trace") || e.target.tagName === "SELECT") return;
      if (e.key === "ArrowRight") this.go(this.step + 1);
      if (e.key === "ArrowLeft") this.go(this.step - 1);
    };
  }
}
