// Each request's lifecycle segments, derived only from stored rows that carry the request.
// Segment: {state, a, b, lane, from, to, missing}. lane: the segment's lane inside its request (lanes.js), so segments
// that run at the same time (decode and stream out) sit on separate lanes. state "unknown" has a `missing` text and no fill.
import { NONE16 } from "../../store/columns.js";
import { assignLanes } from "./lanes.js";

const KINDS = ["client event", "component stamp", "client transport", "iteration"];
const cache = new WeakMap();

/** @returns {Map<number, {req: number, name: string, segs: any[], lanes: number}>} by request unit id */
export function lifecycle(S, u) {
  const key = `${S.N}/${S.rev}/${u.ids.length}`, c = cache.get(S);
  if (c?.key === key) return c.map;
  const per = S.requests.map(() => ({ rows: new Map(), iters: [] }));
  for (const kn of KINDS) {
    const code = S.kinds.findIndex((k) => k.name === kn);
    for (const id of (code >= 0 && S.dims.byKind[code]) || []) {
      const r = S.field("req", id); if (r === NONE16 || !per[r]) continue;
      if (kn === "iteration") { per[r].iters.push(id); continue; }
      const k = `${kn}|${S.nameText(S.field("name", id))}`, e = per[r].rows.get(k);
      if (!e) per[r].rows.set(k, { first: id, last: id });
      else { if (S.startOf[id] < S.startOf[e.first]) e.first = id; if (S.endOf[id] > S.endOf[e.last]) e.last = id; }
    }
  }
  const at = (id, end = false) => ({ t: end ? S.endOf[id] : S.startOf[id],
    text: `${end ? "end of " : ""}"${S.nameText(S.field("name", id))}" (${S.kinds[S.field("kind", id)]?.name}, row ${id})` });
  const map = new Map();
  for (const id of u.ids) {
    const r = S.field("req", id), q = r === NONE16 ? null : S.requests[r], P = per[r] ?? { rows: new Map(), iters: [] };
    const name = q ? `request ${q.startsWith(`${S.run}-`) ? q.slice(S.run.length + 1) : q}` : "request", segs = [];
    const row = (k) => P.rows.get(k);
    const seg = (state, a, b, missing = null) => { if (b.t > a.t) segs.push({ state, a: a.t, b: b.t, lane: 0, from: a.text, to: b.text, missing }); };
    const send = row("client event|send"), enq = row("component stamp|LlmRequest enqueued"), deq = row("component stamp|new requests taken from the queue");
    const hdr = row("client event|response headers"), sse = row("component stamp|SSE frame sent"), body = row("client transport|body read");
    const its = P.iters.sort((x, y) => S.startOf[x] - S.startOf[y] || x - y);
    const pre = its.filter((x) => S.dims.flowOf(x) === "prefill"), dec = its.filter((x) => S.dims.flowOf(x) === "decode");
    const t0 = send ? at(send.first) : at(id), tEnd = body ? at(body.last, true) : at(id, true);
    const s0 = sse ? at(sse.first) : body ? at(body.first) : null;
    if (enq && its.length) {
      const q0 = at(enq.first), sched = deq ? at(deq.first) : at(its[0]), d0 = dec.length ? at(dec[0]) : null;
      seg("request in", t0, q0);
      seg("queued", q0, sched);
      if (pre.length) seg("prefill", sched, d0 ?? at(pre.at(-1), true));
      else if (d0) seg("unknown", sched, d0, "missing: no prefill iteration row for this request");
      if (d0) seg("decode", d0, at(its.at(-1), true));
      if (s0) seg("stream out", s0, tEnd);
      else seg("unknown", d0 ?? sched, at(id, true), "missing: no stream row (SSE frame sent, body read) for this request");
    } else if (hdr && s0) {
      seg("request in", t0, at(hdr.first));
      seg("unknown", at(hdr.first), s0, "missing: no engine row carries this request (queued and prefill cannot be separated)");
      seg("unknown", s0, tEnd, "missing: no iteration row carries this request (decode)");
      seg("stream out", s0, tEnd);
    } else {
      if (hdr) seg("request in", t0, at(hdr.first));
      seg("unknown", hdr ? at(hdr.first) : t0, at(id, true), `missing: no ${hdr ? "stream" : "response headers"} row for this request`);
    }
    segs.sort((x, y) => x.a - y.a);
    const { lane, lanes } = assignLanes(segs.map((x) => x.a), segs.map((x) => x.b), segs.map((x) => x.state));
    segs.forEach((x, j) => { x.lane = lane[j]; });
    map.set(id, { req: r, name, segs, lanes });
  }
  cache.set(S, { key, map });
  return map;
}
