"""D1 prototype: peak resident memory per option, each in a fresh process: open, a whole-request window, and the
whole-run union busy query. Reads VmHWM of the process that holds the data (Python, or trace_processor_shell).
Usage: python rss.py <dataset> <option>   -> appends one JSON line to /mnt/ie-data/cc-v2-proto/bench/rss.jsonl"""
import json
import os
import sys

from bench import RUN_ALL, targets
from stores import make


def hwm(pid):
    for line in open(f"/proc/{pid}/status"):
        if line.startswith("VmHWM"):
            return round(int(line.split()[1]) / 1024)


def baseline():
    return hwm(os.getpid())


if __name__ == "__main__":
    ds, opt = sys.argv[1], sys.argv[2]
    t = targets(ds)
    base = baseline()
    s = make(opt, ds).open()
    s.window(*t["request"])
    s.busy_union(*RUN_ALL)
    pid = s.tp.subprocess.pid if hasattr(s, "tp") else os.getpid()
    out = {"dataset": ds, "option": opt, "peak_rss_mb": hwm(pid),
           "python_baseline_mb": base, "holder": "trace_processor_shell" if hasattr(s, "tp") else "python"}
    s.close()
    with open("/mnt/ie-data/cc-v2-proto/bench/rss.jsonl", "a") as f:
        f.write(json.dumps(out) + "\n")
    print(out)
