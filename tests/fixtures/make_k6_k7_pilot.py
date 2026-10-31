"""One-off: extract the author's steady pilot (spec I01-L2, K6/K7) per replay batch: clocks and Locust's own summary."""
import json
from pathlib import Path

SOURCE = (Path.home() / "Work/Code/Personal/inference-engineering-fundamentals"
          / "outputs/verification/I01_L2_spec_20261028/chat_stack/data")
CLOCKS = ("send_ns", "first_content_ns", "protocol_complete_ns")

batches = []
for isl in (64, 256, 1024):
    for repeat in (1, 2, 3):
        data = json.loads((SOURCE / f"normal_r{repeat}_{isl}.json").read_text())
        records = sorted(data["records"], key=lambda r: r["send_ns"])
        batches.append({
            "isl": isl, "repeat": repeat,
            "records": [{key: r[key] for key in CLOCKS} | {"prompt_ms": r["timings"]["prompt_ms"]} for r in records],
            "locust": {key: data["locust"][key] for key in ("count", "response_times", "p50_ms", "p95_ms")},
        })
Path("tests/fixtures/k6_k7_pilot.json").write_text(json.dumps(batches, indent=1))
print(len(batches), "batches written")
