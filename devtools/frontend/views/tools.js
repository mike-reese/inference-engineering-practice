// Tools view: the hosted tools (Grafana, Prometheus) and a run's files for the desktop tools (Wireshark, Nsight).
import { escape } from "./util.js";

const OPENS_IN = [
  [/\.pcap$/, "Wireshark"], [/\.nsys-rep$/, "Nsight Systems"], [/\.ncu-rep$/, "Nsight Compute"],
  [/torch_trace\.json$/, "Perfetto (ui.perfetto.dev) or chrome://tracing"], [/\.sqlite$/, "sqlite3"],
  [/frames\.tsv$/, "a spreadsheet"], [/\.log$/, "the Logs view"], [/run\.json$/, "iectl or jq"],
];

export class ToolsView {
  constructor(root) { this.root = root; this.run = null; }

  open(params) { this.run = params[0] ?? null; }

  render(state) {
    const runs = Object.values(state.runs).sort((a, b) => b.mtime - a.mtime);
    const run = state.runs[this.run] ?? runs[0];
    const files = (run?.files ?? []).map((f) => {
      const tool = OPENS_IN.find(([re]) => re.test(f));
      return `<tr><td><a href="/api/runs/${encodeURIComponent(run.run_id)}/file?path=${encodeURIComponent(f)}">${escape(f)}</a></td>
        <td class="dim">${tool ? tool[1] : ""}</td></tr>`;
    }).join("");
    this.root.innerHTML = `<section class="tools">
      <div class="label">hosted</div>
      <ul><li><a href="/grafana/d/engine/engine-client-and-gpu?orgId=1" target="_blank">Grafana: engine, client and GPU</a>
        (also inside the Metrics view)</li>
      <li><a href="/prometheus/query" target="_blank">Prometheus</a> · <a href="/prometheus/targets" target="_blank">its targets</a>
        (engine and client found through /api/prometheus/targets)</li>
      <li><a href="/api/snapshot" target="_blank">/api/snapshot</a> · <a href="/api/runs" target="_blank">/api/runs</a>
        · the same API iectl reads</li></ul>
      <div class="label">run files · <select class="run">${runs.map((r) => `<option ${r === run ? "selected" : ""}>${escape(r.run_id)}</option>`).join("")}</select></div>
      ${run ? `<table class="files">${files}</table>` : "<p>No runs yet.</p>"}</section>`;
    const select = this.root.querySelector("select.run");
    if (select) select.onchange = (e) => { location.hash = `tools/${encodeURIComponent(e.target.value)}`; };
  }
}
