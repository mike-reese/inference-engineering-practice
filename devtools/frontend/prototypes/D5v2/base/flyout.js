// The command-center flyout: the v1 tabs that are not places in the scene (runs, metrics, tools, ...), docked to the
// right or the bottom of the scene. Picking a tab replaces the flyout's content; the scene stays as it is.
import { state as live } from "/static/live.js";
import { RunView } from "/static/views/run.js";
import { RunsView } from "/static/views/runs.js";
import { RequestsView } from "/static/views/requests.js";
import { EngineView } from "/static/views/engine.js";
import { MetricsView } from "/static/views/metrics.js";
import { LifecycleView } from "/static/views/lifecycle.js";
import { LogsView } from "/static/views/logs.js";
import { ToolsView } from "/static/views/tools.js";
import { CompareView } from "/static/views/compare.js";
import { hostV1 } from "./levels.js";

export const TABS = { summary: ["Summary", null], run: ["Run", RunView], runs: ["Runs", RunsView], requests: ["Requests", RequestsView],
  engine: ["Engine", EngineView], metrics: ["Metrics", MetricsView], lifecycle: ["Lifecycle", LifecycleView], logs: ["Logs", LogsView],
  tools: ["Tools", ToolsView], compare: ["Compare", CompareView] };

const KEY = "cc-v2-flyout";
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
const save = (o) => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* private window */ } };

export class Flyout {
  /** @param {HTMLElement} el the aside  @param {HTMLElement} summary the scene's summary element (tab "summary") */
  constructor(el, summary) {
    this.el = el; this.summary = summary; this.hosts = {}; this.current = "summary"; this.params = [];
    const pref = load(); this.dock = pref.dock || "right"; this.big = !!pref.big;
    el.insertAdjacentHTML("afterbegin", `<nav id="ftabs">${Object.entries(TABS).map(([k, [l]]) => `<button data-t="${k}">${l}</button>`).join("")}
      <span class="fsp"></span><button id="fbig" title="larger or smaller">⤢</button><button id="fdock" title="dock right or bottom"></button></nav>`);
    this.body = document.createElement("div"); this.body.id = "fbody"; el.appendChild(this.body); this.body.appendChild(summary);
    el.querySelector("#ftabs").onclick = (e) => { const t = e.target.dataset.t; if (t) this.open(t, []); };
    el.querySelector("#fdock").onclick = () => { this.dock = this.dock === "right" ? "bottom" : "right"; this.layout(); };
    el.querySelector("#fbig").onclick = () => { this.big = !this.big; this.layout(); };
    this.layout(); this.open("summary", []);
  }
  layout() { document.body.classList.toggle("dock-bottom", this.dock === "bottom"); document.body.classList.toggle("fly-big", this.big);
    this.el.querySelector("#fdock").textContent = this.dock === "right" ? "dock ↓ bottom" : "dock → right"; save({ dock: this.dock, big: this.big }); }
  /** Show a tab (v1 route name) with v1 route params, e.g. open("run", ["I02A-L1"]). */
  open(name, params) {
    if (!(name in TABS)) return false;
    this.current = name; this.params = params;
    this.el.querySelectorAll("#ftabs button[data-t]").forEach((b) => b.classList.toggle("on", b.dataset.t === name));
    this.summary.hidden = name !== "summary";
    for (const [k, h] of Object.entries(this.hosts)) { h.host.hidden = k !== name; h.active = k === name; }
    if (name !== "summary") {
      const h = (this.hosts[name] ??= hostV1(TABS[name][1], { cls: "flyhost", style: "height:100%", wrapStyle: "height:100%" }));
      if (!h.host.parentNode) this.body.appendChild(h.host);
      h.root.innerHTML = ""; h.view.open?.(params, live); h.active = true; h.draw();
    }
    return true;
  }
  hash() { return "#" + [this.current, ...this.params].map(encodeURIComponent).join("/"); }
}
