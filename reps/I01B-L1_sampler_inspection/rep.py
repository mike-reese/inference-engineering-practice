import copy
import hashlib
import importlib.util
import json
import os
import platform
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

os.environ.setdefault("HF_HUB_OFFLINE", "1")  # before any Hugging Face import: nothing is downloaded

import httpx
import huggingface_hub
import torch
import safetensors
import transformers
from huggingface_hub import hf_hub_download
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BatchEncoding,
    PreTrainedModel,
    PreTrainedTokenizerBase,
)
from transformers.generation.logits_process import LogitsProcessorList
from transformers.generation.utils import GenerateDecoderOnlyOutput

SEED = 2
OUTPUTS = {
    "max_new_tokens": 1,
    "output_logits": True,
    "output_scores": True,
    "return_dict_in_generate": True,
}

MODEL_ID = "Qwen/Qwen2.5-0.5B-Instruct"
REVISION = "7ae557604adf67be50417f59c2c2f167def9a775"

SAMPLING = {
    "do_sample": True,
    "temperature": 0.7,
    "top_k": 20,
    "top_p": 0.8,
    "repetition_penalty": 1.0,
}

REP_DIR = Path(__file__).resolve().parent
RESULTS_DIR = REP_DIR / "results"
SYSTEM = "You are a concise assistant for an inference team."
USER = "The KV cache grows during decode. Why does decode slow down?"
MESSAGES = [
    {"role": "system", "content": SYSTEM},
    {"role": "user", "content": USER},
]

SERVER_SCRIPT = REP_DIR.parents[1] / "scripts" / "llama_cpp_server.py"
# rep.py starts the server with the script's default image and GGUF, so read them from there.
_spec = importlib.util.spec_from_file_location("llama_cpp_server", SERVER_SCRIPT)
_server_script = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_server_script)
ENGINE_IMAGE: str = _server_script.DEFAULT_IMAGE
ENGINE_GGUF: Path = _server_script.DEFAULT_GGUF.resolve()
SERVER_FLAGS = [
    "--ctx-size", "4096",
    "--parallel", "1",
    "--n-gpu-layers", "99",
    "--jinja",
]
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
    if r.returncode != 0:
        raise RuntimeError(
            f"server did not stop (exit {r.returncode}):\n{r.stderr}"
        )

def engine_identity(docker_cmd: str) -> dict[str, Any]:
    """The engine run's system under test: GPU and driver, image digest, GGUF size and sha256."""
    if ENGINE_IMAGE not in docker_cmd or f"/models/{ENGINE_GGUF.name}" not in docker_cmd:
        raise RuntimeError(f"docker run does not use {ENGINE_IMAGE} and {ENGINE_GGUF.name}:\n{docker_cmd}")
    gpu = subprocess.run(
        ["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader"],
        capture_output=True, text=True, timeout=30, check=True,
    ).stdout.strip()
    image_id = subprocess.run(
        ["docker", "image", "inspect", "--format", "{{.Id}}", ENGINE_IMAGE],
        capture_output=True, text=True, timeout=30, check=True,
    ).stdout.strip()
    with ENGINE_GGUF.open("rb") as f:
        gguf_sha256 = hashlib.file_digest(f, "sha256").hexdigest()
    return {
        "gpu_name_driver": gpu,
        "engine_image": ENGINE_IMAGE,
        "engine_image_id": image_id,
        "gguf_path": str(ENGINE_GGUF),
        "gguf_bytes": ENGINE_GGUF.stat().st_size,
        "gguf_sha256": gguf_sha256,
    }


def configuration(server_url: str, docker_cmd: str) -> dict[str, Any]:
    """Step 1: versions, revision, dtype, device, the docker run command, the server's build_info from GET /props,
    and the engine's GPU, driver, image digest and GGUF identity."""
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
        **engine_identity(docker_cmd),
        "huggingface_hub": huggingface_hub.__version__,
        "tokenizer_revision": REVISION,
        "messages": MESSAGES,
        "sampling": SAMPLING,
        "output_fields": OUTPUTS,
        "seed": SEED,
    }
    emit("== Configuration")
    for key, value in config.items():
        emit(f"{key:18} {value}")
    return config


def build_processors(
    model: PreTrainedModel,
    encoding: BatchEncoding,
    sampling: dict[str, Any],
) -> LogitsProcessorList:
    config = copy.deepcopy(model.generation_config)
    config.update(**sampling)
  
    return model._get_logits_processor(
        generation_config = config,
        input_ids_seq_length=encoding["input_ids"].shape[1],
    )

def run_generate(
    model: PreTrainedModel,
    encoding: BatchEncoding,
    sampling: dict[str, Any],
) -> GenerateDecoderOnlyOutput:
    torch.manual_seed(SEED)
    return model.generate(**encoding, **sampling, **OUTPUTS)

def recompute_surviving(
    raw_logits: torch.Tensor,
    temperature: float,
    top_k: int,
    top_p: float,
    temperature_last: bool = False,
) -> tuple[torch.Tensor, torch.Tensor]:
    logits = raw_logits if temperature_last else raw_logits / temperature
    top_values, top_ids = torch.topk(logits, top_k)
    cumulative = torch.cumsum(torch.softmax(top_values,dim=0),dim=0)
    keep = int((cumulative < top_p).sum()) + 1
    kept_values, kept_ids = top_values[:keep], top_ids[:keep]
    if temperature_last:
        kept_values = kept_values / temperature
    return kept_ids, torch.softmax(kept_values, dim=-1)


def inspect_processor_list(
    model: PreTrainedModel,
    encoding: BatchEncoding,
) -> dict[str, Any]:
    path = hf_hub_download(
        MODEL_ID,
        "generation_config.json",
        revision=REVISION,
        local_files_only=True,
    )
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)

    loaded = {
        key: getattr(model.generation_config, key) for key in raw
    }
    config = copy.deepcopy(model.generation_config)
    config.update(**SAMPLING)
    resolved = {key: getattr(config, key) for key in raw}

    emit()
    emit("== Point 1: checkpoint fields")
    emit("Field: raw file | loaded defaults | resolved request")
    for key in raw:
        emit(f"{key}: {raw[key]!r} | {loaded[key]!r} | {resolved[key]!r}")
    emit(f"Loaded checkpoint fields match raw file: {loaded == raw}")

    processors = build_processors(model, encoding, SAMPLING)
    processor_records = []
    emit("Processors in execution order:")
    for position, processor in enumerate(processors, start=1):
        parameters = {
            key: "-inf" if value==float("-inf") else value for key, value in vars(processor).items()
        }
        record = {
            "position": position,
            "class": type(processor).__name__,
            "parameters": parameters,
        }
        processor_records.append(record)
        emit(f"{position}. {record['class']}: {parameters}")

    return {
        "raw_generation_config": raw,
        "loaded_checkpoint_fields": loaded,
        "resolved_checkpoint_fields": resolved,
        "defaults_match": loaded == raw,
        "processors": processor_records,
    }

def inspect_generation_output(
    out: GenerateDecoderOnlyOutput,
    encoding: BatchEncoding,
) -> dict[str, Any]:
    prompt_ids = encoding["input_ids"]
    prompt_length = prompt_ids.shape[1]

    record = {
        "prompt_length": prompt_length,
        "prompt_ids": prompt_ids[0].tolist(),
        "sequences": {
            "shape": list(out.sequences.shape),
            "dtype": str(out.sequences.dtype),
            "ids": out.sequences[0].tolist(),
        },
        "logits": {
            "step_count": len(out.logits),
            "step_1_shape": list(out.logits[0].shape),
            "step_1_dtype": str(out.logits[0].dtype),
        },
        "scores": {
            "step_count": len(out.scores),
            "step_1_shape": list(out.scores[0].shape),
            "step_1_dtype": str(out.scores[0].dtype),
        },
        "cache_type": type(out.past_key_values).__name__,
        "cache_length": int(out.past_key_values.get_seq_length()),
        "prompt_prefix_matches": torch.equal(
            out.sequences[:, :prompt_length],
            prompt_ids,
        ),
    }

    emit()
    emit("== Generation output")
    for name, value in record.items():
        emit(f"{name}: {value}")

    return record

def inspect_processor_steps(
    processors: LogitsProcessorList,
    encoding: BatchEncoding,
    out: GenerateDecoderOnlyOutput,
) -> dict[str, Any]:
    scores = out.logits[0].clone()
    steps = []

    emit()
    emit("== Point 2: processors applied one at a time")
    for position, processor in enumerate(processors, start=1):
        scores = processor(encoding["input_ids"], scores)
        largest_score, largest_id = scores[0].max(dim=0)
        record = {
            "position": position,
            "class": type(processor).__name__,
            "finite_entries": int(torch.isfinite(scores).sum()),
            "largest_token_id": int(largest_id.item()),
            "largest_score": float(largest_score.item()),
        }
        steps.append(record)
        emit(
            f"{position}. {record['class']}: "
            f"finite_entries={record['finite_entries']}, "
            f"largest_token_id={record['largest_token_id']}, "
            f"largest_score={record['largest_score']!r}"
        )

    matches = torch.equal(scores, out.scores[0])
    emit(f"Replayed processors equal generate scores: {matches}")

    return {
        "steps": steps,
        "matches_generate_scores": matches,
    }       


def inspect_surviving_set(
    tokenizer: PreTrainedTokenizerBase,
    out: GenerateDecoderOnlyOutput,
) -> dict[str, Any]:
    raw = out.logits[0][0]
    processed = out.scores[0][0]
    library_ids = torch.isfinite(processed).nonzero().flatten()
    library_probs = torch.softmax(processed, dim=-1)

    temperature = SAMPLING["temperature"]
    top_k = SAMPLING["top_k"]
    top_p = SAMPLING["top_p"]

    library_rows = []
    emit()
    emit("== Point 2: surviving tokens")
    emit("ID | piece | logit | score | probability")
    for token_id in library_ids.tolist():
        row = {
            "id": token_id,
            "piece": tokenizer.decode([token_id]),
            "logit": float(raw[token_id].item()),
            "score": float(processed[token_id].item()),
            "probability": float(library_probs[token_id].item()),
        }
        library_rows.append(row)
        emit(" | ".join(repr(value) for value in row.values()))

    top_values, top_ids = torch.topk(raw / temperature, top_k)
    top_probs = torch.softmax(top_values, dim=0)
    cumulative = torch.cumsum(top_probs, dim=0)
    keep = int((cumulative < top_p).sum()) + 1

    top_rows = []
    emit(f"Top-{top_k} of {raw.numel()} vocabulary entries; remainder omitted")
    emit("rank | ID | piece | logit | probability in top-k | cumulative | kept")
    for rank, token_id in enumerate(top_ids.tolist(), start=1):
        index = rank - 1
        row = {
            "rank": rank,
            "id": token_id,
            "piece": tokenizer.decode([token_id]),
            "logit": float(raw[token_id].item()),
            "probability_in_top_k": float(top_probs[index].item()),
            "cumulative_probability": float(cumulative[index].item()),
            "kept": rank <= keep,
        }
        top_rows.append(row)
        emit(" | ".join(repr(value) for value in row.values()))
    emit(f"Top-p threshold: {top_p}; retained tokens: {keep}")

    ids, probs = recompute_surviving(raw, temperature, top_k, top_p)
    recomputed = {
        "ids": ids.tolist(),
        "pieces": [tokenizer.decode([i]) for i in ids.tolist()],
        "probabilities": probs.tolist(),
    }
    ids_match = set(ids.tolist()) == set(library_ids.tolist())
    max_diff = float((probs - library_probs[ids]).abs().max().item())
    probabilities_match = ids_match and max_diff <= 1e-6

    late_ids, late_probs = recompute_surviving(
        raw, temperature, top_k, top_p, temperature_last=True
    )
    temperature_last = {
        "ids": late_ids.tolist(),
        "pieces": [tokenizer.decode([i]) for i in late_ids.tolist()],
        "probabilities": late_probs.tolist(),
    }
    late_differs = set(late_ids.tolist()) != set(library_ids.tolist())

    emit(f"Recomputed survivors: {recomputed}")
    emit(f"Surviving IDs match: {ids_match}")
    emit(f"Maximum probability difference at recomputed IDs: {max_diff!r}")
    emit(f"IDs and probabilities match within 1e-6: {probabilities_match}")
    emit(f"Temperature-last survivors: {temperature_last}")
    emit(f"Temperature-last IDs differ from library IDs: {late_differs}")

    return {
        "library_survivors": library_rows,
        "top_k_table": top_rows,
        "top_p": top_p,
        "retained_count": keep,
        "recomputed": recomputed,
        "ids_match": ids_match,
        "max_probability_difference_at_recomputed_ids": max_diff,
        "probability_tolerance": 1e-6,
        "probabilities_match": probabilities_match,
        "temperature_last": temperature_last,
        "temperature_last_ids_differ": late_differs,
    }


def inspect_engine(
    server_url: str,
    tokenizer: PreTrainedTokenizerBase,
    encoding: BatchEncoding,
    out: GenerateDecoderOnlyOutput,
) -> dict[str, Any]:
    response = httpx.get(f"{server_url}/props", timeout=10.0)
    response.raise_for_status()
    props = response.json()
    params = props["default_generation_settings"]["params"]

    emit()
    emit("== Point 2: llama.cpp comparison")
    emit(f"Sampler order: {params['samplers']}")
    for key in (
        "temperature", "top_k", "top_p", "min_p",
        "repeat_penalty", "repeat_last_n",
    ):
        emit(f"Default {key}: {params[key]!r}")

    request = {
        "prompt": encoding["input_ids"][0].tolist(),
        "n_predict": 1,
        "temperature": SAMPLING["temperature"],
        "top_k": SAMPLING["top_k"],
        "top_p": SAMPLING["top_p"],
        "min_p": 0.0,
        "n_probs": SAMPLING["top_k"],
        "post_sampling_probs": True,
        "seed": SEED,
        "cache_prompt": False,
    }
    response = httpx.post(
        f"{server_url}/completion", json=request, timeout=30.0
    )
    response.raise_for_status()
    completion = response.json()
    candidates = completion["completion_probabilities"][0]["top_probs"]
    engine_probs = {row["id"]: row["prob"] for row in candidates}

    raw = out.logits[0][0]
    late_ids, late_probs = recompute_surviving(
        raw,
        SAMPLING["temperature"],
        SAMPLING["top_k"],
        SAMPLING["top_p"],
        temperature_last=True,
    )
    late_by_id = dict(zip(late_ids.tolist(), late_probs.tolist()))
    library_ids = set(
        torch.isfinite(out.scores[0][0]).nonzero().flatten().tolist()
    )
    library_probs = torch.softmax(out.scores[0][0], dim=-1)

    comparison_rows = []
    all_ids = sorted(set(engine_probs) | set(late_by_id) | library_ids)
    emit("ID | piece | engine probability | temperature-last probability | generate probability")
    for token_id in all_ids:
        row = {
            "id": token_id,
            "piece": tokenizer.decode([token_id]),
            "engine_probability": engine_probs.get(token_id, 0.0),
            "temperature_last_probability": late_by_id.get(token_id, 0.0),
            "generate_probability": float(library_probs[token_id].item()),
        }
        comparison_rows.append(row)
        emit(" | ".join(repr(value) for value in row.values()))

    ids_match = set(engine_probs) == set(late_by_id)
    max_diff = max(
        abs(row["engine_probability"] - row["temperature_last_probability"])
        for row in comparison_rows
    )
    differs_from_generate = set(engine_probs) != library_ids
    probabilities_match = ids_match and max_diff <= 0.02
    temperature_is_last = params["samplers"][-1] == "temperature"

    emit(f"Temperature is last in server chain: {temperature_is_last}")
    emit(f"Engine IDs match temperature-last IDs: {ids_match}")
    emit(f"Maximum surviving-probability difference: {max_diff!r}")
    emit(f"IDs and probabilities match within 0.02: {probabilities_match}")
    emit(f"Surviving counts, engine/generate: {len(engine_probs)}/{len(library_ids)}")
    emit(f"Engine IDs differ from generate IDs: {differs_from_generate}")
    emit(f"Echoed generation settings: {completion['generation_settings']}")

    raw_request = {
        **request,
        "temperature": 0.0,
        "post_sampling_probs": False,
    }
    response = httpx.post(
        f"{server_url}/completion", json=raw_request, timeout=30.0
    )
    response.raise_for_status()
    raw_completion = response.json()
    candidates = raw_completion["completion_probabilities"][0]["top_logprobs"]
    cpu_logprobs = torch.log_softmax(raw.double(), dim=-1)

    logprob_rows = []
    for rank, candidate in enumerate(candidates, start=1):
        token_id = candidate["id"]
        cpu_value = float(cpu_logprobs[token_id].item())
        row = {
            "rank": rank,
            "id": token_id,
            "piece": tokenizer.decode([token_id]),
            "engine_logprob": candidate["logprob"],
            "transformers_logprob": cpu_value,
            "engine_minus_transformers": candidate["logprob"] - cpu_value,
        }
        logprob_rows.append(row)

    max_logprob_diff = max(
        abs(row["engine_minus_transformers"]) for row in logprob_rows
    )
    emit(f"Pre-sampling log-probabilities: first 5 of {len(logprob_rows)} engine candidates")
    for row in logprob_rows[:5]:
        emit(str(row))
    emit(f"Maximum absolute log-probability difference over all candidates: {max_logprob_diff!r}")

    return {
        "server_props": props,
        "request": request,
        "completion": completion,
        "comparison_rows": comparison_rows,
        "temperature_is_last": temperature_is_last,
        "temperature_last_ids_match": ids_match,
        "max_probability_difference": max_diff,
        "probability_tolerance": 0.02,
        "probabilities_match": probabilities_match,
        "engine_differs_from_generate": differs_from_generate,
        "raw_logprob_request": raw_request,
        "raw_logprob_completion": raw_completion,
        "logprob_comparison_rows": logprob_rows,
        "max_absolute_logprob_difference": max_logprob_diff,
    }


def inspect_draw(
    model: PreTrainedModel,
    tokenizer: PreTrainedTokenizerBase,
    encoding: BatchEncoding,
    out: GenerateDecoderOnlyOutput,
) -> dict[str, Any]:
    processed = out.scores[0][0]
    probabilities = torch.softmax(processed, dim=-1)
    token_id = int(out.sequences[0, -1].item())
    surviving_ids = torch.isfinite(processed).nonzero().flatten().tolist()
    rank = int((processed > processed[token_id]).sum().item()) + 1

    rerun = run_generate(model, encoding, SAMPLING)
    rerun_token_id = int(rerun.sequences[0, -1].item())

    record = {
        "seed": SEED,
        "token_id": token_id,
        "piece": tokenizer.decode([token_id]),
        "rank_by_processed_score": rank,
        "probability": float(probabilities[token_id].item()),
        "in_surviving_set": token_id in surviving_ids,
        "rerun_token_id": rerun_token_id,
        "rerun_token_matches": rerun_token_id == token_id,
        "rerun_logits_match": torch.equal(rerun.logits[0], out.logits[0]),
        "rerun_scores_match": torch.equal(rerun.scores[0], out.scores[0]),
    }

    emit()
    emit("== Point 3: the drawn token and same-seed rerun")
    for name, value in record.items():
        emit(f"{name}: {value}")

    return record


def inspect_repetition_penalty(
    model: PreTrainedModel,
    tokenizer: PreTrainedTokenizerBase,
    encoding: BatchEncoding,
    baseline: GenerateDecoderOnlyOutput,
) -> dict[str, Any]:
    sampling = {
        key: value
        for key, value in SAMPLING.items()
        if key != "repetition_penalty"
    }
    processors = build_processors(model, encoding, sampling)
    processor_records = []
    for position, processor in enumerate(processors, start=1):
        parameters = {
            key: "-inf" if value == float("-inf") else value
            for key, value in vars(processor).items()
        }
        processor_records.append({
            "position": position,
            "class": type(processor).__name__,
            "parameters": parameters,
        })

    out = run_generate(model, encoding, sampling)
    processed = out.scores[0][0]
    probabilities = torch.softmax(processed, dim=-1)
    surviving_ids = torch.isfinite(processed).nonzero().flatten().tolist()
    survivors = [
        {
            "id": token_id,
            "piece": tokenizer.decode([token_id]),
            "probability": float(probabilities[token_id].item()),
        }
        for token_id in surviving_ids
    ]
    survivors.sort(key=lambda row: row["probability"], reverse=True)

    without_ids, without_probs = recompute_surviving(
        out.logits[0][0],
        SAMPLING["temperature"],
        SAMPLING["top_k"],
        SAMPLING["top_p"],
    )
    without_penalty = [
        {
            "id": token_id,
            "piece": tokenizer.decode([token_id]),
            "probability": probability,
        }
        for token_id, probability in zip(
            without_ids.tolist(), without_probs.tolist()
        )
    ]
    token_id = int(out.sequences[0, -1].item())

    record = {
        "request_sampling_fields": sampling,
        "checkpoint_repetition_penalty": model.generation_config.repetition_penalty,
        "processors": processor_records,
        "raw_logits_match_baseline": torch.equal(
            out.logits[0], baseline.logits[0]
        ),
        "processed_scores_match_baseline": torch.equal(
            out.scores[0], baseline.scores[0]
        ),
        "survivors": survivors,
        "drawn_token_id": token_id,
        "drawn_piece": tokenizer.decode([token_id]),
        "baseline_token_id": int(baseline.sequences[0, -1].item()),
        "recomputed_without_penalty": without_penalty,
        "surviving_ids_differ_from_recomputation": (
            set(surviving_ids) != set(without_ids.tolist())
        ),
        "draw_in_recomputed_set": token_id in without_ids.tolist(),
    }

    emit()
    emit("== Hazard: checkpoint repetition penalty")
    for name, value in record.items():
        emit(f"{name}: {value}")

    return record


def save_results(records: dict[str, Any]) -> None:
    json_text = json.dumps(
        records,
        indent=2,
        ensure_ascii=False,
        allow_nan=False,
    ) + "\n"

    RESULTS_DIR.mkdir(exist_ok=True)
    record_path = RESULTS_DIR / "record.json"
    output_path = RESULTS_DIR / "output.txt"

    record_path.write_text(json_text, encoding="utf-8")

    emit(f"Results JSON: {record_path}")
    emit(f"Printed output: {output_path}")
    output_path.write_text("\n".join(LINES) + "\n", encoding="utf-8")


def main() -> int:
    tokenizer = AutoTokenizer.from_pretrained(
        MODEL_ID,
        revision=REVISION,
        local_files_only=True,
    )
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_ID,
        revision=REVISION,
        dtype=torch.float32,
        local_files_only=True,
    ).to("cpu").eval()

    encoding = tokenizer.apply_chat_template(
        MESSAGES,
        add_generation_prompt=True,
        return_tensors="pt",
        return_dict=True,
    )

    records: dict[str, Any] = {}
    server_name = f"i01b-rep-{uuid.uuid4().hex[:8]}"

    try:
        server_url, docker_cmd = start_server(server_name)
        records["configuration"] = configuration(server_url, docker_cmd)

        records["processor_list"] = inspect_processor_list(model, encoding)
        processors = build_processors(model, encoding, SAMPLING)

        out = run_generate(model, encoding, SAMPLING)
        records["generation_output"] = inspect_generation_output(out, encoding)

        records["processor_steps"] = inspect_processor_steps(
            processors, encoding, out
        )
        records["surviving_set"] = inspect_surviving_set(tokenizer, out)
        records["engine"] = inspect_engine(
            server_url, tokenizer, encoding, out
        )
        records["draw"] = inspect_draw(model, tokenizer, encoding, out)
        records["repetition_penalty"] = inspect_repetition_penalty(
            model, tokenizer, encoding, out
        )
    finally:
        try:
            stop_server(server_name)
        finally:
            save_results(records)

    return 0


if __name__ == "__main__":
    sys.exit(main())
