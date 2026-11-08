// Nsight Systems and Nsight Compute are links, not views we rebuild (design: Role). A target comes from a detail row's
// `open` ({run, path}, path relative to that run's folder); the host runner opens the report in nsys-ui or ncu-ui on
// Mike's display (POST /runner/open, the pattern of commit 91c28c2). The runner takes no time range or kernel id, so
// the caller shows where to look (the row's report time range, the profile row).

/** @param {{run: string, path: string}} target @returns {Promise<{ok: boolean, message: string}>} */
export async function openInNsight(target) {
  try {
    const r = await fetch("/runner/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ run: target.run, path: target.path }) });
    const text = await r.text();
    if (!r.ok) return { ok: false, message: `could not open ${target.path}: HTTP ${r.status} ${text}` };
    const d = JSON.parse(text);
    return { ok: true, message: `opening ${d.file} in ${d.tool} (pid ${d.pid}; the first start takes a few seconds)` };
  } catch (e) { return { ok: false, message: `could not reach the runner: ${e}` }; }
}

/** Where to look in Nsight Systems once the report is open: the row's time range on the report's clock. */
export const nsysWhere = (o) => (o?.t ? `report time ${(o.t[0] / 1e9).toFixed(6)}–${(o.t[1] / 1e9).toFixed(6)} s` : "report time unknown (no session start)");
