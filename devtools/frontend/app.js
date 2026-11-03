// The shell: one live connection, one shared state, the active view redraws from it.
import { CompareView } from "./views/compare.js";
import { EngineView } from "./views/engine.js";
import { InfraView } from "./views/infra.js";
import { LifecycleView } from "./views/lifecycle.js";
import { LogsView } from "./views/logs.js";
import { MetricsView } from "./views/metrics.js";
import { RequestsView } from "./views/requests.js";
import { RunView } from "./views/run.js";
import { RunsView } from "./views/runs.js";
import { TraceView } from "./views/trace.js";
import { ToolsView } from "./views/tools.js";

const HISTORY = 120; // seconds of sparkline per series
const KEEP_LOG_LINES = 5000; // per container, in the browser
const KEEP_ENGINE_SAMPLES = 1800;
const KEEP_ITERATIONS = 20000; // per engine, as the backend keeps

const state = {
  containers: [],
  stats: {},        // container id -> latest usage
  gpu: null,        // latest nvidia-smi sample
  gpuProcesses: [], // who holds GPU memory
  gpuHistory: [],   // every GPU sample with its wall-clock ns, for the lifecycle lanes
  events: [],       // newest last
  history: {},      // series name -> last HISTORY values
  logs: {},         // container id -> [{ns, stream, line}]
  lifecycles: {},   // container id -> {container, project, marks}
  logSources: [],   // containers whose logs the backend holds, running or not, newest first
  engineMetrics: {}, // container id -> [{ns, metrics}]
  engineInfo: {},   // container id -> version, model, command, config, iter_stats
  engineIterations: {},     // container id -> [iteration] (engine iteration stats, live runs)
  engineIterationReads: {}, // container id -> {ns, count}: the newest /metrics batch
  requests: {},     // request id -> its summary as it lands (records collector)
  runs: {},         // run id -> run folder summary
};

function remember(name, value) {
  const series = (state.history[name] ??= []);
  series.push(value);
  if (series.length > HISTORY) series.shift();
}

function apply(message) {
  const { topic, key, data } = message;
  if (topic === "containers") state.containers = data;
  if (topic === "stats") {
    state.stats[key] = data;
    remember(`cpu:${key}`, data.cpu_pct);
  }
  if (topic === "gpu_processes") state.gpuProcesses = data;
  if (topic === "event") state.events = [...state.events.slice(-199), { ...data, wall_ns: message.wall_ns }];
  if (topic === "lifecycle") state.lifecycles[key] = data;
  if (topic === "log_sources") state.logSources = data;
  if (topic === "log") {
    const lines = (state.logs[key] ??= []);
    lines.push(data);
    if (lines.length > KEEP_LOG_LINES) lines.shift();
  }
  if (topic === "engine_metrics") {
    const samples = (state.engineMetrics[key] ??= []);
    if (!samples.length || samples.at(-1).ns < data.ns) samples.push({ ns: data.ns, metrics: data.metrics });
    if (samples.length > KEEP_ENGINE_SAMPLES) samples.shift();
  }
  if (topic === "engine_info") state.engineInfo[key] = data;
  if (topic === "engine_iterations") addIterations(key, data.iterations, data.read_ns);
  if (message.removed) {  // a run folder was deleted: drop it and its requests
    if (topic === "run") delete state.runs[key];
    if (topic === "request") delete state.requests[key];
  }
  else if (topic === "request") state.requests[key] = data;
  if (topic === "run" && !message.removed) state.runs[key] = data;
  if (topic === "gpu") {
    state.gpu = data;
    state.gpuHistory.push({ ns: message.wall_ns, ...data });
    for (const name of ["memory.used", "sm_busy_pct", "mem_busy_pct", "power.draw", "pcie_rx_mb_s"]) {
      remember(name, data[name]);
    }
  }
}

function addIterations(id, iterations, readNs) { // in arrival order, each once (a batch can arrive twice on connect)
  const list = (state.engineIterations[id] ??= []);
  const last = list.at(-1)?.seq ?? 0;
  const fresh = iterations.filter((it) => it.seq > last);
  list.push(...fresh);
  if (list.length > KEEP_ITERATIONS) list.splice(0, list.length - KEEP_ITERATIONS);
  if (readNs) state.engineIterationReads[id] = { ns: readNs, count: iterations.length };
}

const root = document.getElementById("view");
const views = {
  infra: new InfraView(root), engine: new EngineView(root), lifecycle: new LifecycleView(root), logs: new LogsView(root),
  metrics: new MetricsView(root), requests: new RequestsView(root), runs: new RunsView(root),
  trace: new TraceView(root), tools: new ToolsView(root), run: new RunView(root), compare: new CompareView(root),
};
let active = "infra";
let pending = false;
function redraw() { // at most once per animation frame, however many messages arrive
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; views[active].render(state); });
}

function open(hash) { // a tab; the URL keeps it (#trace/<run>/<request>), so a link or a reload lands on the same view
  const [name, ...params] = hash.split("/").map(decodeURIComponent);
  active = name in views ? name : "infra";
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === active));
  root.innerHTML = "";
  views[active].open?.(params, state);
  redraw();
}
for (const button of document.querySelectorAll("#tabs button")) {
  button.onclick = () => { location.hash = button.dataset.view; };
}
window.onhashchange = () => open(location.hash.slice(1));
for (const view of Object.values(views)) view.redraw = redraw; // views redraw after their own fetches
open(location.hash.slice(1));

// What happened before this tab opened: GPU samples for the lifecycle lanes, engine counters for the charts.
fetch("/api/gpu/history").then((r) => r.json()).then((samples) => {
  state.gpuHistory = [...samples, ...state.gpuHistory.filter((s) => s.ns > (samples.at(-1)?.ns ?? 0))];
  redraw();
});
fetch("/api/engine/iterations").then((r) => r.json()).then((byEngine) => {
  for (const [id, iterations] of Object.entries(byEngine)) {
    const live = state.engineIterations[id] ?? [];
    state.engineIterations[id] = [];
    addIterations(id, iterations, null);
    addIterations(id, live, null);
  }
  redraw();
});
fetch("/api/engine/history").then((r) => r.json()).then((byEngine) => {
  for (const [id, samples] of Object.entries(byEngine)) {
    const live = state.engineMetrics[id] ?? [];
    state.engineMetrics[id] = [...samples, ...live.filter((s) => s.ns > (samples.at(-1)?.ns ?? 0))];
  }
  redraw();
});

const link = document.getElementById("link");
const source = new EventSource("/api/live");
source.onopen = () => { link.textContent = "live"; link.className = "link live"; };
source.onerror = () => { link.textContent = "reconnecting"; link.className = "link down"; };
source.onmessage = (event) => { apply(JSON.parse(event.data)); redraw(); };
window.devtools = { state, views, ready: () => document.readyState === "complete" }; // for iectl snapshot
