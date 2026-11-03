"""Metrics as they are calculated: latency.json (rep.py's latency_records output) -> Metric records whose inputs are
the spans each value was computed from, plus efficiency (efficiency.json) beside the GPU samples in the window.
"""
import json
from pathlib import Path

from ..schema import Metric, Run
from ...latency import N_TTFT
from .common import find

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
