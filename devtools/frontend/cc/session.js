// The shell's catalog: reps (README sections, launch actions, key moments) and the store's runs with their results,
// from GET /api/v3/reps (COMMAND_CENTER.md 6.4). reloadSession() reads it again (a launched run has finished).
const get = async () => { const r = await fetch("/api/v3/reps"); if (!r.ok) throw new Error(`GET /api/v3/reps: HTTP ${r.status}`); return r.json(); };
export const SESSION = await get();
export async function reloadSession() { Object.assign(SESSION, await get()); }

export const repOf = (id) => SESSION.reps.find((r) => r.id === id);
export const runOf = (id) => SESSION.runs.find((r) => r.id === id);
export const runsOf = (rep) => SESSION.runs.filter((r) => r.rep === rep).sort((a, b) => (b.started ?? "").localeCompare(a.started ?? ""));
export const kindOf = (run) => run?.labels?.measured ? "measured" : run?.labels?.trace ? `trace: ${run.labels.trace}` : "unlabelled";
export const whenOf = (run) => run?.started ? run.started.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2}).*/, "$1-$2-$3 $4:$5") : "";
/** A value in a run result by path, as moments.toml writes it: "wire.headers_ms", or "segments[first_scheduled_time].ms"
 *  for the segment whose name starts with that text (runs differ in how many segments they have, so never by index). */
export const valueAt = (result, path) => path.split(/\.|\[([^\]]+)\]/).filter(Boolean)
  .reduce((o, k) => Array.isArray(o) && !/^\d+$/.test(k) ? o.find((x) => x.name?.startsWith(k)) : o?.[k], result);
/** The segments that make up client TTFT: every one up to the client's first token event. Only latency.json has a
 *  segment list; another result's `segments` (I01-L2 summary.json: medians by ISL) is not one. */
export const ttftSegments = (result) => {
  const s = Array.isArray(result?.segments) ? result.segments : [], i = s.findIndex((x) => /client first token event/.test(x.name));
  return i < 0 ? [] : s.slice(0, i + 1);
};

/** The run result file of a rep: moments.toml `result` (COMMAND_CENTER.md 2.6). */
export const resultFile = (rep) => rep?.moments?.result ?? "latency.json";
/** How the shell shows a result, by its file. cols(result): the table's columns, each a base path into the result;
 *  rows: [label, leaf path, or {column: leaf path}]; marker(result, request): the Load panel's [label, TTFT path];
 *  fromRows(request): the [row, column] cell compare recomputes from the store's client rows (7.4). */
const RESULT_VIEWS = {
  "latency.json": {
    cols: () => [["client", "#7cc4ff"], ["wire", "#58d68d"], ["engine", "#f5a623"]].map(([name, color]) => ({ name, base: name, color })),
    rows: [["TTFT", "ttft_ms"], ["Mean ITL", "mean_itl_ms"], ["End-to-end", { client: "e2e_ms", wire: "done_ms", engine: "e2e_ms" }]],
    marker: () => ["TTFT", "client.ttft_ms"],
    fromRows: () => ["TTFT", "client"],
  },
  "readout.json": {
    cols: (r) => Object.keys(r?.clients ?? {}).map((k) => ({ name: k, base: `clients.${k}.durations` })),
    rows: [["Headers", "headers_ms"], ["TTFT", "ttft_ms"], ["End-to-end", "e2e_ms"]],
    marker: (r, request) => [`TTFT ${request}`, `clients.${request}.durations.ttft_ms`],
    fromRows: (request) => ["TTFT", request],
  },
  "analysis/summary.json": {
    cols: (r) => (r?.pooled ?? []).map((p, i) => ({ name: `ISL ${p.isl}`, base: `pooled[${i}]` })),
    rows: [["TTFT P50", "ttft_ms.p50"], ["TTFT P95", "ttft_ms.p95"], ["End-to-end P50", "e2e_ms.p50"], ["End-to-end P95", "e2e_ms.p95"]],
    marker: (r) => { const i = (r?.pooled?.length ?? 0) - 1; return [`TTFT P50, ISL ${r?.pooled?.[i]?.isl}`, `pooled[${i}].ttft_ms.p50`]; },
  },
};
const isNum = (v) => typeof v === "number" && !Number.isNaN(v);
/** The Results table of a rep's results (one, or A and B): {file, cols, rows: [{label, path: {column: path}}],
 *  fromRows}, holding only the rows where some result has a number, and the columns where some result has a number or
 *  a null (a value the result names but lacks: a request that did not complete). No layout for the file: no columns. */
export function resultTable(rep, results) {
  const file = resultFile(rep), v = RESULT_VIEWS[file];
  if (!v) return { file, cols: [], rows: [] };
  const all = [...new Map(results.flatMap((r) => (r ? v.cols(r) : [])).map((c) => [c.name, c])).values()];
  const has = (p) => results.some((r) => isNum(valueAt(r, p)));
  const rows = v.rows.map(([label, leaf]) => ({ label, path: Object.fromEntries(all.map((c) => [c.name, `${c.base}.${typeof leaf === "string" ? leaf : leaf[c.name]}`])) }))
    .filter((r) => all.some((c) => has(r.path[c.name])));
  const named = (p) => results.some((r) => r && valueAt(r, p) === null);
  return { file, cols: all.filter((c) => rows.some((r) => has(r.path[c.name]) || named(r.path[c.name]))), rows, fromRows: v.fromRows?.(rep?.moments?.request) };
}
/** The Load panel's TTFT marker of a run result: {label, value, file}, null when the file has no layout or no TTFT. */
export function ttftMark(rep, result) {
  const file = resultFile(rep), m = result && RESULT_VIEWS[file]?.marker(result, rep?.moments?.request), value = m && valueAt(result, m[1]);
  return isNum(value) ? { label: m[0], value, file } : null;
}
/** A run whose moments' request did not complete (moments.toml `complete` is false): its flag, else "". */
export const incompleteText = (run) => (run?.incomplete ? `request ${run.incomplete} did not complete` : "");
export const fmtMs = (v) => (v == null || Number.isNaN(+v) ? "–" : `${(+v).toFixed(3)} ms`);
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** The small Markdown the rep READMEs use: ### headings, bullets, tables, bold, code. */
export function md(text) {
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  const out = []; let list = false, table = null;
  const flush = () => {
    if (list) { out.push("</ul>"); list = false; }
    if (table) { out.push(`<table class="md">${table.map((r, i) => `<tr>${r.map((c) => i ? `<td>${inline(c)}</td>` : `<th>${inline(c)}</th>`).join("")}</tr>`).join("")}</table>`); table = null; }
  };
  let item = null;
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.trimEnd();
    if (/^\|/.test(line)) {
      if (list) { out.push(`<li>${inline(item)}</li>`); item = null; flush(); }
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
      (table ??= []).push(cells); continue;
    }
    if (table) flush();
    const b = line.match(/^- (.*)$/);
    if (b) { if (item != null) out.push(`<li>${inline(item)}</li>`); if (!list) { out.push("<ul>"); list = true; } item = b[1]; continue; }
    if (list && /^\s{2,}\S/.test(raw)) { item += " " + line.trim(); continue; }
    if (item != null) { out.push(`<li>${inline(item)}</li>`); item = null; }
    flush();
    const h = line.match(/^###\s+(.*)$/);
    if (h) out.push(`<h4>${inline(h[1])}</h4>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (item != null) out.push(`<li>${inline(item)}</li>`);
  flush();
  return out.join("");
}

/** "Why It Matters" bullets as lessons: { lead, rest }. */
export const lessonsOf = (rep) => [...(rep?.sections?.["Why It Matters"] ?? "").matchAll(/^- \*\*(.+?)\*\*\s*([\s\S]*?)(?=^- |$(?![\s\S]))/gm)]
  .map((m) => ({ lead: m[1].trim(), rest: m[2].replace(/\s+/g, " ").trim() }));
