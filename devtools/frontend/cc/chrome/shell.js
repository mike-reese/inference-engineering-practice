// The shell around the worlds: which session is open (a replayed run, a live launch, or two runs compared) and the
// panel that opens one. Every world draws the session's run; the shell only chooses it.
import { state, loadRun, launch, compareRuns, setFollow, setSide } from "../control/control.js";
import { SESSION, repOf, runOf, runsOf, kindOf, whenOf, ttftMark, incompleteText, fmtMs, esc } from "../session.js";

const CSS = `
.sh-blk { display:flex; align-items:center; gap:8px; margin-left:14px; padding-left:14px; border-left:1px solid #263041; min-width:0; }
.sh-blk .rep { color:#fff; font-weight:600; white-space:nowrap; } .sh-blk .run { color:#8fa3bd; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:360px; }
.sh-badge { font-size:11.5px; font-weight:700; letter-spacing:.5px; padding:1px 7px; border-radius:9px; border:1px solid; white-space:nowrap; }
.sh-badge.replay { color:#7cc4ff; border-color:#2e4a6e; } .sh-badge.live { color:#ff7b72; border-color:#f85149; } .sh-badge.compare { color:#d2b8ff; border-color:#b58cff; }
.sh-blk button.op, .sh-blk button.fl { background:#121826; color:#c9d3e0; border:1px solid #263041; border-radius:6px; font:inherit; font-size:12.5px; padding:2px 9px; cursor:pointer; white-space:nowrap; }
.sh-blk button.op:hover { color:#fff; border-color:#3a475c; } .sh-blk button.op.on { background:#2b3a52; color:#fff; }
.sh-blk button.fl.on { color:#ff7b72; border-color:#f85149; }
.sh-blk .ab button { background:none; border:1px solid #3a475c; color:#8fa3bd; font:inherit; font-size:12px; padding:1px 8px; cursor:pointer; }
.sh-blk .ab button:first-child { border-radius:5px 0 0 5px; } .sh-blk .ab button:last-child { border-radius:0 5px 5px 0; border-left:0; }
.sh-blk .ab button.on { color:#d2b8ff; border-color:#b58cff; background:#1d1730; }
.sh-pan { position:fixed; top:36px; left:10px; z-index:40; width:min(980px, calc(100vw - 20px)); max-height:calc(100vh - 60px); overflow:auto;
  background:#0d121b; border:1px solid #2e3a4f; border-radius:8px; box-shadow:0 14px 50px #000c; font:14px/1.45 system-ui, sans-serif; color:#dbe4f0; }
.sh-pan .hd { display:flex; gap:4px; padding:8px 10px; border-bottom:1px solid #1d2635; align-items:center; position:sticky; top:0; background:#0d121b; }
.sh-pan .hd button.tab { background:none; border:0; color:#8fa3bd; font:inherit; padding:4px 12px; border-radius:6px; cursor:pointer; }
.sh-pan .hd button.tab.on { background:#2b3a52; color:#fff; } .sh-pan .hd .x { margin-left:auto; background:none; border:0; color:#8fa3bd; font-size:18px; cursor:pointer; }
.sh-pan .bd { display:grid; grid-template-columns:260px 1fr; min-height:300px; }
.sh-pan .reps { border-right:1px solid #1d2635; padding:6px; }
.sh-pan .reps button { display:block; width:100%; text-align:left; background:none; border:0; color:#cfd8e6; font:inherit; padding:6px 8px; border-radius:6px; cursor:pointer; }
.sh-pan .reps button.on { background:#1b2a40; } .sh-pan .reps button small { display:block; color:#7d8ba0; font-size:12px; }
.sh-pan .main { padding:10px 14px; min-width:0; } .sh-pan h3 { margin:12px 0 6px; font-size:12px; text-transform:uppercase; letter-spacing:.6px; color:#8fa3bd; }
.sh-pan h3:first-child { margin-top:2px; }
.sh-pan .row { display:grid; grid-template-columns:1fr auto auto; gap:10px; align-items:center; padding:6px 8px; border-radius:6px; border:1px solid transparent; font-size:13px; }
.sh-pan .row:hover { border-color:#263041; background:#111827; } .sh-pan .row code { font:12.5px ui-monospace, monospace; color:#cfe3ff; }
.sh-pan .row .m { color:#7d8ba0; font-size:12px; white-space:nowrap; } .sh-pan .row .m.ok { color:#58d68d; }
.sh-pan button.go { background:#1b2a40; color:#cfe3ff; border:1px solid #2e4a6e; border-radius:6px; padding:3px 10px; font:inherit; font-size:12.5px; cursor:pointer; white-space:nowrap; }
.sh-pan button.go:disabled { opacity:.4; cursor:default; } .sh-pan button.go.b { border-color:#b58cff; color:#d2b8ff; background:#1d1730; }
.sh-pan .act { border:1px solid #1d2635; border-radius:8px; padding:10px 12px; margin:8px 0; }
.sh-pan .act .t { font-weight:700; } .sh-pan .act .d { color:#aab6c8; font-size:13px; margin:2px 0 6px; }
.sh-pan .act label { display:grid; grid-template-columns:150px 160px 1fr; gap:8px; align-items:center; font-size:12.5px; margin:4px 0; color:#aab6c8; }
.sh-pan .act input, .sh-pan .act select { background:#070a10; color:#dbe4f0; border:1px solid #2e3a4f; border-radius:5px; padding:2px 6px; font:12.5px ui-monospace, monospace; }
.sh-pan .act input.bad { border-color:#f85149; }
.sh-pan .note { color:#d29922; font-size:12.5px; border:1px dashed #6b5414; border-radius:6px; padding:6px 10px; margin:6px 0 10px; }
.sh-pan .none { color:#7d8ba0; font-style:italic; }
.sh-pan .pick { display:flex; gap:10px; align-items:center; margin:8px 0; flex-wrap:wrap; font-size:13px; }
.sh-pan .pick b { color:#d2b8ff; }
`;
const css = document.createElement("style"); css.textContent = CSS; document.head.append(css);

const MODE = { replay: "Replay", live: "● Live", compare: "Compare" };
/** How far a live run has recorded: the head, or why there is none (a dry run, a job not yet recording). */
const recorded = (s) => (s.session.live?.dry_run ? "dry run" : s.session.run ? `${(s.head / 1e9).toFixed(1)} s` : s.session.live?.state ?? "");
/** The header block: the open session and the three ways to open another. */
export function sessionBlock(s) {
  const ss = s.session, rep = repOf(ss.rep), a = runOf(ss.run), b = runOf(ss.runB);
  const runTxt = ss.mode === "live" ? `${ss.run ?? "no run yet"} · ${ss.live?.action?.label ?? ""}`
    : ss.mode === "compare" ? `A ${whenOf(a)} ${kindOf(a)} · B ${whenOf(b)} ${kindOf(b)}`
      : a ? `${whenOf(a)} · ${kindOf(a)}` : ss.run ?? "no run";
  return `<div class="sh-blk">
    <span class="rep" title="${esc(rep?.title)}">${esc(ss.rep)}</span>
    <span class="run" title="${esc(ss.run)}${ss.runB ? " vs " + esc(ss.runB) : ""}">${esc(runTxt)}</span>
    <span class="sh-badge ${ss.mode}"><span class="sh-live">${MODE[ss.mode]}${ss.mode === "live" ? " " + recorded(s) : ss.live?.done ? " (done)" : ""}</span></span>
    ${ss.mode === "live" ? `<button class="fl ${s.follow ? "on" : ""}" data-sh="follow" title="keep the cursor at the newest recorded moment">follow live</button>` : ""}
    ${ss.mode === "compare" ? `<span class="ab" title="which run the replay worlds show">${["A", "B"].map((x) => `<button data-sh="side" data-v="${x}" class="${(ss.side ?? "A") === x ? "on" : ""}">${x}</button>`).join("")}</span>` : ""}
    ${["load", "launch", "compare"].map((t) => `<button class="op" data-sh="open" data-v="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}
  </div>`;
}
export const liveText = (s) => s.session.mode === "live" ? `${MODE.live} ${recorded(s)}` : null;

/** The panel that opens a session. Lives on <body>, so a header re-render never closes it. */
export function mountShell(chromeEl) {
  const pan = document.createElement("div"); pan.className = "sh-pan"; pan.hidden = true; document.body.append(pan);
  const ui = { tab: "load", rep: state.session.rep, a: state.session.run, b: state.session.runB };
  const open = (tab) => { Object.assign(ui, { tab, rep: state.session.rep, a: state.session.run, b: state.session.runB, error: null }); pan.hidden = false; draw(); };
  const close = () => { pan.hidden = true; };

  chromeEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-sh]"); if (!b) return;
    const { sh, v } = b.dataset;
    if (sh === "open") (pan.hidden || ui.tab !== v) ? open(v) : close();
    else if (sh === "follow") setFollow(!state.follow);
    else if (sh === "side") setSide(v);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pan.hidden) close(); });
  document.addEventListener("mousedown", (e) => { if (!pan.hidden && !pan.contains(e.target) && !e.target.closest("[data-sh]")) close(); });

  pan.addEventListener("click", (e) => {
    const b = e.target.closest("[data-p]"); if (!b) return;
    const { p, v } = b.dataset;
    if (p === "tab") ui.tab = v;
    else if (p === "close") return close();
    else if (p === "rep") { ui.rep = v; if (ui.tab !== "compare") ui.a = runsOf(v)[0]?.id ?? null; ui.b = null; }
    else if (p === "load") { loadRun(ui.rep, v); return close(); }
    else if (p === "a") ui.a = v;
    else if (p === "b") ui.b = v;
    else if (p === "compare") { compareRuns(runOf(ui.a).rep, ui.a, ui.b); return close(); }
    else if (p === "launch") {
      const act = repOf(ui.rep).actions.find((x) => x.id === v), opts = {};
      for (const o of act.options) {
        const inp = pan.querySelector(`[data-opt="${v}.${o.id}"]`), val = inp.value.trim();
        if (o.pattern && !new RegExp(o.pattern).test(val)) { inp.classList.add("bad"); inp.focus(); return; }
        opts[o.id] = val;
      }
      ui.error = null;
      launch(ui.rep, act, opts).then((r) => { if (r.ok) close(); else { ui.error = r.error; draw(); } }, (err) => { ui.error = String(err.message ?? err); draw(); });
      return;
    }
    draw();
  });

  const repList = () => `<div class="reps">${SESSION.reps.map((r) => `<button data-p="rep" data-v="${esc(r.id)}" class="${r.id === ui.rep ? "on" : ""}">
    ${esc(r.id)}<small>${esc(r.title)} · ${runsOf(r.id).length} runs${r.registered ? "" : " · replay only"}</small></button>`).join("")}</div>`;
  const resultMark = (r) => { const m = r.result && ttftMark(repOf(r.rep), r.result);
    return m ? `<span class="m ok" title="from the run's ${esc(m.file)}">${esc(m.label)} ${fmtMs(m.value)} · ${esc(m.file)}</span>`
      : `<span class="m">${r.incomplete ? incompleteText(r) : r.result ? "no TTFT in its result" : "results not computed"}</span>`; };
  function runRows(rep, btn) {
    const runs = runsOf(rep);
    if (!runs.length) return `<p class="none">No recorded runs for ${esc(rep)} under its results folder.</p>`;
    const groups = Map.groupBy(runs, kindOf);
    return [...groups].map(([k, rs]) => `<h3>${esc(k)} · ${rs.length}</h3>` + rs.map((r) =>
      `<div class="row"><span><code>${esc(r.id)}</code> <span class="m">${whenOf(r)}</span></span>${resultMark(r)}${btn(r)}</div>`).join("")).join("");
  }

  function body() {
    const rep = repOf(ui.rep);
    if (ui.tab === "load") return runRows(ui.rep, (r) => `<button class="go" data-p="load" data-v="${esc(r.id)}">Replay ▸</button>`);
    if (ui.tab === "compare") {
      const pick = (r) => `<span style="display:flex;gap:4px"><button class="go ${ui.a === r.id ? "b" : ""}" data-p="a" data-v="${esc(r.id)}">A</button><button class="go ${ui.b === r.id ? "b" : ""}" data-p="b" data-v="${esc(r.id)}">B</button></span>`;
      return `<div class="pick">A <b>${esc(ui.a ?? "pick a run")}</b> · B <b>${esc(ui.b ?? "pick a run")}</b>
          <button class="go" data-p="compare" ${ui.a && ui.b && ui.a !== ui.b ? "" : "disabled"}>Compare ▸</button></div>
        <p class="none" style="margin:0 0 4px">Pick A and B from this rep's runs. Runs from another rep: choose that rep on the left for B (A is kept).</p>
        ${runRows(ui.rep, pick)}`;
    }
    if (!rep.registered) return `<p class="none">${esc(rep.id)} has no rep.toml, so the runner cannot launch it. Add ${esc(rep.folder)}/rep.toml with its actions to make it launchable. Its recorded runs can still be replayed from Load.</p>`;
    return `${new URLSearchParams(location.search).get("dry_run") === "1" ? `<div class="note">Dry run (?dry_run=1): the runner checks the action and its options and starts nothing.</div>` : ""}
      ${ui.error ? `<div class="note">The runner refused: ${esc(ui.error)}</div>` : ""}
      ${Object.entries(Object.groupBy(rep.actions, (a) => a.group)).map(([g, acts]) => `<h3>${esc(g)}</h3>` + acts.map((a) => `<div class="act">
        <div style="display:flex;justify-content:space-between;gap:10px"><span class="t">${esc(a.label)}</span>
          <span class="m" style="color:#7d8ba0;font-size:12px">${a.measured ? "measured · " : ""}about ${a.minutes} min
          <button class="go" data-p="launch" data-v="${esc(a.id)}" style="margin-left:8px">Launch ▸</button></span></div>
        <div class="d">${esc(a.description)}</div>
        ${a.options.map((o) => `<label><span>${esc(o.label)}</span>${o.choices
          ? `<select data-opt="${esc(a.id)}.${esc(o.id)}">${o.choices.map((c) => `<option ${c === o.default ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>`
          : `<input data-opt="${esc(a.id)}.${esc(o.id)}" value="${esc(o.default ?? "")}">`}<span>${esc(o.description)}</span></label>`).join("")}
      </div>`).join("")).join("")}`;
  }
  function draw() {
    pan.innerHTML = `<div class="hd">${[["load", "Load · replay a run"], ["launch", "Launch · run live"], ["compare", "Compare · two runs"]]
      .map(([t, l]) => `<button class="tab ${ui.tab === t ? "on" : ""}" data-p="tab" data-v="${t}">${l}</button>`).join("")}
      <button class="x" data-p="close" aria-label="close">×</button></div>
      <div class="bd">${repList()}<div class="main">${body()}</div></div>`;
  }
}
