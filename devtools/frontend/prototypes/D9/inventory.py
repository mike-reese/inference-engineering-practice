"""D9 prototype: read-only hardware inventory of this machine, for the node, board and GPU renders. No profiler, no load:
nvidia-smi queries, PCI sysfs (link speed and width, current and maximum), lspci -tv, lscpu -J, /proc/meminfo, DMI board
identity (/sys/class/dmi/id, readable without root), NVMe sysfs. Commands that need root are not run; their fields are
written as Unavailable. Every field carries its source.
Usage: python3 -I inventory.py -> D9/inventory.json"""
import json
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent


def sh(*cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=30).stdout
    except Exception:
        return ""


def rd(p):
    try:
        return Path(p).read_text().strip()
    except Exception:
        return None


def link(bdf):
    d = Path("/sys/bus/pci/devices") / bdf
    return {k: rd(d / k) for k in ("current_link_speed", "current_link_width", "max_link_speed", "max_link_width")} | {"source": f"sysfs {d}"}


def upstream(bdf):
    """The chain of PCI bridges from the root complex to the device (sysfs path)."""
    real = Path("/sys/bus/pci/devices", bdf).resolve()
    return [p for p in real.parts if re.fullmatch(r"[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9]", p)]


def main():
    q = "name,pci.bus_id,memory.total,clocks.max.sm,clocks.max.memory,pcie.link.gen.current,pcie.link.gen.max,pcie.link.width.current,pcie.link.width.max,driver_version,vbios_version,power.limit"
    v = [x.strip() for x in sh("nvidia-smi", f"--query-gpu={q}", "--format=csv,noheader,nounits").split(",")]
    gpu = dict(zip(q.split(","), v)) | {"source": "nvidia-smi --query-gpu"}
    bdf = "0000:" + gpu["pci.bus_id"].split(":", 1)[1].lower() if gpu.get("pci.bus_id") else None
    if bdf: gpu["link"] = link(bdf); gpu["path"] = upstream(bdf)
    nvme = []
    for c in sorted(Path("/sys/class/nvme").glob("nvme*")):
        dev = (c / "device").resolve(); b = dev.name
        nvme.append({"name": c.name, "model": rd(c / "model"), "firmware": rd(c / "firmware_rev"), "pci": b, "link": link(b), "path": upstream(b), "source": f"sysfs {c}"})
    cpu = {}
    try:
        for f in json.loads(sh("lscpu", "-J"))["lscpu"]:
            cpu[f["field"].rstrip(":")] = f["data"]
    except Exception:
        pass
    keep = ("Model name", "Socket(s)", "Core(s) per socket", "Thread(s) per core", "CPU max MHz", "L1d cache", "L1i cache", "L2 cache", "L3 cache")
    mem = rd("/proc/meminfo").splitlines()[0] if rd("/proc/meminfo") else None
    board = {k: rd(f"/sys/class/dmi/id/{k}") for k in ("board_vendor", "board_name", "bios_version", "bios_date", "product_name")} | {"source": "/sys/class/dmi/id"}
    out = {"gpu": gpu, "nvme": nvme, "cpu": {k: cpu.get(k) for k in keep} | {"source": "lscpu -J"}, "memory": {"MemTotal": mem, "source": "/proc/meminfo"},
           "board": board, "pci_tree": sh("lspci", "-tv"),
           "unavailable": {"memory modules (DIMM part numbers, channels)": "dmidecode needs root",
                           "GDDR7 chip count and board layout": "not exposed by the driver; Published only (vendor board photos/specs)",
                           "address-to-channel mapping": "not published; interleaving across all channels is Inferred"}}
    (HERE / "inventory.json").write_text(json.dumps(out, indent=1)); print(json.dumps({k: out[k] for k in ("gpu", "nvme", "cpu", "board")}, indent=1)[:3000])


if __name__ == "__main__":
    main()
