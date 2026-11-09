"""Components collector: every step a request takes through the containers, as it happens.

Tails three files of each stamped run folder (labels.json "stamps": true; TRACE=components and the profiled levels):
  trace/server_stamps.jsonl   the server's component stamps (deploy/server/ie_stamps), HTTP process and worker
  client/client_stamps.jsonl  the client's (scripts/chat_client.py: Locust, send_one, SDK, httpx2 transport)
  <run>_s<n>.pcap             tcpdump on the server's eth0 (-U: written per packet), parsed here frame by frame
and publishes `component_stamps` batches (key: run id). The files are read after the stack stops too, so a run's
stamps are complete even when the page opened late; /api/components returns everything held.

Clocks: stamps are CLOCK_MONOTONIC ns. Pcap times are UTC ns, converted with this container's UTC - monotonic offset
read at the time of the read (same kernel, so the same clocks; the run's wire adapter uses the client's anchor pair).
"""
import asyncio
import collections
import json
import os
import re
import struct
import sys
import time
from pathlib import Path

REPO = Path(os.environ.get("REPO", "/repo"))
sys.path.insert(0, str(REPO / "src"))
from inference_analysis.trace.adapters.components import Attributor  # noqa: E402

POLL_S = 0.2
FRESH_S = 600  # a run folder older than this (no file written) is not tailed
KEEP_RUNS = 3
KEEP_STAMPS = 60000  # per run
XRID = re.compile(rb"(?i)x-request-id: *([^\r\n]+)")
SERVER_PORT = 8080


class LineTail:
    def __init__(self, path: Path):
        self.path, self.offset, self.rest = path, 0, b""

    def read(self) -> list[dict]:
        try:
            with self.path.open("rb") as f:
                f.seek(self.offset)
                data = f.read()
        except OSError:
            return []
        self.offset += len(data)
        lines = (self.rest + data).split(b"\n")
        self.rest = lines.pop()  # a line still being written
        out = []
        for line in lines:
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
        return out


class PcapTail:
    """tcpdump's nanosecond pcap, Ethernet + IPv4 + TCP, one dict per frame."""

    def __init__(self, path: Path):
        self.path, self.offset, self.buf, self.order = path, 0, b"", None

    def read(self) -> list[dict]:
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
        offset = time.time_ns() - time.monotonic_ns()
        out = []
        while len(self.buf) >= 16:
            sec, frac, incl, _ = struct.unpack(self.order + "IIII", self.buf[:16])
            if len(self.buf) < 16 + incl:
                break
            frame, self.buf = self.buf[16:16 + incl], self.buf[16 + incl:]
            utc = sec * 1_000_000_000 + (frac if self.nano else frac * 1000)
            parsed = parse_frame(frame)
            if parsed:
                out.append({**parsed, "t0": utc - offset, "utc_ns": utc})
        return out


def parse_frame(frame: bytes) -> dict | None:
    if len(frame) < 34 or frame[12:14] != b"\x08\x00":
        return None
    ip = frame[14:]
    ihl = (ip[0] & 0x0F) * 4
    if ip[9] != 6:
        return None
    tcp = ip[ihl:]
    src, dst = struct.unpack(">HH", tcp[:4])
    flags = tcp[13]
    payload = tcp[(tcp[12] >> 4) * 4:]
    total = struct.unpack(">H", ip[2:4])[0]
    payload = payload[:max(0, total - ihl - (tcp[12] >> 4) * 4)]  # drop Ethernet padding
    names = [n for bit, n in ((0x02, "SYN"), (0x01, "FIN"), (0x04, "RST")) if flags & bit]
    to_server = dst == SERVER_PORT
    if payload:
        text = payload[:2000].decode("utf-8", "replace")
        events = payload.count(b"data: ")
        name = ("request line and headers" if to_server and payload[:4] in (b"POST", b"GET ")
                else "request body" if to_server else "response headers" if payload.startswith(b"HTTP/")
                else f"SSE frame ({events} event{'s' if events != 1 else ''})" if events else "data")
    else:
        text, name = None, ("-".join(names) + ("-ACK" if flags & 0x10 and "SYN" in names and not to_server else "")
                            if names else "ACK")
    return {"port": src if to_server else dst, "direction": "to server" if to_server else "to client",
            "name": name, "bytes": len(payload), "frame_len": len(frame), "text": text, "xrid_seen": (
                XRID.search(payload).group(1).decode().strip() if to_server and payload and XRID.search(payload)
                else None)}


class RunTail:
    def __init__(self, run_dir: Path):
        self.run_dir, self.run_id = run_dir, run_dir.name
        self.server = LineTail(run_dir / "trace" / "server_stamps.jsonl")
        self.client = LineTail(run_dir / "client" / "client_stamps.jsonl")
        self.pcaps = {}
        self.attributor = Attributor()
        self.ports = {}  # client TCP port -> X-Request-ID
        self.pending = collections.defaultdict(list)  # frames of a port whose request is not known yet
        self.stamps = collections.deque(maxlen=KEEP_STAMPS)
        self.seq = 0

    def add(self, stamp: dict, out: list) -> None:
        self.seq += 1
        stamp["seq"] = self.seq
        self.stamps.append(stamp)
        out.append(stamp)

    def read(self) -> list[dict]:
        out = []
        for s in self.server.read():
            if s.get("box") == "stamps":
                continue
            xrids = self.attributor.feed(s)
            if xrids:
                self.add({"src": "server", **s, "xrids": xrids}, out)
        for s in self.client.read():
            self.add({"src": "client", **s, "xrids": [s["xrid"]]}, out)
        for pcap in sorted(self.run_dir.glob("*.pcap")):
            tail = self.pcaps.setdefault(pcap.name, PcapTail(pcap))
            for f in tail.read():
                if f.pop("xrid_seen", None):
                    self.ports[f["port"]] = XRID.search(f["text"].encode()).group(1).decode().strip()
                stamp = {"src": "wire", "box": "eth0", "proc": "network", "name": f["name"], "t0": f["t0"], "t1": None,
                         "data": {k: f[k] for k in ("direction", "bytes", "frame_len", "port", "text", "utc_ns")}}
                xrid = self.ports.get(f["port"])
                if xrid is None:
                    self.pending[f["port"]].append(stamp)
                    continue
                for held in self.pending.pop(f["port"], []):
                    self.add({**held, "xrids": [xrid]}, out)
                self.add({**stamp, "xrids": [xrid]}, out)
        out.sort(key=lambda s: s["t0"])
        return out


class ComponentsCollector:
    def __init__(self, bus):
        self.bus = bus
        self.runs: dict[str, RunTail] = {}

    def stamped_runs(self) -> list[Path]:
        now = time.time()
        found = []
        for labels in REPO.glob("*/*/results/*/labels.json"):
            try:
                if now - labels.parent.stat().st_mtime > FRESH_S and labels.parent.name not in self.runs:
                    continue
                if json.loads(labels.read_text()).get("stamps"):
                    found.append(labels.parent)
            except (OSError, ValueError):
                continue
        return sorted(found, key=lambda p: p.stat().st_mtime)[-KEEP_RUNS:]

    def history(self, run_id: str | None = None) -> dict:
        return {rid: list(t.stamps) for rid, t in self.runs.items() if run_id in (None, rid)}

    async def run(self) -> None:
        tick = 0
        while True:
            if tick % 10 == 0:  # look for new run folders every 2 s
                for d in await asyncio.to_thread(self.stamped_runs):
                    self.runs.setdefault(d.name, RunTail(d))
                while len(self.runs) > KEEP_RUNS:
                    self.runs.pop(next(iter(self.runs)))
            for rid, tail in list(self.runs.items()):
                batch = await asyncio.to_thread(tail.read)
                if batch:
                    self.bus.publish("component_stamps", {"run_id": rid, "stamps": batch}, key=rid)
            tick += 1
            await asyncio.sleep(POLL_S)
