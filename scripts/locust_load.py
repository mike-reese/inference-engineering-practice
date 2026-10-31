from gevent import monkey
monkey.patch_all()

from pathlib import Path 
from gevent.event import Event
from locust import User, task
from locust.env import Environment
from locust.exception import StopUser

import json
import os
import signal
import sys 
import time 

from chat_client import ClientMetrics, ObservedTransport, save_record, send_one, make_client 

RECORDS_DIR = Path(os.environ["RECORDS_DIR"])


def run_step(client, transport: ObservedTransport, metrics: ClientMetrics, records_dir: Path, step: dict):
    pending = list(step["requests"])
    finished = Event()
    phase = step["phase"]

    class ChatUser(User):
        @task
        def one_request(self):
            if not pending:
                finished.set()
                raise StopUser()
            item = pending.pop(0)
            with metrics.in_flight.labels(phase).track_inprogress():
                record = send_one(client, transport, item["request_id"], item["messages"], item["max_tokens"],
                                  diagnostic=step.get("diagnostic", False), detail=step.get("detail", True))
            record["phase"] = phase
            record["isl"] = step["isl"]
            record["block"] = step.get("block")
            record["control"] = step.get("control")
            record["pair"] = step.get("pair")
            record["condition"] = step.get("condition")
            save_record(record, records_dir)
            if step.get("detail", True):
                metrics.observe(record, phase)
            end_ns = record["protocol_complete_ns"] if record["complete"] else record["close_ns"]
            self.environment.events.request.fire(
                request_type="POST",
                name=f"{phase} isl={step['isl']}",
                response_time=(end_ns - record["send_ns"]) / 1e6,
                response_length=sum(read["bytes"] for read in record["body_reads"]),
                exception=None if record["complete"] else RuntimeError(str(record["error"])),
                context={"request_id": item["request_id"]},
            )

    env = Environment(user_classes=[ChatUser])
    runner = env.create_local_runner()
    runner.start(1, spawn_rate=1)
    finished.wait()
    runner.quit()
    return env.stats


def locust_summary(stats) -> list[dict]:
    rows = []
    for entry in stats.entries.values():
        rows.append({
            "name": entry.name,
            "num_requests": entry.num_requests,
            "num_failures": entry.num_failures,
            "median_ms": entry.median_response_time,
            "p95_ms": entry.get_response_time_percentile(0.95),
            "response_times": entry.response_times, 
        })
    return rows

CONTROL_DIR = Path(os.environ["CONTROL_DIR"])


def write_atomic(path: Path, data: dict) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(path)


def main():
    signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(0))
    metrics = ClientMetrics()
    metrics.start_server()
    client, transport = make_client()

    index = 0
    while True:
        command = CONTROL_DIR / f"step_{index:04d}.json"
        while not command.exists():
            time.sleep(0.05)
        step = json.loads(command.read_text())
        print(f"step {index}: {step['phase']} isl={step['isl']} n={len(step['requests'])}", flush=True)
        try:
            stats = run_step(client, transport, metrics, RECORDS_DIR, step)
            result = {"step": index, "ok": True, "locust": locust_summary(stats)}
        except Exception as exc:
            result = {"step": index, "ok": False, "error": f"{type(exc).__name__}: {exc}"}
        write_atomic(RECORDS_DIR / f"step_{index:04d}.done.json", result)
        index += 1


if __name__ == "__main__":
    main()
