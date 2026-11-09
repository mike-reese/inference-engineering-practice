// What the request and iteration rows add to a row built by bands.js. The request row draws each request as its
// lifecycle segments (lifecycle.js) and can give every request its own lane; the iteration row gets a head strip
// showing which request each iteration served. Every placement comes from assignLanes (lanes.js).
import { FLOW_COLOR } from "../../control/control.js";
import { NONE16 } from "../../store/columns.js";
import { assignLanes } from "./lanes.js";
import { lifecycle } from "./lifecycle.js";
import { eachVisible, laneBox, NO_FLOW, LABEL_MIN_PX, CHAR_PX } from "./bands.js";

const QUEUED = "#9aa7b8", MISSING = "#8a90a0";
const dur = (ns) => `${(ns / 1e6).toFixed(1)} ms`;

/** @param {import("./bands.js").Bands} B @param {import("./bands.js").Row} row */
export function decorate(B, S, row) {
  if (row.name === "request") {
    const n = row.u.ids.length, life = lifecycle(S, row.u);
    // "one per request": each request is its own stream, and one that never ends for the rule never frees its lane
    if (B.laneMode === "request") Object.assign(row, assignLanes(row.u.start, new Float64Array(n).fill(Infinity), row.u.ids));
    // a request's lane holds its segments' lanes, so it is that many shared lane heights tall
    row.weight = Math.max(1, ...Array.from(life.values(), (q) => q.lanes));
    row.parts = (k, y, h) => { const q = life.get(row.u.ids[k]); return q.segs.map((sg) => [sg.a, sg.b, ...segmentBox(q, sg, y, h)]); };
    row.draw = requests;
    row.title = (k, at) => segmentTitle(S, row, k, at);
  }
  if (row.name === "iteration" && row.u.ids.length) {
    const requestRow = B.bands.find((b) => b.name === "request"), laneOf = new Int32Array(S.requests.length).fill(-1);
    requestRow?.u.ids.forEach((id, k) => { const r = S.field("req", id); if (r !== NONE16) laneOf[r] = requestRow.lane[k]; });
    const req = Array.from(row.u.ids, (id) => S.field("req", id)), short = (q) => (q.startsWith(`${S.run}-`) ? q.slice(S.run.length + 1) : q);
    // the head strip: a line per request lane; iterations of one request that overlap stack inside that line
    const served = [...row.u.ids.keys()].filter((k) => req[k] !== NONE16 && laneOf[req[k]] >= 0);
    const byRequest = Map.groupBy(served, (k) => laneOf[req[k]]), inLine = new Int32Array(row.u.ids.length);
    let inside = 1;
    for (const ks of byRequest.values()) {
      const { lane, lanes } = assignLanes(ks.map((k) => row.u.start[k]), ks.map((k) => row.u.end[k]), new Uint8Array(ks.length));
      ks.forEach((k, j) => { inLine[k] = lane[j]; }); inside = Math.max(inside, lanes);
    }
    const lines = (requestRow?.lanes ?? 0) * inside, px = lines <= 4 ? 4 : lines <= 16 ? 2 : 1;
    row.stripLane = Int32Array.from(req, (r, k) => (r === NONE16 || laneOf[r] < 0 ? -1 : laneOf[r] * inside + inLine[k]));
    row.head = lines * px + 3;
    row.drawHead = (g, f, X, cx, clip, _, R) => strip(g, f, X, cx, clip, row, R, px);
    const title = row.title;
    row.title = (k) => `${title(k)}${req[k] === NONE16 ? "" : ` · serves request ${short(S.requests[req[k]])} (iteration row's req column)`}`;
  }
  return row;
}

/** A request's segments on their own lanes inside the request's lane box [y, y + h]. */
const segmentBox = (q, sg, y, h) => [y + (sg.lane * h) / q.lanes, h / q.lanes - (q.lanes > 1 ? 0.5 : 0)];

let hatchPattern = null;
function hatch(g) {
  if (!hatchPattern) {
    const c = document.createElement("canvas"); c.width = c.height = 8; const x = c.getContext("2d");
    x.strokeStyle = "#c9d3e0"; x.lineWidth = 1.4; x.beginPath();
    for (const o of [-8, 0, 8]) { x.moveTo(o - 1, 9); x.lineTo(o + 9, -1); }
    x.stroke(); hatchPattern = g.createPattern(c, "repeat");
  }
  return hatchPattern;
}

/** The request row: each request on its lane, cut into its lifecycle segments. */
function requests(B, g, f, X, cx, [xmin, xmax], row, R) {
  const S = B.S, u = row.u, life = lifecycle(S, u), base = f.metric ? 0.22 : row.i === f.tier ? 0.85 : 0.5;
  eachVisible(u, f.a, f.b, (k) => {
    const id = u.ids[k], s = u.start[k], e = u.end[k], [y, h] = laneBox(R, row.lane[k]), q = life.get(id);
    const on = s <= f.t && f.t < e, sel = id === f.sel && !f.selLayer, pe = id === f.pe, hov = id === f.hover, lit = f.lit.has(id);
    if (lit) B.litDrawn.add(id);
    const alpha = f.metric ? (lit ? 1 : 0.22) : on || sel || pe || hov ? 1 : base;
    const boxes = q.segs.filter((sg) => sg.b >= f.a && sg.a <= f.b).map((sg) => {
      const xa = cx(X(sg.a)), [yy, hh] = segmentBox(q, sg, y, h);
      return { sg, xa, w: Math.max(1, cx(X(sg.b)) - xa), yy, hh };
    });
    for (const { sg, xa, w, yy, hh } of boxes) {
      if (sg.state === "unknown" && w < 8) { g.globalAlpha = alpha * 0.3; g.fillStyle = MISSING; g.fillRect(xa, yy, w, hh); }
      else if (sg.state === "unknown") {
        g.globalAlpha = Math.max(0.6, alpha); g.strokeStyle = MISSING; g.lineWidth = 1; g.setLineDash([4, 3]);
        g.strokeRect(xa + 0.5, yy + 0.5, Math.max(1, w - 1), hh - 1); g.setLineDash([]);
      } else if (sg.state === "queued") {
        g.globalAlpha = alpha * 0.3; g.fillStyle = QUEUED; g.fillRect(xa, yy, w, hh);
        g.globalAlpha = alpha; g.fillStyle = hatch(g); g.fillRect(xa, yy, w, hh);
      } else { g.globalAlpha = alpha; g.fillStyle = FLOW_COLOR[sg.state] ?? NO_FLOW; g.fillRect(xa, yy, w, hh); }
    }
    const stroke = f.metric && lit ? ["#fff", 1.5] : pe ? ["#e3b341", 3] : sel ? ["#fff", 2] : hov ? ["#fff", 1] : null;
    if (stroke) { const xa = cx(X(s)); g.globalAlpha = 1; g.strokeStyle = stroke[0]; g.lineWidth = stroke[1]; g.strokeRect(xa, y, Math.max(1, cx(X(e)) - xa), h); }
    g.globalAlpha = 1; g.textAlign = "center"; g.textBaseline = "middle";
    let named = false;
    for (const { sg, xa, w, yy, hh } of boxes) {
      const va = Math.max(xa, xmin), vb = Math.min(xa + w, xmax), vw = vb - va, chars = Math.floor((vw - 8) / CHAR_PX);
      if (vw < LABEL_MIN_PX || chars < 3 || hh < 9) continue;
      const own = sg.missing ?? `${sg.state} ${dur(sg.b - sg.a)}`, full = named ? own : `${q.name} · ${own}`;
      if (full.length <= chars) named = true;
      const text = full.length <= chars ? full : own.length <= chars ? own : sg.state.length <= chars && !sg.missing ? sg.state : `${own.slice(0, chars - 1)}…`;
      g.font = `${on ? 800 : 600} ${Math.min(11.5, hh - 0.5)}px system-ui, sans-serif`;
      if (sg.state === "queued") { const tw = g.measureText(text).width + 10; g.fillStyle = "#0b0e14"; g.globalAlpha = 0.8; g.fillRect((va + vb) / 2 - tw / 2, yy + 1, tw, hh - 2); g.globalAlpha = 1; }
      g.fillStyle = sg.state === "queued" ? "#e8eef7" : sg.state === "unknown" ? "#a9b8cc" : "#0a0f18";
      g.fillText(text, (va + vb) / 2, yy + hh / 2 + 0.5);
    }
  });
}

/** Hover title of request k: the request, then the segment under the pointer with the rows it was cut from. */
function segmentTitle(S, row, k, at) {
  const q = lifecycle(S, row.u).get(row.u.ids[k]);
  const sg = q.segs.find((s) => { const [yy, hh] = segmentBox(q, s, 0, at.h); return at.x >= at.X(s.a) && at.x <= Math.max(at.X(s.a) + 1, at.X(s.b)) && at.dy >= yy && at.dy < yy + hh + 1; });
  return sg ? `${q.name} · ${sg.missing ?? sg.state} · ${dur(sg.b - sg.a)} · from ${sg.from} to ${sg.to}` : q.name;
}

/** The iteration row's head: thin lines per request lane, lit over each iteration that carries that request
 *  (the iteration row's req column). */
function strip(g, f, X, cx, [xmin, xmax], row, R, px) {
  const u = row.u, runs = new Map();
  eachVisible(u, f.a, f.b, (k) => {
    const l = row.stripLane[k]; if (l < 0) return;
    const xa = cx(X(u.start[k])), xb = Math.max(xa + 1, cx(X(u.end[k]))), run = runs.get(l);
    if (run && xa <= run.at(-1) + 0.5) run[run.length - 1] = Math.max(run.at(-1), xb); else if (run) run.push(xa, xb); else runs.set(l, [xa, xb]);
  });
  g.globalAlpha = 1; g.fillStyle = "#070a10"; g.fillRect(xmin, R.top, xmax - xmin, row.head - 1);
  g.globalAlpha = f.metric ? 0.22 : 0.9; g.fillStyle = "#e8eef7";
  for (const [l, run] of runs) for (let j = 0; j < run.length; j += 2) g.fillRect(run[j], R.top + 1 + l * px, run[j + 1] - run[j], Math.max(1, px - 1));
}
