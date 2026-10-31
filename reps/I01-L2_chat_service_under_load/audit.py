"""Offline Hugging Face parity audit for I01-L2 (spec Point 3; pass rows P1b-P1d).

Runs as its own process after rep.py, never inside the Locust/gevent client. For each ISL that has
diagnostic records, it renders the exact messages the client sent (read from the run's control/ step files),
generates 32 greedy tokens with the pinned HF model, and compares those IDs with the server's diagnostic IDs.

    uv run python reps/I01-L2_chat_service_under_load/audit.py [RUN_ID]

Without RUN_ID it audits the newest run. Output: results/<RUN_ID>/audit/hf_parity.json.
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import torch
import transformers
from transformers import AutoModelForCausalLM, AutoTokenizer

REP_DIR = Path(__file__).resolve().parent
MODEL_ID = "Qwen/Qwen2.5-0.5B-Instruct"
REVISION = "7ae557604adf67be50417f59c2c2f167def9a775"
OSL = 32
# Greedy, no repetition penalty, exactly OSL new tokens (matches the server's ignore_eos and max_tokens).
GREEDY = {"do_sample": False, "temperature": None, "top_p": None, "top_k": None, "repetition_penalty": 1.0,
          "min_new_tokens": OSL, "max_new_tokens": OSL}


def run_dir_from_args() -> Path:
    if len(sys.argv) > 1:
        return REP_DIR / "results" / sys.argv[1]
    return max((p for p in (REP_DIR / "results").iterdir() if (p / "control").is_dir()), key=lambda p: p.name)


def sent_requests(run_dir: Path) -> dict[str, dict]:
    requests = {}
    for path in sorted((run_dir / "control").glob("step_*.json")):
        for request in json.loads(path.read_text())["requests"]:
            requests[request["request_id"]] = request
    return requests


def server_token_groups(record: dict) -> list[list[int]]:
    """Token IDs per SSE delivery from the b6500 logprobs extension. Grouped deliveries stay grouped."""
    groups = []
    for item in record["events"]:
        choices = item["event"]["choices"]
        logprobs = choices[0].get("logprobs") if choices else None
        if logprobs and logprobs.get("content"):
            groups.append([entry["id"] for entry in logprobs["content"]])
    return groups


def main():
    run_dir = run_dir_from_args()
    records = [json.loads(p.read_text()) for p in (run_dir / "client").glob(f"{run_dir.name}-*.json")]
    diagnostic = [r for r in records if r.get("diagnostic") and r["complete"]]
    if not diagnostic:
        raise SystemExit(f"{run_dir.name}: no complete diagnostic records to audit")
    sent = sent_requests(run_dir)

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, revision=REVISION)
    model = AutoModelForCausalLM.from_pretrained(MODEL_ID, revision=REVISION, dtype=torch.float32)
    model = model.to(device).eval()

    rows = []
    for isl in sorted({r["isl"] for r in diagnostic}):
        at_isl = sorted((r for r in diagnostic if r["isl"] == isl), key=lambda r: r["anchor_pair"]["utc_ns"])
        messages = sent[at_isl[0]["request_id"]]["messages"]
        if any(sent[r["request_id"]]["messages"] != messages for r in at_isl):
            raise ValueError(f"ISL {isl}: diagnostic requests sent different messages")

        encoding = tokenizer.apply_chat_template(messages, add_generation_prompt=True, return_tensors="pt",
                                                 return_dict=True).to(device)
        input_ids = encoding["input_ids"][0].tolist()
        with torch.no_grad():
            output = model.generate(**encoding, **GREEDY, pad_token_id=tokenizer.eos_token_id)
        hf_output = output[0, len(input_ids):].tolist()

        server = []
        for record in at_isl:
            groups = server_token_groups(record)
            ids = [token for group in groups for token in group]
            server.append({
                "request_id": record["request_id"], "control": record.get("control"),
                "prompt_tokens": record["usage"]["prompt_tokens"],
                "completion_tokens": record["usage"]["completion_tokens"],
                "output_ids": ids, "group_sizes": [len(group) for group in groups], "equal_hf": ids == hf_output,
            })
        rows.append({"isl": isl, "hf_input_len": len(input_ids), "hf_input_ids": input_ids,
                     "hf_output_ids": hf_output, "hf_text": tokenizer.decode(hf_output), "server": server})

    out = run_dir / "audit"
    out.mkdir(exist_ok=True)
    (out / "hf_parity.json").write_text(json.dumps({
        "utc": datetime.now(timezone.utc).isoformat(), "run_id": run_dir.name,
        "model": MODEL_ID, "revision": REVISION, "torch": torch.__version__,
        "transformers": transformers.__version__, "device": device,
        "device_name": torch.cuda.get_device_name(0) if device.startswith("cuda") else "cpu",
        "dtype": "float32", "generation": {**GREEDY, "pad_token_id": tokenizer.eos_token_id}, "rows": rows,
    }, indent=2))

    print(f"audit {run_dir.name} on {device}")
    for row in rows:
        matches = sum(s["equal_hf"] for s in row["server"])
        print(f"  ISL {row['isl']:>4}: HF input {row['hf_input_len']}, server prompt "
              f"{sorted({s['prompt_tokens'] for s in row['server']})}, HF output {len(row['hf_output_ids'])} IDs, "
              f"server IDs equal HF in {matches}/{len(row['server'])} diagnostic records")


if __name__ == "__main__":
    main()
