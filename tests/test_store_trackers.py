"""The P2 tracker adapters (devtools/backend/store/adapters/trackers.py): raw sidecar and sampler reads -> samples and
process start rows, the same whether the live writer tails the files or the importer reads them whole."""
import json
import math
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "devtools" / "backend"))
from store.adapters.base import Ctx  # noqa: E402
from store.adapters.trackers import (ContainerSamples, GpuApps, GpuProcs, HostSamples, NvmeSamples,  # noqa: E402
                                     ProcessStarts, Trackers, UncoreSamples)
from store.registry import Registry  # noqa: E402

REG = Registry.load()
MS = 1_000_000


def ctx() -> Ctx:
    return Ctx("run", None, REG, wall_offset_ns=0)


def cpu(user, system, idle, iowait):
    return [user, 0, system, idle, iowait, 0, 0, 0, 0, 0]


def host(t, cpus, total_kib=8 << 20, avail_kib=6 << 20):
    return {"mono_ns": t, "cpu": cpus, "mem_kib": {"MemTotal": total_kib, "MemAvailable": avail_kib}}


def test_host_cpu_busy_is_the_share_of_ticks_not_idle_or_iowait_since_the_previous_read():
    a = HostSamples(ctx())
    first = host(0, {"cpu": cpu(100, 100, 1000, 10), "cpu0": cpu(50, 50, 500, 5), "cpu1": cpu(50, 50, 500, 5)})
    second = host(100 * MS, {"cpu": cpu(130, 110, 1150, 20), "cpu0": cpu(60, 10 + 50, 500, 5),
                             "cpu1": cpu(60, 50, 590, 5)})
    assert a.feed([first]) == []
    [(clock, t, v)] = a.feed([second])
    assert (clock, t) == ("host", 100 * MS)
    assert v["host.cpu.busy"] == pytest.approx(100 * 40 / 200)
    assert v["host.cpu.busy.cpu0"] == pytest.approx(100.0)
    assert v["host.cpu.busy.cpu1"] == pytest.approx(10.0)
    assert v["host.mem.used"] == 2 * 1024
    assert [c.label for c in a.clocks["host"][2:]] == ["CPU 0 busy", "CPU 1 busy"]


def test_uncore_bandwidth_divides_by_perfs_own_interval_and_counts_64_byte_lines():
    a = UncoreSamples(ctx())
    counts = {"uncore_imc/data_reads/": [100.0, "MiB"], "uncore_imc/data_writes/": [25.0, "MiB"],
              "unc_cbo_cache_lookup.any_mesi": [1e6, ""], "unc_cbo_cache_lookup.any_i": [2.5e5, ""]}
    out = a.feed([{"mono_ns": 7, "perf_s": 0.1, "counts": counts, "line": 0},
                  {"mono_ns": 9, "perf_s": 0.3, "counts": counts, "line": 1}])
    first, second = out[0][2], out[1][2]
    assert first["host.ram.read"] == pytest.approx(100 * 2 ** 20 / 0.1)
    assert first["host.ram.bw"] == pytest.approx(125 * 2 ** 20 / 0.1)
    assert second["host.ram.bw"] == pytest.approx(125 * 2 ** 20 / 0.2)
    assert second["host.l3.lookup"] == pytest.approx(1e6 * 64 / 0.2)
    assert second["host.l3.miss"] == pytest.approx(2.5e5 * 64 / 0.2)


def test_uncore_stops_on_a_unit_it_does_not_know():
    counts = {"uncore_imc/data_reads/": [1.0, "GiB"]}
    with pytest.raises(ValueError, match="line 4: uncore_imc/data_reads/ in 'GiB'"):
        UncoreSamples(ctx()).feed([{"mono_ns": 1, "perf_s": 0.1, "counts": counts, "line": 3}])


def test_uncore_not_counted_is_nan():
    counts = {"uncore_imc/data_reads/": [None, "MiB"], "uncore_imc/data_writes/": [1.0, "MiB"],
              "unc_cbo_cache_lookup.any_mesi": [1.0, ""], "unc_cbo_cache_lookup.any_i": [1.0, ""]}
    [(_, _, v)] = UncoreSamples(ctx()).feed([{"mono_ns": 1, "perf_s": 0.1, "counts": counts, "line": 0}])
    assert math.isnan(v["host.ram.read"]) and math.isnan(v["host.ram.bw"])


def test_nvme_rates_from_sectors_and_busy_milliseconds():
    a = NvmeSamples(ctx())
    stat0 = [0] * 17
    stat1 = list(stat0)
    stat1[2], stat1[6], stat1[9] = 2000, 4000, 50
    [(_, _, v)] = a.feed([{"mono_ns": 0, "dev": "nvme0n1", "stat": stat0},
                          {"mono_ns": 100 * MS, "dev": "nvme0n1", "stat": stat1}])
    assert v == {"nvme.read": pytest.approx(2000 * 512 / 0.1), "nvme.write": pytest.approx(4000 * 512 / 0.1),
                 "nvme.busy": pytest.approx(50.0)}


def proc(pid, ticks, line, first=False, ppid=1):
    return {"mono_ns": 0, "pid": pid, "ppid": ppid, "comm": "python3", "cmdline": ["python3"], "start_ticks": ticks,
            "clk_tck": 100, "boot_minus_mono_ns": 5 * 10 ** 9, "first_poll": first, "line": line}


def test_process_start_is_on_the_server_process_at_its_own_start_time():
    c = ctx()
    rows = ProcessStarts(c).feed([proc(87, 1234, 0), proc(87, 9999, 1)])
    r = rows.row(0)
    assert r["kind"] == "process start" and r["start"] == r["end"] == 12_340_000_000 - 5 * 10 ** 9
    assert r["lane"] == "server pid 87/(process-wide)"
    assert c.things[r["lane"]][0] == "host/server/server pid 87"
    assert [rows.row(i)["eid"] for i in range(2)] == ["process/87/start", "process/87/start#1"]
    assert json.loads(r["args"])["ppid"] == 1 and r["raw_ptr"] == "line 1"


def apps(t, *held, ok=True):
    return {"mono_ns": t, "ok": ok, "apps": list(held)}


SERVER = {"pid": 4242, "used_mib": 3000.0, "name": "python3", "ns_pid": 87, "container": "ie-x-server-1",
          "service": "server"}
DESKTOP = {"pid": 37764, "used_mib": 350.0, "name": "/usr/lib/chromium/chromium --type=gpu-process", "ns_pid": None,
           "container": None, "service": None}


def test_gpu_apps_one_clock_per_process_zero_once_released():
    c = ctx()
    a = GpuApps(c)
    out = a.feed([apps(0, DESKTOP), apps(1, DESKTOP, SERVER), apps(2, ok=False), apps(3, DESKTOP)])
    by = {}
    for clock, t, v in out:
        by.setdefault(clock, []).append((t, v["gpu.app.memory.used"]))
    assert by == {"gpu-apps-host-pid-37764": [(0, 350.0), (1, 350.0), (3, 350.0)],
                  "gpu-apps-server-pid-87": [(1, 3000.0), (3, 0.0)]}
    assert a.clocks["gpu-apps-server-pid-87"][0].thing == "host/server/server pid 87"
    assert c.things["host/host pid 37764"][2] == "chromium (host pid 37764)"
    assert c.stats["gpu_apps"]["failed reads"] == 1


def nvml(t, used, reserved, *procs, ok=True):
    return {"mono_ns": t, "ok": ok, "used_mib": used, "reserved_mib": reserved, "procs": list(procs)}


HYPRLAND = {"pid": 1614, "used_mib": 335.0, "type": "G", "name": "Hyprland", "ns_pid": None, "container": None,
            "service": None}


def test_gpu_procs_split_the_devices_used_memory_into_reserve_processes_and_the_rest():
    c = ctx()
    a = GpuProcs(c)
    out = a.feed([nvml(0, 1200.0, 372.0, HYPRLAND), nvml(50 * MS, 4400.0, 372.0, HYPRLAND, SERVER | {"type": "C"}),
                  nvml(100 * MS, 0, 0, ok=False), nvml(150 * MS, 1300.0, 372.0, HYPRLAND)])
    dev = [v for clock, _, v in out if clock == "gpu-mem"]
    assert [v["gpu.mem.used"] for v in dev] == [1572.0, 4772.0, 1672.0]
    for v, procs in zip(dev, (335.0, 3335.0, 335.0)):
        assert v["gpu.mem.reserved"] + procs + v["gpu.mem.unattributed"] == v["gpu.mem.used"]
    held = {(clock, t): v["gpu.proc.memory.used"] for clock, t, v in out if clock != "gpu-mem"}
    assert held == {("gpu-proc-host-pid-1614", 0): 335.0, ("gpu-proc-host-pid-1614", 50 * MS): 335.0,
                    ("gpu-proc-server-pid-87", 50 * MS): 3000.0, ("gpu-proc-host-pid-1614", 150 * MS): 335.0,
                    ("gpu-proc-server-pid-87", 150 * MS): 0.0}
    assert c.things["host/host pid 1614"][2] == "Hyprland (host pid 1614)"
    assert a.clocks["gpu-proc-server-pid-87"][0].thing == "host/server/server pid 87"
    assert c.stats["gpu_procs"]["failed reads"] == 1


def cgroup(t, *cs, ok=True):
    return {"mono_ns": t, "ok": ok, "containers": list(cs)}


def cont(cid, name, cpu_usec, current, inactive, rx=None, tx=None, project="ie-x"):
    return {"id": cid, "name": name, "project": project, "cpu_usec": cpu_usec, "memory_current": current,
            "inactive_file": inactive, "mem_limit": None, "rx_bytes": rx, "tx_bytes": tx}


def test_container_cpu_memory_and_network_from_two_cgroup_reads_of_one_container_id():
    c = ctx()
    c._projects = {"ie-x"}
    a = ContainerSamples(c)
    out = a.feed([cgroup(0, cont("a1", "ie-x-client-1", 1_000_000, 900, 100, rx=0, tx=0),
                         cont("b1", "ie-x-capture-1", 0, 50, 0), cont("z9", "other-db-1", 0, 1, 0, project="other")),
                  cgroup(100 * MS, cont("a1", "ie-x-client-1", 1_150_000, 1000, 100, rx=4000, tx=1000),
                         cont("b1", "ie-x-capture-1", 10_000, 60, 0)),
                  cgroup(200 * MS, cont("a2", "ie-x-client-1", 5_000, 500, 0, rx=10, tx=10))])
    client = [v for clock, _, v in out if clock == "cgroup-ie-x-client-1"]
    assert client[0]["container.mem_bytes"] == 800.0 and math.isnan(client[0]["container.cpu_pct"])
    assert client[1]["container.cpu_pct"] == pytest.approx(150.0)
    assert (client[1]["container.rx_rate"], client[1]["container.tx_rate"]) == (40000.0, 10000.0)
    assert math.isnan(client[2]["container.cpu_pct"]) and math.isnan(client[2]["container.rx_rate"])
    capture = [v for clock, _, v in out if clock == "cgroup-ie-x-capture-1"]
    assert capture[1]["container.cpu_pct"] == pytest.approx(10.0) and math.isnan(capture[1]["container.rx_rate"])
    assert list(a.clocks) == ["cgroup-ie-x-client-1", "cgroup-ie-x-capture-1"]
    assert a.clocks["cgroup-ie-x-client-1"][0].thing == "host/ie-x-client-1"


def write(path: Path, recs: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        for r in recs:
            f.write(json.dumps({k: v for k, v in r.items() if k != "line"}) + "\n")


def test_tailing_the_files_in_two_reads_gives_what_one_whole_read_gives(tmp_path):
    hosts = [host(i * 100 * MS, {"cpu": cpu(i * 10, i * 5, i * 100, 0), "cpu0": cpu(i, i, i * 10, 0)})
             for i in range(4)]
    procs = [proc(1, 10, 0, first=True), proc(87, 50, 1)]
    gpu = [apps(0, DESKTOP), apps(500 * MS, DESKTOP, SERVER), apps(10 ** 9, SERVER)]
    reads = [nvml(0, 1200.0, 372.0, HYPRLAND), nvml(50 * MS, 4400.0, 372.0, HYPRLAND, SERVER | {"type": "C"})]
    write(tmp_path / "trackers/host.jsonl", hosts[:2])
    write(tmp_path / "trackers/procs.jsonl", procs[:1])
    write(tmp_path / "gpu_apps.jsonl", gpu[:1])
    write(tmp_path / "gpu_procs.jsonl", reads[:1])
    live = Trackers(tmp_path, ctx())
    got = live.read()
    rows, samples = live.rows(got).cols["eid"], live.samples(got)
    write(tmp_path / "trackers/host.jsonl", hosts[2:])
    write(tmp_path / "trackers/procs.jsonl", procs[1:])
    write(tmp_path / "gpu_apps.jsonl", gpu[1:])
    write(tmp_path / "gpu_procs.jsonl", reads[1:])
    got = live.read(final=True)
    rows, samples = rows + live.rows(got).cols["eid"], samples + live.samples(got)

    whole = Trackers(tmp_path, ctx())
    got = whole.read(final=True)
    assert rows == whole.rows(got).cols["eid"] == ["process/1/start", "process/87/start"]
    assert sorted(samples, key=lambda s: s[:2]) == sorted(whole.samples(got), key=lambda s: s[:2])
    assert all(v == [] for v in live.read(final=True).values())
    assert list(live.clocks) == list(whole.clocks) == ["host", "gpu-apps-host-pid-37764", "gpu-apps-server-pid-87",
                                                       "gpu-proc-host-pid-1614", "gpu-mem", "gpu-proc-server-pid-87"]


def test_a_second_tracker_session_starts_its_rates_over():
    a, u = HostSamples(ctx()), UncoreSamples(ctx())
    one = {"cpu": cpu(0, 0, 0, 0)}
    reads = [host(0, one) | {"session": 1}, host(100 * MS, {"cpu": cpu(10, 0, 90, 0)}) | {"session": 1},
             host(9 * 10 ** 9, {"cpu": cpu(500, 0, 9000, 0)}) | {"session": 2},
             host(9 * 10 ** 9 + 100 * MS, {"cpu": cpu(550, 0, 9050, 0)}) | {"session": 2}]
    assert [round(v["host.cpu.busy"]) for _, _, v in a.feed(reads)] == [10, 50]
    counts = {"uncore_imc/data_reads/": [1.0, "MiB"], "uncore_imc/data_writes/": [0.0, "MiB"],
              "unc_cbo_cache_lookup.any_mesi": [0.0, ""], "unc_cbo_cache_lookup.any_i": [0.0, ""]}
    perf = [{"mono_ns": 1, "perf_s": 40.1, "counts": counts, "session": 1, "line": 0},
            {"mono_ns": 2, "perf_s": 0.1, "counts": counts, "session": 2, "line": 1}]
    assert [v["host.ram.read"] for _, _, v in u.feed(perf)] == pytest.approx([2 ** 20 / 40.1, 2 ** 20 / 0.1])
