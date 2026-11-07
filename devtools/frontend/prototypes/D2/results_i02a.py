"""D2 prototype: the per-rep results file (schema ie-results/1, draft) and I02A-L1's file filled from its README and the
saved runs. Every value names its source; values that cannot be traced to a saved file are flagged, not dropped.

Schema (ie-results/1, draft):
  schema, rep {id, title, spec {path, sha256}}
  thesis {claim, guards_against[], source}
  setup {engine, image, model, revision, command, engine_config, request {messages, params}, source}
  runs[] {run_id, role: measured | demonstration | trace (not measured), labels, path}
  values[] {id, name, unit, clock: client | wire | engine | cross-clock | offline, run_id, request_id, value,
            formula, evidence, source {file, pointer}, events[] {run, key, field}, readme {value, line},
            traced: true | false, note}
  checks[] {id, title, why, rows[] {id, quantity, relation, bound {lo, hi, lo_open, hi_open} | equals, tolerance,
            bound_reason, spec_measured {text, source, traced}, per_run {run_id: {value, pass, value_id}},
            wrong_methods[] {name, formula, per_run {run_id: value}, spec_range {text, source, traced}, outcome}}}
  response {run_id, request_id, text, finish_reason, usage, tokens[] {i, text, client_ns, wire_ns, gap_ms}}
A value points at events by `key` (the run.json span id) and at raw files by `file` + JSON pointer; the D2 options
resolve the key differently (bench2.py measures each).
Output: devtools/frontend/prototypes/D2/I02A-L1.results.json (small) + a trace report.
"""
import hashlib
import json
import re
from pathlib import Path

REP = Path(__file__).resolve().parents[4] / "reps/I02A-L1_streamed_latency"
RES = REP / "results"
README = REP / "README.md"
MAIN = "I02A_20261103T164324Z_348959"
MEASURED = [MAIN, "I02A_20261103T172804Z_a3ca9a", "I02A_20261103T172929Z_0e5d39"]
OUT = Path(__file__).resolve().parent / "I02A-L1.results.json"
SPEC = "practice/specs/I02A-L1.md (inference-engineering-fundamentals), Known results"


def load(run, f):
    return json.loads((RES / run / f).read_text())


def readme_line(text):
    for i, l in enumerate(README.read_text().splitlines(), start=1):
        if text in l:
            return i
    return None


def ptr(obj, p):
    for k in p.strip("/").split("/"):
        obj = obj[int(k)] if isinstance(obj, list) else obj[k]
    return obj


def per_run(run):
    rid = f"{run}-measured"
    lat = load(run, "latency.json")[rid]
    cl = load(run, f"client/{rid}.json")
    pm = load(run, "perf_metrics.json")
    st = load(run, "streams.json")[rid]
    pr = load(run, "prompt.json")
    first = pm["first"][0]
    tm = first["perf_metrics"]["timing_metrics"]
    send = cl["send_ns"]
    eng_ft_ms = (tm["first_token_time"] * 1e9 - send) / 1e6
    off = cl["anchor_pair"]["utc_ns"] - cl["anchor_pair"]["monotonic_ns"]
    wire_headers_ms = (st["response_first_ns"] - off - send) / 1e6
    tok = [e for e in cl["events"] if e["event"]["choices"] and e["event"]["choices"][0]["delta"].get("content")
           is not None]
    recs = [len(e["event"]["choices"][0]["logprobs"]["content"]) for e in tok]
    return {"rid": rid, "lat": lat, "cl": cl, "pm": pm, "st": st, "pr": pr, "tm": tm, "send": send, "off": off,
            "eng_ft_ms": eng_ft_ms, "wire_headers_ms": wire_headers_ms, "tok": tok, "recs": recs,
            "first_read_role_only": cl["events"][0]["event"]["choices"][0]["delta"].get("content") is None}


def main():
    R = {r: per_run(r) for r in MEASURED}
    m = R[MAIN]
    values, flags = [], []

    def val(vid, name, unit, clock, v, src_file, pointer, readme_text=None, readme_value=None, events=(),
            formula=None, evidence="Observed", run=MAIN, note=None):
        line = readme_line(readme_text) if readme_text else None
        traced = True
        if readme_value is not None:
            dec = len(str(readme_value).split(".")[1]) if "." in str(readme_value) else 0
            traced = abs(round(float(v), dec) - float(readme_value)) <= 10 ** -dec * 0.51 if isinstance(v, (int, float)) \
                else str(v) == str(readme_value)
            if not traced:
                flags.append(f"{vid}: README {readme_value} (line {line}) vs saved {v}")
        values.append({"id": vid, "name": name, "unit": unit, "clock": clock, "run_id": run,
                       "request_id": f"{run}-measured", "value": v, "formula": formula, "evidence": evidence,
                       "source": {"file": f"results/{run}/{src_file}", "pointer": pointer},
                       "events": [{"run": run, "key": f"{run}-measured/{k}", "field": f} for k, f in events],
                       "readme": {"value": readme_value, "line": line}, "traced": traced, "note": note})

    L = "/" + m["rid"]
    lat = m["lat"]
    # Inspection Points and Results (run 348959)
    val("offline_prompt_tokens", "Prompt tokens, offline", "tokens", "offline", m["pr"]["tokens"], "prompt.json",
        "/tokens", "| 1 offline | Prompt tokens", 34, formula="apply_chat_template")
    for k, name, rv, ev in (("headers_ms", "Response headers", 4.858, [("client/headers", "start_ns")]),
                            ("first_body_read_ms", "First body read", 34.957, [("client/body_read/0", "start_ns")]),
                            ("ttft_ms", "TTFT, client", 35.564, [("client/event/1", "start_ns"), ("client/send", "start_ns")]),
                            ("e2e_ms", "End-to-end, client", 321.604, [("client/send", "start_ns")]),
                            ("mean_itl_ms", "Mean ITL, client", 4.531, []),
                            ("perceived_tps", "Perceived tokens per second", 220.7, [])):
        val(f"client_{k}", name, "ms" if k.endswith("ms") else "tokens/s", "client", lat["client"][k], "latency.json",
            f"{L}/client/{k}", f"| {rv}", rv, events=ev, formula="(last - first) / 63" if k == "mean_itl_ms" else None)
    for k, name, rv in (("headers_ms", "Response headers on the wire", 4.463), ("ttft_ms", "TTFT, wire", 34.910),
                        ("done_ms", "[DONE] on the wire", 321.134), ("mean_itl_ms", "Mean ITL, wire", 4.533)):
        val(f"wire_{k}", name, "ms", "wire", lat["wire"][k], "latency.json", f"{L}/wire/{k}", f"| {rv}", rv,
            evidence="Observed (pcap); converted to the client clock with the record's anchor_pair (Calculated)")
    for k, name, rv in (("queue_ms", "Queue", 2.169), ("ttft_ms", "TTFT, engine", 29.478),
                        ("decode_span_ms", "Decode span", 286.469), ("e2e_ms", "End-to-end, engine", 315.947),
                        ("http_ttft_ms", "HTTP-layer TTFT", 31.370), ("mean_itl_ms", "Mean ITL, engine", 4.547),
                        ("headers_parsed_ms", "Headers parsed (server_arrival_time)", 2.955)):
        val(f"engine_{k}", name, "ms", "engine", lat["engine"][k], "latency.json", f"{L}/engine/{k}", f"{rv}", rv,
            events=[("engine/first_token_time", "start_ns")] if "ttft" in k else [])
    val("token_events", "Token events", "events", "client", lat["client"]["token_events"], "latency.json",
        f"{L}/client/token_events", "| 3 tokens | Token events", 64)
    val("completion_tokens", "usage.completion_tokens", "tokens", "client", m["cl"]["usage"]["completion_tokens"],
        f"client/{m['rid']}.json", "/usage/completion_tokens", "`usage.completion_tokens`, running", None)
    val("events_total", "Events, total", "events", "client", len(m["cl"]["events"]), f"client/{m['rid']}.json",
        "/events (length)", "| 3 tokens | Events, total", 66)
    gaps = lat["client"]["exact_itl_ms"]
    val("gap_min", "Token gap, smallest", "ms", "client", min(gaps), "latency.json", f"{L}/client/exact_itl_ms (min)",
        "Token gaps (exact ITL)", 1.706)
    val("gap_max", "Token gap, largest", "ms", "client", max(gaps), "latency.json", f"{L}/client/exact_itl_ms (max)",
        "Token gaps (exact ITL)", 14.377)
    val("engine_request_id", "/perf_metrics request_id", "", "engine", m["pm"]["first"][0]["request_id"],
        "perf_metrics.json", "/first/0/request_id", "| 5 engine | `request_id`", 3)
    pmf = m["pm"]["first"][0]["perf_metrics"]
    val("iterations", "last_iter - first_iter + 1", "iterations", "engine", pmf["last_iter"] - pmf["first_iter"] + 1,
        "perf_metrics.json", "/first/0/perf_metrics/{first_iter,last_iter}", "129 − 66 + 1 = 64", 64)
    val("second_read_entries", "/perf_metrics second read: entries", "entries", "engine", len(m["pm"].get("second", [])),
        "perf_metrics.json", "/second (length)", "second read: entries", 0)
    seg_readme = [2.348, 1.196, 2.169, 27.309, 1.303, 0.584, 0.655, 1.643, 0.469]
    for i, (s, rv) in enumerate(zip(lat["segments"], seg_readme)):
        val(f"segment_{i}", s["name"], "ms", s["clocks"], s["ms"], "latency.json", f"{L}/segments/{i}/ms",
            f"| {rv} |", rv, evidence="Calculated: difference of two stamps; cross-clock via anchor_pair"
            if "→" in s["clocks"] else "Calculated: difference of two engine stamps")
    s7 = sum(s["ms"] for s in lat["segments"][:7])
    val("segments_sum", "Sum of the 7 TTFT segments", "ms", "cross-clock", s7, "latency.json", f"{L}/segments/0..6",
        "sum of the 7", 35.564, formula="must equal client TTFT", evidence="Calculated")
    # Results bullets that cite numbers not in the run's files
    for text, why in (("decode MBU 0.485", "efficiency.json (if present) or I02A analysis; not re-derived here"),
                      ("SM clock was 2742 MHz", "not found in the run's files: basis.json holds start and end clocks; "
                                                "the nvidia-smi clocks.sm samples in run.json inside the request "
                                                "window read 2632, 2632 and 2797 MHz (Observed)")):
        flags.append(f"README line {readme_line(text)}: '{text}' - {why}")
    eff = RES / MAIN / "efficiency.json"
    if eff.exists():
        ms_ = json.loads(eff.read_text())[m["rid"]]["metrics"]
        k = next(i for i, x in enumerate(ms_) if x["name"] == "decode MBU")
        val("decode_mbu", "Decode MBU", "fraction", "engine", ms_[k]["value"], "efficiency.json",
            f"{L}/metrics/{k}/value", "decode MBU 0.485", 0.485, formula=ms_[k]["formula"],
            evidence="Calculated: bytes per step / engine ITL / Published peak 448 GB/s")
        flags.pop(-2)
    # Checks: per-run values from the saved measured runs (traced) and the spec's 60-request ranges (not traced)
    def chk_row(rid_, quantity, relation, bound, tol, reason, spec_text, spec_k, fn, wrong=()):
        pr_ = {}
        for r in MEASURED:
            v = fn(R[r])
            pr_[r] = {"value": v, "pass": relation(v)}
        return {"id": rid_, "quantity": quantity, "bound": bound, "tolerance": tol, "bound_reason": reason,
                "spec_measured": {"text": spec_text, "source": f"{SPEC} {spec_k}", "traced": False,
                                  "why_not": "60 requests measured 2026-10-31 by the tutor; the raw records are not "
                                             "in the practice repo's results/ (Inferred: kept in a scratch folder)"},
                "per_run": pr_, "wrong_methods": [
                    {"name": n, "formula": f, "per_run": {r: g(R[r]) for r in MEASURED}, "outcome": o,
                     "spec_range": {"text": t, "source": f"{SPEC} K8", "traced": False}} for n, f, g, t, o in wrong]}

    eq = lambda x: (lambda v: v == x)
    checks = [
        {"id": 1, "title": "Token counts: usage against the offline tokenizer and the token records",
         "why": "Exact: integers at temperature 0 with a fixed output length.", "rows": [
            chk_row("1a", "prompt_tokens − offline count", eq(0), {"equals": 0}, "exact", "integers", "34 = 34", "K1, K3",
                    lambda r: r["cl"]["usage"]["prompt_tokens"] - r["pr"]["tokens"]),
            chk_row("1b", "records per token event", lambda v: v == [1], {"equals": 1}, "exact", "the evidence rule",
                    "1", "K3", lambda r: sorted(set(r["recs"]))),
            chk_row("1c", "completion_tokens − sum of records", eq(0), {"equals": 0}, "exact", "integers", "64 = 64",
                    "K3", lambda r: r["cl"]["usage"]["completion_tokens"] - sum(r["recs"])),
            chk_row("1d", "token events − completion_tokens", eq(0), {"equals": 0}, "exact", "integers", "64 = 64",
                    "K2, K3", lambda r: len(r["tok"]) - r["cl"]["usage"]["completion_tokens"],
                    wrong=[("count all events", "len(events) − completion_tokens",
                            lambda r: len(r["cl"]["events"]) - r["cl"]["usage"]["completion_tokens"], "66 events",
                            "fails: 2 extra events")]),
            chk_row("1e", "cached_tokens", eq(0), {"equals": 0}, "exact", "block reuse off", "0", "K3",
                    lambda r: r["cl"]["usage"]["prompt_tokens_details"]["cached_tokens"])]},
        {"id": 2, "title": "Client intervals against the engine's", "why": "Containment and matching boundaries.",
         "rows": [
            chk_row("2a", "mean ITL, client − engine (ms)", lambda v: abs(v) <= 0.1, {"lo": -0.1, "hi": 0.1}, "0.1 ms",
                    "about twice the largest measured difference", "−0.052 to −0.003", "K6, K7, K8",
                    lambda r: r["lat"]["client"]["mean_itl_ms"] - r["lat"]["engine"]["mean_itl_ms"],
                    wrong=[("end-to-end ÷ 64 as ITL", "client e2e / 64 − engine mean ITL",
                            lambda r: r["lat"]["client"]["e2e_ms"] / 64 - r["lat"]["engine"]["mean_itl_ms"],
                            "+0.24 to +0.32", "fails: outside ±0.1")]),
            chk_row("2b", "TTFT remainder, client − engine (ms)", lambda v: 0 < v <= 10, {"lo": 0, "hi": 10, "lo_open": True},
                    "bound", "above the largest remainder (5.97), below the smallest engine TTFT (15.77)",
                    "3.22 to 5.97", "K8", lambda r: r["lat"]["remainder"]["ttft_ms"],
                    wrong=[("headers time as TTFT", "client headers − engine TTFT",
                            lambda r: r["lat"]["client"]["headers_ms"] - r["lat"]["engine"]["ttft_ms"],
                            "−17.26 to −13.07", "fails the lower bound"),
                           ("first body read as TTFT", "first body read − engine TTFT",
                            lambda r: r["lat"]["client"]["first_body_read_ms"] - r["lat"]["engine"]["ttft_ms"],
                            "+2.81 to +5.56", "passes this bound; only check 3 catches it")]),
            chk_row("2c", "client TTFT − HTTP-layer TTFT (ms)", lambda v: 0 < v <= 10, {"lo": 0, "hi": 10, "lo_open": True},
                    "bound", "same as 2b", "2.17 to 2.94", "K8",
                    lambda r: r["lat"]["client"]["ttft_ms"] - r["lat"]["engine"]["http_ttft_ms"]),
            chk_row("2d", "end-to-end remainder (ms)", lambda v: 0 < v <= 10, {"lo": 0, "hi": 10, "lo_open": True},
                    "bound", "same as 2b", "2.97 to 3.94", "K8", lambda r: r["lat"]["remainder"]["e2e_ms"])]},
        {"id": 3, "title": "The hazard: which client time is the first token", "why": "Headers come before any token.",
         "rows": [
            chk_row("3a", "headers before first body read", lambda v: v, {"equals": True}, "exact", "order",
                    "2.69 vs 19.52 (P50)", "K5",
                    lambda r: r["lat"]["client"]["headers_ms"] < r["lat"]["client"]["first_body_read_ms"]),
            chk_row("3b", "first body read holds a token", lambda v: v is False, {"equals": False}, "exact",
                    "content", "role only", "K2, K5", lambda r: not r["first_read_role_only"]),
            chk_row("3c", "first token event − first body read (ms)", lambda v: v > 0, {"lo": 0, "lo_open": True},
                    "exact", "order", "+0.38 to +0.63", "K5",
                    lambda r: r["lat"]["client"]["ttft_ms"] - r["lat"]["client"]["first_body_read_ms"]),
            chk_row("3d", "headers time − engine TTFT (ms)", lambda v: v < 0, {"hi": 0, "hi_open": True}, "exact",
                    "negative control", "−17.26 to −13.07", "K8",
                    lambda r: r["lat"]["client"]["headers_ms"] - r["lat"]["engine"]["ttft_ms"])]},
        {"id": 4, "title": "The join: one isolated request, one engine record", "why": "Correlation rests on isolation.",
         "rows": [
            chk_row("4a", "entries, first read", eq(1), {"equals": 1}, "exact", "isolation", "1", "K9",
                    lambda r: len(r["pm"]["first"])),
            chk_row("4b", "entries, second read", eq(0), {"equals": 0}, "exact", "drain", "0", "K9",
                    lambda r: len(r["pm"].get("second", []))),
            chk_row("4c", "last_iter − first_iter + 1 − completion_tokens", eq(0), {"equals": 0}, "exact",
                    "one token per iteration", "64 = 64", "K7",
                    lambda r: r["pm"]["first"][0]["perf_metrics"]["last_iter"] - r["pm"]["first"][0]["perf_metrics"]
                    ["first_iter"] + 1 - r["cl"]["usage"]["completion_tokens"]),
            chk_row("4d", "request_id type", lambda v: v == "int", {"equals": "int"}, "exact", "engine-internal id",
                    "int", "K7, K10", lambda r: type(r["pm"]["first"][0]["request_id"]).__name__)]},
        {"id": 5, "title": "The wire: the capture against the client and the engine", "why": "The wire is the referee.",
         "rows": [
            chk_row("5b", "token events on the wire − completion_tokens", eq(0), {"equals": 0}, "exact", "third reader",
                    "64 = 64", "K14", lambda r: len(r["st"]["token_event_ns"]) - r["cl"]["usage"]["completion_tokens"]),
            chk_row("5c", "mean ITL, wire − client (ms)", lambda v: abs(v) <= 0.05, {"lo": -0.05, "hi": 0.05}, "0.05 ms",
                    "seven times the largest difference; below the 0.052 of ÷64", "+0.002 to +0.007", "K15",
                    lambda r: r["lat"]["wire"]["mean_itl_ms"] - r["lat"]["client"]["mean_itl_ms"]),
            chk_row("5d", "smallest segment (ms)", lambda v: v > 0, {"lo": 0, "lo_open": True}, "bound",
                    "the clock join", "≥ 0.094", "K15, K16", lambda r: min(s["ms"] for s in r["lat"]["segments"])),
            chk_row("5e", "headers on wire − first_token_time (ms)", lambda v: v < 0, {"hi": 0, "hi_open": True},
                    "exact", "hazard on a third clock", "−19.73 to −15.24", "K15",
                    lambda r: r["wire_headers_ms"] - r["eng_ft_ms"])]},
    ]
    flags.append("Check 5 row 1 (chat requests in the stream = 1): streams.json keeps one stream per request id; "
                 "the count of chat requests per TCP stream is not saved, so it is not filled (Unavailable)")
    kl = readme_line("gives 56 records for 64 tokens (K4)")
    flags.append(f"README line {kl} says K4 gives 56 records; line {readme_line('gives 58 records')} and "
                 f"results/k4_demo.json say 58 (the spec measured 56 on another day). The file uses 58 (k4_demo.json).")
    k4 = json.loads((RES / "k4_demo.json").read_text())
    tokens = []
    prev = None
    wire = m["st"]["token_event_ns"]
    for i, e in enumerate(m["tok"]):
        lp = e["event"]["choices"][0]["logprobs"]["content"]
        w = wire[i] - m["off"] if i < len(wire) else None
        tokens.append({"i": i, "text": "".join(x["token"] for x in lp), "client_ns": e["ns"], "wire_ns": w,
                       "gap_ms": None if prev is None else round((e["ns"] - prev) / 1e6, 6),
                       "logprob": lp[0]["logprob"]})
        prev = e["ns"]
    spec_rel = "inference-engineering-fundamentals/practice/specs/I02A-L1.md"
    doc = {
        "schema": "ie-results/1 (draft, D2 prototype)",
        "rep": {"id": "I02A-L1", "title": "Streamed latency",
                "spec": {"path": "reps/I02A-L1_streamed_latency/README.md",
                         "sha256": hashlib.sha256(README.read_bytes()).hexdigest()},
                "course_spec": spec_rel},
        "thesis": {"claim": "TTFT is a client time that must hold a token; every latency has an owner across three "
                            "clocks (client, wire, engine).",
                   "guards_against": ["headers time taken as TTFT", "first body read taken as TTFT (role event only)",
                                      "end-to-end ÷ 64 taken as ITL", "joining the wrong /perf_metrics record",
                                      "special tokens with no event (K4)"],
                   "source": {"file": "README.md", "lines": [readme_line("## Mechanism"), readme_line("## Why It Matters")]},
                   "traced": True, "note": "Summarised from Mechanism and Why It Matters; the spec's 'What this rep "
                                           "is for' section was not read for this draft."},
        "setup": {"engine": "TensorRT-LLM 1.2.1, PyTorch backend, trtllm-serve",
                  "image": load(MAIN, "basis.json")["images"],
                  "model": "Qwen2.5-0.5B-Instruct", "revision": "7ae557604adf67be50417f59c2c2f167def9a775",
                  "command": "trtllm-serve serve /model --backend pytorch --host 0.0.0.0 --port 8080 --max_batch_size 1 "
                             "--max_seq_len 2048 --config /config/config.yaml",
                  "engine_config_file": f"results/{MAIN}/config.yaml",
                  "request": {"rendered_prompt": m["pr"]["rendered"], "prompt_tokens": m["pr"]["tokens"],
                              "params": "max_tokens=64, temperature=0, seed=0, stream=True, include_usage, logprobs, "
                                        "top_logprobs=1, ignore_eos, skip_special_tokens=false"},
                  "source": {"file": "README.md", "lines": [readme_line("| Engine |"), readme_line("| Request |")],
                             "basis": f"results/{MAIN}/basis.json", "prompt": f"results/{MAIN}/prompt.json"}},
        "runs": [{"run_id": r, "role": "measured", "labels": load(r, "labels.json")} for r in MEASURED] +
                [{"run_id": "K4_20261103T172626Z_3c139c", "role": "demonstration", "demo": "K4",
                  "values": {k: {x: k4[k][x] for x in ("records", "completion_tokens", "check_1_holds")}
                             for k in ("default", "false")}, "source": "results/k4_demo.json"}] +
                [{"run_id": d.name, "role": "trace (not measured)", "labels": json.loads((d / "labels.json").read_text())}
                 for d in sorted(RES.glob("I02A-TRACE-*")) if (d / "labels.json").exists()],
        "values": values, "checks": checks,
        "response": {"run_id": MAIN, "request_id": m["rid"], "text": "".join(t["text"] for t in tokens),
                     "finish_reason": m["cl"]["finish_reason"], "usage": m["cl"]["usage"], "tokens": tokens,
                     "source": {"client": f"results/{MAIN}/client/{m['rid']}.json /events/*/event/choices/0/logprobs",
                                "wire": f"results/{MAIN}/streams.json /{m['rid']}/token_event_ns (UTC ns, converted "
                                        f"with anchor_pair: Calculated)"}},
        "flags": flags,
    }
    for c in checks:
        for row in c["rows"]:
            for r, x in row["per_run"].items():
                if isinstance(x["value"], float):
                    x["value"] = round(x["value"], 6)
            for w in row["wrong_methods"]:
                w["per_run"] = {r: round(v, 6) for r, v in w["per_run"].items()}
    OUT.write_text(json.dumps(doc, indent=1, ensure_ascii=False, default=str))
    summary = {"values": len(values), "traced": sum(v["traced"] for v in values),
               "untraced": [v["id"] for v in values if not v["traced"]], "flags": flags,
               "check_rows": sum(len(c["rows"]) for c in checks),
               "passes": {r: sum(row["per_run"][r]["pass"] for c in checks for row in c["rows"]) for r in MEASURED},
               "bytes": OUT.stat().st_size}
    print(json.dumps(summary, indent=1, ensure_ascii=False))
    Path("/mnt/ie-data/cc-v2-proto/bench/d2_results_trace.json").write_text(json.dumps(summary, indent=1,
                                                                                         ensure_ascii=False))


if __name__ == "__main__":
    main()
