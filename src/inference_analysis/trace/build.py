"""Build run.json from a run folder: each adapter whose input file exists adds what it read."""
import hashlib
import json
from collections.abc import Callable
from pathlib import Path

from .schema import Run, validate

Adapter = Callable[[Path, Run], None]



def default_adapters() -> list[tuple[str, Adapter]]:
    """(file pattern in the run folder, adapter), one per data source, in the order they must run."""
    from .adapters import ADAPTERS
    return ADAPTERS

def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def build_run(run_dir: Path, adapters: list[tuple[str, Adapter]] | None = None) -> Run:
    run = Run(run_id=run_dir.name)
    labels = run_dir / "labels.json"  # what kind of run (trace level, measured or not), written by rep.py
    if labels.exists():
        run.labels = json.loads(labels.read_text())
    for pattern, adapt in default_adapters() if adapters is None else adapters:
        for path in sorted(run_dir.glob(pattern)):
            adapt(path, run)
            run.sources.append({"file": str(path.relative_to(run_dir)), "sha256": sha256(path),
                               "adapter": f"{adapt.__module__}.{adapt.__name__}"})
    problems = validate(run)
    if problems:
        raise ValueError(f"{run_dir}: run is not sound:\n  " + "\n  ".join(problems))
    return run


def write_run(run_dir: Path, adapters: list[tuple[str, Adapter]] | None = None) -> Path:
    out = run_dir / "run.json"
    out.write_text(json.dumps(build_run(run_dir, adapters).to_json(), indent=1))
    return out           
