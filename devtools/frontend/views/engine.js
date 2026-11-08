// Engine view: what the engine's scheduler did each iteration (one forward pass), as the iterations arrive.
// Source: TensorRT-LLM's /metrics (IterationStats), read by the engine collector from engines started with
// enable_iter_perf_stats (a rep's Live action). The engine hands iterations over in ~2 s batches, every one included.
// Step time = start of this iteration to start of the next (the stats' timestamps). It matched the engine's mean ITL
// (3.99 ms against 4.06 ms, run I02A-TRACE-live_20261103T185133Z_55cd9f); iterLatencyMS spans ~2 steps (overlap).
import { escape, ms } from "./util.js";

const W = 1200;
const PHASE_COLOR = { prefill: "#d29922", decode: "#58a6ff", mixed: "#bc8cff", idle: "#555c6a" };
const WINDOWS = [100, 300, 1000, "all"];
const OVER = 5; // a step longer than OVER x the window's median is drawn capped (hatched), its value on hover

export function phase(it) {
  if (it.context_requests > 0 && it.generation_requests > 0) return "mixed";
  if (it.context_requests > 0) return "prefill";
  if (it.generation_requests > 0) return "decode";
  return "idle";
}

const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

export class EngineView {
  constructor(root) {
    this.root = root;
    this.selected = null;
    this.follow = true;   // keep the window on the newest iteration
    this.end = null;      // index one past the window's last iteration when not following
    this.size = 300;
    this.picked = null;   // seq of the iteration under the mouse, or held by a click
    this.held = false;
  }

  engines(state) { // containers that have iterations, or are running with iteration stats
    const ids = new Set([...Object.keys(state.engineIterations),
      ...Object.entries(state.engineInfo).filter(([, i]) => i.iter_stats).map(([id]) => id)]);
    return [...ids];
  }

  render(state) {
    if (!this.root.querySelector(".engineview")) {
      this.root.innerHTML = `<div class="engineview"><div class="picker"></div><div class="status dim"></div>
        <div class="now"></div><div class="enginecontrols"></div><div class="chart"></div><div class="legend dim"></div></div>`;
    }
    const $ = (q) => this.root.querySelector(q);
    const ids = this.engines(state);
    const names = Object.fromEntries(state.containers.map((c) => [c.id, `${c.project}/${c.service}`]));
    const running = (id) => state.containers.some((c) => c.id === id && c.state === "running");
    const plain = Object.entries(state.engineInfo).filter(([id, i]) => !i.iter_stats && running(id));
    if (!ids.length) {
      $(".picker").innerHTML = `<p>No engine with iteration stats yet. Start a rep's <b>Live (engine iteration stats)</b>
        action in the Run tab: it adds <code>enable_iter_perf_stats: true</code> to the engine's config.yaml, and this view
        fills as the engine works.</p>${plain.length ? `<p class="dim">Running without iteration stats: ${plain.map(([id]) =>
        escape(names[id] ?? id)).join(", ")} (a measured or traced run: its config leaves them off).</p>` : ""}`;
      for (const q of [".status", ".now", ".enginecontrols", ".chart", ".legend"]) $(q).innerHTML = "";
      return;
    }
    if (!ids.includes(this.selected)) { this.selected = ids.find(running) ?? ids.at(-1); this.picked = null; this.held = false; }
    $(".picker").innerHTML = ids.map((id) => `<button data-id="${id}" class="${id === this.selected ? "on" : ""}">
      ${escape(names[id] ?? state.engineInfo[id]?.container ?? id.slice(0, 12))}${running(id) ? "" : " (stopped)"}</button>`).join("");
    $(".picker").querySelectorAll("button").forEach((b) => (b.onclick = () => {
      this.selected = b.dataset.id; this.picked = null; this.held = false; this.follow = true; this.render(state);
    }));

    const all = state.engineIterations[this.selected] ?? [];
    const read = state.engineIterationReads[this.selected];
    $(".status").innerHTML = `${all.length} iterations · ${read ? `last batch ${((Date.now() * 1e6 - read.ns) / 1e9).toFixed(1)} s ago,
      ${read.count} iteration(s) in it` : "no batch yet"} · the engine hands iterations over in ~2 s batches
      (its /metrics waits 2 s per read), so the newest step shows up to ~2 s late`;
    if (!all.length) {
      $(".now").innerHTML = "<p>Waiting for the first iterations: send a request (the Live action does).</p>";
      for (const q of [".enginecontrols", ".chart", ".legend"]) $(q).innerHTML = "";
      return;
    }
    const n = this.size === "all" ? all.length : this.size;
    const end = this.follow ? all.length : Math.min(all.length, Math.max(n, this.end ?? all.length));
    const start = Math.max(0, end - n);
    // step time: this iteration's start to the next one's; the newest has none yet
    const shown = all.slice(start, end).map((it, i) => {
      const next = all[start + i + 1];
      return { ...it, step_ms: next ? (next.ns - it.ns) / 1e6 : null };
    });
    this.drawNow(shown);
    this.drawControls(state, all.length, end, n);
    this.drawChart(shown);
    $(".legend").innerHTML = `bars: one iteration each, left to right · height = step time, from this iteration's start
      to the next one's (includes any wait for work) ·
      <span style="color:${PHASE_COLOR.prefill}">prefill</span> (prompt tokens) ·
      <span style="color:${PHASE_COLOR.decode}">decode</span> (one token per generation request) ·
      <span style="color:${PHASE_COLOR.mixed}">mixed</span> (both in one batch) ·
      hatched = over ${OVER}× the window's median, drawn capped (hover for its value) · outlined = the newest, no next start yet ·
      hover for one iteration, click to hold it`;
  }

  drawNow(shown) {
    const it = shown.find((x) => x.seq === this.picked) ?? shown.at(-1);
    const decode = median(shown.filter((x) => phase(x) === "decode").map((x) => x.step_ms));
    const tpb = it.tokens_per_block ?? 0, used = it.kv_used_blocks ?? 0, max = it.kv_max_blocks ?? 0;
    const p = phase(it);
    this.root.querySelector(".now").innerHTML = `<div class="nowcard">
      <h3>iteration ${it.seq} · <span style="color:${PHASE_COLOR[p]}">${p}</span> ·
        step ${it.step_ms == null ? "– (no next start yet)" : `${ms(it.step_ms, 3)} ms`}</h3>
      <div class="dim">step = this start to the next start · the engine's own iterLatencyMS ${ms(it.latency_ms, 3)} ms spans about two
        steps (the overlap scheduler records a step after launching the next) · engine counter ${it.iter}</div>
      <div><b>batch:</b> ${it.scheduled} scheduled = ${it.context_requests} context request(s), ${it.context_tokens} prompt tokens
        + ${it.generation_requests} generation request(s), one token each · paused ${it.paused}</div>
      <div><b>requests:</b> ${it.active} active of max ${it.max_active} · ${it.new_active} admitted this step
        · ${it.queued} queued · ${it.completed} completed this step</div>
      <div class="dim">raw engine accumulator <code>newActiveRequestsQueueLatencyMS</code> = ${escape(it.queue_latency_ms ?? "–")}
        · not an elapsed wait: TensorRT-LLM 1.2.1 adds <code>time.time()</code> differences in seconds with <code>+=</code>
        despite the MS suffix (<code>executor_request_queue.py:643–654</code>); shown as returned, not converted</div>
      <div><b>KV cache:</b> ${used} of ${max} blocks used (${used * tpb} token slots of ${max * tpb}; ${tpb} tokens per block) ·
        ${it.kv_new_blocks} blocks allocated, ${it.kv_reused_blocks} reused since start (hit rate ${ms(it.kv_hit_rate, 2)})
        <div class="kvbar"><span style="width:${max ? Math.max(0.3, (100 * used) / max) : 0}%"></span></div></div>
      <div class="dim">GPU memory held by the engine process ${ms((it.gpu_mem_bytes ?? 0) / 2 ** 30, 2)} GiB ·
        median decode step in this window ${ms(decode, 3)} ms${decode ? ` (≈ ${ms(1000 / decode, 0)} tokens/s per generation request)` : ""}
        · started ${new Date(it.ns / 1e6).toISOString().slice(11, 23)} UTC</div></div>`;
  }

  drawControls(state, total, end, n) {
    const box = this.root.querySelector(".enginecontrols");
    box.innerHTML = `<label><input type="checkbox" class="follow" ${this.follow ? "checked" : ""}> follow newest</label>
      · window <select class="size">${WINDOWS.map((w) => `<option ${w === this.size ? "selected" : ""}>${w}</option>`).join("")}</select> iterations
      · <button class="older">◀ older</button><button class="newer">newer ▶</button>
      <span class="dim">showing ${Math.max(0, end - n) + 1}–${end} of ${total}</span>`;
    box.querySelector(".follow").onchange = (e) => { this.follow = e.target.checked; this.end = null; this.render(state); };
    box.querySelector(".size").onchange = (e) => { this.size = e.target.value === "all" ? "all" : +e.target.value; this.render(state); };
    const page = (d) => { this.follow = false; this.end = Math.max(n, Math.min(total, end + d)); this.render(state); };
    box.querySelector(".older").onclick = () => page(-Math.floor(n / 2));
    box.querySelector(".newer").onclick = () => page(Math.floor(n / 2));
  }

  drawChart(shown) {
    const n = shown.length, bw = W / Math.max(n, 1);
    const mid = median(shown.map((x) => x.step_ms)) ?? 1;
    const inScale = shown.map((x) => x.step_ms).filter((v) => v != null && v <= OVER * mid);
    const top = Math.max(...(inScale.length ? inScale : [mid])) * 1.1 || 1;
    const H1 = 150, H2 = 60, H3 = 46, H4 = 46, G = 20;
    const y2 = H1 + G, y3 = y2 + H2 + G, y4 = y3 + H3 + G, total = y4 + H4 + 4;
    const tokens = shown.map((x) => (x.context_tokens ?? 0) + (x.generation_requests ?? 0));
    const tmax = Math.max(1, ...tokens);
    const kmax = Math.max(1, ...shown.map((x) => x.kv_used_blocks ?? 0));
    const rmax = Math.max(1, ...shown.map((x) => Math.max(x.active ?? 0, x.queued ?? 0, x.max_active ?? 0)));
    const bars = shown.map((x, i) => {
      const p = phase(x), x0 = i * bw, w = Math.max(bw - 0.5, 0.4);
      const over = x.step_ms != null && x.step_ms > top;
      const h = x.step_ms == null ? H1 * 0.15 : Math.min(H1, (x.step_ms / top) * H1);
      const fill = x.step_ms == null ? `fill="none" stroke="${PHASE_COLOR[p]}"` : `fill="${over ? "url(#overhatch)" : PHASE_COLOR[p]}"`;
      const ctx = ((x.context_tokens ?? 0) / tmax) * H2, gen = ((x.generation_requests ?? 0) / tmax) * H2;
      const on = x.seq === this.picked ? `<rect class="pick" x="${x0}" y="0" width="${Math.max(bw, 1)}" height="${total}"/>` : "";
      return `${on}<rect x="${x0}" y="${H1 - h}" width="${w}" height="${h}" ${fill}><title>iteration ${x.seq} · ${p} · step ${x.step_ms == null ? "–" : ms(x.step_ms, 3) + " ms"}</title></rect>
        <rect x="${x0}" y="${y2 + H2 - ctx}" width="${w}" height="${ctx}" fill="${PHASE_COLOR.prefill}"/>
        <rect x="${x0}" y="${y2 + H2 - ctx - gen}" width="${w}" height="${gen}" fill="${PHASE_COLOR.decode}"/>`;
    }).join("");
    const line = (key, y, h, max) => shown.map((x, i) => `${(i * bw + bw / 2).toFixed(1)},${(y + h - ((x[key] ?? 0) / max) * h).toFixed(1)}`).join(" ");
    this.root.querySelector(".chart").innerHTML = `<svg class="enginechart" viewBox="0 0 ${W} ${total}" preserveAspectRatio="none">
      <defs><pattern id="overhatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="6" height="6" fill="#2a2f3a"/><line x1="0" y1="0" x2="0" y2="6" stroke="#8b949e" stroke-width="2"/></pattern></defs>
      ${bars}
      <text class="lanelabel" x="4" y="12">step time, 0–${ms(top, 2)} ms</text>
      <text class="lanelabel" x="4" y="${y2 - 4}">tokens this iteration (prompt tokens + one per generation request), 0–${tmax}</text>
      <text class="lanelabel" x="4" y="${y3 - 4}">KV blocks used, 0–${kmax} (of ${shown.at(-1).kv_max_blocks})</text>
      <polyline class="kvline" points="${line("kv_used_blocks", y3, H3, kmax)}"/>
      <text class="lanelabel" x="4" y="${y4 - 4}">requests: active (white), queued (red), 0–${rmax}</text>
      <polyline class="activeline" points="${line("active", y4, H4, rmax)}"/>
      <polyline class="queuedline" points="${line("queued", y4, H4, rmax)}"/></svg>`;
    const svg = this.root.querySelector(".enginechart");
    const at = (e) => shown[Math.min(n - 1, Math.max(0, Math.floor((e.offsetX / svg.clientWidth) * n)))];
    svg.onmousemove = (e) => { if (this.held) return; this.picked = at(e)?.seq; this.drawNow(shown); };
    svg.onmouseleave = () => { if (!this.held) { this.picked = null; this.drawNow(shown); } };
    svg.onclick = (e) => {
      const x = at(e);
      this.held = !(this.held && this.picked === x?.seq);
      this.picked = x?.seq; this.drawNow(shown); this.drawChart(shown);
    };
  }
}
