// Mounts the world for state.world into the stage and swaps it in place when the header tab changes.
// Stacked: the 3D world with a small floating architecture lens (D10). Spine: the 2D spine with its Split lens on top.
// Architecture: the full-screen v1 architecture drawing over a thin execution strip.
import { subscribe } from "./model.js";
import { mountArch } from "./arch.js";

const WORLD = {
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

export function mountStage(el) {
  let shown = null, dispose = null;
  subscribe(async (s, ch) => {
    if (!ch.world || s.world === shown) return;
    shown = s.world; dispose?.(); dispose = null; el.replaceChildren();
    const host = document.createElement("div"); host.style.cssText = "position:absolute;inset:0"; el.append(host);
    const d = await WORLD[s.world](host);
    if (shown === s.world) dispose = d; else d?.();
  });
}
