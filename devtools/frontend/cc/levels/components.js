// L2 Components: the component map (registry/components.json, imported as things under the "component map" thing):
// container, process and IPC boundaries, one box per component that owns a step of a request, and the request path's
// edges. A box is lit while a row of its component is active at the cursor (activeBy("comp", t)). The request at the
// cursor moves as a packet: from the box of its previous step to the box of its current step, with what the request
// is at that step (the data form, from the step's cold args). The level owns no replay, pickers or follow: the cursor
// is Control's. A live run's new stage rows join their request's path in frame() (store.N is the counter).
import * as THREE from "three";
import { Boxes, Links, palette, exitPoint } from "../scene/boxes.js";
import { frameMeshes, title, windowOf, TITLE_H, LIT } from "./level.js";
import { NONE16 } from "../store/columns.js";

const PAD = 10, PACKET_MS = 280, LINE_PX = 12;
const C = palette({
  idle: "#222833", edge: "#3a4252", seen: "#262d39", active: "#1d5a73", activeEdge: "#4fb3d9", current: "#24533f",
  currentEdge: "#ffd36b", prevEdge: "#c98b52", driven: "#2e3550", sel: "#ffffff", link: "#384152", hot: "#ffd36b", packet: "#ffd36b",
  container: "#5e81ac", process: "#7fa7a6", ipc: "#b48ead", network: "#c9a95c", gpu: "#8fb07a",
});
const BOUND_FILL = palette({ 0: "#1c2028", 1: "#20252e", 2: "#232934" });

export function componentsLevel(spec) { return new ComponentsLevel(spec); }

class ComponentsLevel {
  constructor({ name, key, homeTier, natural }) { Object.assign(this, { name, key, homeTier, natural, index: -1, seq: -1, anim: null, seenN: 0 }); }

  mount({ group, store, H, index, redraw }) {
    Object.assign(this, { group, store, index, redraw });
    const T = store.things, map = T.find((t) => t.kind === "component map");
    this.size = map?.attrs?.size ?? [1400, 700];
    this.bounds = T.filter((t) => t.kind === "boundary").sort((a, b) => a.pre - b.pre);
    this.comps = T.filter((t) => t.kind === "component");
    this.byKey = new Map(this.comps.map((t, k) => [t.attrs.key, k]));
    this.boxOfThing = new Int16Array(T.length).fill(-1); this.comps.forEach((t, k) => (this.boxOfThing[t.i] = k));
    this.edges = (map?.attrs?.edges ?? []).map(([a, b]) => [this.byKey.get(a), this.byKey.get(b)]).filter(([a, b]) => a != null && b != null);
    this.drives = new Map(Object.entries(map?.attrs?.drives ?? {}).map(([a, b]) => [this.byKey.get(a), this.byKey.get(b)]));
    this.indexRequests();
    this.boundBoxes = new Boxes(this.bounds.length, { inset: 1.2, order: 1 });
    this.links = new Links(this.edges.length + 1, { order: 2 });
    this.boxes = new Boxes(this.comps.length, { inset: 1.8, order: 4 });
    this.dot = new THREE.Mesh(new THREE.CircleGeometry(6, 24), new THREE.MeshBasicMaterial({ color: C.packet, depthTest: false }));
    this.dot.renderOrder = 6; this.dot.visible = false;
    this.resize(H);
  }

  /** Per request: its stage rows that sit on a component box, in (start, id) order, and per box the count and time. */
  indexRequests() {
    const s = this.store, ids = [];
    this.path = new Map(); this.stats = new Map();
    s.scan({ win: s.extent, maxTier: 2, starts: true }, (id) => { ids.push(id); });
    this.addRows(ids); this.seenN = s.N; this.seenRev = s.rev;
  }

  /** Stage rows the store gained since the last call (a live run). A seal that changed tiers (store.rev) indexes every row again. */
  grow() {
    if (this.store.rev !== this.seenRev) return this.indexRequests();
    const s = this.store, ids = [];
    for (let id = this.seenN; id < s.N; id++) if (s.field("tier", id) <= 2) ids.push(id);
    this.seenN = s.N; this.addRows(ids);
  }

  /** Add stage rows on a component box to their request's path and box counts; each touched path goes back in (start, id) order. */
  addRows(ids) {
    const s = this.store, touched = new Set();
    for (const id of ids) {
      const c = s.field("comp", id), r = s.field("req", id);
      if (c === NONE16 || r === NONE16 || !(this.boxOfThing[c] >= 0)) continue;
      if (!this.path.has(r)) { this.path.set(r, []); this.stats.set(r, { n: new Uint32Array(this.comps.length), ns: new Float64Array(this.comps.length) }); }
      const k = this.boxOfThing[c], st = this.stats.get(r);
      this.path.get(r).push(id); st.n[k]++; st.ns[k] += s.endOf[id] - s.startOf[id]; touched.add(r);
    }
    for (const r of touched) this.path.get(r).sort((a, b) => s.startOf[a] - s.startOf[b] || a - b);
  }

  resize(H) {
    this.H = H;
    const [W, Hm] = this.size, avail = H - TITLE_H - 2 * PAD, s = (this.s = Math.min((1000 - 2 * PAD) / W, avail / Hm));
    this.ox = (1000 - W * s) / 2; this.oy = TITLE_H + PAD + (avail - Hm * s) / 2;
    const at = (a) => [this.ox + a.x * s, this.oy + a.y * s, a.w * s, a.h * s];
    this.bounds.forEach((b, k) => {
      this.boundBoxes.place(k, ...at(b.attrs));
      const depth = Math.min(2, this.bounds.filter((o) => o.pre < b.pre && o.post >= b.post).length);
      this.boundBoxes.paint(k, BOUND_FILL[depth], C[b.attrs.kind] ?? C.edge);
    });
    this.comps.forEach((c, k) => this.boxes.place(k, ...at(c.attrs)));
    this.edges.forEach(([a, b], k) => this.setLink(k, a, b, 1.2, 6));
    this.links.set(this.edges.length, 0, 0, 0, 0);
    this.group.clear();
    this.group.add(...frameMeshes(H), this.boundBoxes.mesh, this.links.mesh, this.boxes.mesh, this.dot);
    this.seq = -1; this.anim = null;
  }

  /** Link k between the borders of boxes a and b. */
  setLink(k, a, b, w, head) {
    const A = this.boxes.rect(a), B = this.boxes.rect(b), [bx, by] = [B[0] + B[2] / 2, B[1] + B[3] / 2], [ax, ay] = [A[0] + A[2] / 2, A[1] + A[3] / 2];
    const p = exitPoint(A, bx, by), q = exitPoint(B, ax, ay);
    this.links.set(k, p[0], p[1], q[0], q[1], w, head);
    return [p, q];
  }

  /** The request's current and previous step at t: the last row of its path at or before t, and the last before it on another box. */
  steps(f) {
    const r = f.chain.request?.req, list = r == null ? null : this.path.get(r), t = f.cursor.t, s = this.store;
    if (!list?.length) return { req: r ?? null, cur: -1, prev: -1, k: -1, n: list?.length ?? 0 };
    let lo = 0, hi = list.length; while (lo < hi) { const m = (lo + hi) >>> 1; if (s.startOf[list[m]] <= t) lo = m + 1; else hi = m; }
    const k = lo - 1; if (k < 0) return { req: r, cur: -1, prev: -1, k, n: list.length };
    const cur = list[k], box = s.field("comp", cur);
    let j = k - 1; while (j >= 0 && s.field("comp", list[j]) === box) j--;
    return { req: r, cur, prev: j >= 0 ? list[j] : -1, k, n: list.length };
  }

  update(f) {
    const s = this.store, act = s.activeBy("comp", f.cursor.t), st = (this.st = this.steps(f));
    const curBox = st.cur >= 0 ? this.boxOfThing[s.field("comp", st.cur)] : -1, prevBox = st.prev >= 0 ? this.boxOfThing[s.field("comp", st.prev)] : -1;
    const selBox = f.sel >= 0 && s.field("comp", f.sel) !== NONE16 ? this.boxOfThing[s.field("comp", f.sel)] : -1;
    const stats = st.req == null ? null : this.stats.get(st.req), driven = this.drives.get(curBox);
    const lightBoxes = new Set();   // boxes holding a row that frame.lit names (a hovered Metrics input)
    for (const id of f.lit ?? []) { const c = s.field("comp", id); if (c !== NONE16 && this.boxOfThing[c] >= 0) lightBoxes.add(this.boxOfThing[c]); }
    this.lit = this.comps.map((c, k) => act[c.i]);
    this.comps.forEach((c, k) => {
      const on = act[c.i] >= 0;
      const fill = on ? C.active : k === curBox ? C.current : k === driven ? C.driven : stats?.n[k] ? C.seen : C.idle;
      const border = k === selBox ? C.sel : lightBoxes.has(k) ? LIT : k === curBox ? C.currentEdge : on ? C.activeEdge : k === prevBox ? C.prevEdge : C.edge;
      this.boxes.paint(k, fill, border);
    });
    this.edges.forEach((_, k) => this.links.paint(k, C.link));
    const hot = this.edges.length;
    if (curBox >= 0 && prevBox >= 0) {
      const [p, q] = this.setLink(hot, prevBox, curBox, 3, 12); this.links.paint(hot, C.hot);
      // a step to a new box animates the packet; a redraw, a resize or the first draw places it
      const moved = this.anim && this.anim.cur !== st.cur;
      this.anim = { cur: st.cur, from: p, to: q, t0: moved ? performance.now() : this.anim?.cur === st.cur ? this.anim.t0 : 0 };
    } else {
      this.links.set(hot, 0, 0, 0, 0);
      const r = curBox >= 0 ? this.boxes.rect(curBox) : null;
      this.anim = r ? { cur: st.cur, from: [r[0], r[1] + r[3] / 2], to: [r[0], r[1] + r[3] / 2], t0: 0 } : null;
    }
    if (st.cur >= 0 && s.detailCached(st.cur) === undefined) {
      s.detail([st.cur]).then(() => { if (this.st?.cur === st.cur) this.redraw(); }).catch((e) => console.error("components: detail", e));
    }
  }

  frame(f, view) {
    this.px = view.px;
    if (!view.onScreen) return;
    if (this.store.N !== this.seenN || this.store.rev !== this.seenRev) { this.grow(); this.seq = -1; }
    if (f.seq !== this.seq) { this.seq = f.seq; this.update(f); }
    this.drawPacket();
    title(this, f, view, windowOf(this, f, this.store));
    this.labels(f, view);
  }

  drawPacket() {
    const a = this.anim; this.dot.visible = !!a;
    if (!a) return;
    const u = a.t0 ? Math.min(1, (performance.now() - a.t0) / PACKET_MS) : 1, e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
    this.dot.position.set(a.from[0] + (a.to[0] - a.from[0]) * e, a.from[1] + (a.to[1] - a.from[1]) * e, 0);
    this.dot.scale.setScalar(Math.max(0.6, 1.4 / Math.max(0.2, this.px)));
    if (u < 1) this.redraw();
  }

  labels(f, view) {
    const s = this.store, st = this.st, px = view.px, line = LINE_PX / px, stats = st?.req == null ? null : this.stats.get(st.req);
    this.bounds.forEach((b, k) => { const r = this.boundBoxes.rect(k); view.label(r[0] + 4 / px, r[1] + 8 / px, b.name, "group", r[2] * px - 8); });
    this.comps.forEach((c, k) => {
      const [x, y, w, h] = this.boxes.rect(k), wpx = w * px - 8;
      if (h * px < 14 || wpx < 30) return;
      view.label(x + 4 / px, y + h / 2 - (h * px >= 3 * LINE_PX + 4 ? line : h * px >= 2 * LINE_PX + 2 ? line / 2 : 0), c.name, "box", wpx);
      if (h * px >= 2 * LINE_PX + 2) view.label(x + 4 / px, y + h / 2 + (h * px >= 3 * LINE_PX + 4 ? 0 : line / 2), c.attrs.owner ?? "", "note", wpx);
      if (h * px >= 3 * LINE_PX + 4 && stats?.n[k]) {
        const n = stats.n[k], ms = stats.ns[k] / 1e6;
        view.label(x + 4 / px, y + h / 2 + line, `${n}×${ms > 0 ? ` · ${ms.toFixed(ms < 10 ? 3 : 1)} ms` : ""} in this request`, "note", wpx);
      }
    });
    if (this.anim && st.cur >= 0) {
      const p = this.dot.position, d = s.detailCached(st.cur), text = d ? dataForm(d) : s.nameText(s.field("name", st.cur));
      view.label(p.x + 9 / px, p.y - 11 / px, `${s.kinds[s.field("kind", st.cur)]?.label ?? ""}: ${text}`, "packet", 380);
    }
    const req = st?.req == null ? "no request at the cursor" : `${s.requests[st.req]} · step ${st.k + 1} of ${st.n}`;
    view.label(560, TITLE_H / 2, `${req} · lit: a row of that component is active at the cursor`, "note", 430 * px);
  }

  pick({ x, y }, f) {
    const k = this.boxes.hit(x, y); if (k < 0) return -1;
    if (this.lit?.[k] >= 0) return this.lit[k];
    const s = this.store, st = this.st, list = st?.req == null ? null : this.path.get(st.req), th = this.comps[k].i;
    for (let j = st?.k ?? -1; list && j >= 0; j--) if (s.field("comp", list[j]) === th) return list[j];
    return -1;
  }

  dispose() { this.group.clear(); this.boxes.dispose(); this.boundBoxes.dispose(); this.links.dispose(); this.dot.geometry.dispose(); this.dot.material.dispose(); }
}

/**
 * What the request is at one step, in one short line (learned from v1 components_map.js dataForm). A component stamp
 * carries its data under args.stamp; client and wire rows carry it in args. Falls back to the row's name.
 */
export function dataForm(d) {
  const a = d.args ?? {}, x = a.stamp ?? a, box = a.box ?? d.comp?.split("/").pop(), name = d.name ?? "";
  const ids = (v) => (Array.isArray(v) ? `[${v.slice(0, 6).join(", ")}${v.length > 6 ? ", …" : ""}]` : "");
  const req = (x.requests ?? [])[0] ?? {};
  const has = (...k) => k.every((q) => x[q] != null);
  switch (box) {
    case "sdk": return a.kind === "token" ? `token ${a.token ?? a.index}: ${JSON.stringify(a.content ?? "")}` : name;
    case "transport": return name.replace("http11.", "");
    case "eth0": return `${x.direction ?? ""} · ${x.bytes ?? 0} B · ${name}`;
    case "asgi": return name === "SSE frame sent" || has("frame") ? `SSE frame ${x.frame}: ${x.bytes} B` : has("bytes") ? `${x.bytes} B JSON body` : has("status") ? `HTTP ${x.status}` : name;
    case "validate": return Array.isArray(x.messages) ? `ChatCompletionRequest · ${x.messages.length} messages` : name;
    case "parse": return Array.isArray(x.conversation) ? `conversation · ${x.conversation.length} turns` : name;
    case "template": return typeof x.text === "string" ? `${x.text.length} characters of templated text` : has("characters") ? `${x.characters} characters of templated text` : name;
    case "tokenizer": return Array.isArray(x.token_ids) ? `${x.token_ids.length} token IDs ${ids(x.token_ids)}` : name;
    case "llm_api": return Array.isArray(x.prompt_token_ids) ? `prompt_token_ids ${x.prompt_token_ids.length} ${ids(x.prompt_token_ids)}` : name;
    case "proxy": return has("prompt_tokens") ? `GenerationRequest · ${x.prompt_tokens} prompt tokens` : name;
    case "ipc_req": return has("pickled_bytes") ? `${x.pickled_bytes} B pickled` : "received in the worker";
    case "worker": return Array.isArray(x.prompt_token_ids) ? `LlmRequest · ${x.prompt_token_ids.length} prompt tokens` : name;
    case "fetch": return Array.isArray(x.requests) ? `${x.requests.length} new request(s) activated` : name;
    case "scheduler": return Array.isArray(x.context) ? `context ${x.context.length} · generation ${x.generation?.length ?? 0}` : name;
    case "kv_cache": return Array.isArray(req.blocks) ? `blocks ${ids(req.blocks)}${req.new_blocks?.length ? ` +${req.new_blocks.length} new` : ""}` : name;
    case "forward": return x.logits_shape ? `logits ${JSON.stringify(x.logits_shape)}` : has("context") ? `${x.context} ctx + ${x.generation ?? 0} gen` : name;
    case "sampler": return "sampling on the GPU (async)";
    case "update": return req.last_token_id != null ? `token ${req.last_token_id} appended (${req.num_tokens} tokens)` : name;
    case "responses": return Array.isArray(x.requests) ? `${x.requests.length} LlmResponse(s)` : name;
    case "ipc_rsp": return has("pickled_bytes") ? `${x.pickled_bytes} B pickled` : "responses received";
    case "detokenize": return Array.isArray(x.new_token_ids) ? `${ids(x.new_token_ids)} → ${JSON.stringify(x.new_text ?? "")}` : name;
    case "postprocess": return Array.isArray(x.events) ? `${x.events.length} SSE event(s)` : name;
    default: return name;
  }
}
