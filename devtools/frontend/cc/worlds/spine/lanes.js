// The one lane rule for rows of boxes on a time axis. Every pane that stacks boxes calls assignLanes and derives a
// box's y from the lane it returns; nothing else may place a box vertically.

/** The share of a unit's duration, at its end, that the next unit may start inside without overlapping it. */
export const HANDOFF = 0.02;

/**
 * Units arrive sorted by start. `key[k]` names unit k's logical stream (any value a Map can key on).
 *   1. A stream is the units that share a key.
 *   2. A stream splits into tracks only where it overlaps itself: a unit joins the stream's first track whose last
 *      unit has ended, else it opens a new track.
 *   3. Tracks are placed whole, in order of first start: each takes the lowest lane where none of its units overlaps
 *      a unit already there.
 * So two units that overlap in time never share a lane, a stream that never overlaps itself stays on one lane for
 * the whole run, and streams that never overlap each other share a lane. An instant counts as 1 ns long.
 * A hand-off is not an overlap: a unit may start inside the last HANDOFF of the unit before it (measured clocks put
 * the end of one step a few hundred ns after the start of the next).
 * @param {ArrayLike<number>} start @param {ArrayLike<number>} end @param {ArrayLike<*>} key
 * @returns {{lane: Uint16Array, lanes: number}} each unit's lane, and how many lanes are in use
 */
export function assignLanes(start, end, key) {
  const endOf = (k) => start[k] + Math.max(1, (1 - HANDOFF) * (end[k] - start[k]));

  const streams = new Map(), tracks = [];
  for (let k = 0; k < start.length; k++) {
    if (!streams.has(key[k])) streams.set(key[k], []);
    const own = streams.get(key[k]);
    let track = own.find((t) => endOf(t.at(-1)) <= start[k]);
    if (!track) { track = []; own.push(track); tracks.push(track); }
    track.push(k);
  }

  // A lane holds unit indexes in start order, none overlapping, so their ends are in order too.
  const overlapsLane = (units, k) => {
    let lo = 0, hi = units.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (endOf(units[mid]) > start[k]) hi = mid; else lo = mid + 1; }
    return lo < units.length && start[units[lo]] < endOf(k);
  };
  const lane = new Uint16Array(start.length), lanes = [];
  for (const track of tracks) {
    let l = 0;
    while (l < lanes.length && track.some((k) => overlapsLane(lanes[l], k))) l++;
    lanes[l] = mergeSorted(lanes[l] ?? [], track);
    for (const k of track) lane[k] = l;
  }
  return { lane, lanes: lanes.length };
}

/** Two ascending index lists as one. The common case, b wholly after a, appends in place: copying the lane there
 *  would make a band of one-unit streams quadratic. */
function mergeSorted(a, b) {
  if (!a.length || a.at(-1) < b[0]) { for (const k of b) a.push(k); return a; }
  const out = [];
  for (let i = 0, j = 0; i < a.length || j < b.length;) out.push(j >= b.length || (i < a.length && a[i] < b[j]) ? a[i++] : b[j++]);
  return out;
}
