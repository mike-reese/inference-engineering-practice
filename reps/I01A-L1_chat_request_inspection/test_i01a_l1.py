import json
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import math
import re
import struct
import httpx
import pytest
import torch
from huggingface_hub import hf_hub_download
from transformers import AutoModelForCausalLM, AutoTokenizer

from inference_analysis.kv_cache import kv_cache_shape

REPO_ROOT = Path(__file__).resolve().parents[2]
SERVER_SCRIPT = REPO_ROOT / "scripts" / "llama_cpp_server.py"
SERVER_FLAGS = ["--ctx-size", "4096", "--parallel", "1", "--n-gpu-layers", "99", "--jinja"]

MODEL_ID = "Qwen/Qwen2.5-0.5B-Instruct"
REVISION = "7ae557604adf67be50417f59c2c2f167def9a775"
SYSTEM = "You are a concise assistant for an inference team."
USER = "Why does decode slow down as the KV cache grows?"
MESSAGES = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": USER}]

K2_GENERATION_PROMPT = "<|im_start|>assistant\n"
K4_DEFAULT_SYSTEM = "You are Qwen, created by Alibaba Cloud. You are a helpful assistant."


def run_server_script(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SERVER_SCRIPT), *args],
        capture_output=True, text=True, timeout=60,
    )

@pytest.fixture(scope="module")
def server_url():
    if shutil.which("docker") is None or shutil.which("nvidia-smi") is None:
        pytest.skip("needs Docker and an NVIDIA GPU")
    name = f"i01a-test-{uuid.uuid4().hex[:8]}"
    r = run_server_script("start", name, "--", *SERVER_FLAGS)
    if r.returncode != 0:
        pytest.fail(f"server did not start:\n{r.stderr}")
    try:
        yield r.stdout.strip()
    finally:
        run_server_script("stop", name)

@pytest.fixture(scope="module")
def tokenizer():
    return AutoTokenizer.from_pretrained(MODEL_ID, revision=REVISION)

@pytest.fixture(scope="module")
def raw_config() -> dict:
    with open(hf_hub_download(MODEL_ID, "config.json", revision=REVISION)) as f:
        return json.load(f)

@pytest.fixture(scope="module")
def model():
    m = AutoModelForCausalLM.from_pretrained(MODEL_ID, revision=REVISION, dtype=torch.float32)
    return m.eval()


def test_template_one_string_two_implementations(tokenizer, server_url):
    rendered = tokenizer.apply_chat_template(MESSAGES, tokenize=False, add_generation_prompt=True)

    # Rendered string = llama.cpp's render of the same messages
    llama = httpx.post(f"{server_url}/apply-template", json={"messages": MESSAGES}).json()
    assert rendered == llama["prompt"]

    # the GGUF's template = tokenizer_config.json's template
    with open(hf_hub_download(MODEL_ID, "tokenizer_config.json", revision=REVISION)) as f:
        hf_template = json.load(f)["chat_template"]
    assert httpx.get(f"{server_url}/props").json()["chat_template"] == hf_template

    # generation prompt = render - no-generation render
    no_gen = tokenizer.apply_chat_template(MESSAGES, tokenize=False, add_generation_prompt=False)
    assert rendered.startswith(no_gen)
    assert rendered[len(no_gen):] == K2_GENERATION_PROMPT

    # Unseen branch: User message alone, both engines add the default system message
    user_only = [{"role":"user","content": USER}]
    hf_user_only = tokenizer.apply_chat_template(user_only, tokenize=False, add_generation_prompt=True)
    llama_user_only = httpx.post(f"{server_url}/apply-template", json={"messages": user_only}).json()["prompt"]
    assert K4_DEFAULT_SYSTEM in hf_user_only
    assert K4_DEFAULT_SYSTEM in llama_user_only

K6_SPECIAL_COUNTS = {151644: 3, 151645: 2}
FIRST_SPECIAL_ID = 151643

def test_token_ids_one_string_two_tokenizers(tokenizer, server_url):
    rendered = tokenizer.apply_chat_template(MESSAGES, tokenize=False, add_generation_prompt=True)
    ids = tokenizer(rendered, add_special_tokens=False)["input_ids"]
    assert len(ids) == 34

    # the 34 IDs = llama.cpp's tokenization of the same string
    llama = httpx.post(f"{server_url}/tokenize", json={"content": rendered, "add_special": False, "with_pieces": True}).json()
    assert [t["id"] for t in llama["tokens"]] == ids 

    # the 34 IDs = apply_chat_template's own tokenization
    chat_ids = tokenizer.apply_chat_template(MESSAGES, tokenize=True, add_generation_prompt=True, return_dict=True)["input_ids"]
    assert chat_ids == ids

    # special-token IDs and their counts (K6)
    specials = {i: ids.count(i) for i in set(ids) if i >= FIRST_SPECIAL_ID}
    assert specials == K6_SPECIAL_COUNTS

    # Hazard: Special tokens parsed as text in both tokenizers
    hf_as_text = tokenizer(rendered, add_special_tokens=False, split_special_tokens=True)["input_ids"]
    llama_as_text = httpx.post(f"{server_url}/tokenize",
                               json={"content":rendered, "add_special": False, "parse_special": False}).json()["tokens"]
    for as_text in (hf_as_text, llama_as_text):
        assert len(as_text) == 55
        assert max(as_text) < FIRST_SPECIAL_ID

def read_safetensors_header(path: str) -> tuple[int, dict]:
    with open(path, "rb") as f:
        (n,) = struct.unpack("<Q", f.read(8))
        return n, json.loads(f.read(n))

def test_config_against_stored_tensors(raw_config, model):
    path = hf_hub_download(MODEL_ID, "model.safetensors", revision = REVISION)
    n, header = read_safetensors_header(path)
    tensors = {name: t for name, t in header.items() if name != "__metadata__"}

    heads, kv_heads = raw_config["num_attention_heads"], raw_config["num_key_value_heads"]
    hidden = raw_config["hidden_size"]
    head_dim = raw_config.get("head_dim") or hidden // heads
    layers = raw_config["num_hidden_layers"]
    
    # layers in the header = the config's layer count
    indices = {int(m.group(1)) for name in tensors if (m := re.match(r"model\.layers\.(\d+)\.", name))}
    assert indices == set(range(layers))

    for i in range(layers):
        attn = f"model.layers.{i}.self_attn"
        # k_proj, v_proj rows = KV heads * head size, every layer (GQA in the weights)
        assert tensors[f"{attn}.k_proj.weight"]["shape"] == [kv_heads * head_dim, hidden]
        assert tensors[f"{attn}.v_proj.weight"]["shape"] == [kv_heads * head_dim, hidden]

        # q_proj, o_proj = attention heads * head size * square here
        assert tensors[f"{attn}.q_proj.weight"]["shape"] == [heads * head_dim, hidden]
        assert tensors[f"{attn}.o_proj.weight"]["shape"] == [hidden, heads * head_dim]

    # embedding rows = vocabulary size; no separate output layer (tied embeddings)
    assert tensors["model.embed_tokens.weight"]["shape"] == [raw_config["vocab_size"], hidden]
    assert raw_config["tie_word_embeddings"] is True
    assert "lm_head.weight" not in tensors

    # parameters counted from the header = the loaded model's count
    header_params = sum(math.prod(t["shape"]) for t in tensors.values())
    assert header_params == sum(p.numel() for p in model.parameters()) == 494_032_768

    # file size = 8-byte length + header + data
    data_bytes = max(t["data_offsets"][1] for t in tensors.values())
    assert os.path.getsize(path) == 8 + n + data_bytes == 988_097_824

def cache_bytes(cache) -> int:
    return sum(layer.keys.nbytes + layer.values.nbytes for layer in cache.layers)

def test_kv_cache_after_prefill(tokenizer, raw_config, model):
    rendered = tokenizer.apply_chat_template(MESSAGES, tokenize=False, add_generation_prompt=True)
    input_ids = torch.tensor([tokenizer(rendered, add_special_tokens=False)["input_ids"]])
    n = input_ids.shape[1]
    predicted = kv_cache_shape(raw_config, n, dtype_bytes = 4)

    with torch.no_grad():
        out = model(input_ids, use_cache=True)
    cache = out.past_key_values

    # one cache entry per layer; each layer's keys and values have the predicted shape
    assert len(cache.layers) == raw_config["num_hidden_layers"]
    for layer in cache.layers:
        assert tuple(layer.keys.shape) == tuple(layer.values.shape) == predicted.layer_shape
        assert layer.keys.dtype == layer.values.dtype == torch.float32

    # bytes: the tensors' own sizes against the cost model
    total = cache_bytes(cache)
    assert total == predicted.total_bytes == 835_584
    assert total // n == predicted.bytes_per_token == 24_576

    # logits: one score per vocabulary row at every position; 271 rows have no token
    assert tuple(out.logits.shape) == (1, n , raw_config["vocab_size"]) == (1, 34, 151_936)
    assert out.logits.dtype == torch.float32
    assert raw_config["vocab_size"] - len(tokenizer) == 271

    # the hazard: no dtype -> the stored bfloat16 -> half the bytes
    bf16_model = AutoModelForCausalLM.from_pretrained(MODEL_ID, revision=REVISION).eval()
    with torch.no_grad():
        bf16_cache = bf16_model(input_ids, use_cache=True).past_key_values
    assert bf16_cache.layers[0].keys.dtype == torch.bfloat16
    assert cache_bytes(bf16_cache) // n == kv_cache_shape(raw_config, n, dtype_bytes=2).bytes_per_token == 12_288


