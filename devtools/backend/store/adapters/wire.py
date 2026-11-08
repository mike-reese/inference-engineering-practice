"""Network frames: <run>_s<n>.pcap (tcpdump -U on the server's eth0, written per packet), one row per TCP frame.

Read as it grows (PcapReader) live and whole at import, through the same Wire parser, so live and final rows match
frame for frame. Names, attributes, span ids ("<request>/wire/<frame.number>") and raw pointers ("frame.number=N",
the pcap record number, which TShark's frame.number counts) follow src/inference_analysis/trace/adapters/wire.py
describe(); the ie-run/2 store read the same frames from frames.tsv (TShark on this pcap).

Request: a connection belongs to the X-Request-ID in its request headers (to the server). A connection's frames are
held from its SYN until its request headers are complete (the first to-server payload with the blank line that ends
them), then written with that request, or with none when the headers carry no X-Request-ID (health and metrics
reads). A later request on the same connection (keep-alive) takes the frames from its own headers on. Frames of a
connection that ends (FIN, RST) or the run ends before any request headers are written with none.
Times: pcap UTC ns minus the run's wall offset (Ctx.wall_offset_ns), one offset for every frame of the run.
"""
from __future__ import annotations

import re
import struct
from pathlib import Path

from .base import Ctx, Rows, request_short, slug
from .stamps import SRC  # noqa: F401
from inference_analysis.trace.adapters.wire import describe  # noqa: E402

SERVER_PORT = 8080
XRID = re.compile(rb"(?i)x-request-id: *([^\r\n]+)")
HEADERS_MAX = 65536
EVIDENCE = ("Observed: the server's eth0 pcap (tcpdump -U), UTC frame times minus the run's UTC - CLOCK_MONOTONIC "
            "offset")


class PcapReader:
    """tcpdump's pcap (micro- or nanosecond), read from where the last read stopped. Yields every record as
    (number, utc_ns, frame bytes); number is 1-based over all records."""

    def __init__(self, path: Path):
        self.path, self.offset, self.buf, self.order, self.number = path, 0, b"", None, 0

    def read(self) -> list[tuple[int, int, bytes]]:
        try:
            with self.path.open("rb") as f:
                f.seek(self.offset)
                data = f.read()
        except OSError:
            return []
        self.offset += len(data)
        self.buf += data
        if self.order is None:
            if len(self.buf) < 24:
                return []
            magic = self.buf[:4]
            self.order = "<" if magic in (b"\x4d\x3c\xb2\xa1", b"\xd4\xc3\xb2\xa1") else ">"
            self.nano = magic in (b"\x4d\x3c\xb2\xa1", b"\xa1\xb2\x3c\x4d")
            self.buf = self.buf[24:]
        out, pos = [], 0
        while len(self.buf) - pos >= 16:
            sec, frac, incl, _ = struct.unpack_from(self.order + "IIII", self.buf, pos)
            if len(self.buf) - pos < 16 + incl:
                break
            self.number += 1
            out.append((self.number, sec * 1_000_000_000 + (frac if self.nano else frac * 1000),
                        self.buf[pos + 16:pos + 16 + incl]))
            pos += 16 + incl
        self.buf = self.buf[pos:]
        return out


def tcp(frame: bytes) -> dict | None:
    """Ethernet + IPv4 + TCP -> ports, flags, payload (Ethernet padding dropped); None for any other frame."""
    if len(frame) < 34 or frame[12:14] != b"\x08\x00":
        return None
    ip = frame[14:]
    ihl = (ip[0] & 0x0F) * 4
    if ip[9] != 6:
        return None
    t = ip[ihl:]
    src, dst = struct.unpack(">HH", t[:4])
    off = (t[12] >> 4) * 4
    total = struct.unpack(">H", ip[2:4])[0]
    payload = t[off:max(off, total - ihl)]
    flags = t[13]
    return {"src": (ip[12:16], src), "dst": (ip[16:20], dst), "syn": bool(flags & 0x02), "fin": bool(flags & 0x01),
            "rst": bool(flags & 0x04), "ack": bool(flags & 0x10), "payload": bytes(payload)}


class Conn:
    def __init__(self):
        self.rid, self.decided, self.held, self.head, self.tokens = None, False, [], b"", {}


class Wire:
    source = "pcap"

    def __init__(self, ctx: Ctx):
        self.ctx, self.conns = ctx, {}
        self.rule = ctx.reg.event_rule("run_json", "network frame")

    def feed(self, frames: list[tuple[str, int, int, bytes]]) -> Rows:
        """frames: (pcap file name, number, utc_ns, frame bytes)."""
        out = Rows()
        for file, number, utc, raw in frames:
            p = tcp(raw)
            if p is None:
                self.ctx.count(self.source, "frames that are not TCP over IPv4")
                continue
            to_server = p["dst"][1] == SERVER_PORT
            key = (p["src"], p["dst"]) if to_server else (p["dst"], p["src"])
            if p["syn"] and to_server and not p["ack"]:
                self._end(out, key)                   # a new connection on a reused port
            c = self.conns.setdefault(key, Conn())
            f = {"file": file, "number": number, "utc": utc, "to_server": to_server, "syn": p["syn"], "fin": p["fin"],
                 "frame_len": len(raw), "payload": p["payload"], "port": key[0][1]}
            if to_server and p["payload"]:
                if c.decided and XRID.search(p["payload"]):    # keep-alive: the next request's headers
                    c.rid = XRID.search(p["payload"]).group(1).decode(errors="replace").strip()
                elif not c.decided:
                    c.head += p["payload"]
                    if b"\r\n\r\n" in c.head or len(c.head) > HEADERS_MAX:
                        m = XRID.search(c.head)
                        c.rid, c.decided = (m.group(1).decode(errors="replace").strip() if m else None), True
            c.held.append(f)
            if c.decided or p["fin"] or p["rst"]:
                c.decided = True
                self._emit(out, c)
        return out

    def flush(self) -> Rows:
        out = Rows()
        for key in list(self.conns):
            self._end(out, key)
        return out

    def _end(self, out: Rows, key) -> None:
        c = self.conns.pop(key, None)
        if c is not None and c.held:
            self._emit(out, c)

    def _emit(self, out: Rows, c: Conn) -> None:
        ctx = self.ctx
        lane = ctx.lane("network", "eth0")
        for f in c.held:
            rid = c.rid
            name, attrs = describe(f)
            if attrs.get("token_events"):
                attrs["first_token"] = c.tokens.get(rid, 0) + 1
                c.tokens[rid] = c.tokens.get(rid, 0) + attrs["token_events"]
            sid = f"{rid}/wire/{f['number']}" if rid else None
            g = {"request": request_short(rid), "short": slug(name), "name": name}
            out.add(start=f["utc"] - ctx.wall_offset_ns, lane=lane, kind="network frame", name=name, req=rid,
                    end=f["utc"] - ctx.wall_offset_ns, bytes=float(attrs["bytes"]), eid=ctx.eid(self.rule["eid"], **g),
                    what=self.rule["what"].format(**g), args={**attrs, "port": f["port"], "pcap": f["file"],
                                                              "span_id": sid},
                    term=self.rule["term"], source=self.source, evidence=EVIDENCE, raw_file=f["file"],
                    raw_ptr=f"frame.number={f['number']}", span_id=sid)
        c.held = []
