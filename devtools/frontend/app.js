// The shell: one live connection, one shared state, the active view redraws from it.
import { CompareView } from "./views/compare.js";
import { ComponentsView } from "./views/components.js";
import { EngineView } from "./views/engine.js";
import { InfraView } from "./views/infra.js";
import { LifecycleView } from "./views/lifecycle.js";
import { LogsView } from "./views/logs.js";
import { MetricsView } from "./views/metrics.js";
import { RequestsView } from "./views/requests.js";
import { RunView } from "./views/run.js";
import { RunsView } from "./views/runs.js";
import { TraceView } from "./views/trace.js";
import { ToolsView } from "./views/tools.js";

import { state, connect } from "./live.js";

const root = document.getElementById("view");
const views = {
  infra: new InfraView(root), engine: new EngineView(root), lifecycle: new LifecycleView(root), logs: new LogsView(root),
  metrics: new MetricsView(root), requests: new RequestsView(root), runs: new RunsView(root),
  trace: new TraceView(root), tools: new ToolsView(root), run: new RunView(root), compare: new CompareView(root),
  components: new ComponentsView(root),
};
let active = "infra";
let pending = false;
function redraw() { // at most once per animation frame, however many messages arrive
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; views[active].render(state); });
}

function open(hash) { // a tab; the URL keeps it (#trace/<run>/<request>), so a link or a reload lands on the same view
  const [name, ...params] = hash.split("/").map(decodeURIComponent);
  active = name in views ? name : "infra";
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === active));
  root.innerHTML = "";
  views[active].open?.(params, state);
  redraw();
}
for (const button of document.querySelectorAll("#tabs button")) {
  button.onclick = () => { location.hash = button.dataset.view; };
}
window.onhashchange = () => open(location.hash.slice(1));
for (const view of Object.values(views)) view.redraw = redraw; // views redraw after their own fetches
open(location.hash.slice(1));

const link = document.getElementById("link");
connect({ onChange: redraw, onStatus: (status) => {
  link.textContent = status; link.className = `link ${status === "live" ? "live" : "down"}`;
} });
window.devtools = { state, views, ready: () => document.readyState === "complete" }; // for iectl snapshot
