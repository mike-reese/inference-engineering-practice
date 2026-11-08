// The one list of levels, in side placement order (left to right, coarse to fine). Keys 1-7 and the level buttons
// follow this order. A natural window is the level's window at the cursor (the unit it shows), padded where noted.
import { lanesLevel } from "./lanes.js";
import { infraLevel } from "./infra.js";
import { componentsLevel } from "./components.js";
import { kernelLevel } from "./kernel.js";
import { hardwareLevel } from "./hardware.js";

const REQUEST_PAD_NS = 2e6;
const request = (s, t) => { const r = s.chain(t).request; return r && [r.win[0] - REQUEST_PAD_NS, r.win[1] + REQUEST_PAD_NS]; };
const iteration = (s, t) => s.chain(t).iteration?.win ?? null;
/** 64 device ops around the cursor, paged by 32 so a step inside the page keeps the bars still. */
const deviceOps64 = (s, t) => { const d = s.chain(t).device; if (!d) return null; const p = Math.floor(d.ordinal / 32) * 32; return s.span(5, p - 16, p + 48); };
const deviceOp = (s, t) => { const d = s.chain(t).device; return d && s.span(5, d.ordinal - 4, d.ordinal + 5); };

export const LEVELS = [
  infraLevel({ name: "Infra", key: "run", homeTier: 0, natural: (s) => s.extent }),
  componentsLevel({ name: "Components", key: "request", homeTier: 2, natural: request }),
  lanesLevel({ name: "Trace", key: "request", homeTier: 2, tiers: [0, 3], lanes: () => true, natural: request }),
  lanesLevel({ name: "Iteration", key: "iteration + its device work", homeTier: 4, tiers: [1, 6], lanes: (th) => th.kind === "thread" || th.kind === "stream", natural: iteration }),
  lanesLevel({ name: "Model ops", key: "64 device ops", homeTier: 5, tiers: [3, 5], lanes: (th) => th.kind === "stream", layers: true, natural: deviceOps64 }),
  kernelLevel({ name: "Kernel", key: "device op ± 4", homeTier: 5, natural: deviceOp }),
  hardwareLevel({ name: "Hardware", key: "device op ± 4", homeTier: 5, natural: deviceOp }),
];
