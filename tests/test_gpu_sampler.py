"""The host sampler's readers (scripts/gpu_sampler.py) against fake NVML, cgroup and /proc trees: what each read
records, so the store adapters (adapters/trackers.py GpuProcs, ContainerSamples) get the fields they use."""
import sys
from pathlib import Path
from types import SimpleNamespace

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))
from gpu_sampler import Containers, GpuProcs, cgroup_counters, net_bytes  # noqa: E402

MiB = 2 ** 20
NET_DEV = """Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 5000 10 0 0 0 0 0 0 5000 10 0 0 0 0 0 0
  eth0: 1200 3 0 0 0 0 0 0 800 2 0 0 0 0 0 0
  eth1: 300 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0
"""


class FakeNvml:
    nvmlMemory_v2 = 2

    def __init__(self, compute, graphics, fail=False):
        self.compute, self.graphics, self.fail = compute, graphics, fail

    def nvmlInit(self):
        if self.fail:
            raise RuntimeError("NVML Shared Library Not Found")

    def nvmlDeviceGetHandleByIndex(self, i):
        return i

    def nvmlDeviceGetMemoryInfo(self, h, version=None):
        assert version == self.nvmlMemory_v2, "v2: used without the driver's reserve"
        return SimpleNamespace(used=1500 * MiB, reserved=372 * MiB)

    def nvmlDeviceGetComputeRunningProcesses(self, h):
        return [SimpleNamespace(pid=p, usedGpuMemory=m) for p, m in self.compute]

    def nvmlDeviceGetGraphicsRunningProcesses(self, h):
        return [SimpleNamespace(pid=p, usedGpuMemory=m) for p, m in self.graphics]

    def nvmlSystemGetProcessName(self, pid):
        return {1614: b"Hyprland", 4242: "python3"}.get(pid, "")


def nowhere(pid, containers):
    return {"ns_pid": None, "container": None, "service": None}


def test_one_nvml_read_lists_compute_and_graphics_processes_once_each():
    n = FakeNvml(compute=[(4242, 3000 * MiB), (6117, 190 * MiB)], graphics=[(1614, 335 * MiB), (6117, 190 * MiB),
                                                                           (1738, None)])
    rec = GpuProcs(n, nowhere).read()
    assert rec["ok"] and (rec["used_mib"], rec["reserved_mib"]) == (1500.0, 372.0)
    got = {p["pid"]: (p["type"], p["used_mib"], p["name"]) for p in rec["procs"]}
    assert got == {4242: ("C", 3000.0, "python3"), 6117: ("C+G", 190.0, ""), 1614: ("G", 335.0, "Hyprland"),
                   1738: ("G", None, "")}


def test_a_failed_nvml_read_is_recorded_not_raised():
    rec = GpuProcs(FakeNvml([], [], fail=True), nowhere).read()
    assert rec["ok"] is False and "Not Found" in rec["error"]


def cgroup_dir(root: Path, cid: str, usage_usec: int, current: int, inactive: int, limit: str) -> Path:
    d = root / f"docker-{cid}.scope"
    d.mkdir(parents=True)
    (d / "cpu.stat").write_text(f"usage_usec {usage_usec}\nuser_usec 1\nsystem_usec 2\n")
    (d / "memory.current").write_text(f"{current}\n")
    (d / "memory.stat").write_text(f"anon 10\nfile 20\ninactive_file {inactive}\n")
    (d / "memory.max").write_text(f"{limit}\n")
    return d


def test_cgroup_counters_and_interface_bytes_without_lo(tmp_path):
    d = cgroup_dir(tmp_path, "a" * 64, 1_031_513, 822_312_960, 322_056_192, "max")
    assert cgroup_counters(d) == {"cpu_usec": 1_031_513, "memory_current": 822_312_960, "inactive_file": 322_056_192,
                                  "mem_limit": None}
    assert net_bytes(NET_DEV) == (1500, 1000)


def test_containers_read_every_compose_scope_inspected_once_with_network_only_for_its_own_netns(tmp_path):
    slice_dir, proc = tmp_path / "system.slice", tmp_path / "proc"
    server, capture, plain = "1" * 64, "2" * 64, "3" * 64
    cgroup_dir(slice_dir, server, 5_000_000, 4096, 1024, "8589934592")
    cgroup_dir(slice_dir, capture, 10, 100, 0, "268435456")
    cgroup_dir(slice_dir, plain, 10, 100, 0, "max")
    (slice_dir / "user.slice").mkdir()
    (proc / "77" / "net").mkdir(parents=True)
    (proc / "77" / "net" / "dev").write_text(NET_DEV)
    info = {server: {"name": "ie-x-server-1", "project": "ie-x", "service": "server", "pid": 77, "own_netns": True},
            capture: {"name": "ie-x-capture-1", "project": "ie-x", "service": "capture", "pid": 78,
                      "own_netns": False},
            plain: None}
    calls = []
    sampler = Containers(slice_dir, proc, inspect=lambda cid: calls.append(cid) or info[cid])
    first, second = sampler.read(), sampler.read()
    assert sorted(calls) == sorted(info), "each container is inspected once"
    by = {c["name"]: c for c in second["containers"]}
    assert set(by) == {"ie-x-server-1", "ie-x-capture-1"}
    assert by["ie-x-server-1"] == {"id": "1" * 12, "name": "ie-x-server-1", "project": "ie-x", "cpu_usec": 5_000_000,
                                   "memory_current": 4096, "inactive_file": 1024, "mem_limit": 8589934592,
                                   "rx_bytes": 1500, "tx_bytes": 1000}
    assert (by["ie-x-capture-1"]["rx_bytes"], by["ie-x-capture-1"]["tx_bytes"]) == (None, None)
    assert first["ok"] and second["mono_ns"] >= first["mono_ns"]


def test_no_cgroup_slice_is_a_failed_read(tmp_path):
    rec = Containers(tmp_path / "missing", tmp_path).read()
    assert rec["ok"] is False
