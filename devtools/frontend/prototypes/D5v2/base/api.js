// D1 (frozen C) store API client: the devtools backend's /api/v2 (DuckDB over Parquet, ie-run/2 records).
// Every call is one query by time window, by thing, by iteration or by id. Results are columnar JSON, turned into rows.

const BASE = "/api/v2/runs";
/** @type {Record<string, number[]>} */
export const timings = {};

/**
 * @param {string} run
 * @param {string} path   e.g. "events", "state", "samples"
 * @param {Record<string, string|number|undefined>} [params]
 * @returns {Promise<Object[]>}
 */
export async function q(run, path, params = {}) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.set(k, String(v));
  const t = performance.now();
  const r = await fetch(`${BASE}/${encodeURIComponent(run)}/${path}${u.size ? "?" + u : ""}`);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${await r.text()}`);
  const j = await r.json();
  (timings[path] ??= []).push(performance.now() - t);
  return rows(j);
}

/** @param {{columns: string[], rows: any[][]}} j */
export function rows(j) { return j.rows.map((r) => Object.fromEntries(j.columns.map((c, i) => [c, r[i]]))); }

/** @param {string} run */
export async function meta(run) {
  const r = await fetch(`${BASE}/${encodeURIComponent(run)}/meta`);
  if (!r.ok) throw new Error(`meta: HTTP ${r.status}`);
  return r.json();
}

/** @param {string} run @param {string} key eid or numeric id */
export async function event(run, key) {
  const r = await fetch(`${BASE}/${encodeURIComponent(run)}/events/${encodeURIComponent(key)}`);
  if (!r.ok) return null;
  const j = await r.json();
  return { event: rows(j.event)[0], parents: rows(j.parents) };
}

export async function runs() { return (await (await fetch("/api/v2/runs")).json()).runs; }
