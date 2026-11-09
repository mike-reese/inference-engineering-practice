// Requests view: each request as it lands (sent -> client record -> engine record), and the workload panel.
// A run with native_records.json and no engine_records.json saved its native records unpaired (no validated
// client/native join): its per-request engine cells read Unavailable.
import { escape, json, ms } from "./util.js";

const MODEL = [ // basis.json "model" keys rep.py saves -> label
  ["name", "model"], ["path", "path"], ["revision", "revision"], ["quantization_config", "weights quantization"],
  ["torch_dtype", "checkpoint torch_dtype"], ["kv_cache_dtype", "KV cache dtype (realized)"]];
const NO_JOIN = "no validated client/native join";
const unpaired = (run) => (run?.files ?? []).includes("native_records.json") && !(run?.files ?? []).includes("engine_records.json");
const saved = (v) => (v == null ? "not saved" : typeof v === "object" ? JSON.stringify(v) : v);

export class RequestsView {
  constructor(root) {
    this.root = root;
    this.selected = null;
  }

  workload(list, state) {
    const byStatus = {}, byPhase = {};
    for (const r of list) {
      const status = r.state === "sent" ? "in flight" : r.client?.complete ? `${r.client.status} complete` : `${r.client?.status ?? "?"} incomplete`;
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      byPhase[r.phase] = (byPhase[r.phase] ?? 0) + 1;
    }
    const info = Object.values(state.engineInfo).at(-1);
    const run = state.runs[list[0]?.run_id];
    return `<section class="workload"><div class="label">workload</div>
      <div>requests ${list.length} · ${Object.entries(byStatus).map(([k, v]) => `${escape(k)} ${v}`).join(" · ")}</div>
      <div>phases ${Object.entries(byPhase).map(([k, v]) => `${escape(k)} ${v}`).join(" · ")}
        <span class="dim">(warmup: not measured; diagnostic: the measured request)</span></div>
      <div>turns per conversation ${[...new Set(list.map((r) => r.criteria?.turns))].join(", ")}</div>
      <div>${MODEL.map(([k, label]) => `${label} ${escape(saved(run?.basis?.model?.[k]))}`).join(" · ")}
        <span class="dim">(this run's basis.json "model")</span></div>
      <div class="dim">live engine: served id ${escape(info?.["v1/models"]?.data?.[0]?.id ?? "–")} · bind ${escape(info?.model_path ?? "–")}</div>
      <div>engine TensorRT-LLM ${escape(info?.version?.version ?? run?.basis?.version?.version ?? "–")}
        · command <code>${escape((info?.command ?? []).join(" "))}</code></div>
      ${unpaired(run) ? `<div>engine columns: Unavailable · native records saved unpaired (${NO_JOIN}); their totals are in Trace</div>` : ""}
      <details><summary>engine config.yaml (this run)</summary><pre>${escape(run?.config ?? info?.config ?? "")}</pre></details>
    </section>`;
  }

  render(state) {
    const list = Object.values(state.requests).sort((a, b) => (b.run_id > a.run_id ? 1 : b.run_id < a.run_id ? -1 : 0)
      || (a.client?.send_mono_ns ?? Infinity) - (b.client?.send_mono_ns ?? Infinity));
    if (!list.length) {
      this.root.innerHTML = "<p>No requests yet. They appear as the client's step files and records land in a run folder.</p>";
      return;
    }
    const runs = [...new Set(list.map((r) => r.run_id))]; // newest run folder, not the largest run id ("K4_" > "I02C_")
    const latestRun = runs.reduce((a, b) => ((state.runs[b]?.mtime ?? 0) > (state.runs[a]?.mtime ?? 0) ? b : a), runs[0]);
    const current = list.filter((r) => r.run_id === latestRun);
    const rows = list.slice(0, 200).map((r) => {
      const c = r.client ?? {}, e = r.engine ?? {};
      const none = !r.engine && unpaired(state.runs[r.run_id]) ? `<span title="${NO_JOIN}">Unavailable</span>` : null;
      return `<tr data-id="${escape(r.request_id)}" class="${r.request_id === this.selected ? "on" : ""} ${r.state === "sent" ? "inflight" : ""}">
        <td>${escape(r.run_id)}</td><td>${escape(r.request_id.replace(r.run_id + "-", ""))}</td><td>${escape(r.phase)}</td>
        <td>${r.state === "sent" ? "in flight" : c.status ?? "–"}</td><td>${ms(c.headers_ms)}</td><td>${ms(c.ttft_ms)}</td>
        <td>${ms(c.e2e_ms)}</td><td>${c.prompt_tokens ?? "–"} / ${c.completion_tokens ?? "–"}</td>
        <td>${c.events ?? "–"} / ${c.token_events ?? "–"}</td><td>${none ?? ms(e.queue_ms)}</td><td>${none ?? ms(e.ttft_ms)}</td>
        <td>${none ?? (e.first_iter ? `${e.first_iter}–${e.last_iter}` : "–")}</td></tr>`;
    }).join("");
    const chosen = state.requests[this.selected];
    this.root.innerHTML = `${this.workload(current, state)}
      <table class="requests"><tr><th>run</th><th>request</th><th>phase</th><th>status</th><th>headers ms</th>
      <th>TTFT ms</th><th>e2e ms</th><th>tokens in/out</th><th>events/token events</th><th>engine queue ms</th>
      <th>engine TTFT ms</th><th>iterations</th></tr>${rows}</table>
      ${chosen ? `<section class="detail"><div class="label">${escape(chosen.request_id)}
        · <a href="#trace/${encodeURIComponent(chosen.run_id)}/${encodeURIComponent(chosen.request_id)}">open its trace</a></div>
        ${json(chosen)}</section>` : ""}`;
    this.root.querySelectorAll("tr[data-id]").forEach((tr) => (tr.onclick = () => { this.selected = tr.dataset.id; this.render(state); }));
  }
}
