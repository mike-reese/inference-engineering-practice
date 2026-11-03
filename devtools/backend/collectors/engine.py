"""Engine collector: each running engine's Prometheus counters, model and version, at its published port.

Reads /prometheus/metrics, /version and /v1/models only. Never /perf_metrics or /metrics: each read drains the
engine's buffer (K9), and rep.py must be their only reader.
"""
import asyncio
import collections
import os
import re
import time

import aiohttp

SAMPLE = re.compile(r"^([a-zA-Z_:][\w:]*)(\{[^}]*\})?\s+(\S+)")
KEEP = 1800  # samples per engine: 30 minutes at one per second


def parse_prometheus(text: str) -> dict[str, float]:
    """Prometheus text format -> {series: value}; series is the name plus its labels as written."""
    out = {}
    for line in text.splitlines():
        if line.startswith("#"):
            continue
        match = SAMPLE.match(line)
        if match:
            try:
                out[match.group(1) + (match.group(2) or "")] = float(match.group(3))
            except ValueError:
                pass
    return out


def published(container: dict, port: int) -> str | None:
    """127.0.0.1:<host port> that Docker publishes for the container's port (from 'ip:hostport->port/tcp')."""
    for mapping in container.get("ports", []):
        host, _, target = mapping.partition("->")
        if target == f"{port}/tcp":
            return host.replace("0.0.0.0", "127.0.0.1")
    return None


def host_path(source: str) -> str | None:
    """A host path under the repository -> the same file in the devtools container (/repo)."""
    repo_host, repo = os.environ.get("REPO_HOST"), os.environ.get("REPO", "/repo")
    if repo_host and source and source.startswith(repo_host):
        return repo + source[len(repo_host):]
    return None


class EngineCollector:
    def __init__(self, bus):
        self.bus = bus
        self.history = {}  # container id -> deque of {ns, metrics}
        self.info = {}  # container id -> version, models, command, config

    async def engines(self) -> list[dict]:
        state = self.bus.state.get(("containers", None))
        containers = state["data"] if state else []
        return [c for c in containers if c["service"] == "server" and c["state"] == "running"]

    async def scrape(self, session: aiohttp.ClientSession, c: dict) -> None:
        address = published(c, 8080)
        if address is None:
            return
        try:
            async with session.get(f"http://{address}/prometheus/metrics") as response:
                if response.status != 200:
                    return
                metrics = parse_prometheus(await response.text())
        except (aiohttp.ClientError, asyncio.TimeoutError):
            return  # still starting
        sample = {"ns": time.time_ns(), "metrics": metrics}
        self.history.setdefault(c["id"], collections.deque(maxlen=KEEP)).append(sample)
        self.bus.publish("engine_metrics", {"container": c["name"], "project": c["project"], **sample}, key=c["id"])
        if c["id"] not in self.info and c.get("health") == "healthy":
            await self.describe(session, c, address)

    async def describe(self, session: aiohttp.ClientSession, c: dict, address: str) -> None:
        """The workload's fixed facts: engine version, model, command line, engine config."""
        info = {"container": c["name"], "project": c["project"], "command": c.get("command"), "address": address}
        for path in ("version", "v1/models"):
            try:
                async with session.get(f"http://{address}/{path}") as response:
                    info[path] = await response.json()
            except (aiohttp.ClientError, ValueError):
                info[path] = None
        for m in c.get("mounts", []):
            if m["destination"] == "/config":
                local = host_path(m["source"])
                try:
                    info["config"] = open(f"{local}/config.yaml").read() if local else None
                    info["run_dir"] = local
                except OSError:
                    info["config"] = None
            if m["destination"] == "/model":
                info["model_path"] = m["source"]
                info["model_revision"] = m["source"].rstrip("/").rsplit("/", 1)[-1]
        self.info[c["id"]] = info
        self.bus.publish("engine_info", info, key=c["id"])

    def targets(self, service: str, port: int) -> list[dict]:
        """Prometheus http_sd: every running container of a service, at its published port."""
        state = self.bus.state.get(("containers", None))
        out = []
        for c in state["data"] if state else []:
            address = published(c, port) if c["service"] == service and c["state"] == "running" else None
            if address:
                out.append({"targets": [address], "labels": {"project": c["project"], "container": c["name"]}})
        return out

    async def run(self) -> None:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=2)) as session:
            while True:
                await asyncio.gather(*(self.scrape(session, c) for c in await self.engines()))
                await asyncio.sleep(1)
