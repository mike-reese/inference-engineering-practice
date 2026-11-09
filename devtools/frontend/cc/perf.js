// Input-to-frame marks. An input site calls perf.input(intent, event.timeStamp); Control calls perf.frameDone() at the
// end of the animation frame whose subscribers drew the change, so a sample is event time -> frame submitted (CPU side,
// GPU present not included). The same call records delivery: event time -> handler start, the share of input-to-frame
// spent before the page's code runs (the browser's input queue and the main thread's backlog). window.PERF.report() is
// what `ccv perf` reads.
const KEEP = 5000;
const pending = [], samples = new Map(), marks = {}, providers = {};
const SECTION = { "input:": "input_to_frame_ms", "delivery:": "delivery_ms" };

const push = (name, ms) => { const a = samples.get(name) ?? samples.set(name, []).get(name); a.push(ms); if (a.length > KEEP) a.splice(0, a.length - KEEP); };
const stats = (a) => { const b = a.slice().sort((x, y) => x - y), q = (p) => +b[Math.min(b.length - 1, Math.floor(b.length * p))].toFixed(2);
  return { n: b.length, p50: q(0.5), p95: q(0.95), max: +b[b.length - 1].toFixed(2) }; };

export const perf = {
  /** @param {string} intent "step" | "scrub" | "zoom" | "focus" | "pan" | ... @param {number} ts the event's timeStamp */
  input(intent, ts) { pending.push([intent, ts]); push(`delivery:${intent}`, performance.now() - ts); },
  frameDone() { const now = performance.now(); for (const [n, ts] of pending) push(`input:${n}`, now - ts); pending.length = 0; },
  sample(name, ms) { push(name, ms); },
  mark(name) { marks[name] = +performance.now().toFixed(1); performance.mark(`cc:${name}`); },
  provide(name, fn) { providers[name] = fn; },
  report() {
    const out = { input_to_frame_ms: {}, delivery_ms: {}, frame_ms: {}, marks_ms: { ...marks } };
    for (const [k, a] of samples) if (a.length) { const p = Object.keys(SECTION).find((x) => k.startsWith(x)); (p ? out[SECTION[p]] : out.frame_ms)[p ? k.slice(p.length) : k] = stats(a); }
    for (const [k, fn] of Object.entries(providers)) out[k] = fn();
    return out;
  },
};

window.PERF = perf;
