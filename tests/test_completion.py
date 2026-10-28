import pytest

from inference_analysis.completion import CompletionRecord, completion_record

MS = 1_000_000

# Request A's last two chunks and its final event (K6, K8), at chosen times
CHUNK_PERIOD = {"index": 0, "content": ".", "tokens": [13], "stop": False, "tokens_predicted": 15}
CHUNK_EOS = {"index": 0, "content": "", "tokens": [151645], "stop": False, "tokens_predicted": 16}
FINAL = {
    "index": 0, "content": "", "tokens": [], "stop": True,
    "stop_type": "eos", "stopping_word": "", "truncated": False,
    "tokens_evaluated": 35, "tokens_predicted": 16, "tokens_cached": 50,
    "timings": {"cache_n": 0, "prompt_n": 35, "prompt_ms": 28.0, "predicted_n": 16, "predicted_ms": 7.0},
}
EVENTS = [(30 * MS, CHUNK_PERIOD), (37 * MS, CHUNK_EOS), (38 * MS, FINAL)]

def test_record_from_two_chunks_and_final_event():
    record = completion_record(EVENTS, send_ns=0)
    assert isinstance(record, CompletionRecord)
    assert record.n_chunks == 2
    assert record.tokens == [13, 151645]
    assert record.contents == [".", ""]
    assert record.chunk_ms == [30.0, 37.0]
    assert record.ttft_ms == 30.0
    assert record.e2e_ms == 38.0
    assert record.stop_type == "eos"
    assert record.stopping_word == ""
    assert record.truncated is False
    assert (record.tokens_evaluated, record.tokens_predicted, record.tokens_cached) == (35, 16, 50)
    assert record.timings == FINAL["timings"]


def test_times_are_measured_from_the_send():
    shifted = [(t + 5 * MS, event) for t, event in EVENTS]
    record = completion_record(shifted, send_ns=5 * MS)
    assert (record.ttft_ms, record.e2e_ms) == (30.0, 38.0)


def test_stream_without_final_event_raises():
    with pytest.raises(ValueError):
        completion_record(EVENTS[:-1], send_ns=0)
