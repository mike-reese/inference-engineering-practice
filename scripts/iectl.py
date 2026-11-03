"""iectl: the control CLI for the practice stack. Every command prints one JSON document.

Agents and the Makefile call it; the debugger reads what it writes.

    uv run --no-sync python scripts/iectl.py --help
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MODEL_DIR = Path.home() / (".local/share/inference-engineering/models/Qwen2.5-0.5B-Instruct/"
                           "7ae557604adf67be50417f59c2c2f167def9a775")
MODEL_FILES = {"config.json", "model.safetensors", "tokenizer.json", "tokenizer_config.json"}
IMAGES = ("ie-tensorrt-llm:1.2.1-nvml-byref", "ie-capture:alpine3.20", "ie-client:i01-l2")
PROJECT_PREFIX = "ie-"
GPU_QUERY = "name,compute_cap,driver_version,memory.used,memory.total,temperature.gpu"
EXPECTED_COMPUTE_CAP = "12.0"
DEVTOOLS = os.environ.get("DEVTOOLS_URL", "http://127.0.0.1:7700")
REPO = Path(__file__).resolve().parents[1]

def run(*cmd: str) -> subprocess.CompletedProcess:
    """Run a command and capture it; a missing program becomes exit code 127 instead of an exception."""
    try:
        return subprocess.run(cmd, text=True, capture_output=True)
    except FileNotFoundError as exc:
        return subprocess.CompletedProcess(cmd, 127, "", str(exc))


def result(name: str, ok: bool, value, fix: str) -> dict:
    """One check: what was found, and what to do when it is wrong."""
    return {"check": name, "ok": ok, "value": value, "fix": None if ok else fix}

def check_gpu() -> dict:
    out = run("nvidia-smi", f"--query-gpu={GPU_QUERY}", "--format=csv,noheader,nounits")
    if out.returncode != 0:
        return result("gpu", False, out.stderr.strip(), "nvidia-smi failed: check the NVIDIA driver is loaded")
    gpu = dict(zip(GPU_QUERY.split(","), out.stdout.strip().split(", ")))
    return result("gpu", gpu["compute_cap"] == EXPECTED_COMPUTE_CAP, gpu,
                  f"expected compute capability {EXPECTED_COMPUTE_CAP} (RTX 5060 Ti): the spec's known results need it")


def check_docker() -> dict:
    out = run("docker", "version", "--format", "{{.Server.Version}}")
    return result("docker", out.returncode == 0, (out.stdout or out.stderr).strip(),
                  "the Docker daemon did not answer: start it (systemctl start docker) and rerun doctor")


def check_images() -> dict:
    found = {}
    for image in IMAGES:
        out = run("docker", "image", "inspect", image, "--format", "{{.Id}}")
        found[image] = out.stdout.strip() if out.returncode == 0 else None
    missing = [image for image, image_id in found.items() if image_id is None]
    return result("images", not missing, found, f"missing {missing}: run `make images`")


def check_model() -> dict:
    present = {path.name for path in MODEL_DIR.iterdir()} if MODEL_DIR.is_dir() else set()
    missing = sorted(MODEL_FILES - present)
    return result("model", not missing, {"dir": str(MODEL_DIR), "missing": missing},
                  "model files missing: the engine and the offline tokenizer both read this directory")


def check_leftovers() -> dict:
    out = run("docker", "ps", "-a", "--filter", "label=com.docker.compose.project",
              "--format", '{{.Label "com.docker.compose.project"}} {{.Names}} {{.State}}')
    rows = [line.split() for line in out.stdout.splitlines()]
    ours = [{"project": p, "container": c, "state": s} for p, c, s in rows if p.startswith(PROJECT_PREFIX)]
    return result("leftover_stacks", out.returncode == 0 and not ours, ours,
                  "a stack from an earlier run is still there: stop it before starting another "
                  "(docker compose -p <project> down); one GPU serves one engine")


def check_gpu_processes() -> dict:
    """Informational: other compute processes share the GPU and its memory."""
    out = run("nvidia-smi", "--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits")
    apps = []
    for line in out.stdout.splitlines():
        pid, rest = line.split(", ", 1)
        command, used_mib = rest.rsplit(", ", 1)
        apps.append({"pid": int(pid), "program": Path(command.split()[0]).name, "used_mib": int(used_mib)})
    return result("gpu_processes", True, apps, "")


def cmd_doctor(args: argparse.Namespace) -> int:
    checks = [check_gpu(), check_docker(), check_images(), check_model(), check_leftovers(), check_gpu_processes()]
    ok = all(c["ok"] for c in checks)
    print(json.dumps({"command": "doctor", "ok": ok, "checks": checks}, indent=2))
    return 0 if ok else 1


# --- devtools queries: the same backend the browser reads -------------------------------------------------------

class DevtoolsDown(Exception):
    pass


def api(path: str, **params):
    query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    url = f"{DEVTOOLS}{path}" + (f"?{query}" if query else "")
    try:
        with urllib.request.urlopen(url, timeout=120) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise DevtoolsDown(f"{url}: HTTP {error.code} {error.read().decode()[:300]}")
    except (urllib.error.URLError, ConnectionError) as error:
        raise DevtoolsDown(f"{url}: {error}; start it with `make devtools`")


def emit(command: str, data, ok: bool = True) -> int:
    print(json.dumps({"command": command, "ok": ok, "data": data}, indent=2, default=str))
    return 0 if ok else 1


def cmd_status(args) -> int:
    snap = api("/api/snapshot", topics="containers,gpu,gpu_processes,engine_info")["state"]
    containers = [{k: c[k] for k in ("project", "service", "name", "state", "health", "ports")}
                  for c in snap.get("containers", [])]
    return emit("status", {"containers": containers, "gpu": snap.get("gpu"), "gpu_processes": snap.get("gpu_processes"),
                           "engines": list((snap.get("engine_info") or {}).values())})


def cmd_logs(args) -> int:
    lines = api("/api/logs", container=args.container, grep=args.grep, tail=args.tail)
    if args.phase is not None:
        lines = api("/api/lifecycle/lines", container=args.container, index=args.phase)
    if args.text:
        for line in lines:
            print(f"{line['stream'][:3]} {line['line']}")
        return 0
    return emit("logs", lines)


def phases(life: dict) -> list[dict]:
    marks = life["marks"]
    out = []
    for i, m in enumerate(marks):
        end = marks[i + 1]["ns"] if i + 1 < len(marks) else None
        out.append({"index": i, "phase": m["phase"], "starts_s": (m["ns"] - marks[0]["ns"]) / 1e9,
                    "takes_s": (end - m["ns"]) / 1e9 if end else None, "values": m["values"], "line": m["line"][:200]})
    return out


def cmd_lifecycle(args) -> int:
    lives = sorted(api("/api/lifecycle"), key=lambda life: life["started_at"], reverse=True)
    if args.container:
        lives = [life for life in lives if args.container in (life["id"], life["name"], f"{life['project']}/{life['service']}")
                 or life["id"].startswith(args.container)]
    return emit("lifecycle", [{"container": life["name"], "id": life["id"], "phases": phases(life)}
                              for life in lives[: args.last]])


def cmd_events(args) -> int:
    return emit("events", api("/api/snapshot", topics="none")["events"][-args.tail:])


def cmd_gpu(args) -> int:
    snap = api("/api/snapshot", topics="gpu,gpu_processes")["state"]
    data = {"now": snap.get("gpu"), "processes": snap.get("gpu_processes")}
    if args.history:
        data["history"] = api("/api/gpu/history")[-args.history:]
    return emit("gpu", data)


def cmd_engine_metrics(args) -> int:
    history = api("/api/engine/history", match=args.match)
    return emit("engine-metrics", {cid: samples[-1] if samples else None for cid, samples in history.items()})


def cmd_wait(args) -> int:
    """Follow the live stream until the container reaches the state; stop at once if it dies (no blind timeout).
    Prints each lifecycle phase as it starts (stderr), then the outcome with the last log lines on failure."""
    url = f"{DEVTOOLS}/api/live?topics=containers,lifecycle,event"
    seen = set()
    deadline = time.monotonic() + args.timeout if args.timeout else None
    try:
        stream = urllib.request.urlopen(url, timeout=30)
    except urllib.error.URLError as error:
        raise DevtoolsDown(f"{url}: {error}; start it with `make devtools`")
    for raw in stream:
        if deadline and time.monotonic() > deadline:
            return emit("wait", {"container": args.container, "reached": False, "why": "timeout"}, ok=False)
        if not raw.startswith(b"data: "):
            continue
        message = json.loads(raw[6:])
        data = message["data"]
        if message["topic"] == "lifecycle" and args.container in (data["container"], data.get("project"), data.get("service")):
            for m in data["marks"]:
                if (data["container"], m["phase"]) not in seen:
                    seen.add((data["container"], m["phase"]))
                    print(f"[{data['container']}] {m['phase']} {m['values'] or ''}", file=sys.stderr)
        if message["topic"] == "containers":
            for c in data:
                if args.container not in (c["name"], f"{c['project']}/{c['service']}"):
                    continue
                if (args.health and c["health"] == args.health) or (args.state and c["state"] == args.state):
                    return emit("wait", {"container": c["name"], "reached": True, "state": c["state"],
                                         "health": c["health"]})
                if c["state"] in ("exited", "dead") and args.state != c["state"]:
                    tail = api("/api/logs", container=c["id"], tail=40)
                    return emit("wait", {"container": c["name"], "reached": False, "state": c["state"],
                                         "last_log_lines": [line["line"] for line in tail]}, ok=False)
    return emit("wait", {"reached": False, "why": "stream ended"}, ok=False)


def cmd_runs(args) -> int:
    runs = sorted(api("/api/runs").values(), key=lambda r: r["mtime"], reverse=True)
    return emit("runs", [{k: r[k] for k in ("run_id", "rep", "labels", "steps", "done", "file_count", "path")}
                         for r in runs[: args.last]])


def cmd_run(args) -> int:
    run = api(f"/api/runs/{args.run}")
    levels = {}
    for s in run["spans"]:
        levels[f"{s['level']}/{s['component']}"] = levels.get(f"{s['level']}/{s['component']}", 0) + 1
    return emit("run", {"run_id": run["run_id"], "labels": run["labels"], "requests": run["requests"],
                        "spans_by_component": levels, "metrics": len(run["metrics"]), "unavailable": run["unavailable"],
                        "profiles": list(run.get("profiles", {})), "sources": [s["file"] for s in run["sources"]]})


def cmd_requests(args) -> int:
    requests = api("/api/requests")
    if args.run:
        requests = {k: v for k, v in requests.items() if v["run_id"] == args.run}
    return emit("requests", list(requests.values()))


def cmd_request(args) -> int:
    return emit("request", api("/api/requests").get(args.request_id))


def cmd_spans(args) -> int:
    return emit("spans", api(f"/api/runs/{args.run}/spans", request=args.request, level=args.level,
                             component=args.component, name=args.name, limit=args.limit))


def cmd_metrics(args) -> int:
    run = api(f"/api/runs/{args.run}")
    metrics = [m for m in run["metrics"] if not args.request or m["request_id"] == args.request]
    return emit("metrics", metrics)


def cmd_raw(args) -> int:
    return emit("raw", api(f"/api/runs/{args.run}/raw", file=args.file, pointer=args.pointer))


def cmd_profile(args) -> int:
    """A traced run of the rep (labeled, not measured). Follow it with `iectl wait` and `iectl lifecycle`."""
    rep = REPO / "reps" / args.rep / "rep.py"
    env = {**os.environ, "TRACE": args.level}
    done = subprocess.run([sys.executable, str(rep), "--trace", args.level], env=env, text=True, capture_output=True)
    runs = sorted(api("/api/runs").values(), key=lambda r: r["mtime"], reverse=True)
    return emit("profile", {"level": args.level, "exit": done.returncode, "stdout_tail": done.stdout[-3000:],
                            "stderr_tail": done.stderr[-3000:], "run": runs[0]["run_id"] if runs else None},
                ok=done.returncode == 0)


def cmd_snapshot(args) -> int:
    """Headless Chromium on a devtools view: screenshot, an expression's value, console errors (CDP)."""
    import asyncio
    import base64
    import tempfile

    import aiohttp

    async def shoot():
        profile = tempfile.mkdtemp()
        port = 9333
        proc = subprocess.Popen(["chromium", "--headless=new", f"--remote-debugging-port={port}",
                                 f"--user-data-dir={profile}", "--disable-extensions", "--window-size=1600,1000",
                                 "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            async with aiohttp.ClientSession() as http:
                for _ in range(100):
                    try:
                        targets = await (await http.get(f"http://127.0.0.1:{port}/json")).json()
                        break
                    except aiohttp.ClientError:
                        await asyncio.sleep(0.1)
                page = next(t for t in targets if t["type"] == "page")
                async with http.ws_connect(page["webSocketDebuggerUrl"], max_msg_size=0) as ws:
                    n, errors = 0, []

                    async def call(method, **params):
                        nonlocal n
                        n += 1
                        mine = n
                        await ws.send_json({"id": mine, "method": method, "params": params})
                        async for msg in ws:
                            data = json.loads(msg.data)
                            if data.get("method") == "Runtime.exceptionThrown":
                                errors.append(data["params"]["exceptionDetails"].get("exception", {}).get("description"))
                            if data.get("method") == "Runtime.consoleAPICalled" and data["params"]["type"] == "error":
                                errors.append(str(data["params"]["args"])[:500])
                            if data.get("id") == mine:
                                return data.get("result")

                    await call("Runtime.enable")
                    await call("Page.enable")
                    await call("Page.navigate", url=f"{DEVTOOLS}/#{args.view}")
                    await asyncio.sleep(args.wait)
                    value = await call("Runtime.evaluate", expression=args.eval, returnByValue=True, awaitPromise=True)
                    shot = await call("Page.captureScreenshot", captureBeyondViewport=True)
                    Path(args.out).write_bytes(base64.b64decode(shot["data"]))
                    return value["result"].get("value"), errors
        finally:
            proc.terminate()

    value, errors = asyncio.run(shoot())
    return emit("snapshot", {"view": args.view, "png": args.out, "value": value, "console_errors": errors},
                ok=not errors)


def cmd_overhead(args) -> int:
    """The devtools' cost on the measurement: the rep's measured request with the devtools down, then up."""
    rep = REPO / "reps" / "I02A-L1_streamed_latency" / "rep.py"
    out = {}
    for mode in ("down", "up"):
        subprocess.run(["make", "-C", str(REPO), f"devtools-{'down' if mode == 'down' else 'up-quiet'}"], check=True,
                       capture_output=True)
        values = []
        for _ in range(args.runs):
            done = subprocess.run([sys.executable, str(rep)], text=True, capture_output=True, check=True)
            run_id = next(Path(line.split()[1]).parent.name for line in done.stdout.splitlines()
                          if line.startswith("run.json: "))
            lat = json.loads((rep.parent / "results" / run_id / "latency.json").read_text())
            measured = lat[f"{run_id}-measured"]
            values.append({"run": run_id, "ttft_ms": measured["client"]["ttft_ms"], "e2e_ms": measured["client"]["e2e_ms"],
                           "mean_itl_ms": measured["client"]["mean_itl_ms"]})
        out[mode] = values
    med = lambda xs: sorted(xs)[len(xs) // 2]  # noqa: E731
    summary = {k: med([v[k] for v in out["up"]]) - med([v[k] for v in out["down"]]) for k in ("ttft_ms", "e2e_ms",
                                                                                                "mean_itl_ms")}
    result = {"runs_per_mode": args.runs, "devtools_down": out["down"], "devtools_up": out["up"],
              "median_up_minus_down": summary}
    (REPO / "devtools" / "overhead.json").write_text(json.dumps(result, indent=2))
    return emit("overhead", result)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="iectl", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True, metavar="COMMAND")
    doctor = commands.add_parser("doctor", help="is the machine ready? GPU, Docker, images, model files, no old stack",
                                 description="Run every readiness check and print them as JSON. Exit 0 when all pass.")
    doctor.set_defaults(func=cmd_doctor)

    def add(name, func, help_text, *arguments):
        sub = commands.add_parser(name, help=help_text, description=help_text)
        for flags, options in arguments:
            sub.add_argument(*flags, **options)
        sub.set_defaults(func=func)

    add("status", cmd_status, "containers, health, ports, the GPU, the engines (devtools)")
    add("logs", cmd_logs, "a container's log (id, name or project/service), kept after it stops",
        (["container"], {}), (["--grep"], {}), (["--tail"], {"type": int}),
        (["--phase"], {"type": int, "help": "only the lines of lifecycle phase N"}), (["--text"], {"action": "store_true"}))
    add("lifecycle", cmd_lifecycle, "engine startup phases with durations and values",
        (["container"], {"nargs": "?"}), (["--last"], {"type": int, "default": 3}))
    add("events", cmd_events, "Docker events, newest last", (["--tail"], {"type": int, "default": 40}))
    add("gpu", cmd_gpu, "the GPU now, who holds its memory, recent samples", (["--history"], {"type": int, "default": 0}))
    add("engine-metrics", cmd_engine_metrics, "each engine's latest Prometheus counters", (["--match"], {"default": ""}))
    add("wait", cmd_wait, "wait on the live stream for a container state; stops at once if it dies, with its last logs",
        (["container"], {"help": "name or project/service"}), (["--health"], {}), (["--state"], {}),
        (["--timeout"], {"type": float, "default": 0}))
    add("runs", cmd_runs, "run folders, newest first", (["--last"], {"type": int, "default": 10}))
    add("run", cmd_run, "one run's summary: requests, spans by component, Unavailable", (["run"], {}))
    add("requests", cmd_requests, "requests as they landed", (["--run"], {}))
    add("request", cmd_request, "one request's summary", (["request_id"], {}))
    add("spans", cmd_spans, "a run's spans, filtered", (["run"], {}), (["--request"], {}), (["--level"], {}),
        (["--component"], {}), (["--name"], {}), (["--limit"], {"type": int, "default": 200}))
    add("metrics", cmd_metrics, "a run's metrics with formulas and input spans", (["run"], {}), (["--request"], {}))
    add("raw", cmd_raw, "the raw source of a span: file and pointer", (["run"], {}), (["file"], {}),
        (["pointer"], {"nargs": "?", "default": ""}))
    add("profile", cmd_profile, "a traced run: timeline (nsys), code (PyTorch ops, stacks), kernels (ncu)",
        (["level"], {"choices": ["timeline", "code", "kernels"]}),
        (["--rep"], {"default": "I02A-L1_streamed_latency"}))
    add("snapshot", cmd_snapshot, "headless render of a view: screenshot, value of --eval, console errors",
        (["view"], {"help": "the URL hash, e.g. trace/<run>"}), (["--out"], {"default": "devtools.png"}),
        (["--eval"], {"default": "document.querySelector('main').innerText.slice(0, 2000)"}),
        (["--wait"], {"type": float, "default": 4.0}))
    add("overhead", cmd_overhead, "the rep's measured request with the devtools down, then up",
        (["--runs"], {"type": int, "default": 2}))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except DevtoolsDown as error:
        return emit(args.command, {"error": str(error)}, ok=False)


if __name__ == "__main__":
    sys.exit(main())
