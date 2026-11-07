"""D2 prototype: fixtures every model option must express (throwaway). Output: /mnt/ie-data/cc-v2-proto/d2/fixtures/

1. shares (SYNTHETIC) - two requests sharing engine iterations. Copies of the timeline run's real iterations 66-71
   (NVTX _forward_step ranges, their CUDA launches and the GPU work each launch caused) under run "fixture/shares".
   R1 is the run's measured request (prefill in 66, decode after). R2 is invented: it arrives during 67, its 34-token
   prefill joins iteration 68, and it decodes in 69-71. Share rule (stated, Calculated): a request's share of an
   iteration = tokens it puts in that iteration / all tokens in the iteration. R1 decode = 1 token, R2 prefill = 34.
   So 66, 67: R1 1; 68: R1 1/35, R2 34/35; 69-71: 1/2 each. Test: kernel time attributed to each request must sum
   to the iterations' kernel time, and equal the expected values written to expected.json.
2. graph (real, timeline run) - CUDA graph capture and replay. Graph node creation rows (startup) give the graph ids
   (graphNodeId >> 32) and node counts; replay = each cudaGraphLaunch call linked to its node kernels by CUPTI
   correlation. Batch size per graph: the server log says it created graph instances for 1 batch size and warmed
   up batch size 1, and max_batch_size=1, so graph 5 (the one replayed) = batch size 1 (Inferred).
3. board (real probe of this machine, read-only, 2026-11-06) - PCI topology things with negotiated and maximum link
   speed and width (sysfs), and the GPU link generation sampled over each saved run (nvidia-smi
   pcie.link.gen.current, Observed). DMI 3.0 between chipset and CPU: x4 at 8 GT/s, Published (Intel), not re-checked
   here. NVMe link samples during a run and GPU link width samples were not collected: Unavailable.
4. launch-to-kernel (real, code run) - no copy: the neutral events already hold Python frames, nn.Module ranges, CPU
   ops, launches and kernels with code origin. models.py and bench2.py query one iteration of it.
Things (the containment tree beyond process/thread) for 2 and 3 go to things.parquet, shared by every option.
"""
import json
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

NEU = Path("/mnt/ie-data/cc-v2-proto/d2/neutral")
OUT = Path("/mnt/ie-data/cc-v2-proto/d2/fixtures")
TIMELINE = "I02A-TRACE-timeline_20261103T185837Z_e08b8b"
LOG = Path(__file__).resolve().parents[4] / "reps/I02A-L1_streamed_latency/results" / TIMELINE / "server_s1.log"
FIX_ID0 = 2 * 10**9
SHARES = {66: {"R1": (1, 1)}, 67: {"R1": (1, 1)}, 68: {"R1": (1, 35), "R2": (34, 35)},
          69: {"R1": (1, 2), "R2": (1, 2)}, 70: {"R1": (1, 2), "R2": (1, 2)}, 71: {"R1": (1, 2), "R2": (1, 2)}}
THING_SCHEMA = pa.schema([("run", pa.string()), ("id", pa.string()), ("parent_id", pa.string()),
                          ("kind", pa.string()), ("name", pa.string()), ("attrs", pa.string()),
                          ("evidence", pa.string())])


def sysfs(dev, f):
    try:
        return Path(f"/sys/bus/pci/devices/{dev}/{f}").read_text().strip()
    except OSError:
        return None


def shares(con):
    e = f"read_parquet('{NEU}/events.parquet')"
    con.execute(f"""CREATE TEMP TABLE it AS SELECT * FROM {e} WHERE run = '{TIMELINE}' AND (
        (source = 'nvtx' AND name LIKE '%_forward_step%' AND iteration BETWEEN 66 AND 71)
        OR (source = 'cuda_runtime' AND iteration BETWEEN 66 AND 71))""")
    con.execute(f"""CREATE TEMP TABLE work AS SELECT w.* FROM {e} w JOIN read_parquet('{NEU}/links.parquet') l
        ON l.to_id = w.id JOIN it ON it.id = l.from_id WHERE it.source = 'cuda_runtime'""")
    rows = con.execute("SELECT * FROM it UNION ALL SELECT * FROM work").to_arrow_table().to_pylist()
    lk = con.execute(f"""SELECT l.* FROM read_parquet('{NEU}/links.parquet') l JOIN it ON it.id = l.from_id
        JOIN work w ON w.id = l.to_id""").to_arrow_table().to_pylist()
    remap = {r["id"]: FIX_ID0 + i for i, r in enumerate(rows)}
    for r in rows:
        r["id"] = remap[r["id"]]
        r["parent_id"] = remap.get(r["parent_id"])
        r["parent_rule"] = r["parent_rule"] if r["parent_id"] is not None else None
        r["run"], r["synthetic"], r["request_id"] = "fixture/shares", True, None
    for l in lk:
        l["from_id"], l["to_id"], l["run"], l["synthetic"] = remap[l["from_id"]], remap[l["to_id"]], "fixture/shares", True
    steps = {r["iteration"]: r for r in rows if r["source"] == "nvtx" and r["name"].startswith("[Executor]")}
    t0, t1 = steps[66]["start_ns"], steps[71]["end_ns"]
    template = {k: None for k in rows[0]}
    req = {}
    for k, (name, a, b) in enumerate((("R1", t0 - 30_000_000, t1 + 1_000_000),
                                      ("R2", steps[67]["start_ns"] + 2_000_000, t1 + 1_000_000))):
        req[name] = FIX_ID0 + len(rows) + k
        rows.append({**template, "id": req[name], "run": "fixture/shares", "kind": "span", "source": "request",
                     "track": "client/requests", "name": f"request {name}", "start_ns": a, "end_ns": b,
                     "request_id": f"fixture/shares/{name}", "synthetic": True, "process": "client",
                     "thread": "requests (synthetic)",
                     "args": json.dumps({"prompt_tokens": 34, "rule": "SYNTHETIC two-request fixture"})})
    for it, sh in SHARES.items():
        for name, (num, den) in sh.items():
            lk.append({"run": "fixture/shares", "from_id": steps[it]["id"], "to_id": req[name], "kind": "serves",
                       "rule": f"Calculated (SYNTHETIC rule): share = tokens of the request in the iteration / all "
                               f"tokens = {num}/{den}", "synthetic": True, "weight": num / den})
    # expected attribution, computed directly from the copied rows
    by_it = {}
    for r in rows:
        if r["source"] == "kernel":
            by_it[r["iteration"]] = by_it.get(r["iteration"], 0) + r["end_ns"] - r["start_ns"]
    exp = {n: sum(by_it[i] * SHARES[i][n][0] / SHARES[i][n][1] for i in SHARES if n in SHARES[i]) for n in req}
    return rows, lk, {"kernel_ns_by_iteration": by_it, "kernel_ns_total": sum(by_it.values()),
                      "kernel_ns_by_request": exp, "shares": {i: {n: f"{a}/{b}" for n, (a, b) in s.items()}
                                                              for i, s in SHARES.items()}}


def graph_things(con):
    e = f"read_parquet('{NEU}/events.parquet')"
    nodes = con.execute(f"""SELECT (json_extract(args, '$.graph_node')::UBIGINT >> 32) AS g, count(*), min(start_ns)
        FROM {e} WHERE run = '{TIMELINE}' AND source = 'cuda_graph' GROUP BY 1 ORDER BY 1""").fetchall()
    replay = dict(con.execute(f"""SELECT json_extract(args, '$.graph')::BIGINT, count(*) FROM {e}
        WHERE run = '{TIMELINE}' AND source = 'kernel' AND json_extract(args, '$.graph') IS NOT NULL
        GROUP BY 1""").fetchall())
    log = [l.split("[TRT-LLM] ")[-1].strip() for l in LOG.read_text().splitlines()
           if "CUDA graph" in l and ("Creating" in l or "warmup" in l)]
    out = []
    for g, n, first in nodes:
        attrs = {"graph_id": g, "nodes_created": n, "first_node_created_ns": first, "kernels_replayed": replay.get(g, 0)}
        ev = "Observed: CUDA_GRAPH_NODE_EVENTS (graph id = graphNodeId >> 32), kernel graphId"
        if replay.get(g):
            attrs["batch_size"] = 1
            ev += "; batch_size Inferred: server log " + " | ".join(log[:2]) + "; max_batch_size=1"
        out.append({"run": TIMELINE, "id": f"{TIMELINE}|gpu0|graph {g}", "parent_id": f"{TIMELINE}|gpu0",
                    "kind": "cuda_graph", "name": f"CUDA graph {g}", "attrs": json.dumps(attrs), "evidence": ev})
    return out


def board(con):
    ts = "2026-11-06 probe (read-only sysfs, lspci, DMI)"
    pci = {d: {k: sysfs(d, k) for k in ("current_link_speed", "current_link_width", "max_link_speed",
                                         "max_link_width")} for d in ("0000:00:01.0", "0000:01:00.0",
                                                                      "0000:00:1d.0", "0000:02:00.0")}
    dmi = {k: Path(f"/sys/class/dmi/id/{k}").read_text().strip() for k in ("board_vendor", "board_name", "bios_version")}
    R = "fixture/board"
    T = [("node", None, "node", "this machine (host)", {}, "Observed: " + ts),
         ("board", "node", "board", dmi["board_name"], dmi, "Observed: /sys/class/dmi/id"),
         ("cpu", "board", "cpu", "Intel Core i9-9900K", {}, "Observed: lscpu"),
         ("rp 00:01.0", "cpu", "pcie_root_port", "CPU PCIe root port 00:01.0", pci["0000:00:01.0"], "Observed: sysfs"),
         ("gpu 01:00.0", "rp 00:01.0", "gpu", "NVIDIA GeForce RTX 5060 Ti (GB206)", pci["0000:01:00.0"], "Observed: sysfs"),
         ("chipset", "board", "chipset", "Intel Z390 chipset (PCH)", {}, "Observed: lspci"),
         ("rp 00:1d.0", "chipset", "pcie_root_port", "PCH root port 00:1d.0", pci["0000:00:1d.0"], "Observed: sysfs"),
         ("nvme 02:00.0", "rp 00:1d.0", "nvme", "WD_BLACK SN7100", pci["0000:02:00.0"], "Observed: sysfs"),
         # physical links between devices are things too (kind bus_link), with their two ends as attributes
         ("link cpu-gpu", "board", "bus_link", "PCIe: CPU root port 00:01.0 <-> GPU 01:00.0",
          {"ends": ["rp 00:01.0", "gpu 01:00.0"], "negotiated": pci["0000:01:00.0"]["current_link_speed"],
           "width": pci["0000:01:00.0"]["current_link_width"], "device_max": pci["0000:01:00.0"]["max_link_speed"]},
          "Observed: sysfs at probe time (link trains down at idle, so a run samples it)"),
         ("link pch-nvme", "board", "bus_link", "PCIe: PCH root port 00:1d.0 <-> NVMe 02:00.0",
          {"ends": ["rp 00:1d.0", "nvme 02:00.0"], "negotiated": pci["0000:02:00.0"]["current_link_speed"],
           "width": pci["0000:02:00.0"]["current_link_width"], "device_max": pci["0000:02:00.0"]["max_link_speed"]},
          "Observed: sysfs at probe time"),
         ("link dmi", "board", "bus_link", "DMI 3.0: Z390 chipset <-> CPU",
          {"ends": ["chipset", "cpu"], "lanes": 4, "rate": "8 GT/s"},
          "Published (Intel DMI 3.0: x4 at 8 GT/s), not re-checked against the datasheet in this prototype")]
    things = [{"run": R, "id": f"{R}|{i}", "parent_id": f"{R}|{p}" if p else None, "kind": k, "name": n,
               "attrs": json.dumps(a), "evidence": ev} for i, p, k, n, a, ev in T]
    smp = con.execute(f"""SELECT run, ts_ns, value FROM read_parquet('{NEU}/samples.parquet')
        WHERE metric = 'pcie.link.gen.current' ORDER BY run, ts_ns""").fetchall()
    samples = [{"run": r, "thing_id": f"{R}|link cpu-gpu", "metric": "pcie.link.gen.current", "ts_ns": t,
                "value": v, "unit": "PCIe generation", "evidence": "Observed: nvidia-smi during the run (10 Hz)",
                "synthetic": False} for r, t, v in smp]
    return things, samples


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    rows, links, exp = shares(con)
    schema = pq.read_schema(NEU / "events.parquet")
    pq.write_table(pa.Table.from_pylist(rows, schema=schema), OUT / "shares_events.parquet")
    lschema = pq.read_schema(NEU / "links.parquet").append(pa.field("weight", pa.float64()))
    for l in links:
        l.setdefault("weight", None)
    pq.write_table(pa.Table.from_pylist(links, schema=lschema), OUT / "shares_links.parquet")
    things = graph_things(con)
    bt, bs = board(con)
    pq.write_table(pa.Table.from_pylist(things + bt, schema=THING_SCHEMA), OUT / "things.parquet")
    pq.write_table(pa.Table.from_pylist(bs), OUT / "board_samples.parquet")
    exp["graph_things"] = [json.loads(t["attrs"]) | {"evidence": t["evidence"]} for t in things]
    exp["board_things"] = len(bt)
    exp["board_samples"] = {r: sum(1 for s in bs if s["run"] == r) for r in sorted({s["run"] for s in bs})}
    exp["board_link_gen_values"] = sorted({s["value"] for s in bs})
    (OUT / "expected.json").write_text(json.dumps(exp, indent=1, default=str))
    print(json.dumps(exp, indent=1, default=str)[:3000])


if __name__ == "__main__":
    main()
