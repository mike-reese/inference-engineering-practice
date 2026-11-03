"""Level 0: the stack's topology from `docker inspect`, saved by Stack.up as topology.json."""
import json
from pathlib import Path

from ..schema import Run


def topology(path: Path, run: Run) -> None:
    data = json.loads(path.read_text())
    containers = []
    for c in data["containers"]:
        labels = c["Config"]["Labels"]
        nets = c["NetworkSettings"]["Networks"]
        containers.append({
            "name": c["Name"].lstrip("/"),
            "service": labels.get("com.docker.compose.service"),
            "image": c["Config"]["Image"],
            "image_id": c["Image"],
            "state": c["State"]["Status"],
            "health": (c["State"].get("Health") or {}).get("Status"),
            "command": c["Config"].get("Cmd"),
            "networks": {n: v.get("IPAddress") for n, v in nets.items()},
            "network_mode": c["HostConfig"].get("NetworkMode"),
            "ports": {k: [f"{b['HostIp']}:{b['HostPort']}" for b in v or []]
                      for k, v in (c["NetworkSettings"].get("Ports") or {}).items()},
            "mounts": [{"source": m.get("Source"), "destination": m["Destination"], "rw": m.get("RW")}
                       for m in c.get("Mounts", [])],
            "gpu": bool(c["HostConfig"].get("DeviceRequests")),
            "cap_add": c["HostConfig"].get("CapAdd"),
            "env": [e for e in c["Config"].get("Env", []) if e.startswith(("TLLM_", "HF_", "TRANSFORMERS_"))],
        })
    run.topology.update({
        "captured_ns": data.get("captured_ns"),
        "project": data.get("project"),
        "containers": containers,
        "networks": [{"name": n["Name"], "driver": n["Driver"],
                      "subnet": [c.get("Subnet") for c in (n.get("IPAM") or {}).get("Config") or []]}
                     for n in data.get("networks", [])],
        "gpu": data.get("gpu"),
    })
