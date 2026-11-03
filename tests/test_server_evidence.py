import pytest

from inference_analysis.server_evidence import pcap_streams

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
        "token_event_ns": [],  # no logprobs records: not a diagnostic request
        "done_ns": 100_000_090_000,
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


def token(text: str) -> bytes:
    return ('data: {"choices":[{"index":0,"delta":{"content":"%s"},"logprobs":{"content":[{"token":"%s"}]}}]}\n\n'
            % (text, text)).encode()


def test_token_events_and_done_frame():
    """Three frames after the headers, the second holding two token events; [DONE] before the terminator frame."""
    chunked = [
        frame("100.000000300", 0, True, REQUEST),
        frame("100.000020000", 0, False, HEADERS),
        frame("100.000030000", 0, False, ROLE + token("a")),
        frame("100.000033000", 0, False, token("b") + token("c")),
        frame("100.000036000", 0, False, token("d")),
        frame("100.000040000", 0, False, DONE),
        frame("100.000041000", 0, False, b"0\r\n\r\n"),
    ]
    stream = pcap_streams("\n".join([HEADER, *chunked]))["run-0007"]
    assert stream["token_event_ns"] == [100_000_030_000, 100_000_033_000, 100_000_033_000, 100_000_036_000]
    assert stream["done_ns"] == 100_000_040_000
    assert stream["last_data_ns"] == 100_000_041_000
