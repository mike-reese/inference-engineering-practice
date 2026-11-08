// The page URL as view state: #side?run=&t=&w=&sel=&f=&z=. Pure codec; Control decides when to write.
//   t   cursor, integer ns from the run's t0      w   window "a,b", integer ns
//   sel selected row's eid (stable across runs)   f   focused level, 1..7
//   z   camera pose "x,y,z,tx,ty,tz" (world units, rounded)

/** @typedef {{run?: string, t?: number, w?: [number, number], sel?: string, f?: number, z?: number[]}} UrlState */

/** @returns {UrlState} */
export function parse(hash) {
  const q = new URLSearchParams((hash.split("?")[1] ?? ""));
  const int = (k) => { const v = q.get(k); return v != null && /^-?\d+$/.test(v) ? Number(v) : undefined; };
  const nums = (k, n) => { const v = q.get(k)?.split(",").map(Number); return v && v.length === n && v.every(Number.isFinite) ? v : undefined; };
  const f = int("f");
  return { run: q.get("run") ?? undefined, t: int("t"), w: nums("w", 2), sel: q.get("sel") ?? undefined, f: f >= 1 && f <= 7 ? f : undefined, z: nums("z", 6) };
}

/** @param {UrlState} s */
export function format(s) {
  const q = [];
  if (s.run) q.push(`run=${encodeURIComponent(s.run)}`);
  if (s.t != null) q.push(`t=${Math.round(s.t)}`);
  if (s.w) q.push(`w=${Math.round(s.w[0])},${Math.round(s.w[1])}`);
  if (s.sel) q.push(`sel=${encodeURIComponent(s.sel)}`);
  if (s.f) q.push(`f=${s.f}`);
  if (s.z) q.push(`z=${s.z.map((v) => +v.toFixed(1)).join(",")}`);
  return `#side?${q.join("&")}`;
}
