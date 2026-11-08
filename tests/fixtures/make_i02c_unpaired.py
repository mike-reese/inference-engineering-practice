"""One-off: slices of the author's I02C-L1 QA run (pair 0) for the unpaired-native and raw /metrics tests.

Kept as returned: the /perf_metrics entries, the Prometheus sample lines of the three families the aggregate reads
(with their HELP/TYPE lines), and three /metrics responses around a repeated iteration counter.
Not in the QA run, so set here and named as such: the Prometheus read times (only place the scrape spans) and the
client records' anchor pair (taken from the QA iteration read's paired monotonic/UTC start). Client records keep
their timing fields only; events are dropped.
"""
import json
import shutil
from pathlib import Path

SOURCE = (Path.home() / "Work/Code/Personal/inference-engineering-fundamentals"
          / "outputs/verification/I02C_L1_spec_20261107T013500Z")
OUT = Path("tests/fixtures/i02c_unpaired")
FAMILIES = ("trtllm_request_queue_time_seconds_sum", "trtllm_request_queue_time_seconds_count",
            "trtllm_request_success_total")
CLIENT = ("request_id", "send_ns", "headers_ns", "first_content_ns", "protocol_complete_ns", "close_ns", "status",
          "usage")

(OUT / "client").mkdir(parents=True, exist_ok=True)
shutil.copy(SOURCE / "config.yaml", OUT / "config.yaml")
perf = json.loads((SOURCE / "pair0_perf.json").read_text())
clients = json.loads((SOURCE / "pair0_client.json").read_text())
reads = json.loads((SOURCE / "iterations.json").read_text())

# Fixture read times (not measured): baseline ends 1 ms before the first send, final starts 1 ms after
# the last completion.
first_send = min(c["send_ns"] for c in clients)
last_done = max(c["protocol_complete_ns"] for c in clients)
(OUT / "native_records.json").write_text(json.dumps({
    "first": perf["first"], "second": perf["second"],
    "prometheus_reads": {"baseline": {"start_ns": first_send - 2_000_000, "end_ns": first_send - 1_000_000},
                         "final": {"start_ns": last_done + 1_000_000, "end_ns": last_done + 2_000_000}},
}, indent=1))

for name, out in (("pair0_prom_before.txt", "prometheus_baseline.txt"), ("pair0_prom_after.txt",
                                                                          "prometheus_final.txt")):
    lines = [line for line in (SOURCE / name).read_text().splitlines()
             if any(f in line for f in FAMILIES)]
    (OUT / out).write_text("\n".join(lines) + "\n")

anchor = {"monotonic_ns": reads[0]["read_start_ns"], "utc_ns": reads[0]["utc_start_ns"]}
for c in clients:
    record = {k: c[k] for k in CLIENT} | {"phase": "pair", "complete": c["protocol_complete_ns"] is not None,
                                          "anchor_pair": anchor, "events": []}
    (OUT / "client" / f"{c['request_id']}.json").write_text(json.dumps(record, indent=1))

# Three /metrics responses in reader order: the end of read 2 (iteration 132 repeats), read 3's start, an empty read.
(OUT / "metrics_reads.json").write_text(json.dumps(
    [reads[2]["stats"][34:41], reads[3]["stats"][:2], reads[10]["stats"]], indent=1))

# engine_iterations_raw.jsonl in the collector's line format, from QA reads 1, 2 and 10 (QA times: monotonic
# read_start_ns/read_end_ns, wall utc_start_ns). Slices: iterations 3-6 (5 has generation 1, scheduled 1, queued 1),
# 130, 132, 132 (the repeat), and the empty read. Line 1 is a failed read made here (not in the QA run).
before = [sum(len(r["stats"]) for r in reads[:k]) for k in range(len(reads))]
lines = [{"reader_seq": 1, "container": "fixture", "container_id": "fixture", "read_start_ns": reads[1]["utc_start_ns"]
          - 1_000_000_000, "read_end_ns": reads[1]["utc_start_ns"] - 999_000_000,
          "read_start_mono_ns": reads[1]["read_start_ns"] - 1_000_000_000,
          "read_end_mono_ns": reads[1]["read_start_ns"] - 999_000_000, "status": None,
          "error": "ClientConnectorError: fixture (not measured)", "empty": None, "entries": None, "first_seq": None,
          "response": None, "body": None}]
for seq, (k, a, b) in enumerate(((1, 0, 4), (2, 36, 39), (10, 0, 0)), 2):
    r, stats = reads[k], reads[k]["stats"][a:b]
    lines.append({"reader_seq": seq, "container": "qa", "container_id": "qa", "read_start_ns": r["utc_start_ns"],
                  "read_end_ns": r["utc_start_ns"] + r["read_end_ns"] - r["read_start_ns"],
                  "read_start_mono_ns": r["read_start_ns"], "read_end_mono_ns": r["read_end_ns"], "status": r["status"],
                  "error": None, "empty": stats == [], "entries": len(stats),
                  "first_seq": before[k] + a + 1 if stats else None, "response": stats, "body": None})
(OUT / "engine_iterations_raw.jsonl").write_text("".join(json.dumps(x) + "\n" for x in lines))
print("written", sorted(str(p.relative_to(OUT)) for p in OUT.rglob("*") if p.is_file()))
