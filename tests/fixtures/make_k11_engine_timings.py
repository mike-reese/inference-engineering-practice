"""One-off: extract K11's 176 engine timings from the author's saved records (spec I01-L2, K11)."""
import json
from pathlib import Path

SOURCE = (Path.home() / "Work/Code/Personal/inference-engineering-fundamentals"
          / "outputs/verification/I01_L2_spec_20261028/chat_stack/data")
batches = []
for path in sorted(SOURCE.glob("*.json")):
    if path.name.endswith(".machine.json") or path.name == "recovery_generation.json":
        continue
    data = json.loads(path.read_text())
    if isinstance(data, dict) and "records" in data:
        batches.append((data["begin_ns"], data["records"]))
timings = [{"prompt_ms": r["timings"]["prompt_ms"], "predicted_ms": r["timings"]["predicted_ms"]}
           for _, records in sorted(batches, key=lambda b: b[0])
           for r in records if r["complete"]]
Path("tests/fixtures/k11_engine_timings.json").write_text(json.dumps(timings, indent=1))
print(len(timings), "timings written")
