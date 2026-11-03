// Logs view: one container's stdout and stderr, from its first line, live, filterable.
const escape = (text) => text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const clock = (ns) => new Date(ns / 1e6).toISOString().slice(11, 23); // HH:MM:SS.mmm, UTC like Docker

export class LogsView {
  constructor(root) {
    this.root = root;
    this.selected = null;
    this.filter = "";
  }

  async select(state, id) { // the whole log so far from the backend, then live lines from the stream
    this.selected = id;
    state.logs[id] = await (await fetch(`/api/logs?container=${id}`)).json();
    this.redraw();
  }

  render(state) {
    if (!this.root.querySelector(".logs")) { // build the frame once, so typing in the filter keeps focus
      this.root.innerHTML = `<div class="logs"><div class="picker"></div>
        <input class="filter" placeholder="filter (text or /regex/)"><pre class="lines"></pre></div>`;
      this.root.querySelector(".filter").oninput = (e) => { this.filter = e.target.value; this.render(state); };
    }
    const running = new Set(state.containers.filter((c) => c.state === "running").map((c) => c.id));
    const picker = this.root.querySelector(".picker");
    picker.innerHTML = state.logSources.map((c) => `<button data-id="${c.id}" class="${c.id === this.selected ? "on" : ""}">
      ${c.project}/${c.service}${running.has(c.id) ? "" : " (stopped)"}</button>`).join("");
    picker.querySelectorAll("button").forEach((b) => (b.onclick = () => this.select(state, b.dataset.id)));
    if (!this.selected) { // open the newest engine log, else the newest log
      const first = state.logSources.find((c) => c.service === "server") ?? state.logSources[0];
      if (first) this.select(state, first.id);
      return;
    }

    let keep = () => true;
    if (this.filter.startsWith("/") && this.filter.endsWith("/") && this.filter.length > 2) {
      try { const re = new RegExp(this.filter.slice(1, -1), "i"); keep = (l) => re.test(l.line); } catch { /* typing */ }
    } else if (this.filter) {
      keep = (l) => l.line.toLowerCase().includes(this.filter.toLowerCase());
    }
    const pre = this.root.querySelector(".lines");
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20; // follow the tail unless scrolled up
    pre.innerHTML = (state.logs[this.selected] ?? []).filter(keep).slice(-2000).map((l) =>
      `<span class="${l.stream}"><time>${clock(l.ns)}</time> ${escape(l.line)}</span>`).join("\n");
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }
}
