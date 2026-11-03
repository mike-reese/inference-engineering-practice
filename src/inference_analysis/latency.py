"""latency_records: one streamed request on three clocks (client, wire, engine), every value in ms and named by clock.

Clocks:
- client: CLOCK_MONOTONIC ns (time.perf_counter_ns in the client container).
- engine: CLOCK_MONOTONIC seconds (steady_clock in the server container; the same kernel clock, K16).
- wire: CLOCK_REALTIME ns from the capture; converted as wire_ns - (anchor.utc_ns - anchor.monotonic_ns).
Every value is milliseconds from the client's send unless it is an interval.
"""
from .chat_records import chat_durations, content_event_gaps

NS_PER_MS = 1_000_000

TTFT_SEGMENTS = (  # (name, clocks): each starts where the previous ended; they sum to client TTFT
    ("send → request's last byte on the wire", "client → pcap"),
    ("wire → server_arrival_time", "pcap → engine"),
    ("server_arrival_time → arrival_time", "engine"),
    ("arrival_time → first_scheduled_time", "engine"),
    ("first_scheduled_time → first_token_time", "engine"),
    ("first_token_time → server_first_token_time", "engine"),
    ("server_first_token_time → first token on the wire", "engine → pcap"),
    ("wire → client first token event", "pcap → client"),
)
TAIL_SEGMENTS = (
    ("last_token_time → [DONE] on the wire", "engine → pcap"),
    ("[DONE] on the wire → protocol completion", "pcap → client"),
)


def token_records(event: dict) -> int | None:
    """logprobs.content records in one event; None when the event has no choices."""
    choices = event.get("choices") or []
    if not choices:
        return None
    logprobs = choices[0].get("logprobs") or {}
    return len(logprobs.get("content") or [])


def is_token_event(event: dict) -> bool:
    choices = event.get("choices") or []
    return bool(choices) and bool(choices[0]["delta"].get("content") or token_records(event))


def latency_records(record: dict, perf_entry: dict, stream: dict | None = None) -> dict:
    """One latency record from a send_one record (detail on), its /perf_metrics entry and its pcap_streams entry.

    client.ttft_ms = first token event - send;  client.e2e_ms = protocol completion - send
    client.exact_itl_ms = gaps between consecutive token events (only under the evidence rule)
    client.mean_itl_ms = (last token event - first token event) / (n - 1);  perceived_tps = 1000 / mean_itl_ms
    engine.queue_ms = first_scheduled_time - arrival_time;  engine.ttft_ms = first_token_time - arrival_time
    engine.decode_span_ms = last_token_time - first_token_time;  engine.e2e_ms = last_token_time - arrival_time
    engine.http_ttft_ms = server_first_token_time - server_arrival_time
    engine.mean_itl_ms = decode_span_ms / (completion_tokens - 1)
    remainder = client - engine for ttft, e2e and mean ITL
    wire: headers, first token event, [DONE] from send; mean ITL over the token events on the wire
    segments: TTFT_SEGMENTS (sum = client.ttft_ms) then TAIL_SEGMENTS
    """
    if not record.get("detail", True) or not record.get("events"):
        raise ValueError(f"{record['request_id']}: saved without detail; latency needs every event")
    if not record["complete"]:
        raise ValueError(f"{record['request_id']}: incomplete record ({record.get('error') or record['status']})")
    send = record["send_ns"]

    def client_ms(ns: int) -> float:
        return (ns - send) / NS_PER_MS

    timing = perf_entry["perf_metrics"]["timing_metrics"]

    def engine_ms(field: str) -> float:  # engine seconds -> ms from send (both CLOCK_MONOTONIC)
        return timing[field] * 1000 - send / NS_PER_MS

    # --- client
    durations = chat_durations(record)
    unavailable = {k: v for k, v in durations["unavailable"].items() if k not in ("exact_itl_ms", "ttft_ms")}
    tokens = [e for e in record["events"] if is_token_event(e["event"])]
    counts = [token_records(e["event"]) for e in tokens]
    completion_tokens = record["usage"]["completion_tokens"]
    if not tokens:
        raise ValueError(f"{record['request_id']}: no token event")
    first_read = record["body_reads"][0]["ns"] if record.get("body_reads") else None
    client = {
        "headers_ms": durations["headers_ms"],
        "first_body_read_ms": client_ms(first_read) if first_read else None,
        "ttft_ms": client_ms(tokens[0]["ns"]),
        "e2e_ms": durations["e2e_ms"],
        "token_events": len(tokens),
        "token_records": sum(counts),
        "exact_itl_ms": None, "mean_itl_ms": None, "perceived_tps": None,
        "content_event_gaps_ms": content_event_gaps(record),
    }
    if any(c != 1 for c in counts):
        unavailable["exact_itl_ms"] = (f"evidence rule: an event holds {max(counts)} records (needs 1 per token "
                                       f"event); event times are deliveries, not token times")
    elif sum(counts) != completion_tokens:
        unavailable["exact_itl_ms"] = (f"evidence rule: {sum(counts)} records against usage.completion_tokens "
                                       f"{completion_tokens}; some tokens had no event")
    elif len(tokens) < 2:
        unavailable["exact_itl_ms"] = "fewer than two token events: no gap"
    else:
        times = [e["ns"] for e in tokens]
        client["exact_itl_ms"] = [(b - a) / NS_PER_MS for a, b in zip(times, times[1:])]
        client["mean_itl_ms"] = (times[-1] - times[0]) / NS_PER_MS / (len(times) - 1)
        client["perceived_tps"] = 1000 / client["mean_itl_ms"]
    for key in ("mean_itl_ms", "perceived_tps"):
        if client[key] is None:
            unavailable[key] = unavailable["exact_itl_ms"]
    client["unavailable"] = unavailable

    # --- engine
    decode_span = (timing["last_token_time"] - timing["first_token_time"]) * 1000
    engine = {
        "queue_ms": (timing["first_scheduled_time"] - timing["arrival_time"]) * 1000,
        "ttft_ms": (timing["first_token_time"] - timing["arrival_time"]) * 1000,
        "decode_span_ms": decode_span,
        "e2e_ms": (timing["last_token_time"] - timing["arrival_time"]) * 1000,
        "http_ttft_ms": (timing["server_first_token_time"] - timing["server_arrival_time"]) * 1000,
        "mean_itl_ms": decode_span / (completion_tokens - 1) if completion_tokens > 1 else None,
    }
    remainder = {
        "ttft_ms": client["ttft_ms"] - engine["ttft_ms"],
        "e2e_ms": client["e2e_ms"] - engine["e2e_ms"] if client["e2e_ms"] is not None else None,
        "mean_itl_ms": (client["mean_itl_ms"] - engine["mean_itl_ms"]
                        if client["mean_itl_ms"] is not None and engine["mean_itl_ms"] is not None else None),
    }
    out = {"request_id": record["request_id"], "client": client, "engine": engine, "remainder": remainder}
    if stream is None:
        return out

    # --- wire (UTC -> monotonic with the client's anchor pair)
    offset = record["anchor_pair"]["utc_ns"] - record["anchor_pair"]["monotonic_ns"]

    def wire_ms(utc_ns: int) -> float:
        return client_ms(utc_ns - offset)

    events = stream["token_event_ns"]
    out["wire"] = {
        "headers_ms": wire_ms(stream["response_first_ns"]),
        "ttft_ms": wire_ms(events[0]) if events else None,
        "done_ms": wire_ms(stream["done_ns"]) if stream.get("done_ns") else None,
        "token_events": len(events),
        "mean_itl_ms": (events[-1] - events[0]) / NS_PER_MS / (len(events) - 1) if len(events) > 1 else None,
    }
    if not events:
        raise ValueError(f"{record['request_id']}: no token event on the wire (not a diagnostic request?)")
    bounds = [0.0, wire_ms(stream["request_last_ns"]), engine_ms("server_arrival_time"), engine_ms("arrival_time"),
              engine_ms("first_scheduled_time"), engine_ms("first_token_time"), engine_ms("server_first_token_time"),
              wire_ms(events[0]), client["ttft_ms"]]
    segments = [{"name": n, "clocks": c, "ms": b - a} for (n, c), a, b in zip(TTFT_SEGMENTS, bounds, bounds[1:])]
    if out["wire"]["done_ms"] is not None and client["e2e_ms"] is not None:
        tail = [engine_ms("last_token_time"), out["wire"]["done_ms"], client["e2e_ms"]]
        segments += [{"name": n, "clocks": c, "ms": b - a} for (n, c), a, b in zip(TAIL_SEGMENTS, tail, tail[1:])]
    for s in segments:
        if s["ms"] < 0:
            raise ValueError(f"negative segment {s['name']!r} ({s['clocks']}): {s['ms']:.3f} ms; "
                             f"a wrong clock conversion or a wrong join, not a measurement")
    out["segments"] = segments
    return out
