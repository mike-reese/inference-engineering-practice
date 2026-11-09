"""Devtools runner: runs a registered rep's declared commands on the host, one job at a time, for the Run tab.

Why a host process: a rep needs the repo's .venv, `docker compose` with write access and the GPU. The devtools
container has none of these by design (read-only repo and Docker socket), so it proxies /runner/* to this process.

Registration: every reps/*/rep.toml. Only the commands a manifest declares run, from the repo root, with the
manifest's arguments; the browser sends a rep id and an action id, never a command.
Progress: a rep run with `--progress json` prints `@@progress {...}` lines (rep.py `progress()`); the rest of its
output is kept as the job's log.

Dry run: POST /runner/jobs with "dry_run": true validates the action and options and returns the job it would queue;
nothing is queued, saved or started. /runner/health says "dry_run": true, so a client can refuse an older runner.

Options: an action's [[actions.options]] are the only values the browser may set. Each value must be one of the
option's `choices` or fully match its `pattern` (at most 32 characters); the runner appends `arg value` to the command.
Queue: jobs run one at a time in the order they were sent. A queued job waits while its rep's Compose projects have
containers. Cancel: a queued job is dropped; a running one gets SIGINT (rep.py's `finally` takes its stack down),
then SIGTERM, then SIGKILL, then `docker compose -p <project> down` for any project of the rep still up.
History: every job is saved to STATE/jobs/<id>.json (summary, steps, last lines) and read back when the runner starts;
a job that was queued or running when the runner stopped is marked lost.

Register: GET /runner/unregistered lists reps/* folders with .py files and no rep.toml; POST /runner/register writes
a rep.toml for one of them. It never overwrites a manifest, and every command it writes runs a .py file of that
folder (pytest for test_*.py) with arguments from a safe character set.

Desktop tools: POST /runner/open {"run": <run id>, "path": <file in the run>} opens a run's Nsight report in
nsys-ui or ncu-ui on this display. Only .nsys-rep and .ncu-rep files inside reps/*/results/<run id>/ open.

Start: `make devtools` (or `make runner`). Stop: `make runner-down`; a running job keeps running (own session).
"""
import asyncio
import collections
import json
import os
import re
import signal
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
KEEP_LINES = 5000  # per job, in memory
SAVE_LINES = 400  # per job, in its history file
OPTION_MAX = 32  # characters in one option value
CANCEL_WAIT = (90, 20)  # seconds after SIGINT, then after SIGTERM, before the next signal
BUSY_RETRY = 5  # seconds between container checks for a queued job
PROGRESS = "@@progress "
VIEWERS = {".nsys-rep": "nsys-ui", ".ncu-rep": "ncu-ui"}  # report suffix -> desktop tool


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


def resolve_options(action: dict, given: dict) -> tuple[dict, list[str]]:
    """The action's option values (the default where none is given) and the arguments they add, or ValueError."""
    specs = {o["id"]: o for o in action.get("options", [])}
    if unknown := sorted(set(given) - set(specs)):
        raise ValueError(f"action {action['id']!r} has no option {', '.join(unknown)}")
    values, args = {}, []
    for option in specs.values():
        value = str(given.get(option["id"], option["default"]))
        if len(value) > OPTION_MAX:
            raise ValueError(f"{option['id']}: at most {OPTION_MAX} characters")
        if "choices" in option and value not in option["choices"]:
            raise ValueError(f"{option['id']}: {value!r} is not one of {', '.join(option['choices'])}")
        if "pattern" in option and not re.fullmatch(option["pattern"], value):
            raise ValueError(f"{option['id']}: {value!r} does not match {option['pattern']}")
        values[option["id"]] = value
        args += [option["arg"], value]
    return values, args


class Job:
    def __init__(self, number: int, rep: dict, action: dict, options: dict, args: list[str]):
        self.id = number
        self.rep, self.action = rep["id"], action["id"]
        self.projects = rep.get("compose_projects", [])
        self.label, self.argv, self.options = action["label"], action["argv"] + args, options
        self.queued_ns, self.started_ns, self.ended_ns = time.time_ns(), None, None
        self.state, self.exit, self.note = "queued", None, None
        self.lines = collections.deque(maxlen=KEEP_LINES)
        self.progress, self.run_id = [], None
        self.proc: asyncio.subprocess.Process | None = None
        self.cancelled = False

    @classmethod
    def restore(cls, record: dict) -> "Job":
        job = cls.__new__(cls)
        job.id, job.rep, job.action, job.label = record["id"], record["rep"], record["action"], record["label"]
        job.projects, job.argv, job.options = record.get("projects", []), record["argv"], record.get("options", {})
        job.queued_ns, job.started_ns = record.get("queued_ns"), record.get("started_ns")
        job.ended_ns, job.state, job.exit = record.get("ended_ns"), record["state"], record.get("exit")
        job.note, job.run_id, job.progress = record.get("note"), record.get("run_id"), record.get("progress", [])
        job.lines = collections.deque(record.get("lines", []), maxlen=KEEP_LINES)
        job.proc, job.cancelled = None, False
        if job.state in ("queued", "running"):
            job.state, job.note = "lost", f"the runner stopped while this job was {job.state}"
        return job

    def summary(self) -> dict:
        return {"id": self.id, "rep": self.rep, "action": self.action, "label": self.label, "argv": self.argv,
                "options": self.options, "projects": self.projects, "queued_ns": self.queued_ns,
                "started_ns": self.started_ns, "ended_ns": self.ended_ns, "state": self.state, "exit": self.exit,
                "note": self.note, "run_id": self.run_id,
                "step": self.progress[-1]["step"] if self.progress else None}

    def detail(self, tail: int) -> dict:
        return {**self.summary(), "progress": self.progress, "lines": list(self.lines)[-tail:]}

    def save(self) -> None:
        """Write this job's history file (atomically: a reader never sees half a file)."""
        folder = STATE / "jobs"
        folder.mkdir(parents=True, exist_ok=True)
        part = folder / f"{self.id}.json.part"
        part.write_text(json.dumps(self.detail(SAVE_LINES)))
        part.replace(folder / f"{self.id}.json")


class Runner:
    def __init__(self):
        self.jobs: dict[int, Job] = {}
        self.wake = asyncio.Event()
        for path in (STATE / "jobs").glob("*.json"):
            try:
                job = Job.restore(json.loads(path.read_text()))
            except (json.JSONDecodeError, KeyError) as error:
                print(f"runner: skipping {path}: {error}", flush=True)
                continue
            self.jobs[job.id] = job
            if job.state == "lost" and job.note and job.ended_ns is None:
                job.ended_ns = job.started_ns or job.queued_ns
                job.save()

    def current(self) -> Job | None:
        return next((j for j in self.jobs.values() if j.state == "running"), None)

    def queued(self) -> list[Job]:
        return sorted((j for j in self.jobs.values() if j.state == "queued"), key=lambda j: j.id)

    def add(self, rep: dict, action: dict, options: dict, args: list[str]) -> Job:
        job = Job(max(self.jobs, default=0) + 1, rep, action, options, args)
        self.jobs[job.id] = job
        job.save()
        self.wake.set()
        return job

    async def schedule(self) -> None:
        """Start the oldest queued job whenever no job runs and its rep's containers are gone."""
        while True:
            queue = self.queued()
            if not queue or self.current():
                self.wake.clear()
                await self.wake.wait()
                continue
            job = queue[0]
            busy = await asyncio.to_thread(busy_projects, job.projects)
            if job.state != "queued":  # cancelled during the check
                continue
            if busy:
                note = f"waiting for containers to go: {json.dumps(busy)}"
                if note != job.note:
                    job.note = note
                    job.save()
                self.wake.clear()
                try:
                    await asyncio.wait_for(self.wake.wait(), BUSY_RETRY)
                except TimeoutError:
                    pass
                continue
            await self.launch(job)

    async def launch(self, job: Job) -> None:
        env = {k: v for k, v in os.environ.items() if k != "TRACE"} | {"PYTHONUNBUFFERED": "1"}
        job.started_ns = time.time_ns()
        try:
            job.proc = await asyncio.create_subprocess_exec(
                *job.argv, cwd=REPO, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                start_new_session=True)
        except OSError as error:
            job.state, job.note, job.ended_ns = "failed", f"could not start: {error}", time.time_ns()
            job.save()
            return
        job.state, job.note = "running", None  # only now: cancel needs the process
        job.save()
        if job.cancelled:  # cancelled while the process was starting
            asyncio.create_task(self.stop(job))
        asyncio.create_task(self.follow(job))

    async def follow(self, job: Job) -> None:
        async for raw in job.proc.stdout:
            line = raw.decode(errors="replace").rstrip("\n")
            if line.startswith(PROGRESS):
                try:
                    event = json.loads(line[len(PROGRESS):])
                except json.JSONDecodeError:
                    job.lines.append(line)
                    continue
                job.progress.append(event)
                job.run_id = event.get("run_id") or job.run_id
                job.save()
            else:
                job.lines.append(line)
        job.exit = await job.proc.wait()
        job.ended_ns = time.time_ns()
        job.state = "cancelled" if job.cancelled else "ok" if job.exit == 0 else "failed"
        job.save()
        self.wake.set()

    def cancel(self, job: Job) -> None:
        if job.state == "queued":
            job.state, job.cancelled, job.ended_ns, job.note = "cancelled", True, time.time_ns(), "cancelled while queued"
            job.save()
            self.wake.set()
        elif job.state == "running":
            if not job.cancelled:
                job.cancelled = True
                asyncio.create_task(self.stop(job))
        else:
            raise web.HTTPConflict(text=f"job {job.id} is {job.state}")

    async def stop(self, job: Job) -> None:
        """SIGINT the job's process group, then SIGTERM, then SIGKILL; then take down what it left up."""
        for sig, wait in ((signal.SIGINT, CANCEL_WAIT[0]), (signal.SIGTERM, CANCEL_WAIT[1]), (signal.SIGKILL, None)):
            job.note = f"cancelling: sent {sig.name}" + (f", waiting up to {wait} s" if wait else "")
            job.save()
            try:
                os.killpg(job.proc.pid, sig)
            except ProcessLookupError:
                break
            try:
                await asyncio.wait_for(job.proc.wait(), wait)
                break
            except TimeoutError:
                continue
        await job.proc.wait()
        busy = await asyncio.to_thread(busy_projects, job.projects)
        for project in busy:
            job.note = f"cancelled; taking down {project}"
            job.save()
            down = await asyncio.create_subprocess_exec("docker", "compose", "-p", project, "down",
                                                        stdout=asyncio.subprocess.PIPE,
                                                        stderr=asyncio.subprocess.STDOUT)
            out, _ = await down.communicate()
            job.lines.extend(f"[runner] {line}" for line in out.decode(errors="replace").splitlines())
        job.note = "cancelled" + (f"; took down {', '.join(busy)}" if busy else "")
        job.save()
        self.wake.set()


def find(request: web.Request) -> Job:
    try:
        return request.app["runner"].jobs[int(request.match_info["job"])]
    except (KeyError, ValueError):
        raise web.HTTPNotFound(text=f"no job {request.match_info['job']}")


async def health(request: web.Request) -> web.Response:
    return web.json_response({"ok": True, "repo": str(REPO), "pid": os.getpid(), "dry_run": True})


async def reps(request: web.Request) -> web.Response:
    data = await asyncio.to_thread(manifests)
    for rep in data.values():
        rep["busy"] = await asyncio.to_thread(busy_projects, rep.get("compose_projects", []))
    runner = request.app["runner"]
    current = runner.current()
    return web.json_response({"reps": list(data.values()), "running": current.summary() if current else None,
                              "queued": [j.summary() for j in runner.queued()]})


async def jobs(request: web.Request) -> web.Response:
    limit = int(request.query.get("limit", 100))
    listed = sorted(request.app["runner"].jobs.values(), key=lambda j: j.id, reverse=True)[:limit]
    return web.json_response([j.summary() for j in listed])


async def job(request: web.Request) -> web.Response:
    return web.json_response(find(request).detail(int(request.query.get("tail", 400))))


async def start(request: web.Request) -> web.Response:
    """Queue a job: {"rep": <id>, "action": <id>, "options": {<option id>: <value>}, "dry_run": false}.
    dry_run: validate the action and options and return the job; nothing is queued, saved or started."""
    body = await request.json()
    runner = request.app["runner"]
    rep = (await asyncio.to_thread(manifests)).get(body.get("rep"))
    action = next((a for a in (rep or {}).get("actions", []) if a["id"] == body.get("action")), None)
    if not action:
        raise web.HTTPNotFound(text=f"no action {body.get('action')!r} in rep {body.get('rep')!r}")
    given = body.get("options") or {}
    if not isinstance(given, dict):
        raise web.HTTPBadRequest(text="options must be an object of option id -> value")
    try:
        options, args = resolve_options(action, given)
    except ValueError as error:
        raise web.HTTPBadRequest(text=str(error))
    if body.get("dry_run"):
        job = Job(None, rep, action, options, args)
        job.queued_ns, job.state = None, "dry run"
        return web.json_response({**job.summary(), "dry_run": True})
    if runner.current() is None and not runner.queued():
        busy = await asyncio.to_thread(busy_projects, rep.get("compose_projects", []))
        if busy:
            raise web.HTTPConflict(text="containers of this rep exist already (a run from the terminal, or a stack "
                                        f"left up): {json.dumps(busy)}. Wait for it, or `docker compose -p <project> "
                                        "down`.")
    job = runner.add(rep, action, options, args)
    await asyncio.sleep(0.2)  # let the scheduler start it when nothing else runs
    return web.json_response(job.summary(), status=201)


async def cancel(request: web.Request) -> web.Response:
    job = find(request)
    request.app["runner"].cancel(job)
    return web.json_response(job.summary(), status=202)


SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,39}")
SAFE_ARG = re.compile(r"[A-Za-z0-9_.,=:+-][A-Za-z0-9_.,=:/+-]{0,63}")
SAFE_PROJECT = re.compile(r"[a-z0-9][a-z0-9_-]{0,62}")  # docker compose project names


def unregistered() -> list[dict]:
    """reps/* folders with .py files and no rep.toml: what the Register form can offer."""
    out = []
    for folder in sorted(p for p in (REPO / "reps").iterdir() if p.is_dir()):
        scripts = sorted(p.name for p in folder.glob("*.py") if p.name != "__init__.py")
        if scripts and not (folder / "rep.toml").exists():
            out.append({"folder": str(folder.relative_to(REPO)), "scripts": scripts})
    return out


def toml_string(value: str) -> str:
    return json.dumps(value)  # a JSON string is a valid TOML basic string (same escapes)


def manifest_text(body: dict) -> tuple[Path, str]:
    """Check a Register request and render its rep.toml, or ValueError naming the first problem."""
    offered = {u["folder"]: u["scripts"] for u in unregistered()}
    folder = str(body.get("folder", ""))
    if folder not in offered:
        raise ValueError(f"{folder!r} is not a reps/* folder with .py files and no rep.toml")
    rep_id = str(body.get("id", ""))
    if not SAFE_ID.fullmatch(rep_id):
        raise ValueError(f"id {rep_id!r}: letters, digits, _ . - (at most 40)")
    if rep_id in manifests():
        raise ValueError(f"id {rep_id!r} is registered already")
    projects = [str(p) for p in body.get("compose_projects", [])]
    if not projects or not all(SAFE_PROJECT.fullmatch(p) for p in projects):
        raise ValueError("compose_projects: at least one, each lower-case letters, digits, _ and -")
    actions = body.get("actions") or []
    if not actions:
        raise ValueError("at least one action")
    lines = ["# Written by the devtools Register form (scripts/runner.py). Edit freely; the runner reads it each time.",
             f"id = {toml_string(rep_id)}", f"title = {toml_string(str(body.get('title', ''))[:120])}",
             f"spec = {toml_string('README.md')}",
             f"compose_projects = [{', '.join(map(toml_string, projects))}]"]
    seen = set()
    for action in actions:
        action_id, script = str(action.get("id", "")), str(action.get("script", ""))
        if not SAFE_ID.fullmatch(action_id) or action_id in seen:
            raise ValueError(f"action id {action_id!r}: letters, digits, _ . -, unique in the rep")
        seen.add(action_id)
        if script not in offered[folder]:
            raise ValueError(f"action {action_id}: {script!r} is not a .py file in {folder}")
        args = [str(a) for a in action.get("args", [])]
        if bad := [a for a in args if not SAFE_ARG.fullmatch(a) or ".." in a]:
            raise ValueError(f"action {action_id}: arguments {bad} use characters outside A-Z a-z 0-9 _ . , = : / + -")
        group = "check" if action.get("group") == "check" else "run"
        runner = ["pytest", "-q"] if script.startswith("test_") else ["python"]
        command = ["uv", "run", "--no-sync", *runner, f"{{rep}}/{script}", *args]
        lines += ["", "[[actions]]", f"id = {toml_string(action_id)}", f"group = {toml_string(group)}",
                  f"label = {toml_string(str(action.get('label') or action_id)[:80])}",
                  f"description = {toml_string(str(action.get('description', ''))[:300])}"]
        if group == "run":
            lines.append(f"measured = {'true' if action.get('measured') else 'false'}")
        if isinstance(action.get("minutes"), int) and 0 < action["minutes"] < 600:
            lines.append(f"minutes = {action['minutes']}")
        lines.append(f"command = [{', '.join(map(toml_string, command))}]")
    text = "\n".join(lines) + "\n"
    tomllib.loads(text)  # what the runner will read back
    return REPO / folder / "rep.toml", text


async def unregistered_list(request: web.Request) -> web.Response:
    return web.json_response(await asyncio.to_thread(unregistered))


async def register(request: web.Request) -> web.Response:
    body = await request.json()
    try:
        path, text = await asyncio.to_thread(manifest_text, body)
    except ValueError as error:
        raise web.HTTPBadRequest(text=str(error))
    try:
        with path.open("x") as out:  # never overwrite a manifest written meanwhile
            out.write(text)
    except FileExistsError:
        raise web.HTTPConflict(text=f"{path.relative_to(REPO)} exists already")
    return web.json_response({"file": str(path.relative_to(REPO)), "text": text}, status=201)


def report_path(run_id: str, relative: str) -> Path:
    """A report file inside one run folder (reps/*/results/<run id>/), or HTTPNotFound / HTTPBadRequest."""
    folders = [p for p in REPO.glob(f"reps/*/results/{run_id}") if p.is_dir()] if run_id and "/" not in run_id else []
    if not folders:
        raise web.HTTPNotFound(text=f"no run {run_id!r}")
    root = folders[0].resolve()
    path = (root / relative).resolve()
    if root not in path.parents or not path.is_file():
        raise web.HTTPNotFound(text=f"no file {relative!r} in run {run_id}")
    if path.suffix not in VIEWERS:
        raise web.HTTPBadRequest(text=f"{path.name}: only {', '.join(VIEWERS)} files open in a desktop tool")
    return path


async def open_report(request: web.Request) -> web.Response:
    """Open a run's Nsight report in its desktop tool, detached: closing the tool or the runner leaves the other."""
    body = await request.json()
    path = report_path(str(body.get("run", "")), str(body.get("path", "")))
    tool = VIEWERS[path.suffix]
    if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        raise web.HTTPServiceUnavailable(text="the runner has no DISPLAY or WAYLAND_DISPLAY: restart it from a "
                                              "terminal in your desktop session (make runner-down; make runner)")
    with (STATE / "viewers.log").open("a") as log:
        proc = await asyncio.create_subprocess_exec(tool, str(path), cwd=path.parent, stdin=subprocess.DEVNULL,
                                                    stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    asyncio.create_task(proc.wait())  # reap it when the tool closes
    return web.json_response({"tool": tool, "file": str(path.relative_to(REPO)), "pid": proc.pid}, status=201)


async def begin(app: web.Application) -> None:
    app["scheduler"] = asyncio.create_task(app["runner"].schedule())


async def end(app: web.Application) -> None:
    app["scheduler"].cancel()


def make_app() -> web.Application:
    app = web.Application()
    app["runner"] = Runner()
    r = app.router
    r.add_get("/runner/health", health)
    r.add_get("/runner/reps", reps)
    r.add_get("/runner/jobs", jobs)
    r.add_post("/runner/jobs", start)
    r.add_get("/runner/jobs/{job}", job)
    r.add_post("/runner/jobs/{job}/cancel", cancel)
    r.add_get("/runner/unregistered", unregistered_list)
    r.add_post("/runner/register", register)
    r.add_post("/runner/open", open_report)
    app.on_startup.append(begin)
    app.on_cleanup.append(end)
    return app


if __name__ == "__main__":
    STATE.mkdir(parents=True, exist_ok=True)
    (STATE / "runner.pid").write_text(str(os.getpid()))
    print(f"runner: http://{HOST}:{PORT}/runner/reps · repo {REPO} · python {sys.executable}", flush=True)
    web.run_app(make_app(), host=HOST, port=PORT, print=None)
