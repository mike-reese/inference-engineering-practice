import os

os.environ.setdefault("HF_HUB_OFFLINE", "1")  # before any Hugging Face import: nothing is downloaded

import json
import math
import platform
import re
import struct
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

import httpx
import safetensors
import torch
import transformers
from huggingface_hub import hf_hub_download
from safetensors import safe_open
from transformers import AutoModelForCausalLM, AutoTokenizer, PreTrainedTokenizerBase

from inference_analysis.kv_cache import kv_cache_shape

REP_DIR = Path(__file__).resolve().parent
RESULTS_DIR = REP_DIR / "results"
SERVER_SCRIPT = REP_DIR.parents[1] / "scripts" / "llama_cpp_server.py"
SERVER_FLAGS = ["--ctx-size", "4096", "--parallel", "1", "--n-gpu-layers", "99", "--jinja"]

MODEL_ID = "Qwen/Qwen2.5-0.5B-Instruct"
REVISION = "7ae557604adf67be50417f59c2c2f167def9a775"
SYSTEM = "You are a concise assistant for an inference team."
USER = "Why does decode slow down as the KV cache grows?"
MESSAGES = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": USER}]

LINES: list[str] = []

def emit(line: str = "") -> None:
    """Print a line and keep it for results/output.txt"""
    print(line)
    LINES.append(line)

def start_server(name: str) -> tuple[str, str]:
    """Start llama.cpp server through the server script; return (base URL, the docker run command it recorded)."""
    r = subprocess.run(
        [sys.executable, str(SERVER_SCRIPT), "start", name, "--", *SERVER_FLAGS],
        capture_output=True, text=True, timeout=60,
    )
    if r.returncode != 0:
        raise RuntimeError(f"server did not start (exit {r.returncode}):\n{r.stderr}")
    docker_cmd = next(line[2:] for line in r.stderr.splitlines() if line.startswith("+ docker run"))
    return r.stdout.strip(), docker_cmd 

def stop_server(name: str) -> None:
    """Stop the server through the server script. Safe to call when it is already gone."""
    r = subprocess.run(
        [sys.executable, str(SERVER_SCRIPT), "stop", name],
        capture_output=True, text=True, timeout=30
    )
    emit(f"server: {r.stderr.strip()} (exit {r.returncode})")

def configuration(server_url: str, docker_cmd: str) -> dict[str, Any]:
    """Step 1: versions, revision, dtype, device, the docker run command, the server's build_info from GET /props."""
    cpu = next((line.split(":", 1)[1].strip() for line in Path("/proc/cpuinfo").read_text().splitlines()
                if line.startswith("model name")), platform.processor())
    config = {
        "python": platform.python_version(),
        "torch": torch.__version__,
        "transformers": transformers.__version__,
        "safetensors": safetensors.__version__,
        "httpx": httpx.__version__,
        "model": MODEL_ID,
        "revision": REVISION,
        "dtype": "float32",
        "device": "cpu",
        "cpu": cpu,
        "torch_threads": torch.get_num_threads(),
        "hf_hub_offline": os.environ["HF_HUB_OFFLINE"],
        "docker_run": docker_cmd,
        "server_build_info": httpx.get(f"{server_url}/props").json()["build_info"],
    }
    emit("== Configuration")
    for key, value in config.items():
        emit(f"{key:18} {value}")
    return config

def inspect_template(tokenizer: PreTrainedTokenizerBase, server_url: str) -> dict[str, Any]:
    """Steps 2-3, point 1: the rendered string, its special tokens and positions, the generation prompt,
    the user-only branch; /props and /apply-template against transformers."""
    rendered = tokenizer.apply_chat_template(MESSAGES, tokenize=False, add_generation_prompt=True)
    no_gen = tokenizer.apply_chat_template(MESSAGES, tokenize=False, add_generation_prompt=False)
    generation_prompt = rendered[len(no_gen):] if rendered.startswith(no_gen) else None
    specials = [(m.start(), m.group()) for m in re.finditer(r"<\|[a-z_]+\|>", rendered)]

    user_only = [{"role": "user", "content": USER}]
    hf_user_only = tokenizer.apply_chat_template(user_only, tokenize=False, add_generation_prompt=True)
    template = tokenizer.chat_template
    default_at = template.rfind("You are Qwen")
    start = template.rfind("{%- if messages[0]['role'] == 'system' %}", 0, default_at)
    end = template.find("{%- endif %}", default_at) + len("{%- endif %}")
    branch = template[start:end].splitlines()

    llama_render = httpx.post(f"{server_url}/apply-template", json={"messages": MESSAGES}).json()["prompt"]
    llama_user_only = httpx.post(f"{server_url}/apply-template", json={"messages": user_only}).json()["prompt"]
    gguf_template = httpx.get(f"{server_url}/props").json()["chat_template"]

    emit()
    emit("== Point 1: the rendered string")
    emit(f"{len(rendered)} characters:")
    for line in rendered.splitlines(keepends=True):
        emit(f"  {line!r}")
    emit("special tokens (character position, token):")
    for pos, tok in specials:
        emit(f"  {pos:4}  {tok}")
    emit(f"generation prompt (render minus no-generation render): {generation_prompt!r}")
    emit("user-only render:")
    for line in hf_user_only.splitlines(keepends=True):
        emit(f"  {line!r}")
    emit("the template branch that adds the default system message (inside `{%- else %}` of `{%- if tools %}`):")
    for line in branch:
        emit(f"  {line}")
    emit("second source, llama.cpp:")
    emit(f"  /apply-template == transformers render:  {llama_render == rendered}")
    emit(f"  /props chat_template == tokenizer's:     {gguf_template == template} ({len(gguf_template):,} and {len(template):,} characters)")
    emit(f"  user-only render has the default, both:  {('You are Qwen' in hf_user_only) and ('You are Qwen' in llama_user_only)}")
    return {
        "rendered": rendered, "specials": specials, "generation_prompt": generation_prompt,
        "user_only": hf_user_only, "branch": branch,
        "llama_render_equal": llama_render == rendered, "template_equal": gguf_template == template,
        "template_chars": len(template),
    }


def inspect_tokens(tokenizer: PreTrainedTokenizerBase, rendered: str, server_url: str) -> dict[str, Any]:
    """Step 4, point 2: one row per token (index, ID, transformers piece, llama.cpp piece),
    the special-token IDs and counts, the specials-as-text hazard."""
    ids = tokenizer(rendered, add_special_tokens=False)["input_ids"]
    hf_pieces = tokenizer.convert_ids_to_tokens(ids)
    llama = httpx.post(f"{server_url}/tokenize",
                       json={"content": rendered, "add_special": False, "with_pieces": True}).json()["tokens"]
    llama_ids = [t["id"] for t in llama]
    first_special = min(tokenizer.all_special_ids)
    special_counts = {i: ids.count(i) for i in sorted(set(ids)) if i >= first_special}

    hf_as_text = tokenizer(rendered, add_special_tokens=False, split_special_tokens=True)["input_ids"]
    llama_as_text = httpx.post(f"{server_url}/tokenize", json={"content": rendered, "add_special": False, "parse_special": False}).json()["tokens"]

    emit()
    emit(f"== Point 2: {len(ids)} tokens")
    emit(f"{'index':>5}  {'ID':>6}  {'transformers piece':20}  llama.cpp piece")
    for i, (tid, hp, lt) in enumerate(zip(ids, hf_pieces, llama)):
        mark = "" if lt["id"] == tid else "   <- ID differs"
        emit(f"{i:>5}  {tid:>6}  {hp!r:20}  {lt['piece']!r}{mark}")
    emit("special tokens (ID, token, count):")
    for tid, count in special_counts.items():
        emit(f"  {tid}  {tokenizer.convert_ids_to_tokens(tid)}  x{count}")
    emit(f"second source, llama.cpp /tokenize:  same {len(llama_ids)} IDs: {llama_ids == ids}")
    emit(f"the hazard, specials parsed as text: transformers {len(hf_as_text)} IDs, llama.cpp {len(llama_as_text)} IDs; "
         f"highest ID {max(hf_as_text)} and {max(llama_as_text)} (first special ID {first_special})")
    emit(f"  starts: {tokenizer.convert_ids_to_tokens(hf_as_text[:6])}")
    return {
        "ids": ids, "hf_pieces": hf_pieces, "llama_pieces": [t["piece"] for t in llama],
        "llama_ids_equal": llama_ids == ids, "special_counts": special_counts,
        "as_text_ids": {"transformers": hf_as_text, "llama.cpp": llama_as_text},
    }

def read_safetensors_header(path: str) -> tuple[int, dict[str, Any]]:
    """The 8-byte little-endian header length n, then the n-byte JSON header. No tensor data is read."""
    with open(path, "rb") as f:
        (n,) = struct.unpack("<Q", f.read(8))
        return n, json.loads(f.read(n))

def inspect_config(raw_config: dict[str, Any]) -> dict[str, Any]:
    """Step 5, point 3: the safetensors header read from the file's first bytes, the K9 tensors,
    dtype counts, parameter count, data bytes, the size identity; config fields besides the shapes they predict"""
    path = hf_hub_download(MODEL_ID, "model.safetensors", revision=REVISION)
    n, header = read_safetensors_header(path)
    metadata = header.pop("__metadata__", {})
    layer_indices = sorted({int(m.group(1)) for name in header if (m := re.match(r"model\.layers\.(\d+)\.", name))})
    dtype_counts: dict[str, int] = {}
    for t in header.values():
        dtype_counts[t["dtype"]] = dtype_counts.get(t["dtype"],0) + 1 
    params = sum(math.prod(t["shape"]) for t in header.values())
    data_bytes = max(t["data_offsets"][1] for t in header.values())
    file_bytes = os.path.getsize(path)

    c = raw_config
    head_dim = c.get("head_dim") or c["hidden_size"] // c["num_attention_heads"]
    kv_rows, q_rows = c["num_key_value_heads"] * head_dim, c["num_attention_heads"] * head_dim
    shown = {
        "model.embed_tokens.weight": f"[vocab_size, hidden_size] = [{c['vocab_size']}, {c['hidden_size']}]",
        "model.layers.0.self_attn.q_proj.weight": f"[attention heads x head size, hidden] = [{q_rows}, {c['hidden_size']}]",
        "model.layers.0.self_attn.k_proj.weight": f"[KV heads x head size, hidden] = [{kv_rows}, {c['hidden_size']}]",
        "model.layers.0.self_attn.v_proj.weight": f"[KV heads x head size, hidden] = [{kv_rows}, {c['hidden_size']}]",
        "model.layers.0.self_attn.o_proj.weight": f"[hidden, attention heads x head size] = [{c['hidden_size']}, {q_rows}]",
        "model.layers.0.self_attn.q_proj.bias": f"[attention heads x head size] = [{q_rows}]",
        "model.layers.0.self_attn.k_proj.bias": f"[KV heads x head size] = [{kv_rows}]",
        "model.layers.0.mlp.gate_proj.weight": f"[intermediate, hidden] = [{c['intermediate_size']}, {c['hidden_size']}]",
        "model.layers.0.mlp.down_proj.weight": f"[hidden, intermediate] = [{c['hidden_size']}, {c['intermediate_size']}]",
    }
    with safe_open(path, framework="pt") as f:
        cross_check = all(list(f.get_slice(name).get_shape()) == header[name]["shape"] for name in shown)

    emit()
    emit("== Point 3: the config against the stored tensors")
    emit("config.json:")
    for key in ("num_hidden_layers", "num_attention_heads", "num_key_value_heads", "hidden_size", "intermediate_size",
                "vocab_size", "max_position_embeddings", "tie_word_embeddings", "torch_dtype"):
        emit(f"  {key:24} {c.get(key)}")
    emit(f"  {'head_dim':24} {c.get('head_dim')} -> {head_dim} (hidden_size // num_attention_heads)")
    emit(f"safetensors header: first 8 bytes = {n:,} (header length); {len(header)} tensors; "
         f"dtypes {dtype_counts}; __metadata__ {metadata}")
    emit(f"  layer indices {layer_indices[0]}-{layer_indices[-1]} ({len(layer_indices)} layers); "
         f"lm_head.weight present: {'lm_head.weight' in header}")
    emit(f"  {'tensor':42} {'stored shape':16} predicted from config.json")
    for name, predicted in shown.items():
        emit(f"  {name:42} {str(header[name]['shape']):16} {predicted}")
    emit(f"  safe_open reads the same shapes: {cross_check}")
    emit(f"parameters (header): {params:,}; data bytes {data_bytes:,} = {data_bytes / params:g} bytes x parameters")
    emit(f"file size {file_bytes:,} = 8 + {n:,} + {data_bytes:,}: {file_bytes == 8 + n + data_bytes}")
    return {
        "header_bytes": n, "tensors": len(header), "dtype_counts": dtype_counts, "metadata": metadata,
        "layers": len(layer_indices), "lm_head_present": "lm_head.weight" in header,
        "shapes": {name: header[name]["shape"] for name in shown}, "safe_open_equal": cross_check,
        "parameters": params, "data_bytes": data_bytes, "file_bytes": file_bytes, "head_dim": head_dim,
    }

def inspect_kv_cache(model: torch.nn.Module, tokenizer: PreTrainedTokenizerBase, raw_config: dict[str, Any], input_ids: torch.Tensor) -> dict[str, Any]:
    """Step 6, point 4: one prefill forward call: the logits' shape and dtype, one row per layer
    (key shape, value shape, dtype, bytes); the totals beside kv_cache_shape"""
    n = input_ids.shape[1]
    with torch.no_grad():
        out = model(input_ids, use_cache=True)
    cache = out.past_key_values
    rows = [(i, tuple(layer.keys.shape), tuple(layer.values.shape), str(layer.keys.dtype), 
             layer.keys.nbytes + layer.values.nbytes) for i, layer in enumerate(cache.layers)]

    total = sum(r[4] for r in rows)
    element_bytes = cache.layers[0].keys.element_size()
    predicted = kv_cache_shape(raw_config, n, dtype_bytes=element_bytes)
    embedding_rows = model.get_input_embeddings().weight.shape[0]

    emit()
    emit(f"== Point 4: one prefill forward call on {n} tokens")
    emit(f"model dtype {model.dtype}, device {model.device}")
    emit(f"logits {tuple(out.logits.shape)} {out.logits.dtype}: one score per vocabulary row at each of the {n} positions")
    emit(f"  embedding rows {embedding_rows:,} - len(tokenizer) {len(tokenizer):,} = {embedding_rows - len(tokenizer)} rows with no token")
    emit(f"KV cache: {type(cache).__name__}, {len(cache.layers)} layers")
    emit(f"  {'layer':>5}  {'keys':16}  {'values':16}  {'dtype':14}  bytes (K + V)")
    for i, k_shape, v_shape, dtype, nbytes in rows:
        emit(f"  {i:>5}  {str(k_shape):16}  {str(v_shape):16}  {dtype:14}  {nbytes:,}")
    emit(f"  measured:   total {total:,} bytes = {total // n:,} bytes per token x {n} tokens")
    emit(f"  predicted:  kv_cache_shape(config, {n}, dtype_bytes={element_bytes}) -> layer shape {predicted.layer_shape}, "
         f"{predicted.bytes_per_layer:,} per layer, {predicted.bytes_per_token:,} per token, {predicted.total_bytes:,} total")
    emit(f"  equal: {total == predicted.total_bytes and all(r[1] == r[2] == predicted.layer_shape for r in rows)}")
    return {
        "tokens": n, "logits_shape": list(out.logits.shape), "logits_dtype": str(out.logits.dtype),
        "embedding_rows": embedding_rows, "tokenizer_len": len(tokenizer),
        "layers": [{"layer": i, "keys": list(k), "values": list(v), "dtype": d, "bytes": b} for i, k, v, d, b in rows],
        "total_bytes": total, "bytes_per_token": total // n,
        "predicted": {"layer_shape": list(predicted.layer_shape), "bytes_per_layer": predicted.bytes_per_layer,
                      "bytes_per_token": predicted.bytes_per_token, "total_bytes": predicted.total_bytes},
    }

def write_results(record: dict[str, Any]) -> None:
    """Step 7: results/record.json (every value) and results/output.txt (everything printed)."""
    RESULTS_DIR.mkdir(exist_ok=True)
    (RESULTS_DIR / "record.json").write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n")
    (RESULTS_DIR / "output.txt").write_text("\n".join(LINES) + "\n")
    print(f"wrote {RESULTS_DIR / 'record.json'} and {RESULTS_DIR / 'output.txt'}")

def main() -> int:
    """Run steps 1-7 in order; stop the server in a finally block, also when a step fails"""
    name = f"i01a-{uuid.uuid4().hex[:8]}"
    record: dict[str, Any] = {}
    try:
        server_url, docker_cmd = start_server(name)
        record["configuration"] = configuration(server_url, docker_cmd)

        tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, revision=REVISION)
        record["template"] = inspect_template(tokenizer, server_url)
        record["tokens"] = inspect_tokens(tokenizer, record["template"]["rendered"], server_url)

        raw_config = json.loads(Path(hf_hub_download(MODEL_ID, "config.json", revision=REVISION)).read_text())
        record["config"] = inspect_config(raw_config)

        model = AutoModelForCausalLM.from_pretrained(MODEL_ID, revision=REVISION, dtype=torch.float32).eval()
        input_ids = torch.tensor([record["tokens"]["ids"]])
        record["kv_cache"] = inspect_kv_cache(model, tokenizer, raw_config, input_ids)
    finally:
        emit()
        stop_server(name)
        write_results(record)
    return 0

if __name__ == "__main__":
    sys.exit(main())
