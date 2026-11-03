// Metrics view: each engine's Prometheus counters on the shared wall-clock axis, and the Grafana dashboard inside.
import { escape, spark } from "./util.js";

// Histogram series the engine exports: (sum, count) -> a mean per request over the window shown.
const MEANS = [
  ["TTFT", "time_to_first_token_seconds"],
  ["time per output token", "time_per_output_token_seconds"],
  ["end-to-end", "e2e_request_latency_seconds"],
  ["queue", "request_queue_time_seconds"],
];

function find(metrics, part) {
  return Object.keys(metrics).find((k) => k.includes(part));
}

export class MetricsView {
  constructor(root) {
    this.root = root;
    this.selected = null;
    this.filter = "";
    this.grafana = false;
  }

  render(state) {
    const engines = Object.keys(state.engineMetrics);
    if (!this.root.querySelector(".metricsview")) {
      this.root.innerHTML = `<div class="metricsview"><div class="picker"></div><div class="means"></div>
        <label><input type="checkbox" class="showgrafana"> Grafana dashboard (Prometheus at /prometheus)</label>
        <div class="grafana"></div>
        <input class="filter" placeholder="filter series"><table class="series"></table></div>`;
      this.root.querySelector(".filter").oninput = (e) => { this.filter = e.target.value; this.render(state); };
      this.root.querySelector(".showgrafana").onchange = (e) => {
        this.grafana = e.target.checked;
        this.root.querySelector(".grafana").innerHTML = this.grafana
          ? `<iframe src="/grafana/d/engine/engine-client-and-gpu?orgId=1&refresh=5s&kiosk" class="grafanaframe"></iframe>` : "";
      };
    }
    if (!engines.length) {
      this.root.querySelector(".picker").innerHTML = "<p>No engine counters yet. Start a stack (make rep): the engine "
        + "collector reads /prometheus/metrics at the server's published port once it answers.</p>";
      return;
    }
    if (!engines.includes(this.selected)) this.selected = engines.at(-1);
    const names = Object.fromEntries(state.containers.map((c) => [c.id, `${c.project}/${c.service}`]));
    const picker = this.root.querySelector(".picker");
    picker.innerHTML = engines.map((id) => `<button data-id="${id}" class="${id === this.selected ? "on" : ""}">
      ${escape(names[id] ?? id)}${state.containers.some((c) => c.id === id && c.state === "running") ? "" : " (stopped)"}</button>`).join("");
    picker.querySelectorAll("button").forEach((b) => (b.onclick = () => { this.selected = b.dataset.id; this.render(state); }));

    const samples = state.engineMetrics[this.selected];
    const last = samples.at(-1).metrics;
    const first = samples[0].metrics;
    const means = MEANS.map(([label, part]) => {
      const sum = find(last, `${part}_sum`), count = find(last, `${part}_count`);
      if (!sum || !count) return `<div class="mean"><b>${label}</b> not exported</div>`;
      const dn = last[count] - (first[count] ?? 0), ds = last[sum] - (first[sum] ?? 0);
      return `<div class="mean"><b>${label}</b> ${dn ? (1000 * ds / dn).toFixed(2) + " ms" : "–"}
        <span class="dim">mean of ${dn} request(s) in the window; all-time ${last[count] ? (1000 * last[sum] / last[count]).toFixed(2) : "–"} ms</span></div>`;
    }).join("");
    const info = state.engineInfo[this.selected];
    this.root.querySelector(".means").innerHTML = `${means}
      <div class="dim">${samples.length} samples, one per second · engine ${escape(info?.version?.version ?? "")}
      · model ${escape(info?.["v1/models"]?.data?.[0]?.id ?? "")} rev ${escape(info?.model_revision ?? "")}</div>`;

    const keys = Object.keys(last).filter((k) => !k.includes("_bucket") && k.toLowerCase().includes(this.filter.toLowerCase()));
    this.root.querySelector(".series").innerHTML = "<tr><th>series</th><th>value</th><th>last 30 min</th></tr>" + keys.map((k) => {
      const values = samples.slice(-300).map((s) => s.metrics[k] ?? null);
      return `<tr><td>${escape(k)}</td><td>${last[k]}</td><td>${spark(values)}</td></tr>`;
    }).join("");
  }
}
