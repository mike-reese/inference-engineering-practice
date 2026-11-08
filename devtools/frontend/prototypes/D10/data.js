// Scratch data for the D10 layout prototypes (COMMAND_CENTER_DIMENSIONS.md). Not measured: one streamed request on a
// small Qwen-like model (2 of 24 layers drawn), three iterations (prefill, then two decode steps). Time is in µs from
// the request's send. Shapes follow the design: three ladders, execution units, hardware and architecture things,
// transfers, and 100 µs samples (state, never stops).

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
  { id: "p.client", tier: 3, name: "client.py (OpenAI SDK)", parent: "c.client" },
  { id: "p.bridge", tier: 3, name: "bridge / veth", parent: "c.net" },
  { id: "p.http", tier: 3, name: "trtllm-serve: HTTP + LLM API", parent: "c.server" },
  { id: "p.worker", tier: 3, name: "executor worker (MPI-spawned)", parent: "c.server" },
  ...[["sdk", "OpenAI SDK", "p.client"], ["transport", "HTTP transport", "p.client"], ["eth0", "bridge -> eth0", "p.bridge"],
    ["asgi", "ASGI server", "p.http"], ["tokenizer", "chat template + tokenizer", "p.http"], ["llm_api", "LLM API", "p.http"],
    ["ipc", "ZMQ IPC", "p.http"], ["detok", "detokenize + SSE", "p.http"],
    ["fetch", "fetch requests", "p.worker"], ["scheduler", "scheduler", "p.worker"], ["forward", "model forward", "p.worker"],
    ["kv", "KV cache manager", "p.worker"], ["sampler", "sampler", "p.worker"], ["responses", "responses", "p.worker"]]
    .map(([id, name, parent]) => ({ id: "b." + id, tier: 4, name, parent })),
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
const add = (u) => (EXEC.push({ id: `e${n++}`, ...u }), EXEC[EXEC.length - 1]);

const REQ = add({ tier: 0, name: "request: \"Why does decode slow down as the KV cache grows?\" (3 tokens drawn)", t0: 0, t1: 0, parent: null, comp: "b.sdk", hw: ["cpu", "nic", "gpu"] });
let t = 0;
const phase = (name, dur, comp, parent, hw = ["cpu"]) => { const u = add({ tier: 2, name, t0: t, t1: t + dur, parent, comp, hw }); t += dur; return u; };

phase("client send (SDK -> transport)", 120, "b.transport", REQ.id, ["cpu", "nic"]);
phase("network: request frame over the bridge", 60, "b.eth0", REQ.id, ["nic"]);
phase("ASGI receives, headers sent back early", 180, "b.asgi", REQ.id);
phase("chat template + tokenize (24 tokens)", 400, "b.tokenizer", REQ.id);
phase("LLM API enqueue", 150, "b.llm_api", REQ.id);
phase("ZMQ IPC to the worker", 90, "b.ipc", REQ.id);

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

for (let it = 0; it < 3; it++) {
  const prefill = it === 0;
  const I = add({ tier: 1, name: prefill ? "iteration 1: prefill (24 tokens, KV built)" : `iteration ${it + 1}: decode (1 token)`, t0: t, t1: 0, parent: REQ.id, comp: "b.scheduler", hw: ["cpu", "gpu"] });
  phase("fetch new requests", 40, "b.fetch", I.id);
  phase(prefill ? "schedule: admit request, allocate 2 KV blocks" : "schedule: continue decode", 50, "b.scheduler", I.id);
  if (prefill) {
    const tr = { id: `x${TRANSFERS.length}`, t0: t, t1: t + 25, from: "ram", to: "vram", bytes: 2304, what: "token ids + positions (HtoD)" };
    TRANSFERS.push(tr);
  } else {
    TRANSFERS.push({ id: `x${TRANSFERS.length}`, t0: t, t1: t + 12, from: "ram", to: "vram", bytes: 512, what: "next token id (HtoD)" });
  }
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
  TRANSFERS.push({ id: `x${TRANSFERS.length}`, t0: t, t1: t + 10, from: "vram", to: "ram", bytes: 256, what: "sampled token (DtoH)" });
  phase("update request state + KV append", 35, "b.kv", I.id);
  phase("responses -> ZMQ", 45, "b.responses", I.id);
  phase("detokenize + SSE token event", 80, "b.detok", I.id);
  phase("network: SSE frame to the client", 50, "b.eth0", I.id, ["nic"]);
  phase("SDK yields the token", 60, "b.sdk", I.id);
  I.t1 = t;
}
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

export const byId = new Map([...EXEC, ...ARCH, ...HW, ...TRANSFERS].map((x) => [x.id, x]));
