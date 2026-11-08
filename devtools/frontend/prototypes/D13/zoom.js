// One pane's own zoom: wheel zooms around the mouse, drag pans, double-click resets. A drag never counts as a click,
// so clicking a box still selects it. The view object is the caller's, so the pane keeps its zoom across rebuilds.
export function panZoom(viewport, content, view, onChange) {
  content.style.transformOrigin = "0 0";
  const apply = () => { content.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.k})`; onChange?.(view); };
  const wheel = (e) => {
    e.preventDefault();
    const r = viewport.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const k = Math.max(0.5, Math.min(16, view.k * Math.exp(-e.deltaY * 0.0015)));
    view.x = mx - (mx - view.x) * (k / view.k); view.y = my - (my - view.y) * (k / view.k); view.k = k; apply();
  };
  let drag = null, swallow = false;
  const down = (e) => { if (e.button === 0) drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, on: false, id: e.pointerId }; };
  const move = (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.on && Math.hypot(dx, dy) < 4) return;
    if (!drag.on) { drag.on = true; viewport.setPointerCapture(drag.id); viewport.style.cursor = "grabbing"; }
    view.x = drag.vx + dx; view.y = drag.vy + dy; apply();
  };
  const up = () => { if (drag?.on) { swallow = true; viewport.style.cursor = ""; } drag = null; };
  const click = (e) => { if (swallow) { swallow = false; e.stopPropagation(); e.preventDefault(); } };
  const reset = () => { Object.assign(view, { k: 1, x: 0, y: 0 }); apply(); };
  viewport.addEventListener("wheel", wheel, { passive: false });
  viewport.addEventListener("pointerdown", down);
  viewport.addEventListener("pointermove", move);
  viewport.addEventListener("pointerup", up);
  viewport.addEventListener("click", click, true);
  viewport.addEventListener("dblclick", reset);
  apply();
  return { reset, dispose() {
    viewport.removeEventListener("wheel", wheel); viewport.removeEventListener("pointerdown", down);
    viewport.removeEventListener("pointermove", move); viewport.removeEventListener("pointerup", up);
    viewport.removeEventListener("click", click, true); viewport.removeEventListener("dblclick", reset);
  } };
}
