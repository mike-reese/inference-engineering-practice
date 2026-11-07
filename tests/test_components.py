"""Component stamps: request attribution (server stamps carry an X-Request-ID or only the proxy's client id) and the
live collector's packet parsing."""
import struct
import sys
from pathlib import Path

from inference_analysis.trace.adapters.components import Attributor

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "devtools" / "backend"))
from collectors.components import parse_frame  # noqa: E402


def test_cid_binds_to_the_request_id_and_startup_stamps_belong_to_none():
    a = Attributor()
    assert a.feed({"box": "fetch", "cids": [2], "pid": 9, "iter": 0}) == []  # engine start-up, before any request
    assert a.feed({"box": "llm_api", "xrid": "r1", "cid": 2}) == ["r1"]
    assert a.feed({"box": "scheduler", "cids": [2], "pid": 9, "iter": 5}) == ["r1"]
    kv = {"box": "kv_cache", "cids": [2], "pid": 9}
    assert a.feed(kv) == ["r1"] and kv["iter"] == 5  # the KV stamp takes the newest scheduler iteration
    assert a.feed({"box": "ipc_rsp", "data": {"cids": [2]}}) == ["r1"]


def test_a_reused_cid_follows_the_newest_binding():
    a = Attributor()
    a.feed({"box": "llm_api", "xrid": "warmup", "cid": 2})
    a.feed({"box": "llm_api", "xrid": "measured", "cid": 2})
    assert a.feed({"box": "update", "cids": [2], "pid": 1}) == ["measured"]


def frame(src: int, dst: int, flags: int, payload: bytes) -> bytes:
    tcp = struct.pack(">HHIIBBHHH", src, dst, 0, 0, 5 << 4, flags, 0, 0, 0)
    ip = struct.pack(">BBHHHBBH4s4s", 0x45, 0, 20 + len(tcp) + len(payload), 0, 0, 64, 6, 0, b"\0" * 4, b"\0" * 4)
    return b"\0" * 12 + b"\x08\x00" + ip + tcp + payload


def test_parse_frame_reads_direction_request_id_and_sse_events():
    up = parse_frame(frame(40000, 8080, 0x18, b"POST /v1/chat/completions HTTP/1.1\r\nX-Request-ID: r1\r\n\r\n"))
    assert up["direction"] == "to server" and up["port"] == 40000 and up["xrid_seen"] == "r1"
    assert up["name"] == "request line and headers"
    down = parse_frame(frame(8080, 40000, 0x18, b"1a\r\ndata: {}\n\n\r\n"))
    assert down["direction"] == "to client" and down["name"] == "SSE frame (1 event)"
    syn = parse_frame(frame(40000, 8080, 0x02, b""))
    assert syn["name"] == "SYN" and syn["bytes"] == 0
