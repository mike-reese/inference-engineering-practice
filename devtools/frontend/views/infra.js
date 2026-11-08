
// Infrastructure view, zoom level 0: projects -> networks -> containers, and the host's GPU.
import { router } from "./util.js";
const MiB = 1024 * 1024;
const fmt = {
  pct: (v) => (v == null ? "–" : `${v.toFixed(0)} %`),
  mib: (bytes) => `${(bytes / MiB).toFixed(0)} MiB`,
  gib: (mib) => `${(mib / 1024).toFixed(2)} GiB`,
  rate: (bps) => (bps == null ? "–" : bps < 1024 ? `${bps.toFixed(0)} B/s` : `${(bps / 1024).toFixed(1)} KiB/s`),
  time: (ns) => new Date(ns / 1e6).toLocaleTimeString(),
};

function spark(values = [], max) {
  const points = values.map((v, i) => `${i},${30 - (30 * (v ?? 0)) / (max || Math.max(...values, 1))}`);
  return `<svg class="spark" viewBox="0 0 120 30" preserveAspectRatio="none"><polyline points="${points.join(" ")}"/></svg>`;
}

function bar(fraction) {
  return `<span class="bar"><span style="width:${Math.min(100, 100 * fraction).toFixed(1)}%"></span></span>`;
}

function status(c) {
  if (c.state !== "running") return ["down", c.state];
  if (c.health === "starting") return ["starting", "starting"];
  if (c.health === "unhealthy") return ["down", "unhealthy"];
  return ["up", c.health ?? "running"];
}

function card(c, s, held, history, byId) {
  const [cls, label] = status(c);
  const net = c.shares_netns_with
    ? `uses the network namespace of <b>${byId[c.shares_netns_with]?.service ?? c.shares_netns_with}</b>`
    : `↓ ${fmt.rate(s?.rx_rate)} ↑ ${fmt.rate(s?.tx_rate)} · ${Object.values(c.networks).join(", ")}`;
  const gpu = held.map((p) => `<div class="gpuheld">GPU ${fmt.gib(p.mib)} · ${p.program} pid ${p.pid}</div>`).join("");
  return `<div class="card ${cls}" data-id="${c.id}" data-project="${c.project}" data-service="${c.service}"
    title="open the components inside this container">
    <div class="title"><i class="dot"></i>${c.service}<span class="state">${label}</span></div>
    <div class="image">${c.image}</div>
    ${s ? `<div class="row">CPU ${fmt.pct(s.cpu_pct)} ${spark(history[`cpu:${c.id}`])}</div>
    <div class="row">mem ${fmt.mib(s.mem_bytes)} / ${fmt.mib(s.mem_limit)} ${bar(s.mem_bytes / s.mem_limit)}</div>` : ""}
    <div class="row net">${net}</div>
    ${c.ports.map((p) => `<div class="port">host ${p}</div>`).join("")}
    ${gpu}
  </div>`;
}

function project(name, containers, state, byId) {
  const networks = {};
  for (const c of containers) {
    if (c.shares_netns_with) continue; // drawn next to the container whose netns it uses
    const net = Object.keys(c.networks)[0] ?? "none";
    (networks[net] ??= []).push(c, ...containers.filter((o) => o.shares_netns_with === c.id));
  }
  const boxes = Object.entries(networks).map(([net, members]) => `<div class="network">
      <div class="label">network ${net}</div>
      <div class="cards">${members.map((c) => card(c, state.stats[c.id],
        state.gpuProcesses.filter((p) => p.container === c.id), state.history, byId)).join("")}</div>
    </div>`);
  return `<section class="project"><div class="label">project ${name}</div>${boxes.join("")}</section>`;
}

function gpuPanel(g, processes, history, byId) {
  if (!g) return `<section class="gpu" id="gpu">GPU: waiting for nvidia-smi</section>`;
  const used = g["memory.used"], total = g["memory.total"];
  const rows = [
    ["memory", `${fmt.gib(used)} / ${fmt.gib(total)}`, bar(used / total), spark(history["memory.used"], total)],
    ["any kernel running", fmt.pct(g.sm_busy_pct), bar((g.sm_busy_pct ?? 0) / 100), spark(history.sm_busy_pct, 100)],
    ["memory read/write", fmt.pct(g.mem_busy_pct), bar((g.mem_busy_pct ?? 0) / 100), spark(history.mem_busy_pct, 100)],
    ["power", `${g["power.draw"]} / ${g["power.limit"]} W`, bar(g["power.draw"] / g["power.limit"]), spark(history["power.draw"], g["power.limit"])],
    ["PCIe", `gen ${g["pcie.link.gen.current"]} x${g["pcie.link.width.current"]} · ↓ ${g.pcie_rx_mb_s ?? "–"} ↑ ${g.pcie_tx_mb_s ?? "–"} MB/s`, "", spark(history.pcie_rx_mb_s)],
    ["clocks", `SM ${g["clocks.sm"]}/${g["clocks.max.sm"]} · mem ${g["clocks.mem"]}/${g["clocks.max.mem"]} MHz`, "", ""],
    ["temperature", `${g["temperature.gpu"]} °C`, "", ""],
  ];
  const holders = processes.map((p) => `<li>${fmt.gib(p.mib)} · ${p.program} · ${p.container ? byId[p.container]?.name ?? p.container : "host"}</li>`);
  return `<section class="gpu" id="gpu"><div class="label">host GPU · nvidia-smi, 1 s samples</div>
    <table>${rows.map((r) => `<tr><th>${r[0]}</th><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td></tr>`).join("")}</table>
    <div class="label">GPU memory held by</div><ul>${holders.join("")}</ul></section>`;
}

export class InfraView {
  constructor(root) { this.root = root; }

  render(state) {
    const byId = Object.fromEntries(state.containers.map((c) => [c.id, c]));
    const projects = {};
    for (const c of state.containers) (projects[c.project] ??= []).push(c);
    const events = state.events.slice().reverse().map((e) =>
      `<li><time>${fmt.time(e.time_ns ? e.time_ns : e.wall_ns)}</time> ${e.container ?? e.source} · ${e.action}</li>`);
    this.root.innerHTML = `<div class="infra">
      <div class="projects">${Object.entries(projects).map(([n, cs]) => project(n, cs, state, byId)).join("")
        || "<p>No Compose containers. Start a stack.</p>"}</div>
      <div class="side">${gpuPanel(state.gpu, state.gpuProcesses, state.history, byId)}
        <section class="events"><div class="label">events</div><ul>${events.join("")}</ul></section></div>
      <svg class="links"></svg></div>`;
    this.drawLinks(state);
    this.root.querySelectorAll(".card[data-service]").forEach((card) => (card.onclick = () => {
      router.go(`components/${encodeURIComponent(card.dataset.project)}/${encodeURIComponent(card.dataset.service)}`);
    }));
  }

  drawLinks(state) { // a line from each container that holds GPU memory to the GPU panel
    const svg = this.root.querySelector("svg.links");
    const origin = this.root.querySelector(".infra").getBoundingClientRect();
    const gpu = this.root.querySelector("#gpu").getBoundingClientRect();
    const holders = new Set(state.gpuProcesses.map((p) => p.container));
    svg.innerHTML = [...holders].map((id) => {
      const el = this.root.querySelector(`.card[data-id="${id}"]`);
      if (!el) return "";
      const r = el.getBoundingClientRect();
      const x1 = r.right - origin.left, y1 = r.top + r.height / 2 - origin.top;
      const x2 = gpu.left - origin.left, y2 = gpu.top + 30 - origin.top;
      return `<path d="M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}"/>`;
    }).join("");
  }
}
