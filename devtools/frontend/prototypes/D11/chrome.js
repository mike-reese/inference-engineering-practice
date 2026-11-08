import { state, subscribe, setTier, focus, setPaired, setWorld, step, seek, select, togglePlay, stops, tierName,
  metricInputs, data, KEYS, WORLDS, DIM_COLOR, DIMS } from "./model.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ms = (us) => (us / 1000).toFixed(3);

const CSS = `
#chrome { background:var(--bg); }
.ch-top { display:flex; align-items:center; gap:12px; padding:4px 12px; border-bottom:1px solid var(--line); }
.ch-top nav button { background:none; border:0; color:var(--dim); font:inherit; cursor:pointer; padding:4px 8px; }
.ch-top nav button.on { color:var(--text); border-bottom:2px solid var(--accent); }
.ch-pos { margin-left:auto; color:var(--text); white-space:nowrap; } .ch-pos b { font-weight:bold; }
.ch-ctl { display:flex; gap:4px; }
.ch-ctl button, .ch-pair button { background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:4px; font:inherit; padding:2px 8px; cursor:pointer; }
.ch-ctl button.on { border-color:var(--up); color:var(--up); }
.ch-mid { display:grid; grid-template-columns:minmax(0,1fr) 300px; gap:12px; padding:6px 12px 2px; }
.ch-ladders { position:relative; display:grid; grid-template-columns:120px repeat(6, minmax(0,1fr)); gap:8px 6px; }
.ch-ladders .dimname { background:none; border:0; border-left:3px solid transparent; font:inherit; font-weight:bold; text-align:left; cursor:pointer; padding:2px 6px; text-transform:uppercase; font-size:11px; }
.ch-ladders .dimname.focus { border-left-color:currentColor; background:#ffffff0d; }
.ch-ladders .tier { background:var(--panel); border:1px solid var(--line); border-radius:4px; color:var(--dim); font:inherit; font-size:11px; padding:2px 6px 2px 16px; cursor:pointer; text-align:left; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; position:relative; z-index:1; }
.ch-ladders .tier:hover { color:var(--text); }
.ch-ladders .tier.cur { color:#0f1115; font-weight:bold; }
.ch-ladders .row-unfocused .tier.cur { opacity:.75; }
.ch-ladders svg { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; z-index:2; overflow:visible; }
.ch-ladders svg polyline { fill:none; stroke:#e6edf3; stroke-width:2; stroke-dasharray:4 3; opacity:.8; }
.ch-ladders svg circle { fill:#e6edf3; }
.ch-pair { display:flex; flex-direction:column; gap:4px; font-size:11px; color:var(--dim); }
.ch-pair .seg { display:flex; } .ch-pair .seg button { border-radius:0; } .ch-pair .seg button:first-child { border-radius:4px 0 0 4px; }
.ch-pair .seg button:last-child { border-radius:0 4px 4px 0; } .ch-pair .seg button.on { border-color:var(--accent); color:var(--accent); background:#10233d; }
.ch-pair .aligned { color:var(--text); }
.ch-strip { padding:2px 12px 6px; }
.ch-strip .lbl { display:flex; gap:8px; font-size:11px; color:var(--dim); } .ch-strip .lbl .r { margin-left:auto; color:var(--text); }
.ch-strip svg { width:100%; height:30px; display:block; background:var(--panel); border:1px solid var(--line); cursor:pointer; }
.ch-strip .smp { fill:#3fb950; opacity:.18; } .ch-strip .lit { fill:#f778ba; opacity:.22; }
.ch-strip .tick { stroke-width:1.5; vector-effect:non-scaling-stroke; } .ch-strip .tick.on { stroke:#fff; stroke-width:3; }
.ch-strip .cursor { stroke:#e3b341; stroke-width:2; vector-effect:non-scaling-stroke; }
.ch-keys { position:absolute; right:12px; top:34px; z-index:20; background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:8px 12px; }
.ch-keys table td { padding:1px 10px 1px 0; } .ch-keys td:first-child { color:var(--accent); white-space:nowrap; }
`;

export function mountChrome(el) {
  const css = document.createElement("style"); css.textContent = CSS; document.head.append(css);
  let keysOpen = false;

  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const { act, dim, n, w } = b.dataset;
    if (act === "world") setWorld(w);
    else if (act === "tier") setTier(dim, Number(n));
    else if (act === "focus") focus(dim);
    else if (act === "paired") setPaired(n === "1");
    else if (act === "play") togglePlay();
    else if (act === "step") step(Number(n));
    else if (act === "keys") { keysOpen = !keysOpen; render(state); }
  });
  el.addEventListener("click", (e) => {
    const svg = e.target.closest(".ch-strip svg");
    if (!svg) return;
    const r = svg.getBoundingClientRect(), t = ((e.clientX - r.left) / r.width) * data.END;
    const S = stops(); let best = null;
    for (const s of S) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    const px = best ? (Math.abs(best.t - t) / data.END) * r.width : Infinity;
    if (px <= 8) { select(best.ref); seek(best.t); } else seek(t);
  });

  function ladders(s) {
    return DIMS.map((d, row) => {
      const cls = d === s.focus ? "focus" : "";
      const tiers = data.LADDERS[d].map((name, i) => {
        const cur = s.tiers[d] === i;
        const style = cur ? `background:${DIM_COLOR[d]};border-color:${DIM_COLOR[d]}` : `border-color:${DIM_COLOR[d]}33`;
        return `<button class="tier ${cur ? "cur" : ""}" data-act="tier" data-dim="${d}" data-n="${i}" data-row="${row}" style="${style}"
          title="${esc(d)} tier ${i + 1}: ${esc(name)}">${i + 1} ${esc(name)}</button>`;
      }).join("");
      return `<div style="display:contents" class="${d === s.focus ? "" : "row-unfocused"}"><button class="dimname ${cls}" data-act="focus" data-dim="${d}"
        style="color:${DIM_COLOR[d]}" title="focus ${d}">${d}</button>${tiers}</div>`;
    }).join("") + `<svg></svg>`;
  }

  function strip(s) {
    const E = data.END, S = stops(), lit = metricInputs();
    const smp = data.SAMPLES.map((x) => `<rect class="smp" x="${x.t}" width="100" y="${30 - 28 * x.gpuUtil}" height="${28 * x.gpuUtil}"/>`).join("");
    const litR = [...lit].map((id) => data.byId.get(id)).filter(Boolean)
      .map((u) => `<rect class="lit" x="${u.t0}" width="${Math.max(E / 400, u.t1 - u.t0)}" y="0" height="30"/>`).join("");
    const col = DIM_COLOR[s.focus];
    const ticks = S.map((x) => `<line class="tick ${x.ref === s.sel && Math.abs(x.t - s.t) < 1e-6 ? "on" : ""}" x1="${x.t}" x2="${x.t}" y1="4" y2="26" stroke="${col}"/>`).join("");
    const i = S.findIndex((x) => Math.abs(x.t - s.t) < 1e-6);
    const at = i >= 0 ? `${i + 1}/${S.length} ${esc(S[i].label)}` : `between stops (${S.filter((x) => x.t < s.t).length} of ${S.length} passed)`;
    return `<div class="lbl"><span>stops of <b style="color:${col}">${s.focus} › ${esc(tierName())}</b>: ${S.length} ·
      green bars = GPU util samples every 100 µs (state, not stops)${lit.size ? " · pink = metric inputs" : ""}</span><span class="r">${at}</span></div>
      <svg viewBox="0 0 ${E} 30" preserveAspectRatio="none" aria-label="stop strip">${smp}${litR}${ticks}
      <line class="cursor" x1="${s.t}" x2="${s.t}" y1="0" y2="30"/></svg>`;
  }

  function render(s) {
    const S = stops();
    const al = DIMS.map((d) => `<span style="color:${DIM_COLOR[d]}">${esc(tierName(d))}</span>`).join(" ↔ ");
    el.innerHTML = `
      <div class="ch-top">
        <nav>${WORLDS.map(([id, name]) => `<button data-act="world" data-w="${id}" class="${s.world === id ? "on" : ""}">${esc(name)}</button>`).join("")}</nav>
        <span class="ch-pos"><b style="color:${DIM_COLOR[s.focus]}">${s.focus}</b> › ${esc(tierName())} (${s.tiers[s.focus] + 1}/6) ·
          t = ${ms(s.t)} ms · ${S.length} stops · ${s.paired ? "paired" : "independent"}${s.playing ? " · <span style='color:var(--up)'>playing</span>" : ""}</span>
        <span class="ch-ctl"><button data-act="step" data-n="-1" title="previous stop (←)">|◀</button>
          <button data-act="play" class="${s.playing ? "on" : ""}" title="play stops (Space)">${s.playing ? "❚❚" : "▶"}</button>
          <button data-act="step" data-n="1" title="next stop (→)">▶|</button>
          <button data-act="keys" title="keyboard shortcuts">?</button></span>
      </div>
      <div class="ch-mid">
        <div class="ch-ladders">${ladders(s)}</div>
        <div class="ch-pair">
          <div class="seg"><button data-act="paired" data-n="1" class="${s.paired ? "on" : ""}">Paired</button><button data-act="paired" data-n="0" class="${s.paired ? "" : "on"}">Independent</button></div>
          ${s.paired ? `<div>aligned tiers (dashed link):</div><div class="aligned">${al}</div><div>a tier change moves the other two</div>`
            : `<div>each dimension keeps its own tier:</div><div class="aligned">${al.replaceAll(" ↔ ", " · ")}</div><div>a tier change moves only that row</div>`}
        </div>
      </div>
      <div class="ch-strip">${strip(s)}</div>
      ${keysOpen ? `<div class="ch-keys"><div class="label">keys (everything is also clickable)</div><table>${KEYS.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table></div>` : ""}`;
    el.style.position = "relative";
    if (s.paired) requestAnimationFrame(() => link(s));
  }

  function link(s) {
    const box = el.querySelector(".ch-ladders"), svg = box?.querySelector("svg");
    if (!svg) return;
    const o = box.getBoundingClientRect();
    const rs = DIMS.map((d) => box.querySelector(`.tier[data-dim="${d}"][data-n="${s.tiers[d]}"]`).getBoundingClientRect());
    const dots = rs.map((r) => [r.left - o.left + 7, r.top - o.top + r.height / 2]);
    const path = [dots[0]];
    for (let i = 1; i < rs.length; i++) {
      const gy = (rs[i - 1].bottom + rs[i].top) / 2 - o.top;
      path.push([dots[i - 1][0], gy], [dots[i][0], gy], dots[i]);
    }
    svg.innerHTML = `<polyline points="${path.map((p) => p.join(",")).join(" ")}"/>${dots.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3"/>`).join("")}`;
  }

  subscribe(render);
  addEventListener("resize", () => state.paired && link(state));
}
