import pytest

from inference_analysis.server_evidence import join_requests, log_tasks, pcap_streams

HEADER = "frame.time_epoch\ttcp.stream\ttcp.dstport\ttcp.flags.syn\ttcp.payload"
REQUEST = b"POST /v1/chat/completions HTTP/1.1\r\nHost: server:8080\r\nX-Request-ID: run-0007\r\n\r\n"
BODY = b'{"model":"local","messages":[]}'
HEADERS = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n"
ROLE = b'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":null}}]}\n\n'
CONTENT = b'data: {"choices":[{"index":0,"delta":{"content":"1"}}]}\n\n'
DONE = b"data: [DONE]\n\n"
SCRAPE = b"GET /metrics HTTP/1.1\r\nHost: server:8080\r\n\r\n"


def frame(time: str, stream: int, to_server: bool, payload: bytes = b"", syn: bool = False) -> str:
    port = "8080" if to_server else "51234"
    return f"{time}\t{stream}\t{port}\t{syn}\t{payload.hex()}"


CHAT_STREAM = [
    frame("100.000000100", 0, True, syn=True),
    frame("100.000000200", 0, False, syn=True),
    frame("100.000000300", 0, True, REQUEST),
    frame("100.000000400", 0, True, BODY),
    frame("100.000020000", 0, False, HEADERS),
    frame("100.000030000", 0, False, ROLE),
    frame("100.000031000", 0, False, CONTENT),
    frame("100.000090000", 0, False, DONE),
]
SCRAPE_STREAM = [frame("100.000050000", 1, True, SCRAPE)]


def test_chat_stream_boundaries_in_utc_ns():
    streams = pcap_streams("\n".join([HEADER, *CHAT_STREAM, *SCRAPE_STREAM]))
    assert streams == {"run-0007": {
        "syn_ns": 100_000_000_100,
        "request_last_ns": 100_000_000_400,
        "response_first_ns": 100_000_020_000,
        "first_content_ns": 100_000_031_000,
        "last_data_ns": 100_000_090_000,
    }}


def test_stream_cut_before_any_response_keeps_request_times_only():
    streams = pcap_streams("\n".join([HEADER, *CHAT_STREAM[:4]]))
    assert streams["run-0007"]["request_last_ns"] == 100_000_000_400
    assert streams["run-0007"]["response_first_ns"] is None
    assert streams["run-0007"]["first_content_ns"] is None


def test_microsecond_pcap_timestamps_are_refused():
    with pytest.raises(ValueError):
        pcap_streams("\n".join([HEADER, frame("100.000001", 0, True, REQUEST)]))


def test_a_reused_connection_is_refused():
    reused = [*CHAT_STREAM, frame("100.000100000", 0, True, REQUEST)]
    with pytest.raises(ValueError):
        pcap_streams("\n".join([HEADER, *reused]))


LOG = """\
0.04.799.294 I srv  log_server_r: request: GET /health 127.0.0.1 200
0.06.309.321 D request: {"model":"local","stream":true,"messages":[{"role":"system","content":"x"}]}
0.06.311.223 D que          post: new task, id = 0/1, front = 0
0.06.311.346 I slot launch_slot_: id  0 | task 0 | processing task
0.06.311.350 D que          post: new task, id = 1, front = 0
0.06.311.354 I slot update_slots: id  0 | task 0 | new prompt, n_ctx_slot = 4096, n_keep = 0, n_prompt_tokens = 64
0.06.352.943 D srv          send: sending result for task id = 0
0.06.361.968 D srv          send: sending result for task id = 0
0.06.603.843 I slot      release: id  0 | task 0 | stop processing: n_past = 95, truncated = 0
0.06.604.004 I srv  log_server_r: request: POST /v1/chat/completions 172.18.0.7 200
"""


def test_log_task_times_in_microseconds_since_log_start():
    assert log_tasks(LOG) == [{
        "task": 0, "handler_us": 6_309_321, "post_us": 6_311_223, "launch_us": 6_311_346, "n_prompt": 64,
        "first_send_us": 6_352_943, "release_us": 6_603_843, "access_us": 6_604_004,
    }]


def record(request_id: str, utc_ns: int, prompt_tokens: int | None) -> dict:
    usage = None if prompt_tokens is None else {"prompt_tokens": prompt_tokens}
    return {"request_id": request_id, "anchor_pair": {"utc_ns": utc_ns, "monotonic_ns": 0}, "usage": usage}


def test_join_matches_send_order_to_task_order_and_skips_uncaptured_records():
    streams = {"a": {}, "b": {}}
    tasks = [{"task": 0, "n_prompt": 64}, {"task": 33, "n_prompt": 256}]
    records = [record("b", 2, 256), record("never-reached-server", 3, None), record("a", 1, 64)]
    joined = join_requests(records, streams, tasks)
    assert [(row["record"]["request_id"], row["task"]["task"]) for row in joined] == [("a", 0), ("b", 33)]


def test_join_refuses_a_count_or_prompt_mismatch():
    streams = {"a": {}, "b": {}}
    with pytest.raises(ValueError):
        join_requests([record("a", 1, 64), record("b", 2, 64)], streams, [{"task": 0, "n_prompt": 64}])
    with pytest.raises(ValueError):
        join_requests([record("a", 1, 64)], {"a": {}}, [{"task": 0, "n_prompt": 256}])
