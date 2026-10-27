import shlex
import sys
import subprocess
from pathlib import Path
import httpx
import time
import argparse



DEFAULT_IMAGE = "telos-llama:b6500-firstfit-cuda12.4-sm61-nsys2023.4.4"
DEFAULT_GGUF = (
    Path.home()
    / ".local/share/telos-models/qwen2.5-0.5b-instruct-f32"
    / "Qwen2.5-0.5B-Instruct-f32.gguf"
)
CONTAINER_PORT = 8080
DOCKER_TIMEOUT_S = 30.0
READY_TIMEOUT_S = 30.0
POLL_INTERVAL_S = 0.1
REQUEST_TIMEOUT_S = 1.0
STOP_TIMEOUT_S = 15.0

class ServerError(RuntimeError):
    """The server could not be started, reached or stopped."""

def build_run_args(
    name: str,
    server_flags: list[str],
    image: str = DEFAULT_IMAGE,
    gguf_path: Path = DEFAULT_GGUF,
) -> list[str]:
    """Return the `docker run` command that starts llama-server in a container.

    The GGUF's folder is mounted read-only at /models. Container port 8080 is
    published on 127.0.0.1, and Docker assigns the host port.
    """
    gguf_path = gguf_path.resolve()
    return [
        "docker", "run",
        "-d",
        "--rm",
        "--name", name,
        "--gpus", "all",
        "--device", "/dev/nvidia-uvm",
        "--device", "/dev/nvidia-uvm-tools",
        "-v", f"{gguf_path.parent}:/models:ro",
        "-p", f"127.0.0.1::{CONTAINER_PORT}",
        image,
        "-m", f"/models/{gguf_path.name}",
        "--host", "0.0.0.0",
        "--port", str(CONTAINER_PORT),
        *server_flags,
    ]

def run(cmd: list[str], timeout: float = DOCKER_TIMEOUT_S) -> subprocess.CompletedProcess[str]:
    """Run one command; return its exit code and its output as text.

    Does not raise on a non-zero exit code: the caller reads .returncode.
    Raises subprocess.TimeoutExpired if the command runs longer than `timeout` seconds.
    """
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)

def assigned_port(name: str) -> int:
    """Return the host port Docker assigned to the container's port 8080."""
    r = run(["docker", "port", name, str(CONTAINER_PORT)])
    if r.returncode != 0:
        raise ServerError(f"docker port {name} failed: {r.stderr.strip()}")
    first_line = r.stdout.strip().splitlines()[0]
    return int(first_line.rsplit(":", 1)[1])

def is_running(name: str) -> bool:
    """True while the container exists and its process is running."""
    r = run(["docker", "inspect", "--format", "{{.State.Running}}", name])
    return r.returncode == 0 and r.stdout.strip() == "true"

def last_logs(name: str, lines: int = 20) -> str:
    """The container's last `lines` log lines, or why there are none"""
    r = run(["docker", "logs", "--tail", str(lines), name])
    if r.returncode != 0:
        return f"(no logs: {r.stderr.strip()})"
    return (r.stdout + r.stderr).strip()

def wait_ready(name: str, base_url: str, timeout: float = READY_TIMEOUT_S) -> float:
    """Poll GET /health until it returns 200; return the seconds waited.

    Raises ServerError if the container stops first, or if `timeout` seconds pass.
    """
    started = time.monotonic()
    deadline = started + timeout
    last = "no attempt yet"

    while time.monotonic() < deadline:
        if not is_running(name):
            raise ServerError(
                f"container {name} stopped before it was ready (last: {last})\n{last_logs(name)}"
            )
        try:
            resp = httpx.get(f"{base_url}/health", timeout=REQUEST_TIMEOUT_S)
        except httpx.TransportError as e:
            last = type(e).__name__
        else:
            if resp.status_code == 200:
                return time.monotonic() - started
            last = f"HTTP {resp.status_code}"
        time.sleep(POLL_INTERVAL_S)
    raise ServerError(f"{name} not ready after {timeout:.0f}s (last: {last})\n{last_logs(name)}")

def start(
    name: str,
    server_flags: list[str],
    image: str = DEFAULT_IMAGE,
    gguf_path: Path = DEFAULT_GGUF,
    ready_timeout: float = READY_TIMEOUT_S,
) -> str:
    """Start the server container, wait until it is ready, and return its base URL."""
    
    if not gguf_path.is_file():
        raise ServerError(f"GGUF not found: {gguf_path}")

    cmd = build_run_args(name, server_flags, image, gguf_path)
    print("+", shlex.join(cmd), file=sys.stderr)
    r = run(cmd)
    if r.returncode != 0:
        raise ServerError(f"docker run failed (exit {r.returncode}): {r.stderr.strip()}")
    try:
        base_url = f"http://127.0.0.1:{assigned_port(name)}"
        waited = wait_ready(name, base_url, ready_timeout)
    except ServerError:
        stop(name)
        raise
    print(f"ready after {waited:.2f} s at {base_url}", file=sys.stderr)
    return base_url

def exists(name: str) -> bool:
    r = run(["docker", "ps", "-aq", "--filter", f"name=^{name}$"])
    return r.stdout.strip() != ""

def stop(name: str, timeout: float = STOP_TIMEOUT_S) -> None:
    """Stop the container and wait until it is removed. Succeeds if it is already gone."""
    started = time.monotonic()
    if not exists(name):
        print(f"{name} already gone", file=sys.stderr)
        return
    r = run(["docker", "stop", name])
    deadline = time.monotonic() + timeout
    while exists(name):
        if time.monotonic() >= deadline:
            raise ServerError(
                f"{name} still present {timeout:.0f} s after docker stop"
                f" (exit {r.returncode}: {r.stderr.strip()})"
            )
        time.sleep(POLL_INTERVAL_S)
    print(f"stopped {name} in {time.monotonic() - started:.2f} s", file=sys.stderr)

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Start or stop a llama.cpp server container.")
    sub = parser.add_subparsers(dest="command", required=True)

    p_start = sub.add_parser("start", help="start the server; print its base URL on stdout")
    p_start.add_argument("name", help="container name")
    p_start.add_argument("server_flags", nargs="*", help="llama-server flags, after --")
    p_start.add_argument("--image", default=DEFAULT_IMAGE)
    p_start.add_argument("--gguf", type=Path, default=DEFAULT_GGUF)
    p_start.add_argument("--ready-timeout", type=float, default=READY_TIMEOUT_S)

    p_stop = sub.add_parser("stop", help="stop the server; succeed if it is already gone")
    p_stop.add_argument("name", help="container name")
    p_stop.add_argument("--timeout", type=float, default=STOP_TIMEOUT_S)

    args = parser.parse_args(argv)

    try:
        if args.command == "start":
            print(start(args.name, args.server_flags, args.image, args.gguf, args.ready_timeout))
        else:
            stop(args.name, args.timeout)
    except ServerError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0          

if __name__ == "__main__":
    sys.exit(main())
