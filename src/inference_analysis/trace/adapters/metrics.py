"""Metrics as they are calculated: latency.json (rep.py's latency_records output) -> Metric records whose inputs are
the spans each value was computed from, plus efficiency (efficiency.json) beside the GPU samples in the window,
plus aggregate() for an unpaired native set (native_records.json; its file shapes are in engine.py).
"""
import hashlib
import json
import math
import re
from pathlib import Path

from ..schema import Metric, Run, Span
from ...latency import N_TTFT
from .common import find, run_dir

ENGINE = "{rid}/engine/{f}"


def _span_id(run: Run, rid: str, component: str, name: str) -> str | None:
    s = find(run, rid, component, name)
    return s.id if s else None


def _token_events(run: Run, rid: str) -> list:
    return sorted((s for s in run.spans if s.request_id == rid and s.component == "sdk"
                   and s.name == "event: token"), key=lambda s: s.start_ns)


def _wire_tokens(run: Run, rid: str) -> list:
    return sorted((s for s in run.spans if s.request_id == rid and s.component == "eth0"
                   and s.attrs.get("token_events")), key=lambda s: s.start_ns)


def latency(path: Path, run: Run) -> None:
    known = {s.id for s in run.spans}
    for rid, rec in json.loads(path.read_text()).items():
        def e(field):
            return ENGINE.format(rid=rid, f=field)
        tokens = _token_events(run, rid)
        wire_tokens = _wire_tokens(run, rid)
        done = next((s.id for s in run.spans if s.request_id == rid and s.attrs.get("done")), None)
        last_sent = [s for s in run.spans if s.request_id == rid and s.component == "eth0"
                     and s.attrs.get("direction") == "to server" and s.attrs.get("bytes")]
        response = next((s for s in sorted(run.spans, key=lambda s: s.start_ns) if s.request_id == rid
                         and s.component == "eth0" and s.name == "response headers"), None)
        send, first_tok = f"{rid}/client/send", tokens[0].id if tokens else None
        c, g = rec["client"], rec["engine"]
        rows = [
            ("client TTFT", "first token event - send", (send, first_tok), c["ttft_ms"]),
            ("client headers", "response headers - send", (send, f"{rid}/client/headers"), c["headers_ms"]),
            ("client end-to-end", "protocol complete - send", (send, f"{rid}/client/protocol_complete"),
             c["e2e_ms"]),
            ("client mean ITL", "(last token event - first token event) / (n - 1)",
             (first_tok, tokens[-1].id if tokens else None), c["mean_itl_ms"]),
            ("engine queue", "first_scheduled_time - arrival_time", (e("arrival_time"), e("first_scheduled_time")),
             g["queue_ms"]),
            ("engine TTFT", "first_token_time - arrival_time", (e("arrival_time"), e("first_token_time")),
             g["ttft_ms"]),
            ("engine decode span", "last_token_time - first_token_time", (e("first_token_time"),
                                                                           e("last_token_time")), g["decode_span_ms"]),
            ("engine mean ITL", "decode span / (completion_tokens - 1)", (e("first_token_time"),
                                                                          e("last_token_time")), g["mean_itl_ms"]),
            ("engine HTTP TTFT", "server_first_token_time - server_arrival_time",
             (e("server_arrival_time"), e("server_first_token_time")), g["http_ttft_ms"]),
            ("TTFT remainder", "client TTFT - engine TTFT", (send, first_tok, e("arrival_time"),
                                                             e("first_token_time")), rec["remainder"]["ttft_ms"]),
        ]
        if "wire" in rec:
            w = rec["wire"]
            rows += [("wire TTFT", "first token frame - send", (send, wire_tokens[0].id if wire_tokens else None),
                      w["ttft_ms"]),
                     ("wire mean ITL", "(last token frame - first token frame) / (n - 1)",
                      (wire_tokens[0].id if wire_tokens else None, wire_tokens[-1].id if wire_tokens else None),
                      w["mean_itl_ms"]),
                     ("wire headers", "response headers frame - send", (send, response.id if response else None),
                      w["headers_ms"])]
            seg_ends = [send, max(last_sent, key=lambda s: s.start_ns).id if last_sent else None,
                        e("arrival_time"), e("first_scheduled_time"),
                        e("first_token_time"), e("server_first_token_time"),
                        wire_tokens[0].id if wire_tokens else None, first_tok]
            tail_ends = [e("last_token_time"), done, f"{rid}/client/protocol_complete"]
            for i, s in enumerate(rec["segments"]):  # N_TTFT TTFT segments, then the 2 end-to-end tail segments
                ends = (seg_ends[i], seg_ends[i + 1]) if i < N_TTFT else (tail_ends[i - N_TTFT],
                                                                          tail_ends[i - N_TTFT + 1])
                rows.append((f"segment {i + 1}: {s['name']}", f"[{s['clocks']}] end - start", ends, s["ms"]))
        for name, formula, inputs, value in rows:
            inputs = tuple(i for i in inputs if i in known)
            run.metrics.append(Metric(name, formula, inputs, value, "ms", rid))
        if c.get("perceived_tps") is not None:
            run.metrics.append(Metric("perceived TPS", "1000 / client mean ITL", (first_tok, tokens[-1].id),
                                      c["perceived_tps"], "token/s", rid))
        for k, v in c.get("unavailable", {}).items():
            run.unavailable.append({"what": f"{rid}: client {k}", "why": v})


def efficiency(path: Path, run: Run) -> None:
    """MBU and MFU per request (efficiency.json from rep.py), and the GPU samples taken during the request."""
    for rid, eff in json.loads(path.read_text()).items():
        request = find(run, rid, "locust", "request")
        decode = find(run, rid, "executor", "decode (iterations %d-%d)" % (eff["first_iter"] + 1, eff["last_iter"]))
        prefill = find(run, rid, "executor", "prefill (iteration %d)" % eff["first_iter"])
        inputs = tuple(s.id for s in (decode, prefill) if s)
        for m in eff["metrics"]:
            run.metrics.append(Metric(m["name"], m["formula"], inputs, m["value"], m["unit"], rid))
        if request:
            samples = [s for s in run.spans if s.component == "gpu" and s.name == "sample"
                       and request.start_ns <= s.start_ns <= request.end_ns]
            for key in ("utilization.gpu", "utilization.memory", "memory.used", "power.draw", "clocks.sm"):
                values = [s.attrs[key] for s in samples if s.attrs.get(key) is not None]
                run.metrics.append(Metric(f"GPU {key} during the request (mean of {len(values)} samples)",
                                          f"mean(nvidia-smi {key})", tuple(s.id for s in samples),
                                          sum(values) / len(values) if values else None, key, rid))
        for u in eff.get("unavailable", []):
            run.unavailable.append({"what": f"{rid}: {u['what']}", "why": u["why"]})


SAMPLE = re.compile(r"^([a-zA-Z_:][\w:]*)(\{[^}]*\})?\s+(\S+)")  # one sample line of the text format
SCRAPES = ("baseline", "final")
FAMILIES = {  # metric name -> (Prometheus series name, unit); every label set of the series is summed
    "Prometheus queue sum delta": ("trtllm_request_queue_time_seconds_sum", "s"),
    "Prometheus queue count delta": ("trtllm_request_queue_time_seconds_count", "requests"),
    "Prometheus success delta": ("trtllm_request_success_total", "requests"),
}


def scrape_spans(run: Run, folder: Path, which: str, read: dict) -> dict[str, Span]:
    """The sample lines of one saved scrape that FAMILIES use, as spans at its read time: {series: span}."""
    file = f"prometheus_{which}.txt"
    names = {series for series, _ in FAMILIES.values()}
    out = {}
    for n, line in enumerate((folder / file).read_text().splitlines(), 1):
        match = SAMPLE.match(line)
        if match and match.group(1) in names:
            series = match.group(1) + (match.group(2) or "")
            out[series] = Span(f"prometheus/{which}/line {n}", "server", "prometheus", f"{which} scrape: {series}",
                               read["start_ns"], read["end_ns"], None,
                               {"series": series, "value": float(match.group(3)), "scrape": which},
                               {"file": file, "pointer": f"line {n}"})
    run.spans += out.values()
    return out


def aggregate(path: Path, run: Run) -> None:
    """Totals over the unpaired native set (request_id None): native queue sum and count, and matching-window
    Prometheus deltas when both scrapes are saved. Sums use math.fsum, so the native list's order cannot change them."""
    data, folder = json.loads(path.read_text()), run_dir(path)
    queues = []  # (span id, seconds) for each positive interval: the producer observes only positive ones
    for entry in data["first"]:
        t = entry["perf_metrics"]["timing_metrics"]
        interval = t["first_scheduled_time"] - t["arrival_time"]
        if interval > 0:
            queues.append((f"native/{entry['request_id']}/queue", interval))
    queues.sort()  # inputs listed by span id, not by the list's order
    ids = tuple(i for i, _ in queues)
    native_sum = math.fsum(v for _, v in queues)
    run.metrics += [
        Metric("native queue sum (unpaired set)", "fsum(first_scheduled_time - arrival_time) over native records "
               "with a positive interval", ids, native_sum, "s"),
        Metric("native queue count (unpaired set)", "count(native records with first_scheduled_time - arrival_time "
               "> 0)", ids, float(len(queues)), "requests"),
    ]
    files = [folder / f"prometheus_{w}.txt" for w in SCRAPES]
    reads = data.get("prometheus_reads") or {}
    if not all(f.exists() for f in files):
        run.unavailable.append({"what": "Prometheus deltas", "why": "prometheus_baseline.txt and prometheus_final.txt "
                                "are not both saved"})
        return
    if not all(w in reads for w in SCRAPES):
        run.unavailable.append({"what": "Prometheus deltas", "why": "native_records.json has no prometheus_reads "
                                "times for both scrapes"})
        return
    for f in files:
        run.sources.append({"file": f.name, "sha256": hashlib.sha256(f.read_bytes()).hexdigest(),
                            "adapter": f"{aggregate.__module__}.{aggregate.__name__}"})
    before, after = (scrape_spans(run, folder, w, reads[w]) for w in SCRAPES)
    deltas = {}
    for name, (series_name, unit) in FAMILIES.items():
        keys = sorted(k for k in {*before, *after} if k.split("{")[0] == series_name)
        finals = [after[k].attrs["value"] if k in after else None for k in keys]
        bases = [before[k].attrs["value"] if k in before else 0.0 for k in keys]  # absent at baseline: none yet
        inputs = tuple(x.id for k in keys for x in (before.get(k), after.get(k)) if x)
        if not keys or None in finals or any(a < b for a, b in zip(finals, bases)):
            value = None  # missing at the final scrape, or a counter went down (restarted server): not clamped
            run.unavailable.append({"what": name, "why": f"{series_name}: missing at the final scrape or lower "
                                    "than at baseline (restarted server?)"})
        else:
            value = math.fsum(a - b for a, b in zip(finals, bases))
        deltas[name] = (value, inputs)
        run.metrics.append(Metric(name, f"sum over label sets of final - baseline {series_name}", inputs, value, unit))
    prom, prom_inputs = deltas["Prometheus queue sum delta"]
    run.metrics.append(Metric("native queue sum - Prometheus queue sum delta",
                              "(native queue sum - Prometheus queue sum delta) x 1000; both from the engine's own "
                              "timestamps, so this checks the export, not that clock", ids + prom_inputs,
                              None if prom is None else (native_sum - prom) * 1000, "ms"))
