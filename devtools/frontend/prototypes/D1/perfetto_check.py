"""D1 prototype: what the Perfetto import kept, dropped or mis-bound, against the canonical tables (Observed)."""
import json
import sys
from pathlib import Path

import pyarrow.parquet as pq

from stores import CANON, make

OUT = Path("/mnt/ie-data/cc-v2-proto/bench/perfetto_import.json")


def check(dataset):
    links = pq.read_table(CANON / f"{dataset}_links.parquet", columns=["from_id", "to_id"])
    truth = set(zip(links["from_id"].to_pylist(), links["to_id"].to_pylist()))
    events = pq.ParquetFile(CANON / f"{dataset}_events.parquet").metadata.num_rows
    s = make("D", dataset).open()
    got = [(int(a), int(b)) for a, b in s.q("SELECT a.id AS a, b.id AS b FROM flow f JOIN ev a ON a.sid = f.slice_out "
                                             "JOIN ev b ON b.sid = f.slice_in")]
    slices = s.q("SELECT count(*) AS n FROM slice")[0][0]
    stats = {k: v for k, v in s.q("SELECT name, value FROM stats WHERE severity IN ('error', 'data_loss') "
                                  "AND value > 0")}
    s.close()
    return {"events": events, "slices": slices, "dropped_slices": events - slices,
            "drop_reason": ", ".join(f"{k} {v:,}" for k, v in stats.items()),
            "links": len(truth), "flows": len(got), "links_correct": len(set(got) & truth),
            "links_wrong": len(truth) - len(set(got) & truth)}


if __name__ == "__main__":
    res = json.loads(OUT.read_text()) if OUT.exists() else {}
    for ds in sys.argv[1:]:
        res[ds] = check(ds)
        print(ds, res[ds])
    OUT.write_text(json.dumps(res, indent=1))
