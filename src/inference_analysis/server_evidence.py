import csv
import io
import re

CHAT_POST = b"POST /v1/chat/completions"
REQUEST_ID = re.compile(rb"(?i)x-request-id: (\S+)")
CONTENT_DELTA = re.compile(rb'"delta":\{"content":"[^"]')

LOG_LINE = re.compile(r"^(\d+)\.(\d{2})\.(\d{3})\.(\d{3}) \w (.*)$")
TASK_POST = re.compile(r"post: new task, id = (\d+)/")
TASK_PROMPT = re.compile(r"task (\d+) \| new prompt, .*n_prompt_tokens = (\d+)")
TASK_EVENTS = {
    "launch_us": re.compile(r"launch_slot_: id +\d+ \| task (\d+) \| processing task"),
    "first_send_us": re.compile(r"send: sending result for task id = (\d+)$"),
    "release_us": re.compile(r"release: id +\d+ \| task (\d+) \| stop processing"),
}
ACCESS_LOG = "log_server_r: request: POST /v1/chat/completions"


def _epoch_ns(value: str) -> int:
    seconds, fraction = value.split(".")
    if len(fraction) != 9:
        raise ValueError(f"expected nanosecond pcap timestamps, got {value}")
    return int(seconds + fraction)


def _first(frames: list[dict], test) -> int | None:
    return next((f["ns"] for f in frames if test(f)), None)


def pcap_streams(frames_tsv: str, server_port: str = "8080") -> dict[str, dict]:
    by_stream = {}
    for row in csv.DictReader(io.StringIO(frames_tsv), delimiter="\t"):
        by_stream.setdefault(row["tcp.stream"], []).append({
            "ns": _epoch_ns(row["frame.time_epoch"]),
            "to_server": row["tcp.dstport"] == server_port,
            "syn": row["tcp.flags.syn"] == "True",
            "payload": bytes.fromhex(row["tcp.payload"]),
        })

    streams = {}
    for frames in by_stream.values():
        sent = [f for f in frames if f["to_server"] and f["payload"]]
        received = [f for f in frames if not f["to_server"] and f["payload"]]
        request = b"".join(f["payload"] for f in sent)
        if request.count(CHAT_POST) == 0:
            continue
        if request.count(CHAT_POST) > 1:
            raise ValueError("a TCP stream carried more than one chat request; connection reuse is not handled")
        request_id = REQUEST_ID.search(request).group(1).decode()
        response_ns = received[0]["ns"] if received else None
        streams[request_id] = {
            "syn_ns": _first(frames, lambda f: f["syn"] and f["to_server"]),
            "request_last_ns": max(f["ns"] for f in sent if response_ns is None or f["ns"] < response_ns),
            "response_first_ns": response_ns,
            "first_content_ns": _first(received, lambda f: CONTENT_DELTA.search(f["payload"])),
            "last_data_ns": received[-1]["ns"] if received else None,
        }
    return streams


def log_tasks(log_text: str) -> list[dict]:
    tasks = {}
    handler_us = None
    access_times = []
    for line in log_text.splitlines():
        match = LOG_LINE.match(line)
        if match is None:
            continue
        minutes, seconds, ms, us, message = match.groups()
        time_us = ((int(minutes) * 60 + int(seconds)) * 1000 + int(ms)) * 1000 + int(us)

        if message.startswith("request: {") and '"messages"' in message:
            handler_us = time_us
        elif ACCESS_LOG in message:
            access_times.append(time_us)

        post = TASK_POST.search(message)
        if post:
            task_id = int(post.group(1))
            tasks[task_id] = {"task": task_id, "handler_us": handler_us, "post_us": time_us}
            continue
        prompt = TASK_PROMPT.search(message)
        if prompt and int(prompt.group(1)) in tasks:
            tasks[int(prompt.group(1))]["n_prompt"] = int(prompt.group(2))
        for key, pattern in TASK_EVENTS.items():
            event = pattern.search(message)
            if event and int(event.group(1)) in tasks:
                tasks[int(event.group(1))].setdefault(key, time_us)

    for task in tasks.values():
        release = task.get("release_us")
        task["access_us"] = next((t for t in access_times if release is not None and t >= release), None)
    return sorted(tasks.values(), key=lambda t: t["task"])


def join_requests(records: list[dict], streams: dict[str, dict], tasks: list[dict]) -> list[dict]:
    on_server = sorted((r for r in records if r["request_id"] in streams),
                       key=lambda r: r["anchor_pair"]["utc_ns"])
    if len(on_server) != len(tasks):
        raise ValueError(f"{len(on_server)} captured requests but {len(tasks)} log tasks")
    joined = []
    for record, task in zip(on_server, tasks):
        if record["usage"] is not None and task.get("n_prompt") != record["usage"]["prompt_tokens"]:
            raise ValueError(f"{record['request_id']}: task {task['task']} prompt count does not match usage")
        joined.append({"record": record, "stream": streams[record["request_id"]], "task": task})
    return joined
