// Read-only sampler for `ccv eval`: watches the page's moving SVG parts once per animation frame for MS milliseconds
// and returns their paths. It changes nothing on the page. Used by motion.sh.
//   packets  each component-map packet (.compmap .packet): the positions it took while it travelled between boxes
//   beam     the Architecture world's beam dot (.aw .beam circle): its x on the strip each frame
//   frames   the intervals between animation frames, ms
(async (MS) => {
  const ids = new WeakMap(), packets = new Map(), beam = [], frames = [];
  let next = 0, last = 0;
  const end = performance.now() + MS;
  const xy = (g) => (g.getAttribute("transform") ?? "").match(/translate\(([-\d.e]+),([-\d.e]+)\)/)?.slice(1).map(Number);
  await new Promise((done) => {
    const tick = (t) => {
      if (last) frames.push(t - last);
      last = t;
      for (const g of document.querySelectorAll(".compmap .packet")) {
        if (!ids.has(g)) { ids.set(g, next++); packets.set(ids.get(g), []); }
        const p = xy(g); if (p) packets.get(ids.get(g)).push(p);
      }
      const dot = document.querySelector(".aw .beam circle"), vis = dot && dot.closest("svg").style.visibility !== "hidden";
      if (vis && dot.hasAttribute("cx")) beam.push(Number(dot.getAttribute("cx")));
      if (t < end) requestAnimationFrame(tick); else done();
    };
    requestAnimationFrame(tick);
  });
  const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(f * s.length))] * 10) / 10 : null; };
  const trips = [...packets.values()].filter((ps) => ps.length > 1).map((ps) => {
    const a = ps[0], b = ps.at(-1), dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return { frames: ps.length, dist: Math.round(dist) };
  }).filter((t) => t.dist > 0);
  const moves = beam.slice(1).filter((x, i) => x !== beam[i]).length;
  return JSON.stringify({
    frames: { n: frames.length, p50: q(frames, 0.5), p95: q(frames, 0.95) },
    packets: { seen: packets.size, trips: trips.length, medianFrames: q(trips.map((t) => t.frames), 0.5) ?? 0, frames: trips.map((t) => t.frames) },
    beam: { samples: beam.length, moves },
  });
})(MS)
