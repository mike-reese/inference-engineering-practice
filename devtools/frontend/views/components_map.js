// The component map: each container drawn as a boundary, the processes inside it, and each component that owns a
// step of the request, with the data moving between them. Shared by the Components tab (live) and Trace level
// "0b components" (a recorded run). A step is a live stamp ({box, data}) or a run.json span (attrs.box, or a client
// or wire span mapped by boxOf). Component names and owners match src/inference_analysis/trace/adapters/components.py.
import { escape, ms } from "./util.js";

export const W = 1400, H = 700;

// [id, label, owner, x, y, w, h]
export const BOXES = [
  ["locust", "Locust user", "locust · gevent", 30, 70, 230, 46],
  ["send_one", "send_one", "scripts/chat_client.py", 30, 132, 230, 46],
  ["sdk", "OpenAI SDK", "openai · chat.completions stream", 30, 194, 230, 46],
  ["transport", "HTTP transport", "httpx2 HTTPTransport + ObservedTransport", 30, 256, 230, 46],
  ["eth0", "bridge → eth0", "veth pair · tcpdump", 300, 256, 150, 46],
  ["asgi", "ASGI server", "uvicorn + ServerArrivalTimeMiddleware", 500, 76, 390, 40],
  ["validate", "request validation", "FastAPI + pydantic", 500, 134, 180, 40],
  ["parse", "message parsing", "TensorRT-LLM serve", 500, 184, 180, 40],
  ["template", "chat template", "HF tokenizer Jinja template", 500, 234, 180, 40],
  ["tokenizer", "tokenizer", "HF fast tokenizer encode", 500, 284, 180, 40],
  ["llm_api", "LLM API handoff", "GenerationExecutor.generate_async", 500, 334, 180, 40],
  ["proxy", "executor proxy", "GenerationExecutorProxy.submit", 500, 384, 180, 40],
  ["postprocess", "SSE post-processor", "chat_stream_post_processor", 710, 284, 180, 40],
  ["detokenize", "detokenizer", "HF decode_incrementally", 710, 334, 180, 40],
  ["ipc_req", "ZMQ request socket", "pyzmq · pickle", 540, 460, 150, 40],
  ["ipc_rsp", "ZMQ result socket", "pyzmq · pickle", 720, 460, 150, 40],
  ["worker", "worker submit", "BaseWorker → LlmRequest", 500, 540, 150, 40],
  ["fetch", "request queue", "ExecutorRequestQueue", 670, 540, 150, 40],
  ["scheduler", "scheduler", "capacity + micro-batch (C++)", 840, 540, 150, 40],
  ["kv_cache", "KV cache manager", "KVCacheManager (C++ blocks)", 840, 594, 150, 40],
  ["forward", "model forward", "PyTorchModelEngine · CUDA graphs", 1010, 540, 150, 40],
  ["sampler", "sampler", "TorchSampler", 1010, 594, 150, 40],
  ["update", "token update", "PyExecutor._update_requests", 1010, 648, 150, 40],
  ["responses", "responses", "PyExecutor._enqueue_responses", 840, 648, 150, 40],
  ["gpu", "GPU kernels", "RTX 5060 Ti · CUDA", 1220, 548, 160, 40],
  ["kvpool", "KV pool (VRAM)", "blocks of 32 tokens", 1220, 602, 160, 40],
];
export const BOX = Object.fromEntries(BOXES.map(([id, label, owner, x, y, w, h]) => [id, { id, label, owner, x, y, w, h }]));

// Boundaries: [key, label, x, y, w, h, kind]
export const BOUNDS = [
  ["client", "client container", 14, 30, 262, 290, "container"],
  ["network", "network ie-i02a-l1_default", 284, 226, 182, 96, "network"],
  ["server", "server container", 482, 30, 718, 668, "container"],
  ["http", "trtllm-serve process: HTTP, LLM API, proxy", 492, 52, 410, 380, "process"],
  ["zmq", "ZMQ over tcp://127.0.0.1 (between processes)", 524, 440, 362, 70, "ipc"],
  ["worker", "executor worker process (MPI-spawned): PyExecutor loop", 492, 518, 700, 176, "process"],
  ["host", "host GPU", 1208, 520, 184, 140, "gpu"],
];
export const CONTAINER_OF = { // the boundary a component sits in, for a drill-down from the Infrastructure tab
  locust: "client", send_one: "client", sdk: "client", transport: "client", eth0: "network", gpu: "host", kvpool: "host",
};

// The request's path, in order; [from, to] draws an arrow. The response path runs back up.
export const EDGES = [
  ["locust", "send_one"], ["send_one", "sdk"], ["sdk", "transport"], ["transport", "eth0"], ["eth0", "asgi"],
  ["asgi", "validate"], ["validate", "parse"], ["parse", "template"], ["template", "tokenizer"], ["tokenizer", "llm_api"],
  ["llm_api", "proxy"], ["proxy", "ipc_req"], ["ipc_req", "worker"], ["worker", "fetch"], ["fetch", "scheduler"],
  ["scheduler", "kv_cache"], ["kv_cache", "kvpool"], ["kv_cache", "forward"], ["forward", "gpu"], ["forward", "sampler"],
  ["sampler", "update"], ["update", "responses"], ["responses", "ipc_rsp"], ["ipc_rsp", "detokenize"],
  ["detokenize", "postprocess"], ["postprocess", "asgi"],
];

// A run.json span or a live stamp -> its component.
export function boxOf(s) {
  if (!s) return null;
  if (s.box) return s.box === "eth0" ? "eth0" : s.box;
  if (s.attrs?.box) return s.attrs.box;
  if (s.level === "network") return "eth0";
  if (s.level === "client") {
    if (s.component === "locust") return "locust";
    if (s.component === "transport") return "transport";
    return ["send", "protocol complete"].includes(s.name) ? "send_one" : "sdk";
  }
  if (s.level === "hardware") return s.component === "pcie" ? "kvpool" : "gpu";
  return null;
}

// What the request is, in this step: one short line for the packet and the box.
export function dataForm(box, d = {}, name = "") {
  const ids = (a) => (a ? `[${a.slice(0, 6).join(", ")}${a.length > 6 ? ", …" : ""}]` : "");
  const req = (d.requests ?? [])[0] ?? {};
  switch (box) {
    case "locust": return "a task: the request to send";
    case "send_one": return name === "send" ? `${d.messages?.length ?? "?"} messages, max_tokens ${d.max_tokens}` : `done: ${d.finish_reason ?? ""}`;
    case "sdk": return name === "HTTP request built" ? `POST ${d.body?.length ?? "?"} B JSON` : name.startsWith("SSE") ? `chunk: ${JSON.stringify(d.event?.choices?.[0]?.delta?.content ?? "")}` : name;
    case "transport": return name === "body read" ? `${d.bytes} B read` : name.replace("http11.", "");
    case "eth0": return `${d.direction ?? ""} · ${d.bytes ?? 0} B${name ? ` · ${name}` : ""}`;
    case "asgi": return name === "SSE frame sent" ? `SSE frame ${d.frame}: ${d.bytes} B` : name === "request body" ? `${d.bytes} B JSON body` : name;
    case "validate": return `ChatCompletionRequest · ${d.messages?.length ?? "?"} messages` + ("max_completion_tokens" in d ? `, max_completion_tokens ${d.max_completion_tokens}` : "");
    case "parse": return `conversation · ${d.conversation?.length ?? "?"} turns`;
    case "template": return `${d.characters} characters of templated text`;
    case "tokenizer": return `${d.count} token IDs ${ids(d.token_ids)}`;
    case "llm_api": return `prompt_token_ids ${d.count} ${ids(d.prompt_token_ids)}`;
    case "proxy": return `GenerationRequest · ${d.prompt_tokens} prompt tokens`;
    case "ipc_req": return name.includes("receive") ? `received in the worker` : `${d.pickled_bytes} B pickled`;
    case "worker": return `LlmRequest · ${d.prompt_token_ids?.length ?? "?"} prompt tokens`;
    case "fetch": return `${d.requests?.length ?? 0} new request(s) activated`;
    case "scheduler": return `context ${d.context?.length ?? 0}${d.context?.[0] ? ` (chunk ${d.context[0].chunk})` : ""} · generation ${d.generation?.length ?? 0} · paused ${d.paused?.length ?? 0}`;
    case "kv_cache": return name.includes("released") ? `released ${req.blocks?.length ?? 0} blocks` : `blocks ${ids(req.blocks)}${req.new_blocks?.length ? ` +${req.new_blocks.length} new` : ""} · ${d.free_blocks} free`;
    case "forward": return d.logits_shape ? `logits ${JSON.stringify(d.logits_shape)}` : `${d.context ?? 0} ctx + ${d.generation ?? 0} gen`;
    case "sampler": return "sampling on the GPU (async)";
    case "update": return `token ${req.last_token_id} appended (${req.num_tokens} tokens)`;
    case "responses": return `${d.requests?.length ?? 0} LlmResponse(s)`;
    case "ipc_rsp": return name.includes("receive") ? `responses received` : `${d.pickled_bytes ?? "?"} B pickled`;
    case "detokenize": return `${ids(d.new_token_ids)} → ${JSON.stringify(d.new_text ?? "")}`;
    case "postprocess": return `${d.events?.length ?? 0} SSE event(s)`;
    case "gpu": return name;
    default: return name;
  }
}

const center = (b) => [b.x + b.w / 2, b.y + b.h / 2];

// "64× · 95.668 ms in all"; instants (no duration) show the count only
export const statText = (s) => (!s?.n ? "" : s.ms > 0 ? `${s.n}× · ${ms(s.ms, 3)} ms in all` : `${s.n}× (instants)`);

// What a worker step drives on the GPU: lit beside it (the stamps are CPU-side; kernels are in profiled runs, level 3)
const DRIVES = { forward: "gpu", sampler: "gpu", kv_cache: "kvpool" };

// The static map. stats: box -> {n, ms, last}; focus: a boundary key to highlight (drill-down); labels: boundary
// key -> extra text (container name, image, pid).
export function mapSVG({ stats = {}, focus = null, labels = {}, on = null, prev = null } = {}) {
  const bounds = BOUNDS.map(([k, label, x, y, w, h, kind]) => `<g class="bound ${kind} ${focus && focus !== k && kind === "container" ? "dimmed" : ""} ${focus === k ? "focus" : ""}" data-bound="${k}">
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/>
    <text x="${x + 8}" y="${y + 15}">${escape(label)}${labels[k] ? ` · ${escape(labels[k])}` : ""}</text></g>`).join("");
  const edges = EDGES.map(([a, b]) => {
    const [x1, y1] = center(BOX[a]), [x2, y2] = center(BOX[b]);
    return `<line class="edge ${DRIVES[a] === b ? "drives" : ""}" data-edge="${a}>${b}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#cm-arrow)"/>`;
  }).join("");
  const boxes = BOXES.map(([id, label, owner, x, y, w, h]) => {
    const s = stats[id];
    const cls = `cbox ${id === on ? "on" : ""} ${id === prev && id !== on ? "prev" : ""} ${s?.n ? "seen" : ""}`;
    return `<g class="${cls}" data-box="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5"/>
      <text class="cl" x="${x + 6}" y="${y + 14}">${escape(label)}</text>
      <text class="co" x="${x + 6}" y="${y + 26}">${escape(owner)}</text>
      <text class="cs" x="${x + 6}" y="${y + h - 4}" data-stat="${id}">${statText(s)}</text>
      <title>${escape(label)} · ${escape(owner)}</title></g>`;
  }).join("");
  return `<svg class="compmap" viewBox="0 0 ${W} ${H}">
    <defs><marker id="cm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z"/></marker></defs>
    ${bounds}<g class="edges">${edges}</g>${boxes}<g class="packets"></g></svg>`;
}

// Move a packet from one component to another, with the data it carries; resolves when it lands.
export function packet(svg, from, to, label, duration = 320) {
  return new Promise((done) => {
    const a = BOX[from], b = BOX[to];
    if (!svg || !b) return done();
    const layer = svg.querySelector(".packets");
    layer.replaceChildren(); // a new step clears the previous packet at once
    const [x2, y2] = center(b), [x1, y1] = a ? center(a) : [x2, y2];
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "packet");
    g.innerHTML = `<circle r="7"/><text x="10" y="-9">${escape(label.slice(0, 70))}</text>`;
    layer.appendChild(g);
    const start = performance.now();
    const step = (t) => {
      const f = Math.min(1, (t - start) / duration), e = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
      g.setAttribute("transform", `translate(${x1 + (x2 - x1) * e},${y1 + (y2 - y1) * e})`);
      if (f < 1 && g.isConnected) requestAnimationFrame(step); else { g.remove(); done(); }
    };
    requestAnimationFrame(step);
  });
}

export function light(svg, box, prev) {
  svg?.querySelectorAll(".cbox").forEach((g) => {
    g.classList.toggle("on", g.dataset.box === box);
    g.classList.toggle("driven", g.dataset.box === DRIVES[box]);
    g.classList.toggle("prev", g.dataset.box === prev && prev !== box);
  });
  svg?.querySelectorAll(".edge").forEach((e) => e.classList.toggle("hot", e.dataset.edge === `${prev}>${box}` || e.dataset.edge === `${box}>${prev}`));
}

// The data a step carries, rendered for reading: token IDs as chips, text as text, scheduler and KV tables.
export function inspect(box, d = {}) {
  const chips = (a) => `<div class="chips">${a.map((t) => `<span>${escape(t)}</span>`).join("")}</div>`;
  const parts = [];
  for (const key of ["token_ids", "prompt_token_ids", "new_token_ids"]) {
    if (Array.isArray(d[key])) parts.push(`<div class="label">${key} (${d[key].length})</div>${chips(d[key])}`);
  }
  if (box === "template" && d.text) parts.push(`<div class="label">templated text (what the tokenizer reads)</div><pre class="payload">${escape(d.text)}</pre>`);
  for (const key of ["body", "new_text"]) if (typeof d[key] === "string") parts.push(`<div class="label">${key}</div><pre class="payload">${escape(d[key])}</pre>`);
  if (box === "eth0" || box === "asgi" || box === "transport") if (d.text) parts.push(`<div class="label">bytes as text</div><pre class="payload">${escape(d.text)}</pre>`);
  if (Array.isArray(d.events)) parts.push(`<div class="label">SSE events</div><pre class="payload">${escape(d.events.join(""))}</pre>`);
  if (box === "scheduler") {
    const row = (kind, list) => (list ?? []).map((r) => `<tr><td>${kind}</td><td>${r.cid}</td><td>${r.eid}</td><td>${escape(r.state)}</td>
      <td>${r.prompt_len}</td><td>${r.chunk ?? "–"}</td><td>${r.position ?? "–"}</td></tr>`).join("");
    parts.push(`<div class="label">scheduler decision · active ${d.active} · fitting ${d.num_fitting_requests} · max_batch_size ${d.max_batch_size} · max_num_tokens ${d.max_num_tokens}</div>
      <table class="sched"><tr><th>decision</th><th>cid</th><th>engine id</th><th>state</th><th>prompt</th><th>chunk</th><th>position</th></tr>
      ${row("context", d.context)}${row("generation", d.generation)}${row("paused", d.paused)}${row("not scheduled", d.not_scheduled)}</table>
      <div class="dim">The C++ scheduler returns its choice, not its reasons: "not scheduled" lists active requests it left out.</div>`);
  }
  if (box === "kv_cache") {
    parts.push((d.requests ?? []).map((r) => `<div class="label">request cid ${r.cid} (engine ${r.eid}) · ${r.tokens_in_cache ?? "–"} tokens · ${d.free_blocks} blocks free · ${d.tokens_per_block ?? 32} tokens per block</div>
      <div class="kvblocks">${(r.blocks ?? []).map((b) => `<span class="${(r.new_blocks ?? []).includes(b) ? "new" : ""}">${b}</span>`).join("")}</div>`).join(""));
  }
  return parts.join("");
}
