
"""Docker collector: containers, networks, events and stats from the Docker Engine API."""
import asyncio
import json
import time

import aiohttp

API = "http://docker/v1.44"  # the host part is ignored; the request goes down the unix socket
PROJECT = "com.docker.compose.project"
SERVICE = "com.docker.compose.service"


def describe(info: dict) -> dict:
    """One container, reduced to what the map draws."""
    state = info["State"]
    mode = info["HostConfig"]["NetworkMode"]
    ports = info["NetworkSettings"]["Ports"] or {}
    requests = info["HostConfig"].get("DeviceRequests") or []
    return {
        "id": info["Id"][:12],
        "name": info["Name"].lstrip("/"),
        "project": info["Config"]["Labels"].get(PROJECT),
        "service": info["Config"]["Labels"].get(SERVICE),
        "image": info["Config"]["Image"],
        "state": state["Status"],  # created, running, exited, ...
        "health": (state.get("Health") or {}).get("Status"),  # starting, healthy, unhealthy, or None
        "started_at": state["StartedAt"],
        "pid": state["Pid"],
        "shares_netns_with": mode.split(":", 1)[1][:12] if mode.startswith("container:") else None,
        "networks": {name: net["IPAddress"] for name, net in info["NetworkSettings"]["Networks"].items()},
        "ports": [f"{b['HostIp']}:{b['HostPort']}->{port}" for port, binds in ports.items() for b in binds or []],
        "gpu": any(["gpu"] in (r.get("Capabilities") or []) for r in requests),
        "mem_limit": info["HostConfig"]["Memory"] or None,
        "command": info["Config"].get("Cmd"),
        "mounts": [{"source": m.get("Source"), "destination": m["Destination"]} for m in info.get("Mounts", [])],
        "cap_add": info["HostConfig"].get("CapAdd"),
    }


def usage(sample: dict, previous: dict | None) -> dict:
    """CPU, memory and network from one stats sample (Docker sends one per second)."""
    cpu, pre = sample["cpu_stats"], sample["precpu_stats"]
    cpu_delta = cpu["cpu_usage"]["total_usage"] - pre["cpu_usage"].get("total_usage", 0)
    system_delta = cpu.get("system_cpu_usage", 0) - pre.get("system_cpu_usage", 0)
    memory = sample["memory_stats"]
    networks = sample.get("networks")  # absent when the container uses another container's netns
    now = time.monotonic()
    result = {
        "cpu_pct": 100.0 * cpu_delta / system_delta * cpu.get("online_cpus", 1) if system_delta > 0 else 0.0,
        "mem_bytes": memory.get("usage", 0) - memory.get("stats", {}).get("inactive_file", 0),  # what `docker stats` shows
        "mem_limit": memory.get("limit"),
        "rx_bytes": sum(n["rx_bytes"] for n in networks.values()) if networks else None,
        "tx_bytes": sum(n["tx_bytes"] for n in networks.values()) if networks else None,
        "at": now,
    }
    if previous and networks and previous["rx_bytes"] is not None:
        seconds = now - previous["at"]
        result["rx_rate"] = (result["rx_bytes"] - previous["rx_bytes"]) / seconds
        result["tx_rate"] = (result["tx_bytes"] - previous["tx_bytes"]) / seconds
    return result


class DockerCollector:
    def __init__(self, bus, socket: str = "/var/run/docker.sock"):
        self.bus = bus
        self.socket = socket
        self.stats_tasks = {}  # container id -> the task reading its stats stream

    async def get(self, path: str, **params):
        async with self.session.get(API + path, params=params) as response:
            response.raise_for_status()
            return await response.json()

    async def refresh(self) -> None:
        """List every Compose container, publish the list, start or stop stats streams to match."""
        listed = await self.get("/containers/json", all="true", filters=json.dumps({"label": [PROJECT]}))
        containers = []
        for c in listed:
            try:
                containers.append(describe(await self.get(f"/containers/{c['Id']}/json")))
            except aiohttp.ClientResponseError as error:
                if error.status != 404:  # 404: removed between the list and the inspect
                    raise
        self.bus.publish("containers", containers)
        running = {c["id"] for c in containers if c["state"] == "running"}
        for cid in running - self.stats_tasks.keys():
            self.stats_tasks[cid] = asyncio.create_task(self.stream_stats(cid))
        for cid in self.stats_tasks.keys() - running:
            self.stats_tasks.pop(cid).cancel()

    async def stream_stats(self, cid: str) -> None:
        previous = None
        try:
            async with self.session.get(f"{API}/containers/{cid}/stats", params={"stream": "true"}) as response:
                async for line in response.content:  # one JSON document per line, about once a second
                    previous = usage(json.loads(line), previous)
                    self.bus.publish("stats", previous, key=cid)
        except (aiohttp.ClientError, KeyError, ValueError):
            pass  # the container stopped; refresh() starts a new stream if it comes back
        finally:
            if self.stats_tasks.get(cid) is asyncio.current_task():
                del self.stats_tasks[cid]

    async def watch_events(self) -> None:
        filters = json.dumps({"type": ["container"], "label": [PROJECT]})
        async with self.session.get(API + "/events", params={"filters": filters}) as response:
            async for line in response.content:
                event = json.loads(line)
                if event["Action"].startswith("exec_"):
                    continue  # the server's healthcheck runs `curl` as an exec every second
                attributes = event["Actor"]["Attributes"]
                self.bus.publish("event", {
                    "source": "docker",
                    "container": attributes.get("name"),
                    "project": attributes.get(PROJECT),
                    "action": event["Action"],  # start, die, health_status: healthy, destroy, ...
                    "time_ns": event["timeNano"],  # wall clock, from the Docker daemon
                })
                await self.refresh()

    async def run(self) -> None:
        connector = aiohttp.UnixConnector(path=self.socket)
        no_timeout = aiohttp.ClientTimeout(total=None, sock_read=None)  # the event and stats streams never end
        async with aiohttp.ClientSession(connector=connector, timeout=no_timeout) as self.session:
            while True:
                try:
                    await self.refresh()
                    await self.watch_events()
                except (aiohttp.ClientError, OSError) as error:
                    self.bus.publish("event", {"source": "devtools", "action": f"docker collector: {error}"})
                    await asyncio.sleep(2)
