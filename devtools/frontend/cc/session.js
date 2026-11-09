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
/** The segments that make up client TTFT: every one up to the client's first token event. */
export const ttftSegments = (result) => {
  const s = result?.segments ?? [], i = s.findIndex((x) => /client first token event/.test(x.name));
  return i < 0 ? [] : s.slice(0, i + 1);
};
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
