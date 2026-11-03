// Lifecycle view: each engine container's life on one time axis: phases from its log, Docker events, GPU samples.
const COLORS = ["#58a6ff", "#3fb950", "#d29922", "#bc8cff", "#f778ba", "#39c5cf", "#e3b341", "#8b949e"];
const W = 1000; // SVG units across; the SVG scales to the page width
const escape = (text) => text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const seconds = (ns) => (ns / 1e9).toFixed(2);

function phases(life, events, now) {
  // A phase runs from its mark to the next one; the last runs until the container stops, or until now.
  // Times here are for drawing only: ns since 1970 lose a few hundred ns as JavaScript numbers.
  const stopped = events.find((e) => e.container === life.container && ["die", "kill", "stop"].includes(e.action));
  const end = stopped?.time_ns ?? now;
  return life.marks.map((m, i) => ({ ...m, end: life.marks[i + 1]?.ns ?? end }));
}

function lane(samples, start, end, field, max, y, height) { // one GPU series as a line under the phases
  const x = (ns) => ((ns - start) / (end - start)) * W;
  const points = samples.filter((s) => s.ns >= start && s.ns <= end && s[field] != null)
    .map((s) => `${x(s.ns).toFixed(1)},${(y + height - (height * s[field]) / max).toFixed(1)}`);
  return `<polyline class="gpuline" points="${points.join(" ")}"/>`;
}

export class LifecycleView {
  constructor(root) {
    this.root = root;
    this.open = null; // {id, index}: the phase whose raw lines are shown
    this.lines = [];
  }

  async show(id, index) { // the raw log lines inside one phase, cut by the backend on exact times
    this.open = { id, index };
    this.lines = await (await fetch(`/api/lifecycle/lines?container=${id}&index=${index}`)).json();
    this.redraw();
  }

  render(state) {
    const now = Date.now() * 1e6;
    const entries = Object.entries(state.lifecycles).sort((a, b) => b[1].marks[0].ns - a[1].marks[0].ns);
    if (!entries.length) {
      this.root.innerHTML = "<p>No engine container seen yet. Start a stack (make rep).</p>";
      return;
    }
    this.root.innerHTML = entries.map(([id, life]) => {
      const list = phases(life, state.events, now);
      const start = list[0].ns, end = Math.max(list.at(-1).end, start + 1e9);
      const x = (ns) => ((ns - start) / (end - start)) * W;
      const total = state.gpu?.["memory.total"] ?? 16000;
      const bars = list.map((p, i) => {
        const x0 = x(p.ns), width = Math.max(x(p.end) - x0, 1);
        const label = width > 70 ? `<text x="${x0 + 4}" y="22">${escape(p.phase)}</text>` : "";
        return `<g class="phase" data-i="${i}"><rect x="${x0}" y="4" width="${width}" height="28" fill="${COLORS[i % COLORS.length]}">
          <title>${escape(p.phase)}: ${seconds(p.end - p.ns)} s</title></rect>${label}</g>`;
      }).join("");
      const rows = list.map((p, i) => `<tr data-i="${i}" class="${this.open?.id === id && this.open.index === i ? "on" : ""}">
        <td><i style="background:${COLORS[i % COLORS.length]}"></i>${escape(p.phase)}</td>
        <td>${seconds(p.ns - start)}</td><td>${seconds(p.end - p.ns)}</td><td>${p.values.join(", ")}</td>
        <td class="raw">${escape(p.line).slice(0, 140)}</td></tr>`).join("");
      const raw = this.open?.id === id
        ? `<pre class="lines">${this.lines.map((l) => escape(l.line)).join("\n") || "(no lines)"}</pre>` : "";
      return `<section class="life" data-id="${id}">
        <div class="label">${escape(life.project)} / ${escape(life.container)} · ${seconds(end - start)} s shown</div>
        <svg viewBox="0 0 ${W} 130" preserveAspectRatio="none" class="lanes">${bars}
          <text class="lanelabel" x="2" y="50">GPU memory (0–${(total / 1024).toFixed(0)} GiB)</text>
          ${lane(state.gpuHistory, start, end, "memory.used", total, 54, 34)}
          <text class="lanelabel" x="2" y="100">any kernel running (0–100 %)</text>
          ${lane(state.gpuHistory, start, end, "sm_busy_pct", 100, 104, 24)}</svg>
        <table class="phases"><tr><th>phase</th><th>starts, s</th><th>takes, s</th><th>values</th><th>marker line</th></tr>
        ${rows}</table>${raw}</section>`;
    }).join("");
    for (const section of this.root.querySelectorAll(".life")) {
      section.querySelectorAll("[data-i]").forEach((el) => (el.onclick = () => this.show(section.dataset.id, +el.dataset.i)));
    }
  }
}
