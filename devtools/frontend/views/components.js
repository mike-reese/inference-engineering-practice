// Components view, one level below Infrastructure: inside each container, every component that owns a step of the
// request, and the data moving between them, live. Source: the components collector (devtools/backend/collectors/
// components.py) tailing the run's server stamps, client stamps and packet capture (TRACE=components, or any profiled
// level). Opened from an Infrastructure card (#components/<project>/<service>) with that container highlighted.
import { BOX, BOUNDS, CONTAINER_OF, boxOf, dataForm, inspect, light, mapSVG, packet, statText } from "./components_map.js";
import { escape, json, ms } from "./util.js";

const SERVICE_BOUND = { client: "client", server: "server", capture: "network" };
const SPEEDS = { "real time ×1": 1, "×0.25 (slower)": 0.25, "×4": 4 };

export class ComponentsView {
  constructor(root) {
    this.root = root;
    this.runId = null; this.request = null; this.follow = true; this.cursor = -1; this.shown = 0;
    this.focus = null; this.hideAcks = true; this.speed = 1; this.playing = null; this.queue = []; this.animating = false;
    this.built = null; // the run/request/focus the map was built for
  }

  open(params) {
    const [, service] = params;
    this.queue = []; this.playing = false;
    this.focus = SERVICE_BOUND[service] ?? null;
    this.built = null;
  }

  stamps(state) {
    const list = state.componentStamps[this.runId] ?? [];
    return list.filter((s) => s.xrids.includes(this.request) && !(this.hideAcks && s.src === "wire" && s.name === "ACK"));
  }

  requests(state) { // newest first, by first stamp
    const seen = new Map();
    for (const s of state.componentStamps[this.runId] ?? []) for (const x of s.xrids) if (!seen.has(x)) seen.set(x, s.t0);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([x]) => x);
  }

  render(state) {
    const runs = Object.keys(state.componentStamps).sort().reverse();
    if (!runs.length) {
      this.root.innerHTML = `<div class="compview"><p>No component stamps yet. Start <b>Components (live component stamps)</b>
        in the Run tab (or <code>make rep TRACE=components</code>); the profiled levels carry the same stamps.</p>
        <p class="dim">The measured run has none: every stamp is a file write in the client and the server.</p></div>`;
      this.built = null;
      return;
    }
    if (!runs.includes(this.runId) || (this.follow && runs[0] !== this.runId)) { this.runId = runs[0]; this.request = null; }
    const requests = this.requests(state);
    if (!requests.includes(this.request) || (this.follow && requests[0] !== this.request)) { this.request = requests[0]; this.cursor = -1; this.shown = 0; }
    const key = `${this.runId}|${this.request}|${this.focus}|${this.hideAcks}`;
    if (this.built !== key || !this.root.querySelector(".compview")) this.build(state, runs, requests, key);
    else this.update(state, requests);
  }

  labels(state, steps) {
    const app = state.containers.filter((c) => c.project && c.project !== "ie-devtools");
    const of = (svc) => app.filter((c) => c.service === svc).at(-1);
    const describe = (c) => (c ? `${c.name} · ${c.image} · ${c.state}` : "not running now");
    const pid = (proc) => steps.find((s) => s.proc === proc && s.pid)?.pid;
    return { client: describe(of("client")), server: describe(of("server")), network: of("capture") ? "capture shares the server's netns" : "",
      http: pid("http") ? `pid ${pid("http")} in the container` : "", worker: pid("worker") ? `pid ${pid("worker")}` : "" };
  }

  build(state, runs, requests, key) {
    this.built = key;
    const steps = this.stamps(state);
    const linked = state.runs[this.runId]?.files?.includes("run.json");
    this.root.innerHTML = `<div class="compview">
      <div class="controls">
        run <select class="crun">${runs.map((r) => `<option ${r === this.runId ? "selected" : ""}>${escape(r)}</option>`).join("")}</select>
        request <select class="creq">${requests.map((r) => `<option ${r === this.request ? "selected" : ""}>${escape(r)}</option>`).join("")}</select>
        <label><input type="checkbox" class="cfollow" ${this.follow ? "checked" : ""}> live: follow the newest step</label>
        · <button class="cfirst">⏮</button><button class="cback">◀</button><button class="cplay">${this.playing ? "⏸" : "▶ replay"}</button><button class="cnext">▶|</button>
        speed <select class="cspeed">${Object.keys(SPEEDS).map((k) => `<option ${SPEEDS[k] === this.speed ? "selected" : ""}>${k}</option>`).join("")}</select>
        · <label><input type="checkbox" class="cacks" ${this.hideAcks ? "checked" : ""}> hide bare TCP ACKs</label>
        · <a href="#infra">◀ containers</a>
        ${linked ? ` · <a href="#trace/${encodeURIComponent(this.runId)}/${encodeURIComponent(this.request)}/0b">step through in Trace (0b, with kernels and metrics) ▶</a>` : ""}
        <span class="dim cstatus"></span>
      </div>
      <div class="compmapwrap">${mapSVG({ focus: this.focus, labels: this.labels(state, steps) })}</div>
      <div class="compbody"><section class="cinspect"></section><section class="csteps"><table><thead><tr><th>ms</th><th>where</th><th>step</th><th>the request is now</th></tr></thead><tbody></tbody></table></section></div>
      <div class="dim">Every stamp is on CLOCK_MONOTONIC (client and server share the host kernel's clock); wire frames are converted from the
        capture's UTC by this host's UTC − monotonic offset. Stamps add a file write per step: this run is labeled not measured.</div></div>`;
    const $ = (q) => this.root.querySelector(q);
    $(".crun").onchange = (e) => { this.runId = e.target.value; this.follow = false; this.request = null; this.built = null; this.render(state); };
    $(".creq").onchange = (e) => { this.request = e.target.value; this.follow = false; this.cursor = -1; this.shown = 0; this.built = null; this.render(state); };
    $(".cfollow").onchange = (e) => { this.follow = e.target.checked; this.built = null; this.render(state); };
    $(".cacks").onchange = (e) => { this.hideAcks = e.target.checked; this.cursor = -1; this.shown = 0; this.built = null; this.render(state); };
    $(".cspeed").onchange = (e) => { this.speed = SPEEDS[e.target.value]; };
    $(".cfirst").onclick = () => this.go(state, 0, false);
    $(".cback").onclick = () => this.go(state, this.cursor - 1, true);
    $(".cnext").onclick = () => this.go(state, this.cursor + 1, true);
    $(".cplay").onclick = () => this.play(state);
    this.root.querySelectorAll(".cbox").forEach((g) => (g.onclick = () => {
      const steps = this.stamps(state), i = steps.findIndex((s, j) => j > this.cursor && boxOf(s) === g.dataset.box);
      const k = i >= 0 ? i : steps.findIndex((s) => boxOf(s) === g.dataset.box);
      if (k >= 0) { this.follow = false; $(".cfollow").checked = false; this.go(state, k, true); }
    }));
    this.shown = 0;
    this.update(state, requests, true);
    if (steps.length) this.go(state, this.follow || this.cursor < 0 ? (this.follow ? steps.length - 1 : 0) : this.cursor, false);
  }

  update(state, requests, initial = false) { // initial: steps already held when the map is built are not animated
    const $ = (q) => this.root.querySelector(q);
    const req = $(".creq");
    if (req && req.options.length !== requests.length) req.innerHTML = requests.map((r) => `<option ${r === this.request ? "selected" : ""}>${escape(r)}</option>`).join("");
    const steps = this.stamps(state);
    const origin = steps[0]?.t0 ?? 0;
    // box statistics for this request
    const stats = {};
    for (const s of steps) {
      const b = boxOf(s), st = (stats[b] ??= { n: 0, ms: 0 });
      st.n += 1; st.ms += s.t1 ? (s.t1 - s.t0) / 1e6 : 0;
    }
    this.root.querySelectorAll("[data-stat]").forEach((t) => {
      const st = stats[t.dataset.stat];
      t.textContent = statText(st);
      t.closest(".cbox").classList.toggle("seen", !!st);
    });
    const labels = this.labels(state, steps); // container state changes while the run goes on
    for (const [k, label] of BOUNDS.map((b) => [b[0], b[1]])) {
      const t = this.root.querySelector(`[data-bound="${k}"] text`);
      if (t) t.textContent = `${label}${labels[k] ? ` · ${labels[k]}` : ""}`;
    }
    const body = $(".csteps tbody");
    const rows = steps.slice(this.shown).map((s, i) => {
      const b = boxOf(s);
      return `<tr data-i="${this.shown + i}"><td>${ms((s.t0 - origin) / 1e6, 3)}</td><td>${escape(BOX[b]?.label ?? b)}</td>
        <td>${escape(s.name)}${s.t1 ? ` <span class="dim">${ms((s.t1 - s.t0) / 1e6, 3)} ms</span>` : ""}</td><td>${escape(dataForm(b, s.data, s.name))}</td></tr>`;
    }).join("");
    if (rows) {
      body.insertAdjacentHTML("beforeend", rows);
      body.querySelectorAll("tr:not([data-bound])").forEach((tr) => {
        tr.dataset.bound = 1;
        tr.onclick = () => { this.follow = false; $(".cfollow").checked = false; this.go(state, +tr.dataset.i, true); };
      });
    }
    const fresh = steps.length - this.shown;
    this.shown = steps.length;
    $(".cstatus").textContent = `${steps.length} steps for this request · ${(state.componentStamps[this.runId] ?? []).length} stamps in the run`;
    if (this.follow && fresh > 0 && !initial) {
      for (let i = steps.length - fresh; i < steps.length; i++) this.queue.push(i);
      this.drain(state);
    }
  }

  async drain(state) { // live: animate each new step in order; with a backlog, jump ahead so the map keeps up
    if (this.animating) return;
    this.animating = true;
    while (this.queue.length) {
      if (this.queue.length > 12) this.queue.splice(0, this.queue.length - 12);
      const i = this.queue.shift();
      await this.go(state, i, true, Math.max(60, 300 / this.speed / Math.max(1, this.queue.length / 3)));
    }
    this.animating = false;
  }

  async go(state, i, animate, duration) {
    const steps = this.stamps(state);
    if (!steps.length) return;
    if (!this.root.querySelector(".compview")) { // another tab is open: stop the live queue and any replay
      this.queue = []; this.playing = false; this.built = null;
      return;
    }
    i = Math.max(0, Math.min(steps.length - 1, i));
    const prev = steps[this.cursor], cur = steps[i];
    this.cursor = i;
    const svg = this.root.querySelector(".compmap");
    const from = boxOf(prev), to = boxOf(cur);
    light(svg, to, from);
    this.root.querySelectorAll(".csteps tr.on").forEach((tr) => tr.classList.remove("on"));
    const row = this.root.querySelector(`.csteps tr[data-i="${i}"]`);
    row?.classList.add("on");
    if (this.follow && row) { // scroll the step list only: scrollIntoView would scroll the page away from the tabs
      const box = this.root.querySelector(".csteps");
      box.scrollTop = row.offsetTop - box.clientHeight + row.offsetHeight * 2;
    }
    this.inspector(cur, steps[0].t0);
    if (animate) await packet(svg, from, to, dataForm(to, cur.data, cur.name), duration ?? 320 / this.speed);
  }

  play(state) {
    if (this.playing) { this.playing = false; this.root.querySelector(".cplay").textContent = "▶ replay"; return; }
    this.follow = false; this.root.querySelector(".cfollow").checked = false;
    this.playing = true; this.root.querySelector(".cplay").textContent = "⏸";
    const run = async () => {
      const steps = this.stamps(state);
      if (this.cursor >= steps.length - 1) this.cursor = -1;
      while (this.playing && this.cursor < steps.length - 1) {
        const next = steps[this.cursor + 1], cur = steps[this.cursor];
        const gap = cur ? (next.t0 - cur.t0) / 1e6 : 0; // real time between the steps, ms
        await this.go(state, this.cursor + 1, true, Math.min(400, Math.max(80, gap * 20)) / this.speed);
      }
      this.playing = false;
      const b = this.root.querySelector(".cplay"); if (b) b.textContent = "▶ replay";
    };
    run();
  }

  inspector(s, origin) {
    const b = boxOf(s), box = BOX[b];
    const where = CONTAINER_OF[b] ?? (["worker", "fetch", "scheduler", "kv_cache", "forward", "sampler", "update", "responses"].includes(b)
      ? "server container · executor worker process" : b?.startsWith("ipc") ? "server container · between the two processes (ZMQ)" : "server container · trtllm-serve process");
    const proc = s.pid ? ` · pid ${s.pid}${s.thread ? `, thread ${escape(s.thread)}` : ""}` : "";
    const ids = [s.cid != null ? `cid ${s.cid}` : "", s.iter != null ? `executor loop ${s.iter}` : "", s.xrids?.length ? `X-Request-ID ${s.xrids.join(", ")}` : ""].filter(Boolean).join(" · ");
    this.root.querySelector(".cinspect").innerHTML = `<div class="label">${escape(where)}${proc}</div>
      <h3>${escape(box?.label ?? b)} · ${escape(s.name)}</h3>
      <div>owner: <b>${escape(box?.owner ?? "")}</b></div>
      <div>at ${ms((s.t0 - origin) / 1e6, 3)} ms${s.t1 ? `, lasts ${ms((s.t1 - s.t0) / 1e6, 3)} ms` : " (an instant)"} · ${escape(ids)}</div>
      <div class="nowis">the request is now: <b>${escape(dataForm(b, s.data, s.name))}</b></div>
      ${inspect(b, s.data)}
      <details><summary>the stamp as written</summary>${json(s)}</details>`;
  }
}
