// The live state: one SSE connection to the backend plus the history fetches, folded into one shared object.
// Used by the v1 shell (app.js) and by the v2 scene's panels (prototypes/D5v2), so both read the same live feed.

const HISTORY = 120; // seconds of sparkline per series
const KEEP_LOG_LINES = 5000; // per container, in the browser
const KEEP_ENGINE_SAMPLES = 1800;
const KEEP_ITERATIONS = 20000; // per engine, as the backend keeps
const KEEP_STAMPS = 60000; // per run, as the backend keeps

export const state = {
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
  componentStamps: {}, // run id -> [stamp] in seq order (components collector: server, client, wire)
};

export function addStamps(runId, stamps) { // each once, in seq order (a batch can arrive twice on connect)
  const list = (state.componentStamps[runId] ??= []);
  const last = list.at(-1)?.seq ?? 0;
  const fresh = stamps.filter((s) => s.seq > last).sort((a, b) => a.seq - b.seq);
  list.push(...fresh);
  if (list.length > KEEP_STAMPS) list.splice(0, list.length - KEEP_STAMPS);
  // the view lists a request's steps in time order: the three sources arrive interleaved
  if (fresh.length) list.sort((a, b) => a.t0 - b.t0 || a.seq - b.seq);
}

function remember(name, value) {
  const series = (state.history[name] ??= []);
  series.push(value);
  if (series.length > HISTORY) series.shift();
}

function addIterations(id, iterations, readNs) { // in arrival order, each once (a batch can arrive twice on connect)
  const list = (state.engineIterations[id] ??= []);
  const last = list.at(-1)?.seq ?? 0;
  const fresh = iterations.filter((it) => it.seq > last);
  list.push(...fresh);
  if (list.length > KEEP_ITERATIONS) list.splice(0, list.length - KEEP_ITERATIONS);
  if (readNs) state.engineIterationReads[id] = { ns: readNs, count: iterations.length };
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
  if (topic === "component_stamps") addStamps(data.run_id, data.stamps);
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

let connected = false;
/** Open the live feed once. onChange runs after every change; onStatus gets "live" or "reconnecting". */
export function connect({ onChange = () => {}, onStatus = () => {} } = {}) {
  if (connected) return state;
  connected = true;
  // What happened before this page opened: GPU samples for the lifecycle lanes, engine counters for the charts.
  fetch("/api/gpu/history").then((r) => r.json()).then((samples) => {
    state.gpuHistory = [...samples, ...state.gpuHistory.filter((s) => s.ns > (samples.at(-1)?.ns ?? 0))];
    onChange();
  });
  fetch("/api/engine/iterations").then((r) => r.json()).then((byEngine) => {
    for (const [id, iterations] of Object.entries(byEngine)) {
      const live = state.engineIterations[id] ?? [];
      state.engineIterations[id] = [];
      addIterations(id, iterations, null);
      addIterations(id, live, null);
    }
    onChange();
  });
  fetch("/api/components").then((r) => r.json()).then((byRun) => {
    for (const [run, stamps] of Object.entries(byRun)) {
      const live = state.componentStamps[run] ?? [];
      state.componentStamps[run] = [];
      addStamps(run, stamps);
      addStamps(run, live);
    }
    onChange();
  });
  fetch("/api/engine/history").then((r) => r.json()).then((byEngine) => {
    for (const [id, samples] of Object.entries(byEngine)) {
      const live = state.engineMetrics[id] ?? [];
      state.engineMetrics[id] = [...samples, ...live.filter((s) => s.ns > (samples.at(-1)?.ns ?? 0))];
    }
    onChange();
  });
  const source = new EventSource("/api/live");
  source.onopen = () => onStatus("live");
  source.onerror = () => onStatus("reconnecting");
  source.onmessage = (event) => { apply(JSON.parse(event.data)); onChange(); };
  return state;
}
