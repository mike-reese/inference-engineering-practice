"""One-off: join the author's pilot 2 (spec I01-L2, K15/K16) with this repo's parsers; save the inputs per request."""
import base64
import json
from pathlib import Path

from inference_analysis.server_evidence import join_requests, log_tasks, pcap_streams

SOURCE = (Path.home() / "Work/Code/Personal/inference-engineering-fundamentals"
          / "outputs/verification/I01_L2_spec_20261028/split_probe")
RECORD_KEYS = ("request_id", "phase", "isl", "anchor_pair", "send_ns", "first_content_ns", "protocol_complete_ns",
               "transport_trace", "usage")

records = []
for path in sorted((SOURCE / "data").glob("p2_*.json")):
    if not path.name.endswith(".machine.json"):
        records += json.loads(path.read_text())["records"]
streams = pcap_streams((SOURCE / "cap/pilot2-frames.tsv").read_text())
tasks = log_tasks((SOURCE / "logs/pilot2.log").read_text(errors="replace"))

rows = []
for row in join_requests(records, streams, tasks):
    record = {key: row["record"][key] for key in RECORD_KEYS}
    reads = row["record"]["body_reads"]
    first = next(i for i, read in enumerate(reads) if b'"delta":{"content":"' in base64.b64decode(read["base64"]))
    record["body_reads"] = reads[:first + 1]
    rows.append({"record": record, "stream": row["stream"], "task": row["task"]})
Path("tests/fixtures/k15_pilot2.json").write_text(json.dumps(rows, indent=1))
print(len(rows), "requests written")
