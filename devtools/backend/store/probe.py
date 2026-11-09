"""The machine inventory the importer builds host and GPU things from (registry inventory.json), probed by this
backend and cached in $CC_STORE/probe/inventory.json. Read-only queries, no root, no profiler:

  board, BIOS      /sys/class/dmi/id
  CPU              lscpu -J
  host RAM         /proc/meminfo
  NVMe             /sys/class/nvme (model, firmware, PCIe link from the device's sysfs)
  GPU              nvidia-smi --query-gpu (name, PCIe link, clocks, driver) and nvidia-smi -q (kept whole)
  CUDA properties  the CUDA driver API through libcuda (cuDeviceGetAttribute, cuDeviceTotalMem): SM count, L2,
                   bus width, copy engines, shared memory, registers and threads per SM, compute capability

Every value carries its source. The cache is reused until it is deleted (python -m store.probe --refresh); the
GPU's current PCIe link (it trains down at idle) is the one seen at the probe.
"""
from __future__ import annotations

import ctypes
import json
import os
import subprocess
import sys
import time
from pathlib import Path

CC_STORE = Path(os.environ.get("CC_STORE", "/mnt/ie-data/cc/store"))
CACHE = CC_STORE / "probe" / "inventory.json"
SMI_FIELDS = ("name,pci.bus_id,memory.total,clocks.max.sm,clocks.max.memory,pcie.link.gen.current,pcie.link.gen.max,"
              "pcie.link.width.current,pcie.link.width.max,driver_version,vbios_version,power.limit")
# CUdevice_attribute values (cuda.h)
CU_ATTR = {"sms": 16, "bus_bits": 37, "l2_bytes": 38, "max_threads_per_sm": 39, "copy_engines": 40, "cc_major": 75,
           "cc_minor": 76, "smem_per_sm": 81, "regs_per_sm": 82}


class ProbeError(RuntimeError):
    pass


def _sh(*cmd: str) -> str:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=True).stdout


def _rd(p) -> str | None:
    try:
        return Path(p).read_text().strip()
    except OSError:
        return None


def _link(bdf: str) -> dict:
    d = Path("/sys/bus/pci/devices") / bdf
    return {k: _rd(d / k) for k in ("current_link_speed", "current_link_width", "max_link_speed", "max_link_width")}


def cuda_properties() -> dict:
    cu = ctypes.CDLL("libcuda.so.1")
    for fn in ("cuInit", "cuDeviceGet", "cuDeviceGetAttribute", "cuDeviceTotalMem_v2"):
        getattr(cu, fn).restype = ctypes.c_int
    if cu.cuInit(0):
        raise ProbeError("cuInit failed")
    dev = ctypes.c_int()
    if cu.cuDeviceGet(ctypes.byref(dev), 0):
        raise ProbeError("cuDeviceGet(0) failed")
    out = {}
    for k, a in CU_ATTR.items():
        v = ctypes.c_int()
        if cu.cuDeviceGetAttribute(ctypes.byref(v), a, dev):
            raise ProbeError(f"cuDeviceGetAttribute({k}) failed")
        out[k] = v.value
    mem = ctypes.c_size_t()
    if cu.cuDeviceTotalMem_v2(ctypes.byref(mem), dev):
        raise ProbeError("cuDeviceTotalMem failed")
    out["total_mem_bytes"] = mem.value
    return out


def probe() -> dict:
    v = [x.strip() for x in _sh("nvidia-smi", f"--query-gpu={SMI_FIELDS}", "--format=csv,noheader,nounits").split(",")]
    gpu = dict(zip(SMI_FIELDS.split(","), v))
    bdf = "0000:" + gpu["pci.bus_id"].split(":", 1)[1].lower()
    gpu["link"] = _link(bdf)
    nvme = []
    for c in sorted(Path("/sys/class/nvme").glob("nvme*")):
        b = (c / "device").resolve().name
        nvme.append({"name": c.name, "model": _rd(c / "model"), "firmware": _rd(c / "firmware_rev"), "pci": b,
                     "link": _link(b)})
    cpu = {f["field"].rstrip(":"): f["data"] for f in json.loads(_sh("lscpu", "-J"))["lscpu"]}
    mem = next((x for x in (_rd("/proc/meminfo") or "").splitlines() if x.startswith("MemTotal")), None)
    board = {k: _rd(f"/sys/class/dmi/id/{k}") for k in ("board_vendor", "board_name", "bios_version", "bios_date",
                                                        "product_name")}
    if not (mem and board["board_name"] and nvme and cpu.get("Model name")):
        raise ProbeError(f"inventory incomplete: board {board['board_name']!r}, cpu {cpu.get('Model name')!r}, "
                         f"memory {mem!r}, nvme {len(nvme)}")
    return {"schema": "inventory/1", "probed_wall_ns": time.time_ns(), "gpu": gpu, "cuda": cuda_properties(),
            "nvme": nvme, "cpu": cpu, "memory": {"MemTotal": mem}, "board": board,
            "nvidia_smi_q": _sh("nvidia-smi", "-q"),
            "sources": {"gpu": "nvidia-smi --query-gpu; sysfs PCIe link", "cuda": "libcuda cuDeviceGetAttribute",
                        "nvme": "/sys/class/nvme", "cpu": "lscpu -J", "memory": "/proc/meminfo",
                        "board": "/sys/class/dmi/id", "nvidia_smi_q": "nvidia-smi -q"},
            "unavailable": {"memory modules (DIMM part numbers, channels)": "dmidecode needs root",
                            "GDDR7 chip count and board layout": "not exposed by the driver",
                            "address-to-channel mapping": "not published"}}


def load(refresh: bool = False) -> dict:
    """The cached inventory, probed on first use."""
    if CACHE.is_file() and not refresh:
        return json.loads(CACHE.read_bytes())
    inv = probe()
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CACHE.with_suffix(".tmp")
    tmp.write_text(json.dumps(inv, indent=1))
    os.replace(tmp, CACHE)
    return inv


def inventory_things(reg, inv: dict) -> list[tuple]:
    """Things (key, parent, kind, name, attrs, evidence) from registry inventory.json and the probe."""
    g, cpu, dq = inv["gpu"], inv["cpu"], inv["cuda"]
    v = {"board_name": inv["board"]["board_name"], "cpu_name": cpu["Model name"],
         "cores": int(cpu["Core(s) per socket"]), "threads": int(cpu["Core(s) per socket"]) * int(cpu["Thread(s) per core"]),
         "l1d": cpu.get("L1d cache"), "l2": cpu.get("L2 cache"), "l3": cpu.get("L3 cache"), "max_mhz": cpu.get("CPU max MHz"),
         "ram_gib": round(int(inv["memory"]["MemTotal"].split()[1]) / 2 ** 20, 1), "nvme_model": inv["nvme"][0]["model"],
         "nvme_link": f"{inv['nvme'][0]['link']['current_link_speed']} x{inv['nvme'][0]['link']['current_link_width']}",
         "gpu_name": g["name"], "gpu_gen": g["pcie.link.gen.current"], "gpu_width": g["pcie.link.width.current"],
         "gpu_width_max": g["pcie.link.width.max"], "cc": f"{dq['cc_major']}.{dq['cc_minor']}", "sms": dq["sms"],
         "l2_bytes": dq["l2_bytes"], "l2_mib": dq["l2_bytes"] // 2 ** 20, "vram_bytes": dq["total_mem_bytes"],
         "vram_gib": round(dq["total_mem_bytes"] / 2 ** 30, 1), "bus_bits": dq["bus_bits"],
         "memory_controllers": dq["bus_bits"] // 32, "copy_engines": dq["copy_engines"], "smem_per_sm": dq["smem_per_sm"],
         "regs_per_sm": dq["regs_per_sm"], "max_threads_per_sm": dq["max_threads_per_sm"],
         "clocks_max_sm": g.get("clocks.max.sm")}
    out = []
    for t in reg.sources["inventory"]["things"]:
        n = v[t["repeat"]] if "repeat" in t else None
        for i in range(n) if n is not None else [None]:
            f = dict(v, i=i)
            out.append((t["id"].format(**f), t.get("parent"), t["kind"], t["name"].format(**f),
                        {k: v[k] for k in t.get("attrs", [])} | t.get("attrs_fixed", {}), t["evidence"]))
    return out


if __name__ == "__main__":
    inv = load(refresh="--refresh" in sys.argv)
    print(json.dumps({k: inv[k] for k in ("gpu", "cuda", "board", "memory")}, indent=1))
