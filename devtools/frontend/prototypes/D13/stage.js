// Mounts the world for state.world into the stage and swaps it in place when the header tab changes.
// Stacked: the 3D world with a small floating architecture lens (D10). Spine: the 2D spine with its Split lens on top.
// Architecture: the full-screen v1 architecture drawing over a thin execution strip.
// Rep: the run's overview (worlds/rep.js). Over the replay worlds, a ribbon says which run they show in compare.
import { subscribe, data } from "./model.js";
import { mountArch } from "./arch.js";
import { runOf, kindOf, whenOf, esc } from "./session.js";

const WORLD = {
  async rep(el) { return (await import("./worlds/rep.js")).mount(el); },
  async stacked(el) {
    el.innerHTML = `<div class="w" style="position:absolute;inset:0"></div>
      <div class="lens" style="position:absolute;left:12px;bottom:12px;width:min(520px,45%);height:min(360px,55%);
        background:var(--panel);border:1px solid var(--arch);border-radius:6px;overflow:hidden;display:flex;flex-direction:column">
        <div style="display:flex;justify-content:space-between;padding:4px 8px;border-bottom:1px solid var(--line);color:var(--arch)">
          <b>architecture lens</b><button class="tog" style="background:none;border:0;color:var(--dim);cursor:pointer">collapse</button></div>
        <div class="a" style="flex:1;min-height:0;overflow:auto"></div></div>`;
    const { mount } = await import("./worlds/stacked.js");
    const disposeWorld = mount(el.querySelector(".w"));
    const lens = el.querySelector(".lens"), a = el.querySelector(".a");
    const disposeArch = mountArch(a, { size: "lens" });
    el.querySelector(".tog").onclick = (e) => { const c = a.hidden = !a.hidden; lens.style.height = c ? "auto" : ""; e.target.textContent = c ? "expand" : "collapse"; };
    return () => { disposeWorld?.(); disposeArch?.(); };
  },
  async spine(el) { return (await import("./worlds/spine.js")).mount(el); },
  async architecture(el) { return (await import("./worlds/architecture.js")).mount(el); },
};

// Prototype: the scratch timeline is one run, so B replays the same events. Per-run events come with the real build.
function ribbon(rb, s) {
  const ss = s.session, show = s.world !== "rep" && (ss.mode === "compare" || ss.mode === "live");
  rb.hidden = !show; if (!show) return;
  if (ss.mode === "live") { rb.style.borderColor = "#f85149"; rb.innerHTML = `<b style="color:#ff7b72">● live</b> · recorded ${Math.round(100 * s.head / data.END)}% · events past the head are not recorded yet · simulated, nothing started`; return; }
  const side = ss.side ?? "A", r = runOf(side === "A" ? ss.run : ss.runB);
  rb.style.borderColor = "#b58cff";
  rb.innerHTML = `<b style="color:#d2b8ff">compare · showing ${side}</b> · ${esc(r?.id)} · ${esc(kindOf(r))} · ${whenOf(r)} · <span style="color:#d29922">stand-in: both sides replay the scratch timeline</span>`;
}

export function mountStage(el) {
  let shown = null, dispose = null;
  const rb = document.createElement("div"); rb.hidden = true;
  rb.style.cssText = "position:absolute;top:6px;left:50%;transform:translateX(-50%);z-index:15;background:#0d121bee;border:1px solid;border-radius:14px;padding:3px 12px;font:12.5px system-ui,sans-serif;color:#cfd8e6;white-space:nowrap;pointer-events:none";
  subscribe((s, ch) => { if (ch.session || ch.world || ch.head) ribbon(rb, s); });
  subscribe(async (s, ch) => {
    if (!ch.world || s.world === shown) return;
    shown = s.world; dispose?.(); dispose = null; el.replaceChildren(rb);
    const host = document.createElement("div"); host.style.cssText = "position:absolute;inset:0"; el.append(host);
    const d = await WORLD[s.world](host);
    if (shown === s.world) dispose = d; else d?.();
  });
}
