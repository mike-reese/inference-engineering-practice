"""Records collector: run folders as files land in them (reps/*/results/<run>/, experiments/*/results/<run>/).

Publishes `run` (one per run folder: labels, basis, config, steps, files) and `request` (one per request: in flight
when its step file appears, then its client times, then its engine record). Reads files only; never the engine.
"""
import asyncio
import json
import os
from pathlib import Path

REPO = Path(os.environ.get("REPO", "/repo"))
KEEP_RUNS = 30
NS_PER_MS = 1e6


def run_dirs() -> list[Path]:
    dirs = [p.parent for p in REPO.glob("*/*/results/*/config.yaml")]
    return sorted(dirs, key=lambda p: p.stat().st_mtime, reverse=True)[:KEEP_RUNS]


def load(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None  # missing, or still being written


def token_event(event: dict) -> bool:
    choices = event.get("choices") or []
    return bool(choices) and bool((choices[0].get("delta") or {}).get("content")
                                  or ((choices[0].get("logprobs") or {}).get("content")))


def summarize(record: dict) -> dict:
    """Client times and token counts of one send_one record (ms from send, client clock)."""
    send = record["send_ns"]

    def ms(key):
        return (record[key] - send) / NS_PER_MS if record.get(key) else None

    events = record.get("events") or []
    tokens = [e for e in events if token_event(e["event"])]
    usage = record.get("usage") or {}
    return {"status": record.get("status"), "complete": record.get("complete"), "headers_ms": ms("headers_ns"),
            "ttft_ms": (tokens[0]["ns"] - send) / NS_PER_MS if tokens else ms("first_content_ns"),
            "e2e_ms": ms("protocol_complete_ns"), "finish_reason": record.get("finish_reason"),
            "prompt_tokens": usage.get("prompt_tokens"), "completion_tokens": usage.get("completion_tokens"),
            "events": len(events), "token_events": len(tokens), "body_reads": len(record.get("body_reads") or []),
            "error": record.get("error"), "send_mono_ns": send}


def engine_summary(entry: dict) -> dict:
    t = entry["perf_metrics"]["timing_metrics"]
    return {"engine_request_id": entry["request_id"], "first_iter": entry["perf_metrics"]["first_iter"],
            "last_iter": entry["perf_metrics"]["last_iter"],
            "queue_ms": (t["first_scheduled_time"] - t["arrival_time"]) * 1000,
            "ttft_ms": (t["first_token_time"] - t["arrival_time"]) * 1000,
            "e2e_ms": (t["last_token_time"] - t["arrival_time"]) * 1000}


class RecordsCollector:
    def __init__(self, bus):
        self.bus = bus
        self.seen = {}  # path -> mtime
        self.runs = {}  # run id -> folder
        self.published = set()

    def changed(self, path: Path) -> bool:
        try:
            mtime = path.stat().st_mtime
        except OSError:
            return False
        if self.seen.get(path) == mtime:
            return False
        self.seen[path] = mtime
        return True

    def scan(self, run: Path) -> None:
        run_id = run.name
        self.runs[run_id] = run
        rep = run.parents[1].name
        dirty = False
        for step_file in sorted((run / "control").glob("step_*.json")):
            if self.changed(step_file) and (step := load(step_file)):
                dirty = True
                for item in step["requests"]:
                    self.publish_request(run_id, rep, item["request_id"], {
                        "phase": step["phase"], "state": "sent", "step": step_file.name,
                        "criteria": {"messages": item["messages"], "max_tokens": item["max_tokens"],
                                     "isl": step.get("isl"), "diagnostic": step.get("diagnostic", False),
                                     "turns": sum(m["role"] == "user" for m in item["messages"]),
                                     "stream": True, "ignore_eos": True, "skip_special_tokens": False,
                                     "temperature": 0, "seed": 0,
                                     "logprobs": step.get("diagnostic", False)}})
        for record_file in (run / "client").glob("*.json"):
            if record_file.name.startswith("step_") or not self.changed(record_file):
                continue
            record = load(record_file)
            if record and "send_ns" in record:
                dirty = True
                self.publish_request(run_id, rep, record["request_id"],
                                     {"phase": record.get("phase"), "state": "done", "client": summarize(record)})
        joined = run / "engine_records.json"
        if self.changed(joined) and (entries := load(joined)):
            dirty = True
            for rid, entry in entries.items():
                self.publish_request(run_id, rep, rid, {"engine": engine_summary(entry)})
        for name in ("labels.json", "basis.json", "latency.json", "run.json", "frames.tsv", "perf_metrics.json"):
            dirty |= self.changed(run / name)
        if dirty or run_id not in self.published:
            self.publish_run(run_id, rep, run)

    def publish_request(self, run_id: str, rep: str, rid: str, update: dict) -> None:
        current = self.bus.state.get(("request", rid))
        data = dict(current["data"]) if current else {"request_id": rid, "run_id": run_id, "rep": rep}
        data.update(update)
        self.bus.publish("request", data, key=rid)

    def publish_run(self, run_id: str, rep: str, run: Path) -> None:
        self.published.add(run_id)
        basis = load(run / "basis.json") or {}
        files = sorted(str(p.relative_to(run)) for p in run.rglob("*") if p.is_file())
        self.bus.publish("run", {
            "run_id": run_id, "rep": rep, "path": str(run.relative_to(REPO)), "mtime": run.stat().st_mtime,
            "labels": load(run / "labels.json") or {"trace": "off"},
            "basis": {"gpu": basis.get("gpu"), "version": basis.get("version"), "images": basis.get("images")},
            "config": (run / "config.yaml").read_text(), "files": files[:400], "file_count": len(files),
            "steps": len(list((run / "control").glob("step_*.json"))),
            "done": len(list((run / "client").glob("step_*.done.json"))),
        }, key=run_id)

    def forget(self, present: set[str]) -> None:
        """Runs whose folder is gone (deleted, or past KEEP_RUNS) leave the picture with their requests."""
        for run_id in [r for r in self.published if r not in present]:
            self.published.discard(run_id)
            self.runs.pop(run_id, None)
            self.bus.remove("run", run_id)
            for (topic, key), message in list(self.bus.state.items()):
                if topic == "request" and message["data"].get("run_id") == run_id:
                    self.bus.remove("request", key)

    async def run(self) -> None:
        while True:
            dirs = await asyncio.to_thread(run_dirs)
            self.forget({d.name for d in dirs})
            for run in dirs:
                try:
                    self.scan(run)  # in the event loop: bus.publish is not thread-safe
                except (OSError, KeyError, TypeError, ValueError) as error:
                    self.bus.publish("event", {"source": "devtools", "action": f"records: {run.name}: {error}"})
            await asyncio.sleep(0.5)
