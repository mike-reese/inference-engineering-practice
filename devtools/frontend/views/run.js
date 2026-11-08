// Run view: pick a registered rep (reps/*/rep.toml), an action and its options, queue it on the host runner, follow it,
// cancel it, open the run. The runner (scripts/runner.py) runs only the commands the manifest declares; this page sends
// a rep id, an action id and option values the runner checks against the manifest's choices and patterns.
// Register: write a rep.toml for a reps/* folder that has .py files and no manifest yet.
import { escape, getJSON, router } from "./util.js";

const fmtTime = (ns) => new Date(ns / 1e6).toLocaleTimeString();
const fmtDay = (ns) => new Date(ns / 1e6).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const seconds = (ns) => { const s = Math.round(ns / 1e9); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; };
const post = async (url, body) => {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  return { ok: r.ok, status: r.status, text: await r.text() };
};
const emptyAction = () => ({ id: "", label: "", script: "", args: "", group: "run", measured: false, minutes: "" });

export class RunView {
  constructor(root) {
    this.root = root;
    this.reps = null; this.running = null; this.queue = []; this.jobs = []; this.job = null; this.selected = null;
    this.rep = null; this.error = null; this.notice = null; this.seenLeft = ""; this.seenRight = "";
    this.values = {}; // "<rep>/<action>" -> {option id: value}; kept across redraws
    this.reg = null; this.unregistered = null; this.regNotice = null;
    this.timer = null; this.ticks = 0;
  }

  open(params) {
    if (params[0]) this.rep = params[0];
    this.selected = params[1] ? Number(params[1]) : null;
    this.seenLeft = this.seenRight = "";
    this.poll();
    this.timer ??= setInterval(() => { if (router.hash().startsWith("#run")) this.poll(); }, 1000);
  }

  async poll() {
    try {
      if (!this.reps || this.ticks++ % 3 === 0 || this.running || this.queue.length) {
        const data = await getJSON("/runner/reps");
        this.reps = data.reps; this.running = data.running; this.queue = data.queued ?? [];
      }
      this.jobs = await getJSON("/runner/jobs?limit=60");
      const shown = this.jobs.find((j) => j.id === this.selected) ?? this.jobs.find((j) => j.state === "running") ?? this.jobs[0];
      this.job = shown ? await getJSON(`/runner/jobs/${shown.id}?tail=400`) : null;
      this.error = null;
    } catch (e) {
      this.error = String(e);
    }
    this.redraw?.();
  }

  options(repId, action) {
    const key = `${repId}/${action.id}`;
    this.values[key] ??= Object.fromEntries((action.options ?? []).map((o) => [o.id, o.default]));
    return this.values[key];
  }

  argv(rep, action) {
    const values = this.options(rep.id, action);
    return [...action.argv, ...(action.options ?? []).flatMap((o) => [o.arg, values[o.id]])];
  }

  async start(repId, actionId) {
    const rep = this.reps.find((r) => r.id === repId);
    const action = rep.actions.find((a) => a.id === actionId);
    const r = await post("/runner/jobs", { rep: repId, action: actionId, options: this.options(repId, action) });
    this.notice = r.ok ? null : `${r.status}: ${r.text}`;
    if (r.ok) this.selected = JSON.parse(r.text).id;
    this.seenLeft = "";
    await this.poll();
  }

  async cancel(id) {
    const r = await post(`/runner/jobs/${id}/cancel`);
    this.notice = r.ok ? null : `${r.status}: ${r.text}`;
    this.seenLeft = "";
    await this.poll();
  }

  optionField(rep, action, o) {
    const value = this.options(rep.id, action)[o.id];
    const attrs = `data-rep="${escape(rep.id)}" data-action="${escape(action.id)}" data-option="${escape(o.id)}" title="${escape(o.description ?? "")}"`;
    const input = o.choices
      ? `<select ${attrs}>${o.choices.map((c) => `<option ${c === value ? "selected" : ""}>${escape(c)}</option>`).join("")}</select>`
      : `<input ${attrs} value="${escape(value)}" size="9" maxlength="32" pattern="${escape(o.pattern?.replace(/^\^|\$$/g, "") ?? "")}">`;
    return `<label class="option">${escape(o.label)} ${input}</label>`;
  }

  actionCard(rep, a, blocked) {
    const badges = [a.group === "run" ? (a.measured ? "measured" : "not measured") : "check",
      a.graphs == null ? null : `CUDA graphs ${a.graphs ? "on" : "off"}`, a.minutes ? `~${a.minutes} min` : null].filter(Boolean);
    const verb = this.running || this.queue.length ? "Queue" : "Start";
    return `<div class="action ${a.measured ? "measured" : ""}">
      <div class="title">${escape(a.label)} <span class="state">${badges.map(escape).join(" · ")}</span></div>
      <div>${escape(a.description ?? "")}</div>
      ${a.options?.length ? `<div class="options">${a.options.map((o) => this.optionField(rep, a, o)).join("")}</div>` : ""}
      <code class="argv" data-preview="${escape(rep.id)}/${escape(a.id)}">${this.argv(rep, a).map(escape).join(" ")}</code>
      <button class="start" data-rep="${escape(rep.id)}" data-action="${escape(a.id)}" ${blocked ? `disabled title="${escape(blocked)}"` : ""}>${verb}</button>
    </div>`;
  }

  repPanel(rep) {
    if (rep.error) return `<p class="err">${escape(rep.error)}</p>`;
    const busy = Object.entries(rep.busy ?? {});
    // The runner refuses only when nothing is running or queued and the rep's containers exist; otherwise it queues.
    const blocked = !this.running && !this.queue.length && busy.length
      ? `containers exist: ${busy.map(([p, n]) => `${p}: ${n.join(", ")}`).join("; ")}` : null;
    const groups = { run: "Runs", check: "Checks and walkthrough" };
    return `<h3>${escape(rep.id)} · ${escape(rep.title ?? "")}</h3>
      <div class="dim">${escape(rep.folder)}/rep.toml · spec ${escape(rep.folder)}/${escape(rep.spec ?? "README.md")}</div>
      ${blocked ? `<div class="banner">Start is off: ${escape(blocked)}</div>` : ""}
      ${this.running ? `<div class="dim">Job ${this.running.id} is running: a new job waits in the queue.</div>` : ""}
      ${Object.entries(groups).map(([g, label]) => {
        const list = rep.actions.filter((a) => (a.group ?? "run") === g);
        return list.length ? `<div class="label">${label}</div><div class="actions">${list.map((a) => this.actionCard(rep, a, blocked)).join("")}</div>` : "";
      }).join("")}`;
  }

  registerPanel() {
    if (!this.reg) {
      return `<div class="label">register</div><button class="regopen">Register a rep folder …</button>
        <span class="dim">writes reps/&lt;folder&gt;/rep.toml for a folder with .py files and no manifest</span>`;
    }
    const folders = this.unregistered ?? [];
    if (!folders.length) {
      return `<div class="label">register</div><p class="dim">${this.unregistered ? "Every reps/* folder with .py files has a rep.toml." : "Asking the runner …"}</p>
        <button class="regclose">Close</button>`;
    }
    const reg = this.reg;
    reg.folder ||= folders[0].folder;
    const scripts = folders.find((f) => f.folder === reg.folder)?.scripts ?? [];
    const field = (name, label, value, extra = "") => `<label>${label} <input data-reg="${name}" value="${escape(value)}" ${extra}></label>`;
    const row = (a, i) => `<div class="regaction">
        <label>id <input data-act="${i}" data-key="id" value="${escape(a.id)}" size="10"></label>
        <label>label <input data-act="${i}" data-key="label" value="${escape(a.label)}" size="18"></label>
        <label>script <select data-act="${i}" data-key="script"><option value=""></option>${scripts.map((s) => `<option ${s === a.script ? "selected" : ""}>${escape(s)}</option>`).join("")}</select></label>
        <label>arguments <input data-act="${i}" data-key="args" value="${escape(a.args)}" size="24" placeholder="--trace off --progress json"></label>
        <label>group <select data-act="${i}" data-key="group">${["run", "check"].map((g) => `<option ${g === a.group ? "selected" : ""}>${g}</option>`).join("")}</select></label>
        <label><input type="checkbox" data-act="${i}" data-key="measured" ${a.measured ? "checked" : ""}> measured</label>
        <label>minutes <input data-act="${i}" data-key="minutes" value="${escape(a.minutes)}" size="3"></label>
        ${reg.actions.length > 1 ? `<button data-dropact="${i}">remove</button>` : ""}
      </div>`;
    return `<div class="label">register a rep folder</div><div class="register">
      <label>folder <select data-reg="folder">${folders.map((f) => `<option ${f.folder === reg.folder ? "selected" : ""}>${escape(f.folder)}</option>`).join("")}</select></label>
      ${field("id", "rep id", reg.id, 'size="10" placeholder="I02B-L1"')}
      ${field("title", "title", reg.title, 'size="24"')}
      ${field("projects", "compose projects", reg.projects, 'size="28" placeholder="ie-i02b-l1, ie-i02b-l1-test"')}
      <div class="dim">The runner refuses a job while a container of these projects exists, and takes them down on cancel.
        A test_*.py script runs under pytest; any other under python. Arguments: A-Z a-z 0-9 _ . , = : / + - only.</div>
      ${reg.actions.map(row).join("")}
      <div><button class="regadd">Add action</button> <button class="regsend">Write rep.toml</button> <button class="regclose">Close</button></div>
      ${this.regNotice ? `<pre class="${this.regNotice.ok ? "regok" : "err"}">${escape(this.regNotice.text)}</pre>` : ""}
    </div>`;
  }

  async openRegister() {
    this.reg = { folder: "", id: "", title: "", projects: "", actions: [emptyAction()] };
    this.regNotice = null; this.unregistered = null; this.seenLeft = ""; this.redraw?.();
    try { this.unregistered = await getJSON("/runner/unregistered"); } catch (e) { this.regNotice = { ok: false, text: String(e) }; }
    this.seenLeft = ""; this.redraw?.();
  }

  async register() {
    const reg = this.reg;
    const body = {
      folder: reg.folder, id: reg.id.trim(), title: reg.title.trim(),
      compose_projects: reg.projects.split(/[\s,]+/).filter(Boolean),
      actions: reg.actions.map((a) => ({ id: a.id.trim(), label: a.label.trim(), script: a.script, group: a.group,
        measured: a.measured, args: a.args.split(/\s+/).filter(Boolean), ...(a.minutes ? { minutes: Number(a.minutes) } : {}) })),
    };
    const r = await post("/runner/register", body);
    if (r.ok) {
      const data = JSON.parse(r.text);
      this.regNotice = { ok: true, text: `wrote ${data.file}\n\n${data.text}` };
      this.rep = body.id; this.reps = null;
      this.unregistered = await getJSON("/runner/unregistered").catch(() => []);
    } else {
      this.regNotice = { ok: false, text: `${r.status}: ${r.text}` };
    }
    this.seenLeft = "";
    await this.poll();
  }

  jobPanel(job) {
    if (!job) return "<p class=dim>No job yet. Start one on the left; it runs on the host and shows here.</p>";
    const now = job.ended_ns ?? Date.now() * 1e6;
    const steps = job.progress.filter((p) => p.step !== "run").map((p, i, all) => {
      const next = all[i + 1]?.wall_ns ?? (job.state === "running" ? now : job.ended_ns);
      const live = !all[i + 1] && job.state === "running";
      return `<li class="${live ? "live" : ""}">${escape(p.step)}${p.note ? ` <span class="dim">(${escape(p.note)})</span>` : ""}
        <span class="dim">${fmtTime(p.wall_ns)} · ${seconds((next ?? p.wall_ns) - p.wall_ns)}${live ? " so far" : ""}</span></li>`;
    }).join("");
    const state = job.state === "running" ? `running ${seconds(now - job.started_ns)}`
      : job.state === "queued" ? `queued since ${fmtTime(job.queued_ns)}`
      : job.started_ns && job.ended_ns ? `${job.state}${job.exit != null ? ` (exit ${job.exit})` : ""} after ${seconds(job.ended_ns - job.started_ns)}`
      : job.state;
    const options = Object.entries(job.options ?? {});
    return `<div class="jobhead"><b>job ${job.id}: ${escape(job.rep)} · ${escape(job.label)}</b> <span class="jobstate ${job.state}">${escape(state)}</span>
        ${["running", "queued"].includes(job.state) ? `<button class="cancel" data-cancel="${job.id}">Cancel</button>` : ""}</div>
      ${job.note ? `<div class="banner">${escape(job.note)}</div>` : ""}
      ${options.length ? `<div class="dim">options: ${options.map(([k, v]) => `${escape(k)} = <b>${escape(v)}</b>`).join(" · ")}</div>` : ""}
      <code class="argv">${job.argv.map(escape).join(" ")}</code>
      <div class="joblinks">${job.run_id ? `run <b>${escape(job.run_id)}</b> · <a href="#trace/${encodeURIComponent(job.run_id)}">open in Trace</a> · <a href="#compare/${encodeURIComponent(job.run_id)}">compare</a> · <a href="#tools/${encodeURIComponent(job.run_id)}">files</a> · ` : ""}
        watch: <a href="#lifecycle">Lifecycle</a> · <a href="#infra">Infrastructure</a> · <a href="#logs">Logs</a> · <a href="#requests">Requests</a></div>
      ${steps ? `<div class="label">steps</div><ol class="steps">${steps}</ol>` : ""}
      ${job.state === "running" && this.logProgress ? `<div class="logprogress">${escape(this.logProgress)}</div>` : ""}
      <div class="label">output (last ${job.lines.length} lines${job.state === "running" ? "" : ", as saved"})</div>
      <pre class="joblog">${job.lines.map(escape).join("\n")}</pre>`;
  }

  historyPanel() {
    if (!this.jobs.length) return "";
    const shown = this.job?.id;
    return `<div class="label">jobs (kept across runner restarts)</div><table class="history">${this.jobs.map((j) => {
      const when = j.started_ns ?? j.queued_ns;
      return `<tr class="${j.id === shown ? "on" : ""}"><td><a href="#run/${encodeURIComponent(this.rep ?? j.rep)}/${j.id}">job ${j.id}</a></td>
        <td>${when ? fmtDay(when) : ""}</td><td>${escape(j.rep)} · ${escape(j.label)}</td>
        <td class="jobstate ${j.state}">${escape(j.state)}</td>
        <td>${j.run_id ? `<a href="#trace/${encodeURIComponent(j.run_id)}">${escape(j.run_id)}</a>` : ""}</td>
        <td>${["running", "queued"].includes(j.state) ? `<button class="cancel" data-cancel="${j.id}">Cancel</button>` : ""}</td></tr>`;
    }).join("")}</table>`;
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
    if (this.error && !this.reps) {
      this.root.innerHTML = `<p class="err">The runner is not answering: ${escape(this.error)}</p>
        <p>Start it with <code>make devtools</code> (or <code>make runner</code>) from the repo.</p>`;
      this.seenLeft = this.seenRight = "";
      return;
    }
    if (!this.reps) { this.root.innerHTML = "<p>Asking the runner …</p>"; this.seenLeft = this.seenRight = ""; return; }
    if (!this.root.querySelector(".runview")) {
      this.root.innerHTML = `<div class="runview"><section class="reps"></section><section class="job"></section></div>`;
      this.seenLeft = this.seenRight = "";
    }
    const rep = this.reps.find((r) => r.id === this.rep) ?? this.reps[0];
    this.logProgress = this.logLine(state, this.reps.find((r) => r.id === this.running?.rep) ?? rep);
    this.renderLeft(rep);
    this.renderRight();
  }

  // The left side holds form fields: it redraws only when what it shows changes, and never under a focused field.
  renderLeft(rep) {
    const left = this.root.querySelector("section.reps");
    const key = JSON.stringify([this.reps, this.running?.id, this.queue.map((j) => j.id), this.notice, this.error, this.rep,
      this.reg, this.unregistered, this.regNotice]);
    if (key === this.seenLeft || left.contains(document.activeElement) && document.activeElement.matches("input, select")) return;
    this.seenLeft = key;
    left.innerHTML = `<div class="label">registered reps</div>
      <div class="picker">${this.reps.map((r) => `<button class="${r === rep ? "on" : ""}" data-pick="${escape(r.id)}">${escape(r.id)}</button>`).join("")}</div>
      ${this.notice ? `<p class="err">${escape(this.notice)}</p>` : ""}
      ${this.error ? `<p class="err">${escape(this.error)}</p>` : ""}
      ${rep ? this.repPanel(rep) : "<p>No reps registered yet.</p>"}
      ${this.registerPanel()}`;
    left.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = () => { router.go(`run/${encodeURIComponent(b.dataset.pick)}`); }));
    left.querySelectorAll("button.start").forEach((b) => (b.onclick = () => { b.disabled = true; this.start(b.dataset.rep, b.dataset.action); }));
    left.querySelectorAll("[data-option]").forEach((el) => (el.oninput = () => {
      const d = el.dataset;
      const r = this.reps.find((x) => x.id === d.rep);
      const a = r.actions.find((x) => x.id === d.action);
      this.options(d.rep, a)[d.option] = el.value;
      left.querySelector(`[data-preview="${CSS.escape(`${d.rep}/${d.action}`)}"]`).textContent = this.argv(r, a).join(" ");
    }));
    left.querySelector(".regopen")?.addEventListener("click", () => this.openRegister());
    left.querySelectorAll(".regclose").forEach((b) => (b.onclick = () => { this.reg = null; this.redraw?.(); }));
    left.querySelector(".regadd")?.addEventListener("click", () => { this.reg.actions.push(emptyAction()); this.redraw?.(); });
    left.querySelector(".regsend")?.addEventListener("click", () => this.register());
    left.querySelectorAll("[data-dropact]").forEach((b) => (b.onclick = () => { this.reg.actions.splice(+b.dataset.dropact, 1); this.redraw?.(); }));
    left.querySelectorAll("[data-reg]").forEach((el) => (el.oninput = () => {
      this.reg[el.dataset.reg] = el.value;
      if (el.dataset.reg === "folder") { this.reg.actions.forEach((a) => (a.script = "")); el.blur(); this.redraw?.(); }
    }));
    left.querySelectorAll("[data-act]").forEach((el) => (el.oninput = el.onchange = () => {
      this.reg.actions[+el.dataset.act][el.dataset.key] = el.type === "checkbox" ? el.checked : el.value;
    }));
    this.bindCancel(left);
  }

  renderRight() {
    const right = this.root.querySelector("section.job");
    const key = JSON.stringify([this.job, this.jobs, this.logProgress, this.job?.state === "running" ? Math.floor(Date.now() / 1000) : 0]);
    if (key === this.seenRight) return;
    this.seenRight = key;
    const log = right.querySelector(".joblog");
    const atBottom = !log || log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
    right.innerHTML = `${this.jobPanel(this.job)}${this.historyPanel()}`;
    const newLog = right.querySelector(".joblog");
    if (newLog && atBottom) newLog.scrollTop = newLog.scrollHeight;
    this.bindCancel(right);
  }

  bindCancel(el) {
    el.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = () => {
      if (!confirm(`Cancel job ${b.dataset.cancel}? A running job gets SIGINT, its stack is taken down.`)) return;
      b.disabled = true; this.cancel(b.dataset.cancel);
    }));
  }
}
