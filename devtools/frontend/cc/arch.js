// Placeholder until the architecture drawing is ported from D13 (COMMAND_CENTER.md 7.1, 7.4 M1). The stacked world's
// lens mounts it today; the spine and the Architecture world will too. mountArch returns its dispose function.
export function mountArch(el, { size = "lens" } = {}) {
  const p = document.createElement("p");
  p.style.cssText = "margin:0;padding:10px 12px;color:var(--dim);font:13px system-ui,sans-serif";
  p.textContent = `The architecture drawing (${size}) is not ported yet.`;
  el.append(p);
  return () => p.remove();
}
