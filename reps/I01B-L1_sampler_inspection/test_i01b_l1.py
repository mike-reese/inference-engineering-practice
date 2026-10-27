import copy 
import json 
import pytest 
import torch
from huggingface_hub import hf_hub_download 
from transformers import AutoModelForCausalLM, AutoTokenizer

import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import httpx

REPO_ROOT = Path(__file__).resolve().parents[2]
SERVER_SCRIPT = REPO_ROOT / "scripts" / "llama_cpp_server.py"
SERVER_FLAGS = [
    "--ctx-size", "4096",
    "--parallel", "1",
    "--n-gpu-layers", "99",
    "--jinja",
]

MODEL_ID = "Qwen/Qwen2.5-0.5B-Instruct"
REVISION = "7ae557604adf67be50417f59c2c2f167def9a775"
SYSTEM = "You are a concise assistant for an inference team."
USER = "The KV cache grows during decode. Why does decode slow down?"
MESSAGES = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": USER}]

SEED = 2
SAMPLING = {"do_sample": True, "temperature": 0.7, "top_k": 20, "top_p": 0.8, "repetition_penalty": 1.0}
DEFAULT_PENALTY = {k: v for k, v in SAMPLING.items() if k != "repetition_penalty"}
OUTPUTS = {"max_new_tokens": 1, "output_logits": True, "output_scores": True, "return_dict_in_generate": True}

@pytest.fixture(scope="module")
def tokenizer():
    return AutoTokenizer.from_pretrained(MODEL_ID, revision=REVISION)

@pytest.fixture(scope="module")
def model():
    return AutoModelForCausalLM.from_pretrained(MODEL_ID, revision=REVISION, dtype=torch.float32).eval()

@pytest.fixture(scope="module")
def encoding(tokenizer):
    return tokenizer.apply_chat_template(
        MESSAGES, add_generation_prompt=True, return_tensors="pt", return_dict=True
    )

@pytest.fixture(scope="module")
def raw_generation_config() -> dict:
    with open(hf_hub_download(MODEL_ID, "generation_config.json", revision=REVISION)) as f:
        return json.load(f)


def run_generate(model, encoding, sampling):
    torch.manual_seed(SEED)
    return model.generate(**encoding, **sampling, **OUTPUTS)

def build_processors(model, encoding, sampling):
    config = copy.deepcopy(model.generation_config)
    config.update(**sampling)
    return model._get_logits_processor(
        generation_config=config, input_ids_seq_length=encoding["input_ids"].shape[1]
    )

def test_processor_list_and_order(model, encoding):
    processors = build_processors(model, encoding, SAMPLING)
    assert [type(p).__name__ for p in processors] == [
        "TemperatureLogitsWarper", "TopKLogitsWarper", "TopPLogitsWarper"
    ]
    temperature, top_k, top_p = processors
    assert (temperature.temperature, top_k.top_k, top_p.top_p) == (0.7, 20, 0.8)

    out = run_generate(model, encoding, SAMPLING)
    scores = out.logits[0]
    finite_after_each = []
    for processor in processors:
        scores = processor(encoding["input_ids"], scores)
        finite_after_each.append(int(torch.isfinite(scores).sum()))
    assert finite_after_each == [151936, 20, 2]
    assert torch.equal(scores, out.scores[0])

def recompute_surviving(raw_logits, temperature, top_k, top_p, temperature_last=False):
    logits = raw_logits if temperature_last else raw_logits / temperature
    top_values, top_ids = torch.topk(logits, top_k)
    cumulative = torch.cumsum(torch.softmax(top_values, dim=0), dim=0)
    keep = int((cumulative < top_p).sum()) + 1 
    kept_values, kept_ids = top_values[:keep], top_ids[:keep]
    if temperature_last:
        kept_values = kept_values / temperature
    return kept_ids, torch.softmax(kept_values, dim=-1)

def test_surviving_set_recomputed(model, encoding):
    out = run_generate(model, encoding, SAMPLING)
    raw = out.logits[0][0]
    processed = out.scores[0][0]
    library_ids = torch.isfinite(processed).nonzero().flatten()
    library_probs = torch.softmax(processed, dim=-1)
    temperature, top_k, top_p = SAMPLING["temperature"], SAMPLING["top_k"], SAMPLING["top_p"]

    ids, probs = recompute_surviving(raw, temperature, top_k, top_p)
    assert sorted(ids.tolist()) == sorted(library_ids.tolist())
    assert (probs - library_probs[ids]).abs().max() <= 1e-6

    late_ids, _ = recompute_surviving(raw, temperature, top_k, top_p, temperature_last=True)
    assert len(late_ids) == 4
    assert sorted(late_ids.tolist()) != sorted(library_ids.tolist())

def test_drawn_token_and_seeded_rerun(model, encoding):
    out = run_generate(model, encoding, SAMPLING)
    surviving_ids = torch.isfinite(out.scores[0][0]).nonzero().flatten()
    token_id = out.sequences[0, -1].item()
    assert token_id in surviving_ids.tolist()

    rerun = run_generate(model, encoding, SAMPLING)
    assert rerun.sequences[0,-1].item() == token_id
    assert torch.equal(rerun.logits[0], out.logits[0])
    assert torch.equal(rerun.scores[0], out.scores[0])

def test_checkpoint_repetition_penalty(model, encoding, raw_generation_config):
    assert raw_generation_config["repetition_penalty"] == 1.1 

    processors = build_processors(model, encoding, DEFAULT_PENALTY)
    first = processors[0]
    assert type(first).__name__ == "RepetitionPenaltyLogitsProcessor"
    assert first.penalty == raw_generation_config["repetition_penalty"]

    baseline = run_generate(model, encoding, SAMPLING)
    default_out = run_generate(model, encoding, DEFAULT_PENALTY)
    assert torch.equal(default_out.logits[0], baseline.logits[0])

    default_ids = torch.isfinite(default_out.scores[0][0]).nonzero().flatten()
    recomputed_ids, _ = recompute_surviving(
        default_out.logits[0][0],
        SAMPLING["temperature"],
        SAMPLING["top_k"],
        SAMPLING["top_p"],
    )
    assert sorted(default_ids.tolist()) != sorted(recomputed_ids.tolist())



def run_server_script(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SERVER_SCRIPT), *args],
        capture_output=True,
        text=True,
        timeout=60
    )

@pytest.fixture(scope="module")
def server_url():
    if shutil.which("docker") is None or shutil.which("nvidia-smi") is None:
        pytest.skip("needs Docker and an NVIDIA GPU")
    
    name = f"i01b-test-{uuid.uuid4().hex[:8]}"
    try:
        started = run_server_script("start", name, "--", *SERVER_FLAGS)
        if started.returncode != 0:
            pytest.fail(f"server did not start:\n{started.stderr}")
        yield started.stdout.strip()
    finally:
        stopped = run_server_script("stop", name)
        if stopped.returncode != 0:
            pytest.fail(f"server did not stop:\n{stopped.stderr}")

def test_engine_sampler_order(model, encoding, server_url):
    out = run_generate(model, encoding, SAMPLING)
    library_ids = torch.isfinite(out.scores[0][0]).nonzero().flatten().tolist()

    late_ids, late_probs = recompute_surviving(
        out.logits[0][0],
        SAMPLING["temperature"],
        SAMPLING["top_k"],
        SAMPLING["top_p"],
        temperature_last=True
        
    )
    late_probs_by_id = dict(zip(late_ids.tolist(), late_probs.tolist()))

    props_response = httpx.get(f"{server_url}/props", timeout=10.0)
    props_response.raise_for_status()
    params = props_response.json()["default_generation_settings"]["params"]
    assert params["samplers"][-1] == "temperature"

    response = httpx.post(
        f"{server_url}/completion",
        json={
            "prompt": encoding["input_ids"][0].tolist(),
            "n_predict": 1,
            "temperature": SAMPLING["temperature"],
            "top_k": SAMPLING["top_k"],
            "top_p": SAMPLING["top_p"],
            "min_p": 0.0,
            "n_probs": 20,
            "post_sampling_probs": True,
            "seed": SEED,
            "cache_prompt": False,
        },
        timeout=30.0,
    )
    response.raise_for_status()
    rows = response.json()["completion_probabilities"][0]["top_probs"]
    engine_probs = {row["id"]: row["prob"] for row in rows}

    assert set(engine_probs) == set(late_probs_by_id)
    max_diff = max(
        abs(engine_probs[token_id] - probability)
        for token_id, probability in late_probs_by_id.items()
    )
    assert max_diff <= 0.02
    assert set(engine_probs) != set(library_ids)
