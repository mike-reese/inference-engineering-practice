// Compare view: two or more runs side by side (#compare/<run A>/<run B>/...). The first run is the baseline: every
// other column shows its difference from it. Values come from each run's run.json (/api/runs/<id>), the same numbers
// the Trace view shows; nothing is recomputed here.
import { escape, getJSON, router } from "./util.js";

const fixed = (v, d) => Number(v).toFixed(d);
const FORMAT = { // unit -> [shown unit, scale, digits]
  ms: ["ms", 1, 2], byte: ["MB", 1e-6, 1], "byte/s": ["GB/s", 1e-9, 1], fraction: ["%", 100, 1],
  FLOP: ["GFLOP", 1e-9, 1], "FLOP/s": ["GFLOP/s", 1e-9, 1], "token/s": ["token/s", 1, 1],
};
const shown = (unit) => FORMAT[unit] ?? [unit, 1, 2];
const LOWER_IS_BETTER = new Set(["ms"]); // a time that grows is red; other units have no better direction here

const ROLES = ["measured", "warmup"];

function cell(value, base, unit, isBase) {
  if (value == null) return "<td class=dim>–</td>";
  const [, scale, digits] = shown(unit);
  let delta = "";
  if (!isBase && base != null) {
    const diff = (value - base) * scale;
    const pct = base ? ((value - base) / Math.abs(base)) * 100 : null;
    const dir = LOWER_IS_BETTER.has(unit) && Math.abs(pct ?? 0) >= 1 ? (diff > 0 ? "up" : "down") : "";
    delta = `<span class="delta ${dir}">${diff >= 0 ? "+" : ""}${fixed(diff, digits)}${pct != null ? ` (${pct >= 0 ? "+" : ""}${fixed(pct, 0)} %)` : ""}</span>`;
  }
  return `<td>${fixed(value * scale, digits)}${delta}</td>`;
}

export class CompareView {
  constructor(root) {
    this.root = root;
    this.ids = []; this.data = {}; this.errors = {}; this.role = "measured"; this.seen = "";
  }

  open(params) {
    this.ids = params.filter(Boolean);
    this.seen = "";
    for (const id of this.ids) this.load(id);
  }

  async load(id) {
    if (this.data[id] || this.errors[id] === "loading") return;
    this.errors[id] = "loading";
    try {
      this.data[id] = await getJSON(`/api/runs/${encodeURIComponent(id)}`);
      delete this.errors[id];
    } catch (e) {
      this.errors[id] = String(e);
    }
    this.seen = "";
    this.redraw?.();
  }

  go(ids) { router.go(["compare", ...ids].map(encodeURIComponent).join("/")); }

  // Newest measured run (trace off) and newest no-graphs run: the pair that shows what CUDA graphs save.
  suggestion(runs) {
    const measured = runs.find((r) => r.labels?.measured || (r.labels?.trace ?? "off") === "off");
    const nographs = runs.find((r) => r.labels?.trace === "nographs");
    return measured && nographs ? [measured.run_id, nographs.run_id] : null;
  }

  picker(runs) {
    const free = runs.filter((r) => !this.ids.includes(r.run_id));
    const pair = this.suggestion(runs);
    return `<div class="pick">
      ${this.ids.map((id, i) => `<span class="chip">${i === 0 ? "baseline " : ""}<b>${escape(id)}</b>
        <button data-drop="${i}" title="remove">×</button>${i > 0 ? `<button data-first="${i}" title="make baseline">↑</button>` : ""}</span>`).join("")}
      <select class="add"><option value="">add a run …</option>${free.map((r) =>
        `<option value="${escape(r.run_id)}">${escape(r.run_id)} · ${escape(r.labels?.trace ?? "off")}${r.labels?.graphs === false ? " · graphs off" : ""}</option>`).join("")}</select>
      ${pair ? `<button class="suggest" title="${escape(pair.join(" vs "))}">newest measured vs newest no-graphs</button>` : ""}
      <span class="dim">request:</span>${ROLES.map((r) => `<button class="role ${r === this.role ? "on" : ""}" data-role="${r}">${r}</button>`).join("")}
    </div>`;
  }

  labelsTable(ids) {
    const keys = ["trace", "measured", "graphs", "profiler", "profile_range"];
    const opts = [...new Set(ids.flatMap((id) => Object.keys(this.data[id]?.labels?.options ?? {})))];
    const row = (name, get) => `<tr><td>${escape(name)}</td>${ids.map((id) => {
      const v = this.data[id] ? get(this.data[id]) : null;
      return `<td>${v == null ? "<span class=dim>–</span>" : escape(String(v))}</td>`;
    }).join("")}</tr>`;
    return `<div class="label">what each run is</div><table><tr><th></th>${ids.map((id) => `<th><a href="#trace/${encodeURIComponent(id)}">${escape(id)}</a></th>`).join("")}</tr>
      ${keys.map((k) => row(k, (d) => d.labels?.[k])).join("")}
      ${opts.map((k) => row(`option ${k}`, (d) => d.labels?.options?.[k])).join("")}
      ${row("GPU", (d) => d.topology?.gpu?.name)}
      ${row("profiles", (d) => Object.keys(d.profiles ?? {}).join(", ") || null)}</table>
      ${ids.some((id) => this.data[id]?.labels?.measured === false) ? `<div class="dim">A run labeled measured = false had a profiler
        or a changed engine setting: its times describe that setup, not the engine as served.</div>` : ""}`;
  }

  metricsTable(ids) {
    const byRun = Object.fromEntries(ids.map((id) => {
      const d = this.data[id];
      const want = `${id}-${this.role}`;
      return [id, Object.fromEntries((d?.metrics ?? []).filter((m) => m.request_id === want).map((m) => [m.name, m]))];
    }));
    const names = [...new Set(ids.flatMap((id) => Object.keys(byRun[id])))];
    if (!names.length) return `<p class="dim">No ${this.role} request metrics in these runs.</p>`;
    const base = byRun[ids[0]];
    return `<div class="label">${this.role} request · difference from the baseline in small type (red: a time grew by 1 % or more; green: it shrank)</div>
      <table><tr><th>metric</th><th>unit</th>${ids.map((id) => `<th>${escape(id)}</th>`).join("")}</tr>
      ${names.map((name) => {
        const unit = ids.map((id) => byRun[id][name]?.unit).find(Boolean);
        const formula = ids.map((id) => byRun[id][name]?.formula).find(Boolean);
        return `<tr><td title="${escape(formula ?? "")}">${escape(name)}</td><td>${escape(shown(unit)[0])}</td>
          ${ids.map((id, i) => cell(byRun[id][name]?.value, base[name]?.value, unit, i === 0)).join("")}</tr>`;
      }).join("")}</table>`;
  }

  ncuTable(ids) {
    const withNcu = ids.filter((id) => this.data[id]?.profiles?.ncu);
    if (!withNcu.length) return "";
    const stats = (ncu) => {
      const ks = ncu.kernels ?? [];
      const sum = (f) => ks.reduce((t, k) => t + (k[f] ?? 0), 0);
      const top = [...ks].sort((p, q) => (q.duration ?? 0) - (p.duration ?? 0))[0];
      return { iteration: ncu.iteration, kernels: ks.length, "duration under replay (ms)": fixed(sum("duration") / 1000, 3),
        "DRAM read (MB)": fixed((ncu.dram_read_bytes ?? sum("dram_read_bytes")) / 1e6, 1),
        "DRAM write (MB)": fixed(sum("dram_write_bytes") / 1e6, 1), "CUDA graphs": ncu.graphs,
        "longest kernel": top ? `#${top.id} ${top.name.slice(0, 48)} (${fixed(top.duration, 1)} µs)` : null, note: ncu.note };
    };
    const rows = Object.fromEntries(withNcu.map((id) => [id, stats(this.data[id].profiles.ncu)]));
    const keys = Object.keys(rows[withNcu[0]]);
    return `<div class="label">Nsight Compute (each kernel replayed; not on the run clock)</div>
      <table><tr><th></th>${withNcu.map((id) => `<th><a href="#trace/${encodeURIComponent(id)}">${escape(id)}</a></th>`).join("")}</tr>
      ${keys.map((k) => `<tr><td>${escape(k)}</td>${withNcu.map((id) => `<td>${escape(String(rows[id][k] ?? "–"))}</td>`).join("")}</tr>`).join("")}</table>`;
  }

  render(state) {
    const runs = Object.values(state.runs ?? {}).sort((a, b) => b.mtime - a.mtime);
    const key = JSON.stringify([this.ids, this.role, runs.map((r) => r.run_id), Object.keys(this.data), this.errors]);
    if (key === this.seen && this.root.querySelector(".compareview")) return;
    this.seen = key;
    const ready = this.ids.filter((id) => this.data[id]);
    const errors = Object.entries(this.errors).filter(([id, e]) => this.ids.includes(id) && e !== "loading");
    this.root.innerHTML = `<div class="compareview">
      <h3>Compare runs</h3>
      ${this.picker(runs)}
      ${errors.map(([id, e]) => `<p class="err">${escape(id)}: ${escape(e)}</p>`).join("")}
      ${this.ids.length < 2 ? `<p class="dim">Pick two or more runs. The first is the baseline. A measured run against a no-graphs run shows what CUDA graphs save per token.</p>` : ""}
      ${ready.length ? this.labelsTable(ready) + this.metricsTable(ready) + this.ncuTable(ready) : ""}
    </div>`;
    const r = this.root;
    r.querySelector("select.add").onchange = (e) => { if (e.target.value) this.go([...this.ids, e.target.value]); };
    r.querySelector("button.suggest")?.addEventListener("click", () => this.go(this.suggestion(runs)));
    r.querySelectorAll("[data-drop]").forEach((b) => (b.onclick = () => this.go(this.ids.filter((_, i) => i !== +b.dataset.drop))));
    r.querySelectorAll("[data-first]").forEach((b) => (b.onclick = () => {
      const i = +b.dataset.first; this.go([this.ids[i], ...this.ids.filter((_, j) => j !== i)]);
    }));
    r.querySelectorAll("[data-role]").forEach((b) => (b.onclick = () => { this.role = b.dataset.role; this.redraw?.(); }));
  }
}
