// Rep world: the run's overview. What the rep does and teaches, what came out (one run, or two side by side in
// compare), and its key moments: each one jumps the replay to where the lesson can be seen.
import { state, subscribe, select, setTier, setWorld, store } from "../control/control.js";
import { repOf, runOf, kindOf, whenOf, valueAt, ttftSegments, fmtMs, esc, md, lessonsOf } from "../session.js";

/** The first row, in time order, of the moments' request (moments.toml `request`, a request id suffix) whose name
 *  starts with the moment's `event`: the moments lint's rule (store/reps.py). -1 when the run has none. */
function eventRow(S, event, suffix) {
  const req = S.requests.findIndex((r) => r.endsWith(suffix));
  if (req < 0) return -1;
  const named = new Set(); S.names.forEach((_, i) => { if (S.nameText(i).startsWith(event)) named.add(i); });
  for (const id of S.allRows) if (S.field("req", id) === req && named.has(S.field("name", id))) return id;
  return -1;
}
const CLOCKS = [["client", "#7cc4ff"], ["wire", "#58d68d"], ["engine", "#f5a623"]];
const ROWS = [
  ["TTFT", { client: "client.ttft_ms", wire: "wire.ttft_ms", engine: "engine.ttft_ms" }],
  ["Mean ITL", { client: "client.mean_itl_ms", wire: "wire.mean_itl_ms", engine: "engine.mean_itl_ms" }],
  ["End-to-end", { client: "client.e2e_ms", wire: "wire.done_ms", engine: "engine.e2e_ms" }],
];
const SEG_COL = { "client → pcap": "#7cc4ff", "pcap → engine": "#58d68d", engine: "#f5a623", "engine → pcap": "#58d68d", "pcap → client": "#7cc4ff" };

const CSS = `
.rw { position:absolute; inset:0; overflow:auto; background:#070a10; color:#dbe4f0; font:14px/1.45 system-ui, sans-serif; }
.rw .in { max-width:1700px; margin:0 auto; padding:18px 22px 40px; display:grid; grid-template-columns:minmax(0,1.15fr) minmax(0,1fr); gap:18px 28px; }
.rw .top { grid-column:1 / -1; display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; border-bottom:1px solid #263041; padding-bottom:10px; }
.rw .top h1 { margin:0; font-size:26px; } .rw .top .id { color:#7d8ba0; font-size:15px; }
.rw .chip { font-size:12px; padding:2px 8px; border-radius:10px; border:1px solid #3a475c; color:#cfd8e6; white-space:nowrap; }
.rw .chip.live { border-color:#f85149; color:#ff7b72; } .rw .chip.ok { border-color:#2f6b55; color:#58d68d; } .rw .chip.cmp { border-color:#b58cff; color:#d2b8ff; }
.rw h2 { margin:0 0 8px; font-size:13px; text-transform:uppercase; letter-spacing:.6px; color:#8fa3bd; }
.rw section { background:#0d121b; border:1px solid #1d2635; border-radius:8px; padding:12px 14px; min-width:0; }
.rw .lead { font-size:16px; line-height:1.5; } .rw .lead p { margin:0 0 6px; }
.rw .muted { color:#7d8ba0; } .rw code { font:12.5px ui-monospace, monospace; color:#cfe3ff; }
.rw .mom { display:grid; grid-template-columns:28px 1fr auto; gap:4px 10px; padding:10px 0; border-top:1px solid #1d2635; }
.rw .mom:first-of-type { border-top:0; }
.rw .mom .n { width:24px; height:24px; border-radius:12px; background:#1b2a40; color:#7cc4ff; display:grid; place-items:center; font-weight:700; font-size:13px; }
.rw .mom .t { font-weight:700; font-size:15px; } .rw .mom .ls { color:#c39bff; font-size:12.5px; }
.rw .mom .nt { grid-column:2 / 4; color:#aab6c8; font-size:13.5px; }
.rw .mom .ev { grid-column:2 / 4; display:flex; flex-wrap:wrap; gap:6px 18px; font:12.5px ui-monospace, monospace; }
.rw .mom .ev b { color:#fff; font-weight:600; } .rw .mom .ev .b { color:#d2b8ff; }
.rw button.go { background:#1b2a40; color:#cfe3ff; border:1px solid #2e4a6e; border-radius:6px; padding:4px 10px; font:inherit; font-size:13px; cursor:pointer; white-space:nowrap; align-self:start; }
.rw button.go:hover { background:#25406a; }
.rw table.res { border-collapse:collapse; width:100%; font:13px ui-monospace, monospace; }
.rw table.res th, .rw table.res td { padding:5px 8px; text-align:right; border-bottom:1px solid #1d2635; white-space:nowrap; }
.rw table.res th:first-child, .rw table.res td:first-child { text-align:left; } .rw table.res th { color:#8fa3bd; font-weight:600; }
.rw .up { color:#ff7b72; } .rw .down { color:#58d68d; }
.rw .seg { display:flex; height:30px; border-radius:5px; overflow:hidden; margin:6px 0 2px; }
.rw .seg div { min-width:2px; border-right:1px solid #070a10; color:#061018; font:11px ui-monospace, monospace; display:flex; align-items:center; justify-content:center; overflow:hidden; white-space:nowrap; }
.rw .segl { display:grid; grid-template-columns:12px 1fr auto; gap:2px 8px; font:12px ui-monospace, monospace; margin-top:6px; }
.rw .segl i { width:10px; height:10px; border-radius:2px; margin-top:3px; }
.rw .lesson { padding:6px 0; border-top:1px solid #1d2635; } .rw .lesson:first-child { border-top:0; }
.rw .lesson b { color:#fff; } .rw .lesson .cnt { color:#7cc4ff; font-size:12.5px; margin-left:6px; }
.rw table.md { border-collapse:collapse; font-size:12.5px; margin:6px 0; } .rw table.md td, .rw table.md th { border:1px solid #1d2635; padding:3px 6px; text-align:left; vertical-align:top; }
.rw ul { margin:4px 0; padding-left:20px; } .rw li { margin:3px 0; } .rw h4 { margin:12px 0 4px; font-size:14px; color:#cfe3ff; }
.rw details summary { cursor:pointer; color:#8fa3bd; font-size:13px; text-transform:uppercase; letter-spacing:.6px; }
.rw .col { display:flex; flex-direction:column; gap:18px; min-width:0; }
.rw .none { color:#7d8ba0; font-style:italic; }
`;

export function mount(el) {
  const root = document.createElement("div"); root.className = "rw";
  root.innerHTML = `<style>${CSS}</style><div class="in"></div>`; el.append(root);
  const box = root.querySelector(".in");

  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-go]"), S = store(); if (!b) return;
    const rep = repOf(state.session.rep), m = rep?.moments?.moments?.find((x) => x.id === b.dataset.go);
    const id = m && S ? eventRow(S, m.event, rep.moments.request ?? "measured") : -1;
    if (id < 0) { b.textContent = S ? "no such row in this run" : "run not open yet"; return; }
    setTier("execution", 2); select(id); setWorld("spine");
  });

  function results(a, b) {
    const ra = a?.result, rb = b?.result;
    if (!ra && !rb) return state.session.live ? `<p class="none">Results arrive when the run finishes and latency.json is written.</p>`
      : `<p class="none">Results not computed for this run (no latency.json in its folder).</p>`;
    if (!b) return `<table class="res"><tr><th></th>${CLOCKS.map(([c, col]) => `<th style="color:${col}">${c}</th>`).join("")}</tr>
      ${ROWS.map(([name, p]) => `<tr><td>${name}</td>${CLOCKS.map(([c]) => `<td>${fmtMs(valueAt(ra, p[c]))}</td>`).join("")}</tr>`).join("")}</table>`;
    const rows = ROWS.flatMap(([name, p]) => CLOCKS.map(([c, col]) => {
      const va = valueAt(ra, p[c]), vb = valueAt(rb, p[c]), d = va != null && vb != null ? vb - va : null;
      return `<tr><td>${name} <span style="color:${col}">${c}</span></td><td>${fmtMs(va)}</td><td>${fmtMs(vb)}</td>
        <td class="${d > 0 ? "up" : d < 0 ? "down" : ""}">${d == null ? "–" : `${d > 0 ? "+" : ""}${d.toFixed(3)}`}</td>
        <td class="${d > 0 ? "up" : d < 0 ? "down" : ""}">${d == null || !va ? "–" : `${d > 0 ? "+" : ""}${(100 * d / va).toFixed(1)}%`}</td></tr>`;
    })).join("");
    return `<table class="res"><tr><th></th><th>A</th><th>B</th><th>B − A</th><th>%</th></tr>${rows}</table>`;
  }

  function segments(run, scale, label) {
    const segs = ttftSegments(run?.result);
    if (!segs.length) return "";
    const total = segs.reduce((s, x) => s + x.ms, 0), w = (ms) => (100 * ms) / scale;
    return `${label ? `<div class="muted" style="font-size:12.5px">${label}</div>` : ""}
      <div class="seg" style="width:${w(total).toFixed(2)}%">${segs.map((x) => `<div title="${esc(x.name)} · ${x.ms.toFixed(3)} ms · ${esc(x.clocks)}"
        style="flex:${x.ms};background:${SEG_COL[x.clocks] ?? "#8a90a0"}">${x.ms > total * 0.12 ? `${x.ms.toFixed(1)} ms` : ""}</div>`).join("")}</div>`;
  }
  const segLegend = (run, tag) => {
    const segs = ttftSegments(run?.result);
    return segs.length ? `${tag ? `<div class="muted" style="font-size:12.5px;margin-top:8px">${tag}</div>` : ""}<div class="segl">${segs.map((x) => `<i style="background:${SEG_COL[x.clocks] ?? "#8a90a0"}"></i><span>${esc(x.name)} <span class="muted">(${esc(x.clocks)})</span></span><span>${x.ms.toFixed(3)} ms</span>`).join("")}</div>` : "";
  };

  function render(s) {
    const ss = s.session, rep = repOf(ss.rep), a = runOf(ss.run), b = ss.mode === "compare" ? runOf(ss.runB) : null;
    if (!rep) { box.innerHTML = `<p class="none">No rep loaded. Use Load in the header.</p>`; return; }
    const M = rep.moments?.moments ?? [], lessons = lessonsOf(rep), result = a?.result;
    const runChip = (r, tag) => r ? `<span class="chip ${tag ? "cmp" : ""}">${tag ? tag + " · " : ""}${esc(r.id)} · ${esc(kindOf(r))} · ${whenOf(r)}</span>` : "";
    const live = ss.mode === "live" || ss.live
      ? `<span class="chip live">${ss.mode === "live" ? "● live" : "live run, complete"} · ${esc(ss.live?.action?.label ?? "")}${ss.live?.dry_run ? " · dry run, nothing started" : ss.live?.job != null ? ` · job ${esc(ss.live.job)}` : ""}</span>` : "";
    const top = `<div class="top"><h1>${esc(rep.title)}</h1><span class="id">${esc(rep.id)} · ${esc(rep.folder)}</span>
      ${ss.mode === "compare" ? runChip(a, "A") + runChip(b, "B") : runChip(a)}${live}
      ${rep.registered ? "" : `<span class="chip">not registered with the runner (no rep.toml): replay only</span>`}</div>`;

    const moments = M.length ? M.map((m, i) => `<div class="mom"><span class="n">${i + 1}</span>
        <div><div class="t">${esc(m.title)}</div><div class="ls">${esc(m.lesson)}</div></div>
        <button class="go" data-go="${esc(m.id)}" title="jump the replay to this moment's event: ${esc(m.event)}">show me ▸</button>
        <div class="nt">${esc(m.note)}</div>
        <div class="ev">${(m.evidence ?? []).map((ev) => `<span>${esc(ev.label)} <b>${fmtMs(valueAt(result, ev.path))}</b>${b ? ` <span class="b">B ${fmtMs(valueAt(b.result, ev.path))}</span>` : ""}</span>`).join("")}</div></div>`).join("")
      : `<p class="none">No key moments yet. Add moments.toml to ${esc(rep.folder)} (format: reps/I02A-L1_streamed_latency/moments.toml).</p>`;

    const lessonHtml = lessons.length ? lessons.map((l) => {
      const n = M.filter((m) => m.lesson.replace(/[`.]/g, "") === l.lead.replace(/[`.]/g, "")).length;
      return `<div class="lesson"><b>${md(l.lead).replace(/^<p>|<\/p>$/g, "")}</b>${n ? `<span class="cnt">${n} moment${n > 1 ? "s" : ""}</span>` : ""}<div class="muted">${md(l.rest).replace(/^<p>|<\/p>$/g, "")}</div></div>`;
    }).join("") + (rep.moments?.setup_lessons ?? []).map((l) => `<div class="lesson"><span class="muted">no replay moment: about the setup ·</span> ${esc(l.note)}</div>`).join("")
      : `<p class="none">This README has no "Why It Matters" section.</p>`;

    const scale = Math.max(...[a, b].map((r) => ttftSegments(r?.result).reduce((s, x) => s + x.ms, 0)), 1);
    box.innerHTML = `${top}
      <div class="col">
        <section><h2>What this rep teaches</h2><div class="lead">${md(rep.sections.Mechanism) || '<p class="none">No Mechanism section.</p>'}</div></section>
        <section><h2>Key moments · review the dynamic in the replay</h2>${moments}</section>
        <section><h2>Why it matters</h2>${lessonHtml}</section>
        <section><details><summary>What we did (Task)</summary>${md(rep.sections.Task)}</details></section>
      </div>
      <div class="col">
        <section><h2>Results ${b ? "· A against B" : ""}</h2>${results(a, b)}</section>
        ${result || b?.result ? `<section><h2>Where client TTFT goes · ${[a, b].filter((r) => r?.result).map((r, i, rs) => `${rs.length > 1 ? (r === a ? "A " : "B ") : ""}${ttftSegments(r.result).length}`).join(" · ")} segments, 3 clocks</h2>${segments(a, scale, b ? "A" : "")}${b ? segments(b, scale, "B") : ""}${segLegend(a, b ? "A" : "")}${b ? segLegend(b, "B") : ""}</section>` : ""}
        <section><details open><summary>Results notes (README)</summary>${md(rep.sections.Results) || '<p class="none">No Results section.</p>'}</details></section>
        <section><details><summary>Pass checks</summary>${md(rep.sections["Pass Check"])}</details></section>
      </div>`;
  }
  const unsub = subscribe((s, ch) => { if (ch.session) render(s); });
  return () => { unsub(); root.remove(); };
}
