"""The Nsight Compute details export (`ncu --page details --csv --print-details all`) -> sections per kernel."""
from inference_analysis.trace.adapters.ncu import headline, sections

HEADER = ('"ID","Kernel Name","Section Name","Body Item Label","Metric Name","Metric Unit","Metric Value",'
          '"Rule Name","Rule Type","Rule Description","Estimated Speedup Type","Estimated Speedup"')
ROWS = [
    '"7","gemm","GPU Speed Of Light Throughput","","Duration","us","667.36","","","","",""',
    '"7","gemm","GPU Speed Of Light Throughput","GPU Throughput","DRAM Throughput","%","96.35","","","","",""',
    '"7","gemm","Occupancy","","Achieved Occupancy","%","41.20","","","","",""',
    '"7","gemm","Launch Statistics","","Waves Per SM","","1,234.5","","","","",""',
    '"7","gemm","Occupancy","","","","","AchievedOccupancy","OPT","Low occupancy.","local","12.5"',
    '"7","gemm","SpeedOfLight","","","","","SOLBottleneck","INF","Memory bound.","",""',
    '"8","norm","Occupancy","","Achieved Occupancy","%","n/a","","","","",""',
    '    The system does not have any NVLink connections.',
    '',
    '"GPU ID","GPU Name","NUMA ID by CPU Affinity","CPU Affinity","NUMA ID by Memory Affinity"',
    '"0","NVIDIA GeForce RTX 5060 Ti","0","0-15","0"',
    '"8","norm","Occupancy","","Theoretical Occupancy","%","100"',
]


def test_sections_group_metrics_and_rules_per_kernel(tmp_path):
    path = tmp_path / "sections.csv"
    path.write_text("\n".join([HEADER, *ROWS]) + "\n")
    out = sections(path)
    assert sorted(out) == [7, 8]  # the NUMA table's "GPU ID" 0 is not a kernel
    assert out[8]["sections"][0]["items"][0]["metrics"][-1]["value"] == "100"  # a short row (no rule columns)
    k = out[7]
    assert [s["name"] for s in k["sections"]] == ["GPU Speed Of Light Throughput", "Occupancy", "Launch Statistics"]
    assert [i["label"] for i in k["sections"][0]["items"]] == ["", "GPU Throughput"]
    assert [r["name"] for r in k["rules"]] == ["AchievedOccupancy", "SOLBottleneck"]
    assert k["rules"][0]["speedup"] == 12.5 and k["rules"][1]["speedup"] is None


def test_headline_reads_occupancy_waves_and_the_top_finding(tmp_path):
    path = tmp_path / "sections.csv"
    path.write_text("\n".join([HEADER, *ROWS]) + "\n")
    out = sections(path)
    h = headline(out[7])
    assert h["occupancy_achieved_pct"] == 41.2 and h["waves_per_sm"] == 1234.5
    assert h["findings"] == 1 and h["top_finding"]["name"] == "AchievedOccupancy"  # INF rules are not advice
    assert "occupancy_achieved_pct" not in headline(out[8])  # n/a stays absent
    assert headline(None) == {}
