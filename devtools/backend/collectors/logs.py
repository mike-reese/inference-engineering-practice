"""Log collector: every Compose container's stdout and stderr, kept per container, and the server's lifecycle."""
import asyncio
import collections
import re
import struct
from datetime import datetime, timezone

import aiohttp

from collectors.docker import API
from lifecycle import Lifecycle

KEEP_LINES = 20000  # per container: a TensorRT-LLM start is about 160 lines, a rep run a few hundred
KEEP_CONTAINERS = 20  # stopped containers stay viewable until this many newer ones exist
ANSI = re.compile(r"\x1b\[[0-9;]*m")  # terminal color codes some engines write into their logs


def epoch_ns(stamp: str) -> int:
    """Docker's RFC 3339 time with nanoseconds -> integer ns since the epoch (datetime keeps only microseconds)."""
    seconds, _, fraction = stamp.rstrip("Z").partition(".")
    whole = datetime.strptime(seconds, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    return int(whole.timestamp()) * 10**9 + int(fraction.ljust(9, "0")[:9])

class LogCollector:
    def __init__(self, bus, socket: str = "/var/run/docker.sock"):
        self.bus = bus
        self.socket = socket
        self.lines = collections.OrderedDict()  # container id -> deque of {ns, stream, line}
        self.lifecycles = {}  # container id -> Lifecycle, for engine containers
        self.sources = {}  # container id -> its name, project, service: what the Logs view can open
        self.tasks = {}

    async def follow(self, container: dict) -> None:
        """Read one container's log from its first line, then live, until it stops."""
        cid = container["id"]
        if cid in self.lines:
            return  # already read; a restarted container is a new id under Compose
        self.lines[cid] = collections.deque(maxlen=KEEP_LINES)
        self.sources[cid] = {key: container[key] for key in ("id", "name", "project", "service", "started_at")}
        while len(self.lines) > KEEP_CONTAINERS:
            old, _ = self.lines.popitem(last=False)
            self.lifecycles.pop(old, None)
            self.sources.pop(old, None)
        self.bus.publish("log_sources", sorted(self.sources.values(), key=lambda c: c["started_at"], reverse=True))
        if container["service"] == "server":  # every rep's Compose file names its engine service "server"
            self.lifecycles[cid] = Lifecycle(epoch_ns(container["started_at"]))
            self.publish_lifecycle(container)
        params = {"follow": "true", "stdout": "true", "stderr": "true", "timestamps": "true"}
        async with self.session.get(f"{API}/containers/{cid}/logs", params=params) as response:
            buffer = b""
            while True:
                # Without a TTY, Docker multiplexes stdout and stderr: an 8-byte header per frame,
                # [stream (1 = stdout, 2 = stderr), 0, 0, 0, payload length as a big-endian uint32].
                try:
                    header = await response.content.readexactly(8)
                except asyncio.IncompleteReadError:
                    return  # the container stopped
                stream, size = struct.unpack(">BxxxI", header)
                buffer += await response.content.readexactly(size)
                *complete, buffer = buffer.split(b"\n")
                for raw in complete:
                    stamp, _, text = raw.decode(errors="replace").partition(" ")
                    entry = {"ns": epoch_ns(stamp), "stream": "stderr" if stream == 2 else "stdout",
                             "line": ANSI.sub("", text)}
                    self.lines[cid].append(entry)
                    self.bus.publish("log", entry, key=cid)
                    lifecycle = self.lifecycles.get(cid)
                    if lifecycle and lifecycle.feed(entry["ns"], entry["line"]):
                        self.publish_lifecycle(container)

    def publish_lifecycle(self, container: dict) -> None:
        cid = container["id"]
        self.bus.publish("lifecycle", {"container": container["name"], "project": container["project"],
                                       "service": f"{container['project']}/{container['service']}",
                                       "marks": self.lifecycles[cid].marks}, key=cid)

    def phase_lines(self, cid: str, index: int) -> list:
        start, end = self.lifecycles[cid].lines(index)
        return self.history(cid, start, end)

    def resolve(self, ref: str) -> str:
        """A container id, id prefix, name, or project/service (the newest such container) -> its id."""
        if ref in self.lines:
            return ref
        newest = sorted(self.sources.values(), key=lambda c: c["started_at"], reverse=True)
        for c in newest:
            if c["id"].startswith(ref) or c["name"] == ref or f"{c['project']}/{c['service']}" == ref:
                return c["id"]
        return ref

    def history(self, cid: str, since_ns: int = 0, until_ns: int | None = None) -> list:
        return [e for e in self.lines.get(cid, []) if e["ns"] >= since_ns and (until_ns is None or e["ns"] < until_ns)]

    async def run(self) -> None:
        """Subscribe to the Docker collector's container lists; follow each running container once."""
        connector = aiohttp.UnixConnector(path=self.socket)
        async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=None)) as self.session:
            queue = self.bus.subscribe({"containers", "event"})
            while True:
                message = await queue.get()
                if message["topic"] == "event":
                    self.on_event(message["data"])
                    continue
                for c in message["data"]:
                    if c["state"] == "running" and c["id"] not in self.tasks:
                        self.tasks[c["id"]] = asyncio.create_task(self.follow(c))

    def on_event(self, event: dict) -> None:
        """Docker says an engine container turned healthy: its last startup phase ends, serving begins."""
        if event.get("action") != "health_status: healthy":
            return
        for cid, source in self.sources.items():
            lifecycle = self.lifecycles.get(cid)
            if lifecycle and source["name"] == event["container"] and lifecycle.marks[-1]["phase"] != "serving":
                lifecycle.add("serving", int(event["time_ns"]), "Docker: health_status: healthy")
                self.publish_lifecycle(source)
