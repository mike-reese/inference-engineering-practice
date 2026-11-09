import assert from "node:assert/strict";
import { assignLanes } from "./lanes.js";

const check = (start, end, key) => {
  const { lane, lanes } = assignLanes(start, end, key), E = (k) => Math.max(end[k], start[k] + 1);
  for (let a = 0; a < start.length; a++) for (let b = a + 1; b < start.length && start[b] < E(a); b++)
    assert.notEqual(lane[a], lane[b], `units ${a} and ${b} overlap in time and share lane ${lane[a]}`);
  const byKey = new Map();
  start.forEach((_, k) => byKey.set(key[k], [...(byKey.get(key[k]) ?? []), k]));
  for (const [name, ks] of byKey) {
    let open = [], worst = 0;
    for (const k of ks) { open = open.filter((j) => E(j) > start[k]); open.push(k); worst = Math.max(worst, open.length); }
    assert.equal(new Set(ks.map((k) => lane[k])).size, worst, `stream ${name} uses more lanes than its own overlap`);
  }
  return { lane: [...lane], lanes };
};

assert.deepEqual(check([0, 10, 20], [10, 20, 30], ["a", "b", "a"]).lane, [0, 0, 0], "sequential streams share a lane");
assert.deepEqual(check([0, 5, 20, 25], [18, 8, 40, 28], ["loop", "fwd", "loop", "fwd"]).lane, [0, 1, 0, 1], "a stream keeps its lane");
assert.deepEqual(check([0, 5, 12, 20], [10, 8, 15, 30], ["loop", "fwd", "fwd", "loop"]).lane, [0, 1, 1, 0], "fwd stays off loop's lane even when loop is idle");
assert.deepEqual(check([0, 1], [10, 12], ["body", "body"]).lane, [0, 1], "a stream splits where it overlaps itself");
assert.deepEqual(check([5, 5], [5, 5], ["x", "y"]).lane, [0, 1], "two instants at one time stack");
assert.deepEqual(check([0, 10, 20], [10, 20, 30], [1, 2, 3]).lanes, 1, "unique keys pack like the plain rule");
assert.deepEqual([...assignLanes([0, 990], [1000, 2000], ["a", "a"]).lane], [0, 0], "a start inside the last HANDOFF of the unit before is a hand-off");
assert.deepEqual([...assignLanes([0, 970], [1000, 2000], ["a", "a"]).lane], [0, 1], "a start before the last HANDOFF is an overlap");

const rnd = (() => { let s = 7; return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31; })();
for (let round = 0; round < 200; round++) {
  const n = 1 + Math.floor(rnd() * 60), start = Array.from({ length: n }, () => Math.floor(rnd() * 500)).sort((a, b) => a - b);
  check(start, start.map((s) => s + Math.floor(rnd() * 40)), start.map(() => Math.floor(rnd() * 6)));
}

const n = 40000, start = Float64Array.from({ length: n }, (_, k) => k * 10), end = start.map((s, k) => s + (k % 7 ? 9 : 400));
const t0 = performance.now(), big = assignLanes(start, end, Array.from({ length: n }, (_, k) => k % 300));
const unique = assignLanes(start, end, Array.from({ length: n }, (_, k) => k));
console.log(`ok: 8 cases, 200 random layouts; 40000 units in ${(performance.now() - t0).toFixed(0)} ms (${big.lanes} lanes with 300 streams, ${unique.lanes} with unique keys)`);

const seq = Float64Array.from({ length: n }, (_, k) => k * 10), t1 = performance.now();
assert.equal(assignLanes(seq, seq.map((s) => s + 9), Array.from({ length: n }, (_, k) => k)).lanes, 1);
const took = performance.now() - t1;
assert.ok(took < 200, `40000 one-unit streams in sequence took ${took.toFixed(0)} ms`);
console.log(`ok: 40000 one-unit streams in sequence in ${took.toFixed(0)} ms`);
