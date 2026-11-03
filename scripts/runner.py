"""Devtools runner: runs a registered rep's declared commands on the host, one job at a time, for the Run tab.

Why a host process: a rep needs the repo's .venv, `docker compose` with write access and the GPU. The devtools
container has none of these by design (read-only repo and Docker socket), so it proxies /runner/* to this process.

Registration: every reps/*/rep.toml. Only the commands a manifest declares run, from the repo root, with the
manifest's arguments; the browser sends a rep id and an action id, never a command.
Progress: a rep run with `--progress json` prints `@@progress {...}` lines (rep.py `progress()`); the rest of its
output is kept as the job's log.

Start: `make devtools` (or `make runner`). Stop: `make runner-down`; a running job keeps running (own session).
"""
import asyncio
import collections
import json
import os
import subprocess
import sys
import time
import tomllib
from pathlib import Path

from aiohttp import web

REPO = Path(__file__).resolve().parents[1]
HOST = "127.0.0.1"
PORT = int(os.environ.get("RUNNER_PORT", "7701"))
STATE = Path(os.environ.get("RUNNER_STATE", Path.home() / ".local/state/inference-engineering"))
KEEP_LINES = 5000  # per job
PROGRESS = "@@progress "


def manifests() -> dict:
    """Every reps/*/rep.toml, with each action's command resolved ({rep} = the rep folder, relative to the repo)."""
    out = {}
    for path in sorted(REPO.glob("reps/*/rep.toml")):
        folder = str(path.parent.relative_to(REPO))
        try:
            data = tomllib.loads(path.read_text())
        except tomllib.TOMLDecodeError as error:
            out[folder] = {"id": folder, "folder": folder, "error": f"{path.name}: {error}", "actions": []}
            continue
        data["folder"] = folder
        for action in data.get("actions", []):
            action["argv"] = [part.replace("{rep}", folder) for part in action["command"]]
        out[data["id"]] = data
    return out


def busy_projects(projects: list[str]) -> dict:
    """Compose projects of the rep that still have containers (running or not): name -> container names."""
    out = {}
    for project in projects:
        names = subprocess.run(["docker", "ps", "-a", "--filter", f"label=com.docker.compose.project={project}",
                                "--format", "{{.Names}}"], capture_output=True, text=True).stdout.split()
        if names:
            out[project] = names
    return out


class Job:
    def __init__(self, number: int, rep: dict, action: dict):
        self.id = number
        self.rep, self.action = rep["id"], action["id"]
        self.label, self.argv = action["label"], action["argv"]
        self.started_ns, self.ended_ns = time.time_ns(), None
        self.state, self.exit = "running", None
        self.lines = collections.deque(maxlen=KEEP_LINES)
        self.progress, self.run_id = [], None

    def summary(self) -> dict:
        return {"id": self.id, "rep": self.rep, "action": self.action, "label": self.label, "argv": self.argv,
                "started_ns": self.started_ns, "ended_ns": self.ended_ns, "state": self.state, "exit": self.exit,
                "run_id": self.run_id, "step": self.progress[-1]["step"] if self.progress else None}

    def detail(self, tail: int) -> dict:
        return {**self.summary(), "progress": self.progress, "lines": list(self.lines)[-tail:]}


class Runner:
    def __init__(self):
        self.jobs: list[Job] = []

    def current(self) -> Job | None:
        return next((j for j in self.jobs if j.state == "running"), None)

    async def start(self, rep: dict, action: dict) -> Job:
        job = Job(len(self.jobs) + 1, rep, action)
        env = {k: v for k, v in os.environ.items() if k != "TRACE"} | {"PYTHONUNBUFFERED": "1"}
        proc = await asyncio.create_subprocess_exec(*job.argv, cwd=REPO, env=env, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.STDOUT, start_new_session=True)
        self.jobs.append(job)
        asyncio.create_task(self.follow(job, proc))
        return job

    async def follow(self, job: Job, proc: asyncio.subprocess.Process) -> None:
        async for raw in proc.stdout:
            line = raw.decode(errors="replace").rstrip("\n")
            if line.startswith(PROGRESS):
                try:
                    event = json.loads(line[len(PROGRESS):])
                except json.JSONDecodeError:
                    job.lines.append(line)
                    continue
                job.progress.append(event)
                job.run_id = event.get("run_id") or job.run_id
            else:
                job.lines.append(line)
        job.exit = await proc.wait()
        job.ended_ns = time.time_ns()
        job.state = "ok" if job.exit == 0 else "failed"


def find(request: web.Request) -> Job:
    jobs = request.app["runner"].jobs
    number = int(request.match_info["job"])
    if not 1 <= number <= len(jobs):
        raise web.HTTPNotFound(text=f"no job {number}")
    return jobs[number - 1]


async def health(request: web.Request) -> web.Response:
    return web.json_response({"ok": True, "repo": str(REPO), "pid": os.getpid()})


async def reps(request: web.Request) -> web.Response:
    data = await asyncio.to_thread(manifests)
    for rep in data.values():
        rep["busy"] = await asyncio.to_thread(busy_projects, rep.get("compose_projects", []))
    current = request.app["runner"].current()
    return web.json_response({"reps": list(data.values()), "running": current.summary() if current else None})


async def jobs(request: web.Request) -> web.Response:
    return web.json_response([j.summary() for j in reversed(request.app["runner"].jobs)])


async def job(request: web.Request) -> web.Response:
    return web.json_response(find(request).detail(int(request.query.get("tail", 400))))


async def start(request: web.Request) -> web.Response:
    body = await request.json()
    runner = request.app["runner"]
    rep = (await asyncio.to_thread(manifests)).get(body.get("rep"))
    action = next((a for a in (rep or {}).get("actions", []) if a["id"] == body.get("action")), None)
    if not action:
        raise web.HTTPNotFound(text=f"no action {body.get('action')!r} in rep {body.get('rep')!r}")
    if (current := runner.current()) is not None:
        raise web.HTTPConflict(text=f"job {current.id} ({current.rep} {current.label}) is still running")
    busy = await asyncio.to_thread(busy_projects, rep.get("compose_projects", []))
    if busy:
        raise web.HTTPConflict(text="containers of this rep exist already (a run from the terminal, or a stack left "
                                    f"up): {json.dumps(busy)}. Wait for it, or `docker compose -p <project> down`.")
    return web.json_response((await runner.start(rep, action)).summary(), status=201)


def make_app() -> web.Application:
    app = web.Application()
    app["runner"] = Runner()
    r = app.router
    r.add_get("/runner/health", health)
    r.add_get("/runner/reps", reps)
    r.add_get("/runner/jobs", jobs)
    r.add_post("/runner/jobs", start)
    r.add_get("/runner/jobs/{job}", job)
    return app


if __name__ == "__main__":
    STATE.mkdir(parents=True, exist_ok=True)
    (STATE / "runner.pid").write_text(str(os.getpid()))
    print(f"runner: http://{HOST}:{PORT}/runner/reps · repo {REPO} · python {sys.executable}", flush=True)
    web.run_app(make_app(), host=HOST, port=PORT, print=None)
