// Run view: pick a registered rep (reps/*/rep.toml) and an action, start it on the host runner, follow it, open the run.
// The runner (scripts/runner.py) runs only the commands the manifest declares; this page sends a rep id and an action id.
import { escape, getJSON } from "./util.js";

const fmtTime = (ns) => new Date(ns / 1e6).toLocaleTimeString();
const seconds = (ns) => { const s = Math.round(ns / 1e9); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; };

export class RunView {
  constructor(root) {
    this.root = root;
    this.reps = null; this.running = null; this.jobs = []; this.job = null;
    this.rep = null; this.error = null; this.notice = null; this.dirty = true; this.seen = "";
    this.timer = null; this.ticks = 0;
  }

  open(params) {
    if (params[0]) this.rep = params[0];
    this.dirty = true;
    this.poll();
    this.timer ??= setInterval(() => { if (location.hash.startsWith("#run")) this.poll(); }, 1000);
  }

  async poll() {
    try {
      if (!this.reps || this.ticks++ % 3 === 0 || this.running) {
        const data = await getJSON("/runner/reps");
        this.reps = data.reps; this.running = data.running;
      }
      this.jobs = await getJSON("/runner/jobs");
      const shown = this.jobs.find((j) => j.state === "running") ?? this.jobs[0];
      this.job = shown ? await getJSON(`/runner/jobs/${shown.id}?tail=400`) : null;
      this.error = null;
    } catch (e) {
      this.error = String(e);
    }
    const key = JSON.stringify([this.reps, this.jobs, this.job, this.error]);
    if (key !== this.seen) { this.seen = key; this.dirty = true; this.redraw?.(); }
  }

  async start(rep, action) {
    this.notice = null;
    const r = await fetch("/runner/jobs", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rep, action }) });
    if (!r.ok) this.notice = `${r.status}: ${await r.text()}`;
    this.dirty = true;
    await this.poll();
    this.redraw?.();
  }

  actionCard(rep, a, blocked) {
    const badges = [a.group === "run" ? (a.measured ? "measured" : "not measured") : "check",
      a.graphs == null ? null : `CUDA graphs ${a.graphs ? "on" : "off"}`, a.minutes ? `~${a.minutes} min` : null].filter(Boolean);
    return `<div class="action ${a.measured ? "measured" : ""}">
      <div class="title">${escape(a.label)} <span class="state">${badges.map(escape).join(" · ")}</span></div>
      <div>${escape(a.description ?? "")}</div>
      <code class="argv">${a.argv.map(escape).join(" ")}</code>
      <button class="start" data-rep="${escape(rep.id)}" data-action="${escape(a.id)}" ${blocked ? `disabled title="${escape(blocked)}"` : ""}>Start</button>
    </div>`;
  }

  repPanel(rep) {
    if (rep.error) return `<p class="err">${escape(rep.error)}</p>`;
    const busy = Object.entries(rep.busy ?? {});
    const blocked = this.running ? `job ${this.running.id} (${this.running.label}) is running`
      : busy.length ? `containers exist: ${busy.map(([p, n]) => `${p}: ${n.join(", ")}`).join("; ")}` : null;
    const groups = { run: "Runs", check: "Checks and walkthrough" };
    return `<h3>${escape(rep.id)} · ${escape(rep.title ?? "")}</h3>
      <div class="dim">${escape(rep.folder)}/rep.toml · spec ${escape(rep.folder)}/${escape(rep.spec ?? "README.md")}</div>
      ${blocked ? `<div class="banner">Start is off: ${escape(blocked)}</div>` : ""}
      ${Object.entries(groups).map(([g, label]) => {
        const list = rep.actions.filter((a) => (a.group ?? "run") === g);
        return list.length ? `<div class="label">${label}</div><div class="actions">${list.map((a) => this.actionCard(rep, a, blocked)).join("")}</div>` : "";
      }).join("")}`;
  }

  jobPanel(job) {
    if (!job) return "<p class=dim>No job yet. Start one on the left; it runs on the host and shows here.</p>";
    const now = job.ended_ns ?? Date.now() * 1e6;
    const steps = job.progress.filter((p) => p.step !== "run").map((p, i, all) => {
      const next = all[i + 1]?.wall_ns ?? (job.state === "running" ? now : job.ended_ns);
      const live = !all[i + 1] && job.state === "running";
      return `<li class="${live ? "live" : ""}">${escape(p.step)}${p.note ? ` <span class="dim">(${escape(p.note)})</span>` : ""}
        <span class="dim">${fmtTime(p.wall_ns)} · ${seconds(next - p.wall_ns)}${live ? " so far" : ""}</span></li>`;
    }).join("");
    const state = job.state === "running" ? `running ${seconds(now - job.started_ns)}`
      : `${job.state} (exit ${job.exit}) after ${seconds(job.ended_ns - job.started_ns)}`;
    return `<div class="jobhead"><b>job ${job.id}: ${escape(job.rep)} · ${escape(job.label)}</b> <span class="jobstate ${job.state}">${escape(state)}</span></div>
      <code class="argv">${job.argv.map(escape).join(" ")}</code>
      <div class="joblinks">${job.run_id ? `run <b>${escape(job.run_id)}</b> · <a href="#trace/${encodeURIComponent(job.run_id)}">open in Trace</a> · <a href="#tools/${encodeURIComponent(job.run_id)}">files</a> · ` : ""}
        watch: <a href="#lifecycle">Lifecycle</a> · <a href="#infra">Infrastructure</a> · <a href="#logs">Logs</a> · <a href="#requests">Requests</a></div>
      ${steps ? `<div class="label">steps</div><ol class="steps">${steps}</ol>` : ""}
      ${job.state === "running" && this.logProgress ? `<div class="logprogress">${escape(this.logProgress)}</div>` : ""}
      <div class="label">output (last ${job.lines.length} lines)</div>
      <pre class="joblog">${job.lines.map(escape).join("\n")}</pre>`;
  }

  // The rep's [progress_log]: the newest matching line in its service's container log (the live log stream).
  logLine(state, rep) {
    const spec = rep?.progress_log;
    if (!spec || !this.running) return null;
    const re = new RegExp(spec.pattern);
    for (const c of state.containers ?? []) {
      if (!(rep.compose_projects ?? []).includes(c.project) || c.service !== spec.service) continue;
      const lines = state.logs[c.id] ?? [];
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 400); i--) {
        const m = re.exec(lines[i].line);
        if (m) return spec.label.replace(/\{(\d+)\}/g, (_, n) => m[+n] ?? "");
      }
    }
    return null;
  }

  render(state) {
    const shownRep = this.reps?.find((r) => r.id === this.rep) ?? this.reps?.[0];
    const line = this.logLine(state, this.reps?.find((r) => r.id === this.running?.rep) ?? shownRep);
    if (line !== this.logProgress) { this.logProgress = line; this.dirty = true; }
    if (!this.dirty && this.root.querySelector(".runview")) return;
    this.dirty = false;
    if (this.error && !this.reps) {
      this.root.innerHTML = `<p class="err">The runner is not answering: ${escape(this.error)}</p>
        <p>Start it with <code>make devtools</code> (or <code>make runner</code>) from the repo.</p>`;
      return;
    }
    if (!this.reps) { this.root.innerHTML = "<p>Asking the runner …</p>"; return; }
    if (!this.reps.length) { this.root.innerHTML = "<p>No reps registered: add a rep.toml next to a rep.py.</p>"; return; }
    const rep = this.reps.find((r) => r.id === this.rep) ?? this.reps[0];
    const log = this.root.querySelector(".joblog");
    const atBottom = !log || log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
    this.root.innerHTML = `<div class="runview">
      <section class="reps"><div class="label">registered reps</div>
        <div class="picker">${this.reps.map((r) => `<button class="${r === rep ? "on" : ""}" data-pick="${escape(r.id)}">${escape(r.id)}</button>`).join("")}</div>
        ${this.notice ? `<p class="err">${escape(this.notice)}</p>` : ""}
        ${this.error ? `<p class="err">${escape(this.error)}</p>` : ""}
        ${this.repPanel(rep)}</section>
      <section class="job">${this.jobPanel(this.job)}
        ${this.jobs.length > 1 ? `<div class="label">earlier jobs (this runner session)</div><ul class="history">${this.jobs.slice(1).map((j) =>
          `<li>job ${j.id} · ${escape(j.label)} · ${escape(j.state)}${j.run_id ? ` · <a href="#trace/${encodeURIComponent(j.run_id)}">${escape(j.run_id)}</a>` : ""}</li>`).join("")}</ul>` : ""}
      </section></div>`;
    const newLog = this.root.querySelector(".joblog");
    if (newLog && atBottom) newLog.scrollTop = newLog.scrollHeight;
    this.root.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = () => { location.hash = `run/${encodeURIComponent(b.dataset.pick)}`; }));
    this.root.querySelectorAll("button.start").forEach((b) => (b.onclick = () => { b.disabled = true; this.start(b.dataset.rep, b.dataset.action); }));
  }
}
