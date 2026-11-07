"""D2 prototype: the measure catalog. Each measure: formula, unit, additivity, sources with their resolution, evidence
label, and a value computed on option B's tables where the saved runs hold the inputs (Observed or Calculated).
Window for timeline values: the measured request's engine iterations 66-129 (NVTX _forward_step labels 65-128).
Additivity: additive = sums over any split (time, process, request); semi-additive = sums over disjoint time only, not
over overlapping resources; non-additive = recompute from its parts (ratios: sum of numerators / sum of denominators).
Output: /mnt/ie-data/cc-v2-proto/bench/d2_catalog.json
"""
import json
from pathlib import Path

import duckdb

B = Path("/mnt/ie-data/cc-v2-proto/d2/B")
RES = Path(__file__).resolve().parents[4] / "reps/I02A-L1_streamed_latency/results"
TL = "I02A-TRACE-timeline_20261103T185837Z_e08b8b"
CODE = "I02A-TRACE-code_20261103T170709Z_0ac2db"
COMP = "I02A-TRACE-components_20261104T142238Z_0b249c"
MAIN = "I02A_20261103T164324Z_348959"


def main():
    c = duckdb.connect()
    for t in ("events", "links", "samples", "things"):
        c.execute(f"CREATE VIEW {t} AS SELECT * FROM read_parquet('{B}/{t}.parquet')")
    w0, w1 = c.execute(f"""SELECT min(start_ns), max(end_ns) FROM events WHERE run = '{TL}' AND category = 'nvtx'
        AND name LIKE '[Executor] _forward_step%' AND iteration BETWEEN 66 AND 129""").fetchone()
    win = (w1 - w0) / 1e6
    q = lambda sql: c.execute(sql).fetchone()
    k = f"run = '{TL}' AND category = 'kernel' AND start_ns <= {w1} AND end_ns >= {w0}"
    clip = f"least(end_ns, {w1}) - greatest(start_ns, {w0})"
    ksum = q(f"SELECT sum({clip}) FROM events WHERE {k}")[0] / 1e6
    union = q(f"""WITH s AS (SELECT greatest(start_ns, {w0}) s, least(end_ns, {w1}) e FROM events WHERE {k}),
        m AS (SELECT s, e, max(e) OVER (ORDER BY s, e ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) pe FROM s),
        g AS (SELECT s, e, sum(CASE WHEN pe IS NULL OR s > pe THEN 1 ELSE 0 END) OVER (ORDER BY s, e) i FROM m)
        SELECT sum(e - s) FROM (SELECT min(s) s, max(e) e FROM g GROUP BY i)""")[0] / 1e6
    h2d = q(f"""SELECT sum(bytes * ({clip}) / greatest(end_ns - start_ns, 1)), sum({clip}) FROM events
        WHERE run = '{TL}' AND category = 'memcpy' AND name = 'host to device' AND start_ns <= {w1} AND end_ns >= {w0}""")
    lo = q(f"""SELECT median(k.start_ns - la.start_ns) / 1e3, count(*) FROM events k JOIN links l ON l.to_id = k.id
        JOIN events la ON la.id = l.from_id WHERE k.run = '{TL}' AND k.category = 'kernel' AND k.iteration BETWEEN 67 AND 129
        AND la.name LIKE 'cudaLaunchKernel%'""")
    itd = q(f"""SELECT median(end_ns - start_ns) / 1e6, count(*) FROM events WHERE run = '{TL}' AND category = 'nvtx'
        AND name LIKE '[Executor] _forward_step%' AND iteration BETWEEN 67 AND 129""")
    org = dict(c.execute(f"""SELECT code_origin, sum(end_ns - start_ns) / 1e6 FROM events WHERE run = '{CODE}'
        AND category = 'kernel' AND iteration BETWEEN 66 AND 129 GROUP BY 1""").fetchall())
    sm = q(f"""SELECT avg(value), count(*) FROM samples WHERE run = '{TL}' AND metric = 'SMs Active [Throughput %]'
        AND ts_ns BETWEEN {w0} AND {w1}""")
    pw = q(f"""SELECT avg(value), count(*) FROM samples WHERE run = '{TL}' AND metric = 'power.draw'
        AND ts_ns BETWEEN {w0} AND {w1}""")
    zmq = q(f"""SELECT median(b.start_ns - a.start_ns) / 1e3, count(*) FROM links l JOIN events a ON a.id = l.from_id
        JOIN events b ON b.id = l.to_id WHERE l.run = '{COMP}' AND l.kind = 'zmq'""")
    gen = c.execute(f"""SELECT value, count(*) FROM samples WHERE run = '{TL}' AND metric = 'pcie.link.gen.current'
        GROUP BY 1 ORDER BY 1""").fetchall()
    lat = json.loads((RES / MAIN / "latency.json").read_text())[f"{MAIN}-measured"]
    eff = json.loads((RES / MAIN / "efficiency.json").read_text())[f"{MAIN}-measured"]["metrics"]
    mbu = next(m["value"] for m in eff if m["name"] == "decode MBU")
    shares = json.loads((B.parent / "fixtures" / "expected.json").read_text())["kernel_ns_by_request"]
    W = f"timeline run, iterations 66-129 ({win:.3f} ms window)"
    cat = [
        ("TTFT, client", "first token event − send", "ms", "non-additive (a duration per request)",
         "client stamps (perf_counter_ns, 1 ns)", "Observed", lat["client"]["ttft_ms"], f"run {MAIN}"),
        ("Mean ITL, client", "(last token event − first) / (tokens − 1)", "ms", "non-additive (ratio)",
         "client stamps (1 ns)", "Calculated", lat["client"]["mean_itl_ms"], f"run {MAIN}"),
        ("End-to-end, client", "protocol completion − send", "ms", "non-additive", "client stamps (1 ns)", "Observed",
         lat["client"]["e2e_ms"], f"run {MAIN}"),
        ("Iteration duration", "NVTX _forward_step end − start", "ms", "additive over time on one executor",
         "Nsight NVTX (ns)", "Observed", itd[0], f"median of {itd[1]} decode iterations, {TL}"),
        ("Kernel time", "Σ clipped kernel durations", "ms", "additive (process, stream, request share)",
         "CUPTI kernel records (ns)", "Observed", ksum, W),
        ("GPU busy", "|∪ kernel intervals| clipped to the slice", "ms", "semi-additive (disjoint time only)",
         "CUPTI kernel records (ns)", "Calculated", union, W),
        ("GPU busy fraction", "GPU busy / slice length", "fraction", "non-additive (sum/sum)", "as GPU busy",
         "Calculated", union / win, W),
        ("H2D throughput", "Σ clipped bytes / Σ clipped seconds (host to device copies)", "GB/s", "non-additive (sum/sum)",
         "CUPTI memcpy records (ns, bytes)", "Calculated", (h2d[0] or 0) / max(h2d[1] or 1, 1), W),
        ("Launch latency", "kernel start − its cudaLaunchKernel start (CUPTI correlation)", "µs",
         "non-additive (distribution)", "CUPTI runtime + kernel (ns)", "Observed", lo[0],
         f"median of {lo[1]} eager launches, iterations 67-129 (graph launches excluded)"),
        ("Kernel time by code origin", "Σ kernel time grouped by model code / engine code", "ms", "additive",
         "PyTorch profiler kernels + nn.Module ranges (µs, 3 decimals)", "Observed",
         {k_: round(v, 3) for k_, v in org.items()}, f"{CODE}, iterations 66-129 (profiled run: slower)"),
        ("Kernel time per request (iteration shares)", "Σ_iterations kernel time × share", "ns", "additive across requests",
         "kernels + 'serves' links with weight", "Calculated (SYNTHETIC fixture)", shares, "fixture/shares"),
        ("SMs active", "time-weighted mean of the GPU metric (equal 100 µs samples: plain mean)", "%",
         "non-additive (mean); below 100 µs: 'below resolution'", "Nsight GPU metrics, 10 kHz", "Observed",
         sm[0], f"{sm[1]} samples, {W}"),
        ("Power", "mean of nvidia-smi power.draw; energy = ∫ power dt", "W", "non-additive (mean); energy additive",
         "nvidia-smi, 10 Hz (100 ms: wider than one iteration)", "Observed", pw[0], f"{pw[1]} samples, {W}"),
        ("PCIe link generation", "last sample at or before t", "gen", "non-additive (state)", "nvidia-smi, 10 Hz",
         "Observed", {str(int(v)): n for v, n in gen}, f"sample counts by value, {TL}"),
        ("ZMQ hop latency", "receive stamp − send stamp, k-th send ↔ k-th receive", "µs", "non-additive (distribution)",
         "component stamps (ns)", "Calculated (pairing by order)", zmq[0], f"median of {zmq[1]} hops, {COMP}"),
        ("Decode MBU", "bytes per decode step / engine ITL / 448 GB/s", "fraction", "non-additive (ratio)",
         "efficiency.json (weights + KV bytes), engine ITL; peak Published", "Calculated", mbu, f"run {MAIN}"),
        ("Prefill MFU", "achieved FLOP/s / peak tensor FLOP/s", "fraction", "non-additive (ratio)",
         "peak tensor FLOP/s not sourced (I03)", "Unavailable", None, "—"),
    ]
    out = [{"measure": a, "formula": b, "unit": u, "additivity": ad, "sources_resolution": s, "evidence": e,
            "value": v if not isinstance(v, float) else round(v, 4), "where": wh} for a, b, u, ad, s, e, v, wh in cat]
    Path("/mnt/ie-data/cc-v2-proto/bench/d2_catalog.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    for r in out:
        print(r["measure"], "|", r["value"], "|", r["evidence"])


if __name__ == "__main__":
    main()
