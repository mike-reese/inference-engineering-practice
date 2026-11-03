// Helpers shared by the views.
export const escape = (text) => String(text ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export const ms = (v, digits = 2) => (v == null ? "–" : `${Number(v).toFixed(digits)}`);
export const json = (v) => `<pre class="json">${escape(JSON.stringify(v, null, 1))}</pre>`;
export const getJSON = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status} ${await r.text()}`);
  return r.json();
};

export function spark(values = [], width = 160, height = 28) {
  const finite = values.filter((v) => v != null && Number.isFinite(v));
  if (finite.length < 2) return `<svg class="spark" viewBox="0 0 ${width} ${height}"></svg>`;
  const lo = Math.min(...finite), hi = Math.max(...finite), span = hi - lo || 1;
  const points = values.map((v, i) => v == null ? null
    : `${((i / (values.length - 1)) * width).toFixed(1)},${(height - ((v - lo) / span) * height).toFixed(1)}`).filter(Boolean);
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><polyline points="${points.join(" ")}"/></svg>`;
}

// Open a run's Nsight report in nsys-ui or ncu-ui on the desktop, through the host runner (scripts/runner.py).
// Returns a one-line status for the view to show.
export async function openInTool(runId, path) {
  try {
    const r = await fetch("/runner/open", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run: runId, path }) });
    if (!r.ok) return `could not open ${path}: ${r.status} ${await r.text()}`;
    const d = await r.json();
    return `opening ${d.file} in ${d.tool} (first start takes a few seconds)`;
  } catch (e) { return `could not reach the runner: ${e}`; }
}
