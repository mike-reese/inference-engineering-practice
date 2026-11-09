// Header in D10's style and sizing (D10/model.js nav, D10/spine/index.html #hud), rebuilt here, not imported.
// One thin tab bar for the worlds, then one row: title, compact ladders, what is true now.
import { sessionBlock, liveText, mountShell } from "./shell.js";
import { state, subscribe, setTier, focus, setPaired, setWorld, tierName, stops, now, store, ladders as tierLadders, WORLDS, DIM_COLOR, FLOW_COLOR, DIMS, aligned } from "../control/control.js";
import { KEYS } from "../control/keys.js";
import { roleOf, fmtValue } from "../sidebar/samples.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const DESC = {
  execution: ["one request, send to last byte", "one scheduler step: prefill or decode", "executor phases and request hops",
    "one decoder layer", "attention, MLP, linear, norm", "one kernel with the CPU call that launched it"],
  hardware: ["utilization of every GPU and host", "the board: CPU, RAM, links, GPU, NVMe, NIC",
    "bytes moving between devices", "parts inside a device: SMs, L2, memory controllers, copy engines",
    "one kernel's DRAM and L2 bytes over the GPU's SMs", "warps, shared memory, registers (Nsight Compute)"],
  architecture: ["the fleet: every host of the run", "the host and its containers", "containers on the host",
    "processes inside each container", "component boxes inside each process", "toolkit calls runtime calls device code"],
};

const CSS = `
#chrome { background:#070a10; position:relative; font:14px system-ui, sans-serif; color:#dbe4f0; }
.ch-nav { height:34px; display:flex; gap:6px; align-items:center; padding:0 10px; background:#0b0f16ee; border-bottom:1px solid #263041; font-size:13px; color:#c9d3e0; }
.ch-nav button.w { background:none; border:0; font:inherit; color:#8fa3bd; padding:4px 10px; border-radius:6px; cursor:pointer; }
.ch-nav button.w:hover { color:#fff; } .ch-nav button.w.on { background:#2b3a52; color:#fff; }
.ch-nav .pos { margin-left:auto; font-weight:600; color:#fff; white-space:nowrap; } .ch-nav .pos b { color:var(--pc); }
.ch-nav .q { margin-left:10px; background:#121826; color:#c9d3e0; border:1px solid #263041; border-radius:6px; font:inherit; font-size:12px; padding:2px 6px; cursor:pointer; }
.ch-hud { display:flex; gap:24px; padding:10px 16px; align-items:flex-start; }
.ch-focus { min-width:330px; }
.ch-focus .t { font-size:24px; font-weight:700; letter-spacing:.2px; line-height:1.15; }
.ch-focus .d { color:#7d8ba0; font-size:14px; margin-top:4px; max-width:420px; }
.ch-focus .pair { display:flex; align-items:center; gap:8px; margin-top:6px; font-size:12px; color:#7d8ba0; }
.ch-focus .seg { display:flex; } .ch-focus .seg button { background:none; border:1px solid #1d2635; color:#6c7a8e; font:inherit; padding:1px 8px; cursor:pointer; }
.ch-focus .seg button:first-child { border-radius:5px 0 0 5px; } .ch-focus .seg button:last-child { border-radius:0 5px 5px 0; border-left:0; }
.ch-focus .seg button.on { color:#cfd8e6; border-color:#3a475c; background:#121a28; }
.ch-lad { display:grid; grid-template-columns:auto repeat(6,auto); gap:4px 6px; align-items:center; font-size:13px; }
.ch-lad .dn { background:none; border:0; font:inherit; font-weight:700; text-transform:uppercase; font-size:12px; letter-spacing:.6px; padding:0 6px 0 0; cursor:pointer; text-align:left; }
.ch-lad .dn.focus { text-decoration:underline; text-underline-offset:3px; }
.ch-lad .c { background:none; font:inherit; padding:2px 8px; border-radius:5px; color:#6c7a8e; border:1px solid #1d2635; white-space:nowrap; cursor:pointer; text-align:left; }
.ch-lad .c:hover { color:#cfd8e6; }
.ch-lad .c.al { color:#cfd8e6; border-color:#3a475c; }
.ch-lad .c.own { color:var(--dc); border-color:var(--dc); }
.ch-lad .c.on { color:#061018; font-weight:700; }
.ch-now { margin-left:auto; display:grid; grid-template-columns:auto 1fr; gap:4px 10px; font-size:14px; max-width:46%; min-width:0; }
.ch-now .k { font-weight:700; font-size:12px; letter-spacing:.6px; text-transform:uppercase; padding-top:2px; }
.ch-now .v { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ch-now i { display:inline-block; width:8px; height:8px; border-radius:2px; margin:0 4px 0 2px; }
.ch-keys { position:absolute; right:10px; top:34px; z-index:20; background:#121826; border:1px solid #263041; border-radius:6px; padding:8px 12px; box-shadow:0 8px 30px #000a; font-size:12px; }
.ch-keys table td { padding:1px 10px 1px 0; } .ch-keys td:first-child { color:#ffd36b; white-space:nowrap; }
`;

export function mountChrome(el) {
  const css = document.createElement("style"); css.textContent = CSS; document.head.append(css);
  let keysOpen = false;
  mountShell(el);

  el.addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); });
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const { act, dim, n, w } = b.dataset;
    if (act === "world") setWorld(w);
    else if (act === "tier") setTier(dim, Number(n));
    else if (act === "focus") focus(dim);
    else if (act === "paired") setPaired(n === "1");
    else if (act === "keys") { keysOpen = !keysOpen; render(state); }
  });

  function ladders(s) {
    return DIMS.map((d) => {
      const dc = DIM_COLOR[d], al = s.paired && d !== s.focus ? aligned(s.focus, s.tiers[s.focus], d) : -1;
      return `<button class="dn ${d === s.focus ? "focus" : ""}" data-act="focus" data-dim="${d}" style="color:${dc}" title="focus ${d}">${d}</button>` +
        (tierLadders()?.[d] ?? []).map((name, i) => {
          const cur = s.tiers[d] === i, on = cur && d === s.focus;
          const cls = on ? "on" : cur && s.paired ? "al" : cur ? "own" : i === al ? "al" : "";
          const style = on ? `background:${dc};border-color:${dc}` : `--dc:${dc}`;
          return `<button class="c tier ${cls}" data-act="tier" data-dim="${d}" data-n="${i}" style="${style}" title="${esc(d)} tier ${i + 1}: ${esc(name)}">${i + 1} ${esc(name)}</button>`;
        }).join("");
    }).join("");
  }

  function render(s) {
    const pc = DIM_COLOR[s.focus];
    el.innerHTML = `<nav class="ch-nav">
        ${WORLDS.map(([id, name]) => `<button class="w ${s.world === id ? "on" : ""}" data-act="world" data-w="${id}">${esc(name)}</button>`).join("")}
        ${sessionBlock(s)}
        <span class="pos" style="--pc:${pc}"></span>
        <button class="q" data-act="keys" title="keyboard shortcuts" aria-label="Keys">?</button>
      </nav>
      <div class="ch-hud">
        <div class="ch-focus"><div class="t"><span style="color:${pc}">${s.focus}</span> › ${esc(tierName())}</div>
          <div class="d">${esc(DESC[s.focus][s.tiers[s.focus]])}</div>
          <div class="pair"><div class="seg"><button data-act="paired" data-n="1" class="${s.paired ? "on" : ""}" title="a tier change moves the other two to the aligned tier (outlined)">Paired</button><button data-act="paired" data-n="0" class="${s.paired ? "" : "on"}" title="a tier change moves only that row">Independent</button></div>
            <span>${s.paired ? "outlined = aligned tier" : "coloured outline = that dimension's own tier"}</span></div></div>
        <div class="ch-lad">${ladders(s)}</div>
        <div class="ch-now"></div>
      </div>
      ${keysOpen ? `<div class="ch-keys"><div class="label">keys (everything is also clickable)</div><table>${KEYS.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table></div>` : ""}`;
    live(s, true);
  }

  let lastPos = "", lastNow = "";
  function live(s, force) {
    const pos = `<b>${s.focus}</b> › ${esc(tierName())} (${s.tiers[s.focus] + 1}/6) · t = ${(s.t / 1e6).toFixed(3)} ms · ${stops().ids.length} stops here${s.playing ? " · playing" : ""}`;
    const n = now(), S = store(), name = (id) => S.nameText(S.field("name", id));
    const exec = !S ? "no run open" : n.phases.map((u) => `<i style="background:${FLOW_COLOR[S.dims.flowOf(u.id)] ?? "#8a90a0"}"></i>${esc(name(u.id))}`).join(" ‖ ") || "between units";
    // the run's sampled GPU state at t, from whichever source fills each role (Nsight Systems replay, NVML live)
    const val = (role) => { const i = S ? roleOf(S, role) : -1; return i < 0 ? null : `${S.metrics[i].label} ${fmtValue(n.sample[i], S.metrics[i].unit)}`; };
    const kernels = S && S.dims.stops("execution", "kernel").ids.length;
    const hw = !S ? "" : [...["sm_active", "dram_read", "pcie_rx", "gpu_util"].map(val).filter(Boolean),
      n.kernel ? esc(name(n.kernel.id)) : kernels ? "no kernel at the cursor" : "no kernel rows in this run",
      ...(n.transfers.length ? [`copy: ${esc(name(n.transfers[0].id))}`] : [])].join(" · ");
    const ar = !S ? "" : [...n.archPath.slice(1), ...(n.comp >= 0 ? [n.comp] : [])].map((i) => esc(S.things[i]?.name)).join(" › ");
    const nowHtml = [["execution", exec], ["hardware", hw], ["architecture", ar]]
      .map(([d, v]) => `<span class="k" style="color:${DIM_COLOR[d]}">${d}</span><span class="v">${v}</span>`).join("");
    if (force || pos !== lastPos) { el.querySelector(".pos").innerHTML = pos; lastPos = pos; }
    if (force || nowHtml !== lastNow) { el.querySelector(".ch-now").innerHTML = nowHtml; lastNow = nowHtml; }
    const lt = liveText(s), lv = el.querySelector(".sh-live");
    if (lt && lv && lv.textContent !== lt) lv.textContent = lt;
  }

  subscribe((s, ch) => {
    if (ch.world || ch.focus || ch.tiers || ch.paired || ch.session || ch.follow || ch.rev) render(s);
    else if (ch.t || ch.playing || ch.head) live(s, false);
  });
}
