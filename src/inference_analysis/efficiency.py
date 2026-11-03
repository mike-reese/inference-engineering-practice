"""Efficiency against capacity for one request: decode MBU and prefill FLOPs, from the model's own files.

Peaks are Published (vendor specification) until I03 measures them; a peak not yet sourced makes its metric
Unavailable instead of guessed.
"""
import json
import struct
from pathlib import Path

DTYPE_BYTES = {"BF16": 2, "F16": 2, "F32": 4, "F8_E4M3": 1, "I8": 1}
# RTX 5060 Ti 16 GB: 128-bit GDDR7 at 28 Gbps -> 128 / 8 x 28 = 448 GB/s (NVIDIA specification). Published.
PEAK_DRAM_BYTES_S = 448e9
PEAK_TENSOR_FLOPS = None  # not yet sourced for this card; I03 measures it


def weight_bytes(model_dir: Path) -> int:
    """Sum of every tensor's bytes, read from the safetensors header (no weights loaded)."""
    total = 0
    for path in sorted(model_dir.glob("*.safetensors")):
        with path.open("rb") as f:
            (size,) = struct.unpack("<Q", f.read(8))
            header = json.loads(f.read(size))
        for name, t in header.items():
            if name != "__metadata__":
                n = 1
                for d in t["shape"]:
                    n *= d
                total += n * DTYPE_BYTES[t["dtype"]]
    return total


def efficiency(model_dir: Path, perf_entry: dict, prompt_tokens: int, completion_tokens: int) -> dict:
    cfg = json.loads((model_dir / "config.json").read_text())
    t = perf_entry["perf_metrics"]["timing_metrics"]
    layers, hidden = cfg["num_hidden_layers"], cfg["hidden_size"]
    head_dim = hidden // cfg["num_attention_heads"]
    kv_bytes_per_token = 2 * layers * cfg["num_key_value_heads"] * head_dim * 2  # K and V, bf16
    weights = weight_bytes(model_dir)
    params = weights // 2
    decode_s = (t["last_token_time"] - t["first_token_time"]) / max(completion_tokens - 1, 1)
    mean_context = prompt_tokens + completion_tokens / 2
    step_bytes = weights + kv_bytes_per_token * mean_context
    prefill_s = t["first_token_time"] - t["first_scheduled_time"]
    # Matmul FLOPs: 2 per parameter per token, plus attention scores and values (2 x 2 x layers x hidden x n^2 / 2).
    prefill_flops = 2 * params * prompt_tokens + 2 * layers * hidden * prompt_tokens ** 2
    metrics = [
        {"name": "weight bytes read per decode step", "formula": "sum of safetensors tensor bytes (tied embedding = "
         "output projection) + KV bytes x mean context", "value": step_bytes, "unit": "byte"},
        {"name": "decode memory throughput", "formula": "bytes per decode step / engine mean ITL",
         "value": step_bytes / decode_s, "unit": "byte/s"},
        {"name": "decode MBU", "formula": "bytes per decode step / ITL / 448 GB/s (Published)",
         "value": step_bytes / decode_s / PEAK_DRAM_BYTES_S, "unit": "fraction"},
        {"name": "prefill FLOPs", "formula": "2 x params x prompt tokens + 2 x layers x hidden x prompt tokens^2",
         "value": prefill_flops, "unit": "FLOP"},
        {"name": "prefill achieved FLOPS", "formula": "prefill FLOPs / (first_token_time - first_scheduled_time)",
         "value": prefill_flops / prefill_s, "unit": "FLOP/s"},
    ]
    unavailable = []
    if PEAK_TENSOR_FLOPS is None:
        unavailable.append({"what": "prefill MFU", "why": "peak tensor FLOPS for this card not yet sourced; I03 "
                            "measures it. Achieved FLOPS is reported instead"})
    return {"first_iter": perf_entry["perf_metrics"]["first_iter"], "last_iter": perf_entry["perf_metrics"]["last_iter"],
            "weights_bytes": weights, "params": params, "metrics": metrics, "unavailable": unavailable}
