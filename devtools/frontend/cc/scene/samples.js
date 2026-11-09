// Sampled metrics as the levels and the hardware sidebar read them. The store decides what counts at t
// (RunStore.samplesAt: the last sample while fresh); this file names roles and words the evidence. Roles name one
// meaning that different sources fill: replay reads Nsight Systems GPU metrics, live reads NVML GPM (design: Render,
// Live and replay are one path). Every function reads the store's current catalog, so a live group added later counts.
import { fmtSpan } from "../control/bar.js";

/** role -> catalog metric names, first match wins. A role fills a part of L1 or L7. */
export const ROLES = {
  sm_active: ["SMs Active [Throughput %]", "nvml.gpm.sm_util"],
  tensor: ["Tensor Active [Throughput %]", "nvml.gpm.tensor_util"],
  dram_read: ["DRAM Read Bandwidth [Throughput %]", "nvml.gpm.dram_bw_util"],
  dram_write: ["DRAM Write Bandwidth [Throughput %]"],
  pcie_rx: ["PCIe RX Throughput [Throughput %]", "nvml.pcie.rx"],
  pcie_tx: ["PCIe TX Throughput [Throughput %]", "nvml.pcie.tx"],
  sm_clock: ["GPC Clock Frequency [MHz]", "nvml.clocks.sm", "clocks.sm"],
  mem_used: ["nvml.memory.used", "memory.used"],
};

/** @typedef {import("../store/run.js").RunStore} RunStore */

/** Catalog index (in store.metrics) of the metric that fills a role, optionally on one thing, or -1. @param {RunStore} s */
export function roleOf(s, name, thing = null) {
  for (const metric of ROLES[name] ?? []) { const i = s.metrics.findIndex((m) => m.metric === metric && (thing == null || m.thing === thing)); if (i >= 0) return i; }
  return -1;
}

/** Why metric i has no value at the cursor, for a greyed row. @param {RunStore} s */
export function why(s, i) {
  const c = s.sampleSpan(i);
  return c ? `no sample at the cursor; samples cover ${(c[0] / 1e9).toFixed(2)}–${(c[1] / 1e9).toFixed(2)} s` : "no samples in this run";
}

/** "Nsight Systems GPU metrics · 10 kHz": the source and its sampling period, as evidence. @param {RunStore} s */
export function evidence(s, i) {
  const m = s.metrics[i], ms = m.period_ms ?? s.samplePeriod(i) / 1e6;
  const rate = ms < 1 ? `${+(1 / ms).toFixed(1)} kHz` : ms < 1000 ? `${+ms.toFixed(0)} ms` : fmtSpan(ms * 1e6);
  return `${m.source.replace(/^Observed: /, "")} · ${rate}`;
}

const NON_NEGATIVE = new Set(["%", "Throughput %", "MHz", "W", "MiB"]);

/**
 * Why a sample cannot be a reading in its unit, or "". The timeline run's Nsight Systems export holds only negative
 * GPC and SYS clock values (about -1.68e9 "MHz"); Inferred: a 32-bit wrap of a Hz value (v + 2^32 Hz is about the
 * nvidia-smi SM clock). The value is shown as recorded and flagged, never corrected here.
 */
export function implausible(v, unit) { return v < 0 && NON_NEGATIVE.has(unit) ? `the source recorded ${Math.round(v)} ${unit}, not a valid reading` : ""; }

/** A value with its unit, rounded for reading. */
export function fmtValue(v, unit) {
  if (Number.isNaN(v) || v == null) return "–";
  const u = unit === "Throughput %" ? "%" : unit;
  if (u === "%") return `${v < 10 ? v.toFixed(1) : v.toFixed(0)} %`;
  if (u === "MHz" || u === "MiB" || u === "°C") return `${Math.round(v)} ${u}`;
  if (u === "W") return `${v.toFixed(1)} W`;
  return `${Math.abs(v) >= 100 ? Math.round(v) : +v.toPrecision(3)} ${u}`;
}

/** Bytes with a binary prefix. */
export function fmtBytes(b) {
  if (b == null || Number.isNaN(b)) return "–";
  const u = ["B", "KiB", "MiB", "GiB"]; let k = 0; while (b >= 1024 && k < u.length - 1) { b /= 1024; k++; }
  return `${k ? b.toFixed(b < 10 ? 2 : 1) : b} ${u[k]}`;
}

/** The fraction (0..1) a percent metric lights a part with; NaN for other units. */
export const fracOf = (v, unit) => (unit === "%" || unit === "Throughput %" ? Math.max(0, Math.min(1, v / 100)) : NaN);
