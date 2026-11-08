// Scratch data for the D11 prototypes (COMMAND_CENTER_DIMENSIONS.md). Not measured: one streamed request on a small
// Qwen-like model (2 of 24 layers drawn), three iterations (prefill, then two decode steps). Time is in µs from the
// request's send. Adds to D10: v1-style container cards with series, process colours, and the I02A metrics computed
// on this scratch timeline (with the measured run values beside them as reference).

export const LADDERS = {
  execution: ["request", "iteration", "phase", "layer", "module", "kernel"],
  hardware: ["system", "node", "device", "unit", "kernel traffic", "SM internals"],
  architecture: ["fleet", "node", "container", "process", "component", "software layer"],
};

/** Crossing dimensions lands on the aligned tier (section 2). Index = execution tier. */
export const ALIGN = [
  { execution: "request", hardware: "system", architecture: "container" },
  { execution: "iteration", hardware: "device", architecture: "process" },
  { execution: "phase", hardware: "device", architecture: "component" },
  { execution: "layer", hardware: "unit", architecture: "component" },
  { execution: "module", hardware: "unit", architecture: "component" },
  { execution: "kernel", hardware: "kernel traffic", architecture: "software layer" },
];

// ---------------- architecture things: fleet > node > container > process > component > software layer
export const ARCH = [
  { id: "fleet", tier: 0, name: "fleet (one host today; a cluster from I27)", parent: null },
  { id: "host", tier: 1, name: "host: MPG Z390M, i9-9900K, RTX 5060 Ti", parent: "fleet" },
  { id: "c.client", tier: 2, name: "client container", parent: "host" },
  { id: "c.net", tier: 2, name: "network ie-i02a_default", parent: "host" },
  { id: "c.server", tier: 2, name: "server container (trtllm-serve)", parent: "host" },
  { id: "c.capture", tier: 2, name: "capture sidecar (tcpdump)", parent: "host" },
  { id: "c.prometheus", tier: 2, name: "prometheus", parent: "host" },
  { id: "c.grafana", tier: 2, name: "grafana", parent: "host" },
  { id: "c.dcgm", tier: 2, name: "dcgm-exporter", parent: "host" },
  { id: "c.nodeexp", tier: 2, name: "node-exporter", parent: "host" },
  { id: "p.client", tier: 3, name: "client.py (OpenAI SDK)", parent: "c.client" },
  { id: "p.bridge", tier: 3, name: "bridge / veth", parent: "c.net" },
  { id: "p.http", tier: 3, name: "trtllm-serve: HTTP + LLM API", parent: "c.server" },
  { id: "p.worker", tier: 3, name: "executor worker (MPI-spawned)", parent: "c.server" },
  // v1's 26 components (devtools/frontend/views/components_map.js BOXES), same ids, labels and owners. Copied, not imported.
  ...[["locust", "Locust user", "locust · gevent", "p.client"], ["send_one", "send_one", "scripts/chat_client.py", "p.client"],
    ["sdk", "OpenAI SDK", "openai · chat.completions stream", "p.client"],
    ["transport", "HTTP transport", "httpx2 HTTPTransport + ObservedTransport", "p.client"],
    ["eth0", "bridge → eth0", "veth pair · tcpdump", "p.bridge"],
    ["asgi", "ASGI server", "uvicorn + ServerArrivalTimeMiddleware", "p.http"],
    ["validate", "request validation", "FastAPI + pydantic", "p.http"], ["parse", "message parsing", "TensorRT-LLM serve", "p.http"],
    ["template", "chat template", "HF tokenizer Jinja template", "p.http"], ["tokenizer", "tokenizer", "HF fast tokenizer encode", "p.http"],
    ["llm_api", "LLM API handoff", "GenerationExecutor.generate_async", "p.http"],
    ["proxy", "executor proxy", "GenerationExecutorProxy.submit", "p.http"],
    ["postprocess", "SSE post-processor", "chat_stream_post_processor", "p.http"],
    ["detokenize", "detokenizer", "HF decode_incrementally", "p.http"],
    ["ipc_req", "ZMQ request socket", "pyzmq · pickle", "p.http"], ["ipc_rsp", "ZMQ result socket", "pyzmq · pickle", "p.worker"],
    ["worker", "worker submit", "BaseWorker → LlmRequest", "p.worker"], ["fetch", "request queue", "ExecutorRequestQueue", "p.worker"],
    ["scheduler", "scheduler", "capacity + micro-batch (C++)", "p.worker"],
    ["kv_cache", "KV cache manager", "KVCacheManager (C++ blocks)", "p.worker"],
    ["forward", "model forward", "PyTorchModelEngine · CUDA graphs", "p.worker"], ["sampler", "sampler", "TorchSampler", "p.worker"],
    ["update", "token update", "PyExecutor._update_requests", "p.worker"],
    ["responses", "responses", "PyExecutor._enqueue_responses", "p.worker"],
    ["gpu", "GPU kernels", "RTX 5060 Ti · CUDA", "p.worker"], ["kvpool", "KV pool (VRAM)", "blocks of 32 tokens", "p.worker"]]
    .map(([id, name, owner, parent]) => ({ id: "b." + id, tier: 4, name, owner, parent })),
  { id: "sw.toolkit", tier: 5, name: "toolkit: TRT-LLM Python, PyTorch ops", parent: "b.forward" },
  { id: "sw.runtime", tier: 5, name: "runtime: CUDA runtime + driver", parent: "b.forward" },
  { id: "sw.device", tier: 5, name: "device code: cuBLAS / attention kernels", parent: "b.forward" },
];

// ---------------- hardware things: system > node > device > unit (> kernel traffic, SM internals are per kernel)
export const HW = [
  { id: "sys", tier: 0, name: "system: 1 node, 1 GPU", parent: null },
  { id: "board", tier: 1, name: "MSI MPG Z390M GAMING EDGE AC", parent: "sys" },
  { id: "cpu", tier: 2, kind: "cpu", name: "i9-9900K (8C/16T)", parent: "board" },
  { id: "ram", tier: 2, kind: "ram", name: "DDR4 62 GiB", parent: "board" },
  { id: "pcie", tier: 2, kind: "link", name: "PCIe gen 3 x8", parent: "board", ends: ["cpu", "gpu"] },
  { id: "dmi", tier: 2, kind: "link", name: "DMI 3.0 x4", parent: "board", ends: ["cpu", "nvme"] },
  { id: "nvme", tier: 2, kind: "nvme", name: "WD_BLACK SN7100", parent: "board" },
  { id: "nic", tier: 2, kind: "nic", name: "veth / eth0", parent: "board" },
  { id: "gpu", tier: 2, kind: "gpu", name: "RTX 5060 Ti (GB206)", parent: "board" },
  { id: "vram", tier: 2, kind: "vram", name: "GDDR7 16 GiB", parent: "gpu" },
  ...Array.from({ length: 8 }, (_, i) => ({ id: `core${i}`, tier: 3, kind: "core", name: `core ${i}`, parent: "cpu" })),
  { id: "l3", tier: 3, kind: "cache", name: "L3 16 MiB (missing: not collected)", parent: "cpu" },
  ...Array.from({ length: 36 }, (_, i) => ({ id: `sm${i}`, tier: 3, kind: "sm", name: `SM ${i}`, parent: "gpu" })),
  { id: "l2", tier: 3, kind: "cache", name: "L2 32 MiB", parent: "gpu" },
  ...Array.from({ length: 4 }, (_, i) => ({ id: `mc${i}`, tier: 3, kind: "mc", name: `memory controller ${i}`, parent: "gpu" })),
  { id: "ce0", tier: 3, kind: "copy", name: "copy engine 0", parent: "gpu" },
  { id: "ce1", tier: 3, kind: "copy", name: "copy engine 1", parent: "gpu" },
];

// ---------------- execution units
export const EXEC = []; // {id, tier, name, t0, t1, parent, comp, hw: [...], gpu?: {grid, sms, dramMB, l2MB, occ}, cpuT?}
export const TRANSFERS = []; // hardware / device stops: {id, t0, t1, from, to, bytes, what}
let n = 0;
// Flows: the logical jobs a request needs. They overlap in time: while the engine loop runs decode pass N+1,
// the HTTP process is still streaming token N back to the client. Each unit carries its flow.
export const FLOWS = [
  ["f.in", "request in: client to the engine queue"], ["f.prefill", "prefill: build the KV cache, first token"],
  ["f.decode", "decode loop: one token per pass"], ["f.out", "stream out: token back to the user"],
];
export const FLOW_COLOR = { "f.in": "#5aa9ff", "f.prefill": "#ff7b72", "f.decode": "#3fd0a0", "f.out": "#f778ba" };
let flow = null;
const add = (u) => (EXEC.push({ id: `e${n++}`, flow, ...u }), EXEC[EXEC.length - 1]);

const REQ = add({ tier: 0, name: "request: \"Why does decode slow down as the KV cache grows?\" (3 tokens drawn)", t0: 0, t1: 0, parent: null, comp: "b.sdk", hw: ["cpu", "nic", "gpu"] });
let t = 0;
const phase = (name, dur, comp, parent, hw = ["cpu"]) => { const u = add({ tier: 2, name, t0: t, t1: t + dur, parent, comp, hw }); t += dur; return u; };

flow = "f.in";
phase("Locust task: the request to send", 20, "b.locust", REQ.id);
phase("send_one: 2 messages, max_tokens 64", 30, "b.send_one", REQ.id);
phase("SDK builds the HTTP request", 40, "b.sdk", REQ.id);
phase("client send (SDK -> transport)", 120, "b.transport", REQ.id, ["cpu", "nic"]);
phase("network: request frame over the bridge", 60, "b.eth0", REQ.id, ["nic"]);
phase("ASGI receives, headers sent back early", 100, "b.asgi", REQ.id);
phase("request validation (ChatCompletionRequest)", 40, "b.validate", REQ.id);
phase("message parsing (2 turns)", 30, "b.parse", REQ.id);
phase("chat template (Jinja)", 200, "b.template", REQ.id);
phase("tokenize (34 tokens)", 200, "b.tokenizer", REQ.id);
phase("LLM API enqueue", 150, "b.llm_api", REQ.id);
phase("executor proxy submit", 40, "b.proxy", REQ.id);
phase("ZMQ request socket", 50, "b.ipc_req", REQ.id);
phase("worker submit (LlmRequest)", 40, "b.worker", REQ.id);

const MODULES = [ // name, kernels [name, durPrefill, durDecode, grid, kind]
  ["input RMSNorm", [["rmsnorm_kernel", 6, 3, 1, "mem"]]],
  ["QKV linear", [["sm90_gemm_bf16_128x64", 40, 9, 12, "gemm"]]],
  ["attention", [["fmha_prefill / xqa_decode", 55, 14, 14, "attn"], ["kv_cache_write", 8, 2, 4, "mem"]]],
  ["O linear", [["sm90_gemm_bf16_128x64", 28, 7, 7, "gemm"]]],
  ["post-attn RMSNorm", [["fused_add_rmsnorm", 6, 3, 1, "mem"]]],
  ["gate-up linear", [["sm90_gemm_bf16_256x128", 90, 22, 34, "gemm"]]],
  ["SiLU x mul", [["silu_and_mul", 10, 4, 18, "mem"]]],
  ["down linear", [["sm90_gemm_bf16_128x64", 70, 16, 9, "gemm"]]],
];

let outEnd = 0;
for (let it = 0; it < 3; it++) {
  const prefill = it === 0;
  flow = prefill ? "f.prefill" : "f.decode";
  const I = add({ tier: 1, name: prefill ? "iteration 1: prefill (24 tokens, KV built)" : `iteration ${it + 1}: decode (1 token)`, t0: t, t1: 0, parent: REQ.id, comp: "b.scheduler", hw: ["cpu", "gpu"] });
  phase("fetch new requests", 40, "b.fetch", I.id);
  phase(prefill ? "schedule: admit request, allocate 2 KV blocks" : "schedule: continue decode", 50, "b.scheduler", I.id);
  if (prefill) {
    const tr = { id: `x${TRANSFERS.length}`, flow, t0: t, t1: t + 25, from: "ram", to: "vram", bytes: 2304, what: "token ids + positions (HtoD)" };
    TRANSFERS.push(tr);
  } else {
    TRANSFERS.push({ id: `x${TRANSFERS.length}`, flow, t0: t, t1: t + 12, from: "ram", to: "vram", bytes: 512, what: "next token id (HtoD)" });
  }
  phase(prefill ? "KV cache: allocate 2 blocks" : "KV cache: append slot", 20, "b.kv_cache", I.id);
  const F = phase(prefill ? "model forward (prefill)" : "model forward (decode)", 0, "b.forward", I.id, ["cpu", "gpu"]);
  F.t0 = t;
  for (let L = 0; L < 2; L++) {
    const Lu = add({ tier: 3, name: `decoder layer ${L} of 24`, t0: t, t1: 0, parent: F.id, comp: "b.forward", hw: ["gpu"] });
    for (const [mname, kernels] of MODULES) {
      const M = add({ tier: 4, name: mname, t0: t, t1: 0, parent: Lu.id, comp: "b.forward", hw: ["cpu", "gpu"] });
      for (const [kname, dp, dd, grid, kind] of kernels) {
        const dur = prefill ? dp : dd;
        const sms = Math.min(36, grid);
        const weightMB = kind === "gemm" ? grid * 0.9 : 0.2;
        add({ tier: 5, name: kname, t0: t + 4, t1: t + 4 + dur, cpuT: t, parent: M.id, comp: "b.forward", hw: ["gpu", "vram", "l2"],
          gpu: { grid, sms, kind, dramMB: +(weightMB + (prefill ? 0.6 : 0.05)).toFixed(2), l2MB: +(weightMB * 1.4).toFixed(2), occ: kind === "gemm" ? 0.42 : 0.2, profiled: it === 1 },
          launch: "cudaLaunchKernelExC" });
        t += dur + 6;
      }
      M.t1 = t;
    }
    Lu.t1 = t;
  }
  const lm = add({ tier: 4, name: "LM head", t0: t, t1: 0, parent: F.id, comp: "b.forward", hw: ["cpu", "gpu"] });
  add({ tier: 5, name: "sm90_gemm_bf16_lm_head", t0: t + 4, t1: t + 4 + (prefill ? 60 : 30), cpuT: t, parent: lm.id, comp: "b.forward", hw: ["gpu", "vram", "l2"],
    gpu: { grid: 36, sms: 36, kind: "gemm", dramMB: 136, l2MB: 140, occ: 0.6, profiled: it === 1 }, launch: "cudaLaunchKernelExC" });
  t += prefill ? 70 : 40; lm.t1 = t; F.t1 = t;
  phase("sample (greedy) on GPU", 30, "b.sampler", I.id, ["gpu"]);
  TRANSFERS.push({ id: `x${TRANSFERS.length}`, flow, t0: t, t1: t + 10, from: "vram", to: "ram", bytes: 256, what: "sampled token (DtoH)" });
  phase("token update", 35, "b.update", I.id);
  I.t1 = t;
  // Stream out runs on its own clock: the worker hands the token off and starts the next pass at once.
  const loopT = t, loopFlow = flow; flow = "f.out";
  phase("responses -> ZMQ", 45, "b.responses", I.id);
  phase("ZMQ result socket", 30, "b.ipc_rsp", I.id);
  phase("detokenize", 50, "b.detokenize", I.id);
  phase("SSE post-processor: 1 event", 30, "b.postprocess", I.id);
  phase("ASGI sends the SSE frame", 20, "b.asgi", I.id);
  phase("network: SSE frame to the client", 50, "b.eth0", I.id, ["nic"]);
  phase("HTTP transport: body read", 20, "b.transport", I.id, ["cpu", "nic"]);
  phase("SDK yields the token", 60, "b.sdk", I.id);
  outEnd = t; t = loopT; flow = loopFlow;
}
t = Math.max(t, outEnd); flow = "f.out";
phase("send_one: protocol complete (done: length)", 10, "b.send_one", REQ.id);
REQ.t1 = t;
export const END = t;

// ---------------- samples: 100 µs state (never stops). Derived from what is running, scratch values.
export const SAMPLES = [];
for (let s = 0; s <= END; s += 100) {
  const k = EXEC.filter((u) => u.tier === 5 && u.t0 < s + 100 && u.t1 > s);
  const busy = k.reduce((a, u) => a + (Math.min(u.t1, s + 100) - Math.max(u.t0, s)), 0) / 100;
  const smAvg = k.length ? k.reduce((a, u) => a + u.gpu.sms, 0) / k.length : 0;
  SAMPLES.push({ t: s, smActive: Math.round(Math.min(1, busy) * smAvg), dram: Math.min(0.92, busy * (k.some((u) => u.gpu.kind === "gemm") ? 0.85 : 0.4)),
    pcie: TRANSFERS.some((x) => x.t0 < s + 100 && x.t1 > s) ? 0.03 : 0, gpuUtil: Math.min(1, busy), cpu: k.length ? 0.35 : 0.6, vramGiB: 9.4 });
}



// ---------------- process identity: one colour per process, used in every dimension (section 2)
export const PROCESS_COLOR = {
  "p.client": "#5aa9ff", "p.bridge": "#9aa7b8", "p.http": "#f2a541", "p.worker": "#3fd0a0",
};
/** The process a component box or execution unit belongs to. */
export const processOf = (id) => {
  const map = new Map(ARCH.map((a) => [a.id, a]));
  let x = map.get(id); while (x && x.tier > 3) x = map.get(x.parent); return x?.tier === 3 ? x.id : null;
};

// ---------------- v1-style container cards (Infrastructure view): docker state, cpu / mem / net series, GPU held.
// Series hold one value per 100 µs sample, scratch. In a real run these come from docker stats (about 1 s, live only).
const series = (f) => SAMPLES.map((s, i) => +f(s, i).toFixed(3));
const wobble = (i, a) => a * (0.5 + 0.5 * Math.sin(i * 1.7));
export const CONTAINERS = [
  { id: "c.client", project: "ie-i02a", service: "client", image: "ie-client:i01-l2", state: "running", health: "healthy",
    networks: ["ie-i02a_default"], memLimit: 2 * 2 ** 30,
    cpu: series((s, i) => 6 + wobble(i, 4)), mem: series(() => 182 * 2 ** 20), rx: series((s, i) => 900 + wobble(i, 600)), tx: series((s, i) => 300 + wobble(i, 200)) },
  { id: "c.server", project: "ie-i02a", service: "server", image: "ie-trtllm:1.2.1-nvml", state: "running", health: "healthy",
    networks: ["ie-i02a_default"], memLimit: 32 * 2 ** 30,
    cpu: series((s) => 100 * (s.cpu + 0.4)), mem: series(() => 5.1 * 2 ** 30), rx: series((s, i) => 400 + wobble(i, 300)), tx: series((s, i) => 1200 + wobble(i, 900)),
    gpu: { mib: 9626, program: "python3 (executor worker)", pid: 412, util: series((s) => 100 * s.gpuUtil), vramGiB: series((s) => s.vramGiB) } },
  { id: "c.capture", project: "ie-i02a", service: "capture", image: "ie-capture:tcpdump-4.99.4", state: "running", health: null,
    sharesNetnsWith: "c.server", memLimit: 512 * 2 ** 20, cpu: series((s, i) => 1 + wobble(i, 1)), mem: series(() => 14 * 2 ** 20) },
  { id: "c.prometheus", project: "ie-tools", service: "prometheus", image: "prom/prometheus:v3", state: "running", health: "healthy",
    networks: ["ie-tools"], memLimit: 1 * 2 ** 30, cpu: series((s, i) => 2 + wobble(i, 1.5)), mem: series(() => 210 * 2 ** 20) },
  { id: "c.grafana", project: "ie-tools", service: "grafana", image: "grafana/grafana:11", state: "running", health: "healthy",
    networks: ["ie-tools"], memLimit: 1 * 2 ** 30, cpu: series((s, i) => 1 + wobble(i, 0.8)), mem: series(() => 160 * 2 ** 20) },
  { id: "c.dcgm", project: "ie-tools", service: "dcgm-exporter", image: "nvidia/dcgm-exporter:4", state: "running", health: "healthy",
    networks: ["ie-tools"], memLimit: 512 * 2 ** 20, cpu: series((s, i) => 3 + wobble(i, 1)), mem: series(() => 90 * 2 ** 20) },
  { id: "c.nodeexp", project: "ie-tools", service: "node-exporter", image: "prom/node-exporter:v1", state: "running", health: null,
    networks: ["host"], memLimit: 256 * 2 ** 20, cpu: series((s, i) => 0.5 + wobble(i, 0.4)), mem: series(() => 22 * 2 ** 20) },
];

// ---------------- payloads per phase: what the v1 Trace detail showed for a step (scratch, I02A request shape)
export const PAYLOADS = {
  "b.transport": { body: '{"model":"Qwen2.5-0.5B-Instruct","messages":[{"role":"system","content":"You are a concise assistant for an inference team."},{"role":"user","content":"Why does decode slow down as the KV cache grows?"}],"max_tokens":64,"stream":true}', bytes: 412 },
  "b.eth0": { direction: "client -> server", bytes: 566, frame: "TCP PSH 566 B" },
  "b.asgi": { headers: "HTTP/1.1 200 OK\ncontent-type: text/event-stream", bytes: 118 },
  "b.template": { text: "<|im_start|>system\nYou are a concise assistant for an inference team.<|im_end|>\n<|im_start|>user\nWhy does decode slow down as the KV cache grows?<|im_end|>\n<|im_start|>assistant\n" },
  "b.tokenizer": { prompt_token_ids: [151644, 8948, 198, 2610, 525, 264, 63594, 17847, 369, 458, 44378, 2083, 13, 151645, 198, 151644, 872, 198, 10234, 1558, 16895, 6301, 1495, 438, 279, 84648] },
  "b.llm_api": { request_id: 3, sampling: { temperature: 0, max_tokens: 64, seed: 0 } },
  "b.ipc_req": { bytes: 1840, frame: "ZMQ multipart: request + sampling params" },
  "b.scheduler": { table: [{ cid: 3, state: "GENERATION_IN_PROGRESS", prompt_len: 34, kv_blocks: 2 }] },
  "b.sampler": { new_token_ids: [1576] },
  "b.detokenize": { new_text: " Because" },
  "b.postprocess": { events: ['data: {"choices":[{"delta":{"content":" Because"}}]}\n\n'] },
  "b.sdk": { event: { choices: [{ delta: { content: " Because" } }] } },
};

// ---------------- the rep's metrics (I02A), computed on this scratch timeline. Each lights its input units.
const P = EXEC.filter((u) => u.tier === 2);
const first = (re) => P.find((u) => re.test(u.name));
const all = (re) => P.filter((u) => re.test(u.name));
const yields = all(/^SDK yields the token/), frames = all(/^network: SSE frame/), samples_ = all(/^sample \(greedy\)/);
const enqueue = first(/^LLM API enqueue/), sched = first(/^schedule:/), fwd = first(/^model forward \(prefill\)/);
const REQU = EXEC.find((u) => u.tier === 0);
const m = (id, name, value, clock, formula, inputs, ref) => ({ id, name, value, clock, formula, inputs: inputs.map((u) => u.id), ref });
export const METRICS = [
  m("ttft.client", "TTFT, client", yields[0].t1 - REQU.t0, "client", "first token event - send", [REQU, yields[0]], { ms: 35.564, src: "client record" }),
  m("ttft.wire", "TTFT, wire", frames[0].t0 - REQU.t0, "wire", "first SSE frame on eth0 - send", [REQU, frames[0]], { ms: 34.910, src: "pcap" }),
  m("ttft.engine", "TTFT, engine", samples_[0].t1 - enqueue.t0, "engine", "first_token_time - arrival_time", [enqueue, samples_[0]], { ms: 29.478, src: "/perf_metrics" }),
  m("queue", "Queue", sched.t0 - enqueue.t0, "engine", "first_scheduled_time - arrival_time", [enqueue, sched], { ms: 2.169, src: "/perf_metrics" }),
  m("prefill", "Prefill forward", fwd.t1 - fwd.t0, "engine", "model forward (prefill) span", [fwd], { ms: 27.309, src: "/perf_metrics (TTFT - queue)" }),
  m("itl.client", "Mean ITL, client", (yields.at(-1).t1 - yields[0].t1) / (yields.length - 1), "client", "(last token - first token) / (tokens - 1)", yields, { ms: 4.531, src: "client record" }),
  m("e2e.client", "End-to-end, client", REQU.t1 - REQU.t0, "client", "[DONE] - send", [REQU], { ms: 321.604, src: "client record" }),
];
export const REFERENCE_RUN = "I02A_20261103T164324Z_348959";

/** The flows a component box takes part in, in FLOWS order (a box can serve more than one flow). */
export const flowsOf = (comp) => FLOWS.map(([f]) => f).filter((f) => EXEC.some((u) => u.tier === 2 && u.comp === comp && u.flow === f));

export const byId = new Map([...EXEC, ...ARCH, ...HW, ...TRANSFERS].map((x) => [x.id, x]));
