
"""GPU collector: nvidia-smi samples, and which container holds GPU memory."""
import asyncio
import re
from pathlib import Path
import collections
import time

QUERY = [
    "memory.used", "memory.total", "clocks.sm", "clocks.mem", "clocks.max.sm", "clocks.max.mem",
    "power.draw", "power.limit", "temperature.gpu", "pcie.link.gen.current", "pcie.link.width.current",
]
CONTAINER = re.compile(r"docker-([0-9a-f]{12})")  # cgroup v2 path: /system.slice/docker-<id>.scope


def number(text: str):
    try:
        return float(text)
    except ValueError:
        return None  # "[N/A]" on a counter this GPU does not report


def container_of(pid: int) -> str | None:
    """Host pid -> container id. Needs the host's /proc (pid: host)."""
    try:
        match = CONTAINER.search(Path(f"/proc/{pid}/cgroup").read_text())
    except OSError:
        return None
    return match.group(1) if match else None


class GpuCollector:
    def __init__(self, bus):
        self.bus = bus
        self.sample = {}
        self.history = collections.deque(maxlen=3600)

    async def lines(self, *args: str):
        process = await asyncio.create_subprocess_exec("nvidia-smi", *args, stdout=asyncio.subprocess.PIPE)
        async for line in process.stdout:
            yield line.decode().strip()

    async def query(self) -> None:
        """Memory, clocks, power, temperature, PCIe link: one line per second."""
        args = [f"--query-gpu={','.join(QUERY)}", "--format=csv,noheader,nounits", "-lms", "1000"]
        async for line in self.lines(*args):
            self.sample.update(zip(QUERY, map(number, line.split(", "))))
            self.history.append({"ns": time.time_ns(), **self.sample})  # wall clock, like Docker's log times
            self.bus.publish("gpu", dict(self.sample))
    async def dmon(self) -> None:
        """Busy percentages and PCIe traffic. `sm` = % of the second in which any kernel ran;
        `mem` = % of the second in which device memory was read or written. Neither is occupancy."""
        names = []
        async for line in self.lines("dmon", "-s", "ut", "-d", "1"):
            fields = line.lstrip("# ").split()
            if line.startswith("# gpu"):
                names = fields  # gpu sm mem enc dec jpg ofa rxpci txpci
            elif not line.startswith("#") and names:
                row = dict(zip(names, map(number, fields)))
                self.sample.update({"sm_busy_pct": row["sm"], "mem_busy_pct": row["mem"],
                                    "pcie_rx_mb_s": row["rxpci"], "pcie_tx_mb_s": row["txpci"]})

    async def processes(self) -> None:
        """Which processes hold GPU memory, and in which container."""
        args = ["--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"]
        while True:
            held = []
            async for line in self.lines(*args):
                pid, rest = line.split(", ", 1)
                name, used = rest.rsplit(", ", 1)  # the name may itself contain ", "
                held.append({"pid": int(pid), "program": Path(name.split()[0]).name, "mib": number(used),
                             "container": container_of(int(pid))})
            self.bus.publish("gpu_processes", held)
            await asyncio.sleep(1)

    async def run(self) -> None:
        await asyncio.gather(self.query(), self.dmon(), self.processes())
