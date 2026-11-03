// Requests view: each request as it lands (sent -> client record -> engine record), and the workload panel.
import { escape, json, ms } from "./util.js";

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
      <div>model ${escape(info?.["v1/models"]?.data?.[0]?.id ?? "–")} · path ${escape(info?.model_path ?? "–")}
        · revision ${escape(info?.model_revision ?? "–")} · precision: from config.json torch_dtype (bf16 for Qwen2.5-0.5B)</div>
      <div>engine TensorRT-LLM ${escape(info?.version?.version ?? run?.basis?.version?.version ?? "–")}
        · command <code>${escape((info?.command ?? []).join(" "))}</code></div>
      <details><summary>engine config.yaml</summary><pre>${escape(info?.config ?? run?.config ?? "")}</pre></details>
    </section>`;
  }

  render(state) {
    const list = Object.values(state.requests).sort((a, b) => (b.run_id > a.run_id ? 1 : b.run_id < a.run_id ? -1 : 0)
      || (a.client?.send_mono_ns ?? Infinity) - (b.client?.send_mono_ns ?? Infinity));
    if (!list.length) {
      this.root.innerHTML = "<p>No requests yet. They appear as the client's step files and records land in a run folder.</p>";
      return;
    }
    const latestRun = list[0].run_id;
    const current = list.filter((r) => r.run_id === latestRun);
    const rows = list.slice(0, 200).map((r) => {
      const c = r.client ?? {}, e = r.engine ?? {};
      return `<tr data-id="${escape(r.request_id)}" class="${r.request_id === this.selected ? "on" : ""} ${r.state === "sent" ? "inflight" : ""}">
        <td>${escape(r.run_id)}</td><td>${escape(r.request_id.replace(r.run_id + "-", ""))}</td><td>${escape(r.phase)}</td>
        <td>${r.state === "sent" ? "in flight" : c.status ?? "–"}</td><td>${ms(c.headers_ms)}</td><td>${ms(c.ttft_ms)}</td>
        <td>${ms(c.e2e_ms)}</td><td>${c.prompt_tokens ?? "–"} / ${c.completion_tokens ?? "–"}</td>
        <td>${c.events ?? "–"} / ${c.token_events ?? "–"}</td><td>${ms(e.queue_ms)}</td><td>${ms(e.ttft_ms)}</td>
        <td>${e.first_iter ? `${e.first_iter}–${e.last_iter}` : "–"}</td></tr>`;
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
