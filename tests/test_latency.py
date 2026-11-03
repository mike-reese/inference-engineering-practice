import copy

import pytest

from inference_analysis.latency import N_TTFT, latency_records

MS = 1_000_000
UTC0 = 1_700_000_000_000_000_000


def event(ns_ms: float, content: str | None, records: int = 1, usage: dict | None = None, choices: bool = True):
    choice = {"index": 0, "delta": {"content": content}, "finish_reason": None,
              "logprobs": {"content": [{"token": content}] * records} if content else None}
    return {"ns": int(ns_ms * MS), "event": {"choices": [choice] if choices else [], "usage": usage}}


def make_record() -> dict:
    return {
        "request_id": "r-1", "detail": True, "complete": True, "status": 200, "error": None,
        "anchor_pair": {"utc_ns": UTC0, "monotonic_ns": 0},
        "send_ns": 0, "headers_ns": 2 * MS, "first_content_ns": 12 * MS,
        "protocol_complete_ns": 20 * MS, "close_ns": 21 * MS, "finish_reason": "length",
        "usage": {"prompt_tokens": 5, "completion_tokens": 3, "prompt_tokens_details": {"cached_tokens": 0}},
        "body_reads": [{"ns": 10 * MS, "bytes": 80, "base64": ""}],
        "events": [
            {"ns": 10 * MS, "event": {"choices": [{"index": 0, "delta": {"role": "assistant", "content": None}}]}},
            event(12, "a"), event(15, "b"), event(19, "c"),
            event(19.5, None, usage={"completion_tokens": 3}, choices=False),
        ],
    }


ENGINE = {"request_id": 3, "perf_metrics": {"first_iter": 1, "last_iter": 3, "timing_metrics": {
    "server_arrival_time": 0.0005, "arrival_time": 0.001, "first_scheduled_time": 0.002,
    "first_token_time": 0.010, "server_first_token_time": 0.011, "last_token_time": 0.017}}}


def utc(ms: float) -> int:
    return UTC0 + int(ms * MS)


STREAM = {"syn_ns": utc(0.1), "request_last_ns": utc(0.3), "response_first_ns": utc(1.5),
          "first_content_ns": utc(11.4), "token_event_ns": [utc(11.4), utc(14.6), utc(18.7)],
          "done_ns": utc(18.9), "last_data_ns": utc(19.0)}


def test_three_clocks_segments_and_itl():
    out = latency_records(make_record(), ENGINE, STREAM)
    c, e, w = out["client"], out["engine"], out["wire"]
    assert c["ttft_ms"] == 12 and c["exact_itl_ms"] == [3, 4]
    assert c["mean_itl_ms"] == 3.5  # (19 - 12) / 2, not 7 / 3
    assert c["perceived_tps"] == pytest.approx(285.714, abs=1e-3)
    assert e["queue_ms"] == pytest.approx(1) and e["ttft_ms"] == pytest.approx(9)
    assert e["decode_span_ms"] == pytest.approx(7) and e["mean_itl_ms"] == pytest.approx(3.5)
    assert out["remainder"]["ttft_ms"] == pytest.approx(3)
    assert w["mean_itl_ms"] == pytest.approx(3.65)
    ttft = [s["ms"] for s in out["segments"][:N_TTFT]]
    assert ttft == pytest.approx([0.3, 0.7, 1, 8, 1, 0.4, 0.6])
    assert e["headers_parsed_ms"] == pytest.approx(0.5)  # a labeled point, not a boundary
    assert sum(ttft) == pytest.approx(c["ttft_ms"])
    tail = [s["ms"] for s in out["segments"][N_TTFT:]]
    assert tail == pytest.approx([1.9, 1.1])  # last_token 17 -> [DONE] 18.9 -> protocol completion 20


def test_two_records_in_one_event_makes_itl_unavailable():
    record = make_record()
    record["events"][2] = event(15, "b", records=2)
    out = latency_records(record, ENGINE)
    assert out["client"]["exact_itl_ms"] is None and out["client"]["mean_itl_ms"] is None
    assert "evidence rule" in out["client"]["unavailable"]["exact_itl_ms"]
    assert out["client"]["content_event_gaps_ms"] == [3, 4]


def test_incomplete_record_and_wrong_join_are_refused():
    record = make_record()
    record["complete"] = False
    with pytest.raises(ValueError):
        latency_records(record, ENGINE)
    early = copy.deepcopy(STREAM)
    early["token_event_ns"][0] = utc(10.5)  # before server_first_token_time (11 ms)
    with pytest.raises(ValueError, match="server_first_token_time"):
        latency_records(make_record(), ENGINE, early)
