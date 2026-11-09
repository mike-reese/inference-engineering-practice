// Placeholder until this world is ported from D13 (COMMAND_CENTER.md 7.4, M1): mount(el) draws it into the stage
// and returns its dispose function, as stage.js expects of every world.
export function mount(el) {
  const p = document.createElement("div");
  p.style.cssText = "position:absolute;inset:0;display:grid;place-items:center;color:var(--dim);font:14px system-ui,sans-serif";
  p.textContent = "The Architecture world is not ported yet.";
  el.append(p);
  return () => p.remove();
}
