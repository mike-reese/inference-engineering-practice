import secrets
import socket
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path
import json
import os
import subprocess
import threading
from contextlib import contextmanager, nullcontext
import time
import shutil
import urllib.parse
import urllib.error
import urllib.request

import numpy as np

from inference_analysis.chat_records import (
    causal_pairs,
    chat_durations,
    half_p50_difference_ms,
    held_back_line_miss_ms,
    locust_median_ms,
    locust_percentile_ms,
    locust_response_times,
    log_offset_bounds,
    paired_bootstrap_interval,
    request_segments,
    service_output_throughput,
)
from inference_analysis.server_evidence import join_requests, log_tasks, pcap_streams

REP_DIR = Path(__file__).resolve().parent
REPO_ROOT = REP_DIR.parents[1]
COMPOSE_FILE = REPO_ROOT / "deploy" / "compose.yaml"
LOGOFF_FILE = REPO_ROOT / "deploy" / "compose.logoff.yaml"

SYSTEM_MESSAGE = "You are a concise assistant for an inference team."
RED_REPEATS_BY_ISL = {64: 28, 256: 220, 1024: 988}
OSL = 32
BLOCK_ORDERS = [(64, 256, 1024), (256, 1024, 64), (1024, 64, 256)]
WARMUPS_PER_SETTING = 3
MEASURED_PER_SETTING = 8
PROJECT = "ie-i01-l2"
PROM_JOBS = ("server", "client", "node", "dcgm")
CONTROL_ISL = 256
CONTROL_PAIRS = 3
CONTROL_REQUESTS = 4
OBSERVERS = ("prometheus", "grafana", "node", "dcgm")
DASHBOARD_FILE = REPO_ROOT / "monitoring" / "grafana" / "dashboards" / "i01_l2.json"
CAPTURE_IMAGE = "ie-capture:alpine3.20"
TSHARK_FIELDS = ("frame.time_epoch", "tcp.stream", "tcp.dstport", "tcp.flags.syn", "tcp.payload")
ISLS = tuple(sorted(RED_REPEATS_BY_ISL))
GUARD_MS = 15.0
BUDGET_TTFT_P95_MS = 150.0
BUDGET_E2E_P95_MS = 400.0
QUANTILES = (0.5, 0.95, 0.99)
# Each control compares its first condition minus its second.
CONTROL_CONTRASTS = {"diagnostic": ("diagnostic", "normal"), "observer": ("on", "off"), "logging": ("on", "off")}

def run(*cmd: str) -> str:
    return subprocess.run(cmd, check=True, text=True, capture_output=True).stdout


def save_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=2))


def get_json(base: str, path: str, **params) -> dict:
    url = base + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=10) as resp:
        return json.loads(resp.read())


def write_atomic(path: Path, data: dict) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(path)


class Stack:
    def __init__(self, run_id: str, run_dir: Path):
        self.run_id = run_id
        self.run_dir = run_dir
        self.server_start = 0
        self.next_step = 0
        self.next_request = 0
        self.exported = 0
        self.steps = []

    def compose(self, *args: str, files=(COMPOSE_FILE,), capture: bool = False) -> subprocess.CompletedProcess:
        env = {**os.environ, "RUN_ID": self.run_id, "SERVER_START": str(self.server_start)}
        file_args = [arg for f in files for arg in ("-f", str(f))]
        return subprocess.run(["docker", "compose", *file_args, *args],
                              env=env, check=True, text=True, capture_output=capture)

    def url(self, service: str, port: int) -> str:
        address = self.compose("port", service, str(port), capture=True).stdout.strip()
        return f"http://{address}"

    def new_step(self, phase: str, isl: int, count: int, max_tokens: int = OSL, **flags) -> dict:
        requests = []
        for _ in range(count):
            requests.append({"request_id": f"{self.run_id}-{self.next_request:04d}",
                             "messages": messages_for(isl), "max_tokens": max_tokens})
            self.next_request += 1
        return {"phase": phase, "isl": isl, **flags, "requests": requests}

    def submit_step(self, step: dict) -> dict:
        index = self.next_step
        self.next_step += 1
        name = f"step_{index:04d}"
        pending = {"index": index, "name": name, "step": step, "sent": time.time()}
        write_atomic(self.run_dir / "control" / f"{name}.json", step)
        return pending

    def wait_step(self, pending: dict) -> dict:
        step, name = pending["step"], pending["name"]
        result_path = self.run_dir / "client" / f"{name}.done.json"
        timeout_s = max(30, len(step["requests"]) * 10)
        deadline = time.monotonic() + timeout_s
        while not result_path.exists():
            if time.monotonic() > deadline:
                raise TimeoutError(f"{name}: no result after {timeout_s} s")
            time.sleep(0.1)
        result = json.loads(result_path.read_text())

        if step.get("detail", True):
            self.exported += len(step["requests"])
        self.steps.append({"step": pending["index"], "phase": step["phase"], "isl": step["isl"],
                           "block": step.get("block"), "control": step.get("control"),
                           "pair": step.get("pair"), "condition": step.get("condition"),
                           "server_start": self.server_start, "sent_unix": pending["sent"],
                           "done_unix": time.time(), "ok": result["ok"]})
        if not result["ok"]:
            raise RuntimeError(f"{name} failed: {result['error']}")
        return result

    def run_step(self, step: dict) -> dict:
        return self.wait_step(self.submit_step(step))


def run_replay(stack: Stack) -> None:
    for block, order in enumerate(BLOCK_ORDERS):
        for isl in order:
            stack.run_step(stack.new_step("warmup", isl, WARMUPS_PER_SETTING, block=block))
            stack.run_step(stack.new_step("normal", isl, MEASURED_PER_SETTING, block=block))


def run_diagnostic_audit(stack: Stack) -> None:
    """One diagnostic request per ISL before load; audit.py compares their token IDs with offline HF."""
    for isl in ISLS:
        stack.run_step(stack.new_step("diagnostic", isl, 1, diagnostic=True, control="audit"))


def print_urls(stack: Stack) -> None:
    grafana = stack.url("grafana", 3000)
    print(f"grafana dashboard: {grafana}/d/i01-l2")
    print(f"client metrics:    {stack.url('client', 9410)}/metrics")
    print(f"prometheus:        {stack.url('prometheus', 9090)}")
    print(f"server:            {stack.url('server', 8080)}")

def messages_for(isl: int) -> list[dict]:
    user = "Read these words:" + " red" * RED_REPEATS_BY_ISL[isl] + "\nWrite a numbered list with ten observations."
    return [{"role": "system", "content": SYSTEM_MESSAGE}, {"role": "user", "content": user}]


def new_run_id() -> str:
    return datetime.now(timezone.utc).strftime("I01L2_%Y%m%dT%H%M%SZ_") + secrets.token_hex(3)


def prepare_run_dir(run_id: str) -> Path:
    run_dir = REP_DIR / "results" / run_id
    (run_dir / "client").mkdir(parents=True)
    (run_dir / "control").mkdir()
    run_dir.chmod(0o777)
    return run_dir


def host_snapshot(evidence: Path, label: str) -> None:
    gpu = run("nvidia-smi", "--query-gpu=timestamp,uuid,driver_version,clocks.sm,clocks.mem,"
              "temperature.gpu,power.draw,memory.used,memory.total,utilization.gpu", "--format=csv")
    save_json(evidence / f"host_{label}.json", {
        "utc": datetime.now(timezone.utc).isoformat(),
        "loadavg": Path("/proc/loadavg").read_text().split()[:3],
        "nvidia_smi_csv": gpu,
    })
    
def host_identity(evidence: Path) -> None:
    """Live host identity for P3f, compared with Node Exporter and DCGM series."""
    meminfo = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
    gpu = run("nvidia-smi", "--query-gpu=uuid,name,driver_version", "--format=csv,noheader").strip().split(", ")
    save_json(evidence / "host_identity.json", {
        "hostname": socket.gethostname(), "cpu_count": os.cpu_count(),
        "mem_total_bytes": int(meminfo["MemTotal"].split()[0]) * 1024,
        "gpu_uuid": gpu[0], "gpu_name": gpu[1], "driver_version": gpu[2],
    })


def container_snapshot(stack: Stack, evidence: Path) -> None:
    ids = stack.compose("ps", "-q", capture=True).stdout.split()
    inspect = json.loads(run("docker", "inspect", *ids))
    save_json(evidence / "containers_inspect.json", inspect)
    images = sorted({c["Image"] for c in inspect})
    save_json(evidence / "images_inspect.json", json.loads(run("docker", "image", "inspect", *images)))
    stats = run("docker", "stats", "--no-stream", "--format", "{{json .}}", *ids)
    save_json(evidence / "docker_stats.json", {
        "utc": datetime.now(timezone.utc).isoformat(),
        "containers": [json.loads(line) for line in stats.splitlines()],
    })
    (evidence / "compose.resolved.yaml").write_text(stack.compose("config", capture=True).stdout)
    freeze = stack.compose("exec", "-T", "client", "cat", "/app/freeze.txt", capture=True).stdout
    (evidence / "client_freeze.txt").write_text(freeze)
    shutil.copy(REPO_ROOT / "deploy" / "server" / "image.json", evidence / "server_image.json")

def wait_for_final_scrape(prom: str, expected: int, timeout_s: float = 15) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        result = get_json(prom, "/api/v1/query", query="sum(ie_client_requests_total)")["data"]["result"]
        if result and float(result[0]["value"][1]) == expected:
            return
        time.sleep(1)
    raise TimeoutError(f"Prometheus never stored {expected} client requests")


def export_prometheus(prom: str, evidence: Path, start: float, end: float) -> None:
    start, end = int(start), int(end) + 2
    folder = evidence / "prometheus"
    folder.mkdir()
    save_json(folder / "targets.json", get_json(prom, "/api/v1/targets"))
    save_json(folder / "rules.json", get_json(prom, "/api/v1/rules"))
    save_json(folder / "buildinfo.json", get_json(prom, "/api/v1/status/buildinfo"))
    for job in PROM_JOBS:
        save_json(folder / f"range_{job}.json", get_json(
            prom, "/api/v1/query_range", query=f'{{job="{job}"}}', start=start, end=end, step="1s"))
    save_json(folder / "range_alerts.json", get_json(
        prom, "/api/v1/query_range", query="ALERTS", start=start, end=end, step="1s"))


def export_histogram_estimates(prom: str, evidence: Path) -> None:
    """Prometheus's own histogram_quantile over the whole run's normal-phase counters (the dashboard convention)."""
    rows = []
    for metric in ("ttft", "e2e"):
        for q in QUANTILES:
            query = f'histogram_quantile({q}, sum by (le) (ie_client_{metric}_seconds_bucket{{phase="normal"}}))'
            result = get_json(prom, "/api/v1/query", query=query)["data"]["result"]
            rows.append({"metric": metric, "quantile": q, "query": query,
                         "seconds": float(result[0]["value"][1]) if result else None})
    save_json(evidence / "prometheus" / "histogram_estimates.json", rows)


def export_grafana(stack: Stack, evidence: Path) -> None:
    grafana = stack.url("grafana", 3000)
    save_json(evidence / "grafana_health.json", get_json(grafana, "/api/health"))
    save_json(evidence / "grafana_dashboard.json", get_json(grafana, "/api/dashboards/uid/i01-l2"))


def save_logs(stack: Stack, evidence: Path) -> None:
    logs = stack.compose("logs", "--no-color", "--timestamps", capture=True).stdout
    (evidence / "compose_logs.txt").write_text(logs)


def check_cleanup(evidence: Path) -> None:
    left = run("docker", "ps", "-a", "-q", "--filter", f"label=com.docker.compose.project={PROJECT}").split()
    save_json(evidence / "cleanup.json", {
        "utc": datetime.now(timezone.utc).isoformat(), "project": PROJECT, "remaining_containers": left,
    })
    if left:
        raise RuntimeError(f"containers left after down: {left}")

def pair_orders():
    for pair in range(1, CONTROL_PAIRS + 1):
        yield pair, ((True, False) if pair % 2 else (False, True))


def run_condition(stack: Stack, machine: Path, control: str, pair: int, condition: str,
                  around_measured=nullcontext, **flags):
    tags = {"control": control, "pair": pair, "condition": condition, **flags}
    stack.run_step(stack.new_step("warmup", CONTROL_ISL, WARMUPS_PER_SETTING, **tags))
    phase = "diagnostic" if flags.get("diagnostic") else "control"
    label = f"{control}_p{pair}_{condition}"
    host_snapshot(machine, f"{label}_before")
    # around_measured wraps only the measured step, e.g. dashboard polling for observer-on.
    with around_measured() as extra:
        stack.run_step(stack.new_step(phase, CONTROL_ISL, CONTROL_REQUESTS, **tags))
    host_snapshot(machine, f"{label}_after")
    return extra


def checkpoint(stack: Stack, evidence: Path, label: str) -> None:
    wait_for_final_scrape(stack.url("prometheus", 9090), stack.exported)
    for service, port in (("server", 8080), ("client", 9410)):
        with urllib.request.urlopen(stack.url(service, port) + "/metrics", timeout=10) as resp:
            (evidence / f"{service}_metrics_{label}.txt").write_text(resp.read().decode())
    # Which steps and which server lifetime these snapshots cover (P3a-P3e).
    save_json(evidence / f"checkpoint_{label}.json", {"utc": time.time(), "steps_done": stack.next_step,
                                                      "exported": stack.exported, "server_start": stack.server_start})


def run_diagnostic_control(stack: Stack, machine: Path) -> None:
    for pair, order in pair_orders():
        for diagnostic in order:
            run_condition(stack, machine, "diagnostic", pair, "diagnostic" if diagnostic else "normal",
                          diagnostic=diagnostic)


def set_observers(stack: Stack, on: bool) -> None:
    if not on:
        stack.compose("stop", *OBSERVERS)
        return
    stack.compose("start", *OBSERVERS)
    deadline = time.monotonic() + 60
    while True:
        try:
            targets = get_json(stack.url("prometheus", 9090), "/api/v1/targets")["data"]["activeTargets"]
            if targets and all(t["health"] == "up" for t in targets):
                return
        except (OSError, ValueError):
            pass
        if time.monotonic() > deadline:
            raise TimeoutError("observers did not come back up")
        time.sleep(0.5)


@contextmanager
def dashboard_polling(stack: Stack):
    grafana = stack.url("grafana", 3000)
    dashboard = json.loads(DASHBOARD_FILE.read_text())
    queries = [{"refId": f"p{panel['id']}{target['refId']}", "datasource": panel["datasource"],
                "expr": target["expr"], "range": True, "intervalMs": 1000, "maxDataPoints": 300}
               for panel in dashboard["panels"] for target in panel["targets"]]
    body = json.dumps({"from": "now-15m", "to": "now", "queries": queries}).encode()
    stop = threading.Event()
    polls = []

    def loop():
        while not stop.is_set():
            sent = time.time()
            try:
                request = urllib.request.Request(grafana + "/api/ds/query", data=body,
                                                 headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(request, timeout=10) as resp:
                    polls.append({"utc": sent, "status": resp.status})
            except OSError as exc:
                polls.append({"utc": sent, "error": str(exc)})
            stop.wait(5)

    thread = threading.Thread(target=loop)
    thread.start()
    try:
        yield polls
    finally:
        stop.set()
        thread.join()


def run_observer_control(stack: Stack, evidence: Path, machine: Path) -> None:
    polls = {}
    for pair, order in pair_orders():
        for on in order:
            set_observers(stack, on)
            condition = "on" if on else "off"
            if on:
                polls[f"pair{pair}"] = run_condition(stack, machine, "observer", pair, condition,
                                                     around_measured=lambda: dashboard_polling(stack),
                                                     detail=True)
            else:
                run_condition(stack, machine, "observer", pair, condition, detail=False)
    set_observers(stack, True)
    save_json(evidence / "grafana_polls.json", polls)


def restart_server(stack: Stack, logging: bool) -> None:
    stack.server_start += 1
    # Let tcpdump receive its last packet block before the recreate removes eth0 under it.
    time.sleep(2)
    if logging:
        stack.compose("up", "-d", "--force-recreate", "--wait", "server", "capture")
    else:
        stack.compose("up", "-d", "--force-recreate", "--wait", "server", files=(COMPOSE_FILE, LOGOFF_FILE))
        stack.compose("stop", "capture")
    running = stack.compose("ps", "--services", "--status", "running", capture=True).stdout.split()
    if ("capture" in running) != logging:
        raise RuntimeError(f"capture state wrong for logging={logging}: {running}")
    time.sleep(3)


def run_logging_control(stack: Stack, machine: Path) -> None:
    for pair, order in pair_orders():
        for on in order:
            restart_server(stack, logging=on)
            run_condition(stack, machine, "logging", pair, "on" if on else "off")
    restart_server(stack, logging=True)


def rule_state(prom: str) -> str:
    groups = get_json(prom, "/api/v1/rules")["data"]["groups"]
    return next(r["state"] for g in groups for r in g["rules"] if r["name"] == "InferenceServerDown")


def watch_rule(prom: str, until: str, timeout_s: float = 60) -> list[dict]:
    seen = []
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        state = rule_state(prom)
        if not seen or seen[-1]["state"] != state:
            seen.append({"utc": time.time(), "state": state})
        if state == until:
            return seen
        time.sleep(0.25)
    raise TimeoutError(f"rule never reached {until}: {seen}")


def wait_until_generating(server: str, timeout_s: float = 10) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        with urllib.request.urlopen(server + "/metrics", timeout=2) as resp:
            if "llamacpp:requests_processing 1" in resp.read().decode():
                return
        time.sleep(0.02)
    raise TimeoutError("server never started processing the failure request")


def recover_server(stack: Stack) -> list[dict]:
    stack.server_start += 1
    stack.compose("up", "-d", "--force-recreate", "server", "capture")
    server = stack.url("server", 8080)
    observations = []
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        checked = time.time()
        try:
            with urllib.request.urlopen(server + "/health", timeout=2) as resp:
                observations.append({"utc": checked, "status": resp.status})
                return observations
        except urllib.error.HTTPError as exc:
            observations.append({"utc": checked, "status": exc.code})
        except OSError as exc:
            observations.append({"utc": checked, "error": str(exc)})
        time.sleep(0.1)
    raise TimeoutError("server health never returned 200")


def run_failure_test(stack: Stack, evidence: Path, prom: str) -> None:
    rule = watch_rule(prom, "inactive")
    checkpoint(stack, evidence, "before_failure")

    pending = stack.submit_step(stack.new_step("failure", 64, 1, max_tokens=512,
                                               control="failure", condition="midstream_kill"))
    wait_until_generating(stack.url("server", 8080))
    time.sleep(0.3)
    stack.compose("kill", "server")
    killed = time.time()
    stack.wait_step(pending)

    rule += watch_rule(prom, "firing")
    stack.run_step(stack.new_step("failure", 64, 1, control="failure", condition="server_down"))

    health = recover_server(stack)
    stack.run_step(stack.new_step("control", 64, 3, control="failure", condition="recovery"))
    rule += watch_rule(prom, "inactive")

    save_json(evidence / "failure.json", {"killed_unix": killed, "rule": rule, "health": health})


def tshark_frames(run_dir: Path, pcap_name: str) -> str:
    fields = [arg for field in TSHARK_FIELDS for arg in ("-e", field)]
    return run("docker", "run", "--rm", "--network", "none", "-v", f"{run_dir}:/run:ro", CAPTURE_IMAGE,
               "tshark", "-r", f"/run/{pcap_name}", "-T", "fields", "-E", "header=y", "-E", "separator=/t", *fields)


def split_server_start(run_dir: Path, run_id: str, server_start: int) -> dict:
    stem = f"{run_id}_s{server_start}"
    records = [json.loads(p.read_text()) for p in (run_dir / "client").glob(f"{run_id}-*.json")]
    streams = pcap_streams(tshark_frames(run_dir, f"{stem}.pcap"))
    tasks = log_tasks((run_dir / f"{stem}.log").read_text(errors="replace"))
    joined = join_requests(records, streams, tasks)
    low, high = log_offset_bounds([pair for row in joined for pair in causal_pairs(row["stream"], row["task"])])
    offset = (low + high) // 2
    rows = []
    for row in joined:
        record = row["record"]
        if not (record["complete"] and record.get("detail", True)):
            continue
        rows.append({key: record.get(key) for key in ("request_id", "phase", "isl", "block", "control", "condition")}
                    | {"task": row["task"]["task"], "n_prompt": row["task"].get("n_prompt")}
                    | request_segments(record, row["stream"], row["task"], offset))
    return {"server_start": server_start, "offset_ns_interval": [low, high], "offset_ns_used": offset,
            "offset_half_width_ms": (high - low) / 2e6, "joined": len(joined), "decomposed": len(rows), "rows": rows}


# ---------------------------------------------------------------------------------------------------------
# Analysis: summaries from the saved records only (run after teardown, or again with --analyze RUN_ID).
# Raw percentiles are NumPy "linear". Locust and histogram values are shown beside them under their own
# conventions, never relabeled as exact.
# ---------------------------------------------------------------------------------------------------------

def ms_between(record: dict, end: str) -> float:
    return (record[end] - record["send_ns"]) / 1e6


def locust_duration_ms(record: dict) -> float:
    """The duration locust_load.py reports to Locust: protocol complete, or close for a failed attempt."""
    end = record["protocol_complete_ns"] if record["complete"] else record["close_ns"]
    return (end - record["send_ns"]) / 1e6


def p50(values: list[float]) -> float:
    return float(np.quantile(values, 0.5, method="linear"))


def raw_quantiles(values: list[float]) -> dict:
    return {f"p{round(q * 100)}": float(np.quantile(values, q, method="linear")) for q in QUANTILES}


def load_run(run_dir: Path) -> dict:
    run_id = run_dir.name
    records = {}
    for path in (run_dir / "client").glob(f"{run_id}-*.json"):
        record = json.loads(path.read_text())
        records[record["request_id"]] = record
    by_step = {}
    for path in sorted((run_dir / "control").glob("step_*.json")):
        ids = [request["request_id"] for request in json.loads(path.read_text())["requests"]]
        by_step[int(path.stem.split("_")[1])] = sorted((records[i] for i in ids), key=lambda r: r["send_ns"])
    steps = json.loads((run_dir / "evidence" / "steps.json").read_text())
    return {"run_id": run_id, "records": records, "steps": steps, "by_step": by_step}


def measured_replay(run: dict, isl: int | None = None) -> list[dict]:
    return [r for r in run["records"].values()
            if r["phase"] == "normal" and r.get("control") is None and (isl is None or r["isl"] == isl)]


def replay_blocks(run: dict) -> list[dict]:
    blocks = []
    for step in run["steps"]:
        if step["control"] is not None or step["phase"] != "normal":
            continue
        records = run["by_step"][step["step"]]
        done = [r for r in records if r["complete"]]
        e2e = [ms_between(r, "protocol_complete_ns") for r in done]
        blocks.append({
            "isl": step["isl"], "block": step["block"], "step": step["step"], "n": len(records), "n_complete": len(done),
            "e2e_p50_ms": p50(e2e), "ttft_p50_ms": p50([ms_between(r, "first_content_ns") for r in done]),
            "half_p50_difference_ms": half_p50_difference_ms(e2e) if len(e2e) % 2 == 0 else None,
            "prompt_p50_ms": p50([r["timings"]["prompt_ms"] for r in done]),
            "predicted_p50_ms": p50([r["timings"]["predicted_ms"] for r in done]),
            "output_tokens_per_s": service_output_throughput(done),
            "engine_decode_tokens_per_s_p50": p50([r["timings"]["predicted_per_second"] for r in done]),
        })
    return blocks


def stability(blocks: list[dict]) -> dict:
    """P4c/P4d guard: within-replay half-P50 difference and across-block P50 range, both at most 15 ms."""
    halves = [b["half_p50_difference_ms"] for b in blocks]
    ranges = {}
    for isl in ISLS:
        medians = [b["e2e_p50_ms"] for b in blocks if b["isl"] == isl]
        ranges[isl] = max(medians) - min(medians)
    counts_ok = (len(blocks) == sum(len(order) for order in BLOCK_ORDERS)
                 and all(b["n_complete"] == MEASURED_PER_SETTING for b in blocks))
    half_ok = all(h is not None and abs(h) <= GUARD_MS for h in halves)
    range_ok = all(r <= GUARD_MS for r in ranges.values())
    return {"guard_ms": GUARD_MS, "counts_ok": counts_ok, "half_ok": half_ok, "range_ok": range_ok,
            "stable": counts_ok and half_ok and range_ok,
            "max_abs_half_p50_difference_ms": max((abs(h) for h in halves if h is not None), default=None),
            "repeat_e2e_p50_range_ms": ranges}


def prompt_length_decision(blocks: list[dict], stable: bool) -> dict:
    """Spec decision rule: mean paired per-block TTFT P50, highest ISL minus lowest, with the engine direction."""
    cell = {(b["isl"], b["block"]): b for b in blocks}
    order = sorted({b["block"] for b in blocks})
    low_isl, mid_isl, high_isl = ISLS
    ttft = [cell[(high_isl, k)]["ttft_p50_ms"] - cell[(low_isl, k)]["ttft_p50_ms"] for k in order]
    prompt = [cell[(high_isl, k)]["prompt_p50_ms"] - cell[(low_isl, k)]["prompt_p50_ms"] for k in order]
    low, high = paired_bootstrap_interval(ttft)
    engine_change = statistics.fmean(prompt)
    if not stable:
        verdict = "blocked: the stability guard failed, so no causal comparison"
    elif low > 0 and engine_change > 0:
        verdict = "supported: interval above zero and engine prompt time rises too"
    elif high < 0:
        verdict = "contradicted: interval below zero"
    else:
        verdict = "inconclusive: interval includes zero or the engine direction disagrees"
    means = {isl: statistics.fmean(cell[(isl, k)]["ttft_p50_ms"] for k in order) for isl in ISLS}
    return {
        "unit": "whole replay block", "n_units": len(order), "contrast": f"TTFT P50, ISL {high_isl} minus {low_isl}",
        "paired_ttft_p50_differences_ms": ttft, "mean_ms": statistics.fmean(ttft),
        "bootstrap": {"method": "percentile", "statistic": "mean", "confidence": 0.95, "resamples": 10000,
                      "seed": 20261028, "interval_ms": [low, high]},
        "paired_engine_prompt_p50_differences_ms": prompt, "engine_prompt_change_ms": engine_change,
        "verdict": verdict,
        "held_back_line": held_back_line_miss_ms((low_isl, means[low_isl]), (high_isl, means[high_isl]),
                                                 (mid_isl, means[mid_isl])),
    }


def pooled_by_isl(run: dict) -> list[dict]:
    rows = []
    for isl in ISLS:
        records = measured_replay(run, isl)
        done = [r for r in records if r["complete"]]
        ttft = raw_quantiles([ms_between(r, "first_content_ns") for r in done])
        e2e = raw_quantiles([ms_between(r, "protocol_complete_ns") for r in done])
        durations = [locust_duration_ms(r) for r in records]
        rows.append({
            "isl": isl, "n": len(records), "n_complete": len(done), "ttft_ms": ttft, "e2e_ms": e2e,
            "ttft_p95_within_budget": ttft["p95"] <= BUDGET_TTFT_P95_MS,
            "e2e_p95_within_budget": e2e["p95"] <= BUDGET_E2E_P95_MS,
            "locust_convention": {"p50_ms": locust_percentile_ms(durations, 0.5),
                                  "p95_ms": locust_percentile_ms(durations, 0.95),
                                  "p99_ms": locust_percentile_ms(durations, 0.99)},
            "engine_prompt_p50_ms": p50([r["timings"]["prompt_ms"] for r in done]),
            "engine_predicted_p50_ms": p50([r["timings"]["predicted_ms"] for r in done]),
        })
    return rows


def locust_steps(run_dir: Path, run: dict) -> dict:
    """Each step's Locust summary beside the same summary rebuilt from raw records (P4b) and the raw P50."""
    rows = []
    for step in run["steps"]:
        entry = json.loads((run_dir / "client" / f"step_{step['step']:04d}.done.json").read_text())["locust"][0]
        records = run["by_step"][step["step"]]
        durations = [locust_duration_ms(r) for r in records]
        rebuilt = {"num_requests": len(records), "num_failures": sum(not r["complete"] for r in records),
                   "median_ms": locust_median_ms(durations), "p95_ms": locust_percentile_ms(durations, 0.95),
                   "response_times": {str(k): v for k, v in locust_response_times(durations).items()}}
        rows.append({"step": step["step"], "phase": step["phase"], "isl": step["isl"], "control": step["control"],
                     "raw_p50_ms": p50(durations), "locust": {k: entry[k] for k in rebuilt}, "rebuilt": rebuilt,
                     "match": all(entry[k] == rebuilt[k] for k in rebuilt)})
    return {"matched": sum(r["match"] for r in rows), "steps": len(rows), "rows": rows}


def histogram_comparison(run_dir: Path, run: dict) -> dict:
    """Raw exact quantiles beside Prometheus's bucket-interpolated estimates over the same normal-phase requests."""
    path = run_dir / "evidence" / "prometheus" / "histogram_estimates.json"
    if not path.exists():
        return {"unavailable": "this run did not export histogram estimates"}
    done = [r for r in measured_replay(run) if r["complete"]]
    values = {"ttft": [ms_between(r, "first_content_ns") for r in done],
              "e2e": [ms_between(r, "protocol_complete_ns") for r in done]}
    rows = []
    for estimate in json.loads(path.read_text()):
        raw = float(np.quantile(values[estimate["metric"]], estimate["quantile"], method="linear"))
        est = None if estimate["seconds"] is None else estimate["seconds"] * 1e3
        rows.append({"metric": estimate["metric"], "quantile": estimate["quantile"], "raw_ms": raw,
                     "histogram_estimate_ms": est, "estimate_minus_raw_ms": None if est is None else est - raw})
    return {"n": len(done), "phase": "normal (all ISLs pooled)", "rows": rows}


def control_differences(run: dict) -> dict:
    out = {}
    for control, (first, second) in CONTROL_CONTRASTS.items():
        pairs = []
        for pair in range(1, CONTROL_PAIRS + 1):
            def measured(condition):
                return [r for r in run["records"].values()
                        if r.get("control") == control and r.get("pair") == pair and r.get("condition") == condition
                        and r["phase"] != "warmup" and r["complete"]]
            a, b = measured(first), measured(second)
            if not a or not b:
                continue
            pairs.append({
                "pair": pair, "n": [len(a), len(b)],
                "e2e_p50_ms": [p50([ms_between(r, "protocol_complete_ns") for r in x]) for x in (a, b)],
                "ttft_p50_ms": [p50([ms_between(r, "first_content_ns") for r in x]) for x in (a, b)],
            })
            pairs[-1]["e2e_p50_difference_ms"] = pairs[-1]["e2e_p50_ms"][0] - pairs[-1]["e2e_p50_ms"][1]
            pairs[-1]["ttft_p50_difference_ms"] = pairs[-1]["ttft_p50_ms"][0] - pairs[-1]["ttft_p50_ms"][1]
        out[control] = {"contrast": f"{first} minus {second}", "pairs": pairs,
                        "e2e_within_guard": all(abs(p["e2e_p50_difference_ms"]) <= GUARD_MS for p in pairs)}
    return out


def segment_medians(split: dict) -> dict:
    medians = {}
    for path in ("ttft", "e2e"):
        medians[path] = {}
        for isl in ISLS:
            rows = [r for r in split["rows"] if r["phase"] == "normal" and r["control"] is None and r["isl"] == isl]
            names = [s["name"] for s in rows[0][path]]
            medians[path][isl] = {"n": len(rows)} | {
                name: p50([s["ms"] for r in rows for s in r[path] if s["name"] == name]) for name in names}
    return medians


def example_request(run: dict, split: dict) -> dict:
    """Spec Task step 3: one ordinary request's client timeline beside its engine timings and segments."""
    first_step = next(s for s in run["steps"] if s["phase"] == "normal" and s["control"] is None)
    record = run["by_step"][first_step["step"]][0]
    segments = next(r for r in split["rows"] if r["request_id"] == record["request_id"])
    return {"request_id": record["request_id"], "isl": record["isl"], "durations": chat_durations(record),
            "usage": record["usage"], "timings": record["timings"], "ttft_segments": segments["ttft"],
            "e2e_segments": segments["e2e"]}


def print_summary(summary: dict) -> None:
    guard = summary["stability"]
    print(f"\nanalysis {summary['run_id']}")
    print(f"stability: {'PASS' if guard['stable'] else 'FAIL'}  max |half-P50 diff| "
          f"{guard['max_abs_half_p50_difference_ms']} ms, repeat P50 range "
          f"{ {k: round(v, 3) for k, v in guard['repeat_e2e_p50_range_ms'].items()} } ms (guard {GUARD_MS} ms)")
    print(f"{'ISL':>5} {'N':>3} {'TTFT P50':>9} {'P95':>8} {'e2e P50':>9} {'P95':>8} {'Locust P50':>10} "
          f"{'prompt P50':>10}")
    for row in summary["pooled"]:
        print(f"{row['isl']:>5} {row['n']:>3} {row['ttft_ms']['p50']:>9.3f} {row['ttft_ms']['p95']:>8.3f} "
              f"{row['e2e_ms']['p50']:>9.3f} {row['e2e_ms']['p95']:>8.3f} {row['locust_convention']['p50_ms']:>10} "
              f"{row['engine_prompt_p50_ms']:>10.3f}")
    decision = summary["decision"]
    low, high = decision["bootstrap"]["interval_ms"]
    print(f"decision: {decision['contrast']} mean {decision['mean_ms']:.3f} ms, 95% [{low:.3f}, {high:.3f}] "
          f"(N={decision['n_units']} blocks); engine prompt change {decision['engine_prompt_change_ms']:.3f} ms")
    print(f"  -> {decision['verdict']}")
    line = decision["held_back_line"]
    print(f"held-back ISL {ISLS[1]}: predicted {line['predicted_ms']:.3f}, observed {line['observed_ms']:.3f}, "
          f"miss {line['miss_ms']:.3f} ms")
    locust = summary["locust_steps"]
    print(f"Locust reconstruction: {locust['matched']}/{locust['steps']} steps match exactly")
    for row in summary["histogram"].get("rows", []):
        print(f"histogram {row['metric']} P{round(row['quantile'] * 100)}: raw {row['raw_ms']:.3f}, "
              f"estimate {row['histogram_estimate_ms']}, difference {row['estimate_minus_raw_ms']}")
    for control, result in summary["controls"].items():
        diffs = [round(p["e2e_p50_difference_ms"], 3) for p in result["pairs"]]
        print(f"control {control} ({result['contrast']}) e2e P50 differences: {diffs} ms")
    print(f"log offset half-width: {summary['segments']['offset_half_width_ms']:.6f} ms")


def analyze(run_dir: Path) -> dict:
    run = load_run(run_dir)
    analysis = run_dir / "analysis"
    analysis.mkdir(exist_ok=True)
    split = split_server_start(run_dir, run["run_id"], 0)
    save_json(analysis / "split_s0.json", split)
    blocks = replay_blocks(run)
    guard = stability(blocks)
    summary = {
        "run_id": run["run_id"],
        "replay_blocks": blocks,
        "stability": guard,
        "decision": prompt_length_decision(blocks, guard["stable"]),
        "pooled": pooled_by_isl(run),
        "locust_steps": locust_steps(run_dir, run),
        "histogram": histogram_comparison(run_dir, run),
        "controls": control_differences(run),
        "segments": {"offset_half_width_ms": split["offset_half_width_ms"], "medians": segment_medians(split)},
        "example_request": example_request(run, split),
    }
    save_json(analysis / "summary.json", summary)
    print_summary(summary)
    return summary


def main():
    run_id = new_run_id()
    stack = Stack(run_id, prepare_run_dir(run_id))
    evidence = stack.run_dir / "evidence"
    evidence.mkdir()
    machine = evidence / "machine"
    machine.mkdir()
    print(f"run {run_id} -> {stack.run_dir}")

    host_identity(evidence)
    host_snapshot(evidence, "before")
    started = time.time()
    try:
        stack.compose("up", "-d", "--build", "--wait")
        print_urls(stack)
        run_diagnostic_audit(stack)
        run_replay(stack)
        checkpoint(stack, evidence, "after_replay")
        run_diagnostic_control(stack, machine)
        run_observer_control(stack, evidence, machine)
        run_logging_control(stack, machine)
        prom = stack.url("prometheus", 9090)
        run_failure_test(stack, evidence, prom)
        checkpoint(stack, evidence, "final")
        ended = time.time()
        save_json(evidence / "run_window.json", {"start_unix": started, "end_unix": ended})
        host_snapshot(evidence, "after")
        container_snapshot(stack, evidence)
        save_json(evidence / "server_props.json", get_json(stack.url("server", 8080), "/props"))
        export_prometheus(prom, evidence, started, ended)
        export_histogram_estimates(prom, evidence)
        export_grafana(stack, evidence)
    finally:
        save_json(evidence / "steps.json", stack.steps)
        try:
            save_logs(stack, evidence)
        finally:
            stack.compose("down")
    check_cleanup(evidence)
    analyze(stack.run_dir)
    print(f"next: uv run python {REP_DIR / 'audit.py'} {run_id}")
    print(f"then: I01L2_RUN_ID={run_id} uv run pytest {REP_DIR / 'test_i01_l2.py'}")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--analyze":
        analyze(REP_DIR / "results" / sys.argv[2])
    else:
        main()
