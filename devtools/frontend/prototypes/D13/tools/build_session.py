"""Build D13/session-data.json: what the command center shell lists and shows, read from the repo.

reps:  every reps/*/rep.toml (id, title, launch actions), its README sections, and moments.toml when present.
runs:  every reps/*/results/<run> with labels.json, and the measured request's latency.json summary when computed.
The real build serves this from the backend; the prototype reads one snapshot. Run: python3 D13/tools/build_session.py
"""
import json, re, sys, tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[5]
OUT = Path(__file__).resolve().parents[1] / "session-data.json"
SECTIONS = ["Mechanism", "Task", "Results", "Why It Matters", "Pass Check"]


def readme_sections(text: str) -> dict:
    """Top-level '## ' sections by name; also accepts the bold-lead form '**Mechanism.** ...' some READMEs use."""
    out, cur = {}, None
    for line in text.splitlines():
        m = re.match(r"^##\s+(.+?)\s*$", line)
        if m:
            cur = m.group(1).strip()
            out[cur] = []
            continue
        b = re.match(r"^\*\*(%s)\.\*\*\s*(.*)$" % "|".join(SECTIONS), line)
        if b:
            cur = b.group(1)
            out[cur] = [b.group(2)]
            continue
        if cur:
            out[cur].append(line)
    return {k: "\n".join(v).strip() for k, v in out.items() if k in SECTIONS}


def measured(lat: dict, suffix: str) -> dict | None:
    for key, rec in lat.items():
        if key.endswith(suffix):
            pick = lambda d: {k: v for k, v in d.items() if isinstance(v, (int, float, str))}
            return {"request_id": key, "client": pick(rec.get("client", {})), "engine": pick(rec.get("engine", {})),
                    "wire": pick(rec.get("wire", {})), "remainder": pick(rec.get("remainder", {})),
                    "segments": rec.get("segments", [])}
    return None


def main() -> None:
    reps, runs = [], []
    for folder in sorted(p.parent for p in ROOT.glob("reps/*/README.md")):
        toml = folder / "rep.toml"
        man = tomllib.loads(toml.read_text()) if toml.exists() else {"id": folder.name.split("_")[0]}
        h1 = re.search(r"^#\s+\S+\s+-+\s+(.+)$", (folder / "README.md").read_text(), re.M)
        title = man.get("title") or (h1.group(1).strip() if h1 else folder.name)
        moments = tomllib.loads((folder / "moments.toml").read_text()) if (folder / "moments.toml").exists() else None
        spec = folder / man.get("spec", "README.md")
        reps.append({
            "id": man["id"], "title": title, "folder": str(folder.relative_to(ROOT)), "registered": toml.exists(),
            "actions": [{k: a.get(k) for k in ("id", "group", "label", "description", "measured", "minutes")}
                        | {"options": a.get("options", [])} for a in man.get("actions", [])],
            "sections": readme_sections(spec.read_text()) if spec.exists() else {},
            "moments": moments,
        })
        suffix = (moments or {}).get("request", "measured")
        for d in sorted(x for x in (folder / "results").glob("*/") if (x / "basis.json").exists() or (x / "labels.json").exists()):
            lat = json.loads((d / "latency.json").read_text()) if (d / "latency.json").exists() else None
            m = re.search(r"(\d{8}T\d{6}Z)", d.name)
            runs.append({"id": d.name, "rep": man["id"], "labels": json.loads((d / "labels.json").read_text()) if (d / "labels.json").exists() else {},
                         "started": m.group(1) if m else None,
                         "result": measured(lat, suffix) if lat else None})
    OUT.write_text(json.dumps({"reps": reps, "runs": runs}, indent=1))
    print(f"{OUT.relative_to(ROOT)}: {len(reps)} reps ({sum(1 for r in reps if r['moments'])} with moments), "
          f"{len(runs)} runs ({sum(1 for r in runs if r['result'])} with results)")


if __name__ == "__main__":
    sys.exit(main())
