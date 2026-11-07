"""D2 prototype: merge the measured files into D2/results.json for index.html. Hand-written rows (data problems,
engine sources, export, effort) carry their own evidence label; none of them is a measurement."""
import json
from pathlib import Path

BENCH = Path("/mnt/ie-data/cc-v2-proto/bench")
D2 = Path("/mnt/ie-data/cc-v2-proto/d2")
HERE = Path(__file__).resolve().parent
L = lambda n: json.loads((BENCH / n).read_text())

PROBLEMS = [
    ("nsys.py allow-list drops most of the capture",
     "Fixed at import, not by the model: read the whole .sqlite. D2 imported the full PyTorch trace (1,139,192 events, "
     "Observed); a full Nsight re-import was not run in D2 (Not measured).",
     "A, B, D: any category fits (A attrs, B kind+attrs, D span attrs).",
     "C: only what maps to a slice, counter or flow; 3,077 deep slices dropped (Observed)."),
    ("No pid/tid in torch_trace.py spans",
     "The full trace JSON has pid/tid; ingest takes them (Observed: 1,232,270 of 1,237,929 events have a PID).",
     "A, B, D keep pid/tid columns or attributes; B also links the span to a process thing.",
     "C: pid/tid become the track; 1,229,193 kept (Observed)."),
    ("Host PIDs mostly Unavailable",
     "Store the PID with its namespace and evidence (host / container / Unavailable).",
     "B: process thing holds host_pid, container_pid, evidence. A, D: attributes, no typed home.",
     "C: one integer pid per track; no namespace, no evidence label."),
    ("Engine records carry no process",
     "Owner process is Inferred (from the log that wrote them).",
     "B: 'owned_by' edge labeled Inferred. A, D: attribute only.",
     "C: a track must name a process, so the Inferred owner looks Observed."),
    ("ZMQ pairs matched by order",
     "Link rule = 'order', evidence Calculated.",
     "A, B, D keep rule and evidence on every link (59,857 / 59,867 links).",
     "C: flows carry no attributes; 0 links keep the rule (Observed)."),
    ("Nsight quirks: stream 4294967295, PID 0, open-ended rows, negative starts",
     "Flag columns at import: stream_all 2,028, pid0 4 (DIAGNOSTIC_EVENT), negative 1,803, no_end 14 (instants, "
     "not open ranges; Observed). No open-ended ranges found.",
     "A, B, D keep the flags.",
     "C: flags must ride as debug args; stream 4294967295 becomes a track name."),
]
SOURCES = [
    ("TensorRT-LLM (measured here)", "Nsight NVTX + CUPTI, PyTorch profiler, iteration stats, server log, nvidia-smi",
     "all map to B kinds; graph id and node kernels Observed, batch size Inferred from the log", "Observed"),
    ("vLLM", "PyTorch profiler, Nsight NVTX, OTLP request spans, Prometheus metrics",
     "same kinds as TRT-LLM; OTLP spans import as request events", "Inferred (Published docs; no vLLM run in D2)"),
    ("SGLang", "PyTorch profiler, Nsight, Prometheus metrics; OTLP not verified",
     "same kinds; request spans from its log", "Inferred (not verified; D8 runs pending owner go)"),
]
EXPORT = [
    ("A", "Perfetto via the C encoder; Chrome JSON trivial", "Inferred (not built)"),
    ("B", "Perfetto via the C encoder (same records: 1,234,852 slices, 59,857 flows exact); Chrome JSON trivial",
     "Observed for Perfetto (C build); Chrome JSON Inferred"),
    ("C", "native; depth limit and lost link rules apply to any Perfetto export", "Observed"),
    ("D", "native OTLP; Perfetto via the C encoder", "Inferred"),
]
EFFORT = [("A", "small: one table + JSON attrs; slow JSON queries"), ("B", "medium: five kinds + v1 converter (built here)"),
          ("C", "large: hand-written protobuf, trace_processor round trip, 50 s build"),
          ("D", "medium: Unix clock offset per run, resource model; no thing tree")]
REF = [("A", "span_key column on spans.parquet"), ("B", "events.key (run.json span_id, else source/id)"),
       ("C", "debug.ie_key arg in trace_processor args"), ("D", "ie.key span attribute (JSON)")]
DECISIONS = [
    "D2 option. Recommended: B (ie-run/2 with five record kinds and a v1 converter).",
    "Stable event key: run.json span_id where it exists, else '<source>/<id>'. A results file points at this key.",
    "Iteration share rule: request tokens in the iteration / all tokens in the iteration (tested on a SYNTHETIC "
    "two-request fixture only).",
    "Results-file schema ie-results/1 (draft), and how to treat spec ranges that trace only to the spec's Known results "
    "(raw data not saved): accept as traced:false, or re-measure and save.",
    "Whether D1 also keeps the denormalized link files (focus 2x faster; +85 MB at synthetic scale).",
    "README fixes for the rep (not changed here): 'SM clock 2742 MHz' not found in the runs; K4 56 vs 58.",
]


def main():
    out = {
        "d1x": {"real": L("d1x_real.json"), "synthetic": L("d1x_synthetic.json")},
        "bench": L("d2_bench.json"), "builds": L("d2_builds.json"), "catalog": L("d2_catalog.json"),
        "results_trace": L("d2_results_trace.json"),
        "c_load": json.loads((D2 / "C" / "load_stats.json").read_text()),
        "fixtures": json.loads((D2 / "fixtures" / "expected.json").read_text()),
        "problems": PROBLEMS, "sources": SOURCES, "export": EXPORT, "effort": EFFORT, "ref": REF,
        "decisions": DECISIONS,
    }
    import duckdb
    out["board"] = [dict(zip(("id", "parent", "kind", "name", "attrs", "evidence"), r)) for r in duckdb.connect().execute(
        f"SELECT id, parent_id, kind, name, attrs, evidence FROM read_parquet('{D2}/fixtures/things.parquet') "
        "WHERE run = 'fixture/board'").fetchall()]
    (HERE / "results.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    print("fixtures keys:", list(out["fixtures"]))


if __name__ == "__main__":
    main()
