"""D1 prototype: merge benchmark outputs into the small results.json the comparison page reads."""
import json
from pathlib import Path

ROOT = Path("/mnt/ie-data/cc-v2-proto")
HERE = Path(__file__).resolve().parent


def load(p):
    p = ROOT / p
    return json.loads(p.read_text()) if p.exists() else None


def main():
    bench = {}
    for f in sorted((ROOT / "bench").glob("*_*.json")):
        if f.stem.rsplit("_", 1)[0] not in ("real", "synthetic", "synthetic10"):
            continue
        d = json.loads(f.read_text())
        bench.setdefault(d["dataset"], {})[d["option"]] = d
    rss = ROOT / "bench" / "rss.jsonl"
    for line in (rss.read_text().splitlines() if rss.exists() else []):
        r = json.loads(line)
        if r["option"] in bench.get(r["dataset"], {}):
            bench[r["dataset"]][r["option"]]["peak_rss_mb"] = r["peak_rss_mb"]
            bench[r["dataset"]][r["option"]]["rss_holder"] = r["holder"]
    builds = {}
    log = ROOT / "logs"
    for f in log.glob("*.jsonl"):
        for line in f.read_text().splitlines():
            if line.startswith("{"):
                b = json.loads(line)
                builds.setdefault(b["dataset"], {})[b["option"]] = b
    out = {
        "generated": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "real_import": load("canonical/real_report.json"),
        "synthetic_rule": load("canonical/synthetic_rule.json"),
        "synthetic10_rule": load("canonical/synthetic10_rule.json"),
        "builds": builds,
        "bench": bench,
        "live": load("bench/live.json"),
        "deps": load("bench/deps.json"),
        "perfetto_import": load("bench/perfetto_import.json"),
    }
    (HERE / "results.json").write_text(json.dumps(out, separators=(",", ":"), default=str))
    print("results.json", (HERE / "results.json").stat().st_size, "bytes")


if __name__ == "__main__":
    main()
