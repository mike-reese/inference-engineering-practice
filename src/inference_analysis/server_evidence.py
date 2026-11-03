"""The wire: TShark's frame table of a capture, grouped into one entry per chat request."""
import csv
import io
import re

CHAT_POST = b"POST /v1/chat/completions"
REQUEST_ID = re.compile(rb"(?i)x-request-id: (\S+)")
CONTENT_DELTA = re.compile(rb'"delta":\{"content":"[^"]')
TOKEN_EVENT = re.compile(rb'"logprobs":\{"content":\[')  # one per token event (diagnostic requests)
DONE = b"data: [DONE]"

# The TShark fields Stack.pcap_frames asks for, in order.
FIELDS = ("frame.number", "frame.time_epoch", "tcp.stream", "tcp.srcport", "tcp.dstport", "tcp.flags.syn",
          "tcp.flags.fin", "frame.len", "tcp.payload")


def _epoch_ns(value: str) -> int:
    seconds, fraction = value.split(".")
    if len(fraction) != 9:
        raise ValueError(f"expected nanosecond pcap timestamps, got {value}")
    return int(seconds + fraction)


def _first(frames: list[dict], test) -> int | None:
    return next((f["ns"] for f in frames if test(f)), None)


def read_frames(frames_tsv: str, server_port: str = "8080") -> dict[str, list[dict]]:
    """TCP stream number -> its frames in capture order (UTC ns since the epoch)."""
    by_stream = {}
    for row in csv.DictReader(io.StringIO(frames_tsv), delimiter="\t"):
        by_stream.setdefault(row["tcp.stream"], []).append({
            "number": int(row["frame.number"]) if row.get("frame.number") else None,
            "ns": _epoch_ns(row["frame.time_epoch"]),
            "to_server": row["tcp.dstport"] == server_port,
            "syn": row["tcp.flags.syn"] == "True",
            "fin": row.get("tcp.flags.fin") == "True",
            "frame_len": int(row["frame.len"]) if row.get("frame.len") else None,
            "payload": bytes.fromhex(row["tcp.payload"]),
        })
    return by_stream


def request_frames(frames_tsv: str, server_port: str = "8080") -> dict[str, list[dict]]:
    """X-Request-ID -> every frame of the TCP stream that carried that one chat request."""
    out = {}
    for frames in read_frames(frames_tsv, server_port).values():
        request = b"".join(f["payload"] for f in frames if f["to_server"])
        if request.count(CHAT_POST) == 0:
            continue
        if request.count(CHAT_POST) > 1:
            raise ValueError("a TCP stream carried more than one chat request; connection reuse is not handled")
        out[REQUEST_ID.search(request).group(1).decode()] = frames
    return out


def pcap_streams(frames_tsv: str, server_port: str = "8080") -> dict[str, dict]:
    streams = {}
    for request_id, frames in request_frames(frames_tsv, server_port).items():
        sent = [f for f in frames if f["to_server"] and f["payload"]]
        received = [f for f in frames if not f["to_server"] and f["payload"]]
        response_ns = received[0]["ns"] if received else None
        token_event_ns = []
        for f in received:  # a frame holding two events gives both its time
            token_event_ns += [f["ns"]] * len(TOKEN_EVENT.findall(f["payload"]))
        streams[request_id] = {
            "syn_ns": _first(frames, lambda f: f["syn"] and f["to_server"]),
            "request_last_ns": max(f["ns"] for f in sent if response_ns is None or f["ns"] < response_ns),
            "response_first_ns": response_ns,
            "first_content_ns": _first(received, lambda f: CONTENT_DELTA.search(f["payload"])),
            "token_event_ns": token_event_ns,
            "done_ns": _first(received, lambda f: DONE in f["payload"]),
            "last_data_ns": received[-1]["ns"] if received else None,
        }
    return streams
