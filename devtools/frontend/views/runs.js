// Runs view: every run folder the records collector has seen, newest first; open one in the trace view.
import { escape } from "./util.js";

export class RunsView {
  constructor(root) { this.root = root; }

  render(state) {
    const runs = Object.values(state.runs).sort((a, b) => b.mtime - a.mtime);
    if (!runs.length) {
      this.root.innerHTML = "<p>No run folders yet (reps/*/results/&lt;run&gt;/ with a config.yaml).</p>";
      return;
    }
    this.root.innerHTML = `<table class="runs"><tr><th>run</th><th>rep</th><th>trace</th><th>steps done</th>
      <th>engine</th><th>files</th><th></th></tr>${runs.map((r) => {
        const traced = r.labels?.trace && r.labels.trace !== "off";
        return `<tr><td>${escape(r.run_id)}</td><td>${escape(r.rep)}</td>
          <td class="${traced ? "traced" : ""}">${escape(r.labels?.trace ?? "off")}${traced ? " (not measured)" : ""}</td>
          <td>${r.done}/${r.steps}</td><td>${escape(r.basis?.version?.version ?? "–")}</td><td>${r.file_count}</td>
          <td><a href="#trace/${encodeURIComponent(r.run_id)}">trace</a> · <a href="#tools/${encodeURIComponent(r.run_id)}">files</a></td></tr>`;
      }).join("")}</table>`;
  }
}
