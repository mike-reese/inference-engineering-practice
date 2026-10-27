import pytest
import json
from inference_analysis.kv_cache import KVCacheShape, kv_cache_shape
from huggingface_hub import hf_hub_download

QWEN_REPO = "Qwen/Qwen2.5-0.5B-Instruct"
QWEN_REVISION = "7ae557604adf67be50417f59c2c2f167def9a775"
PROMPT_TOKENS = 34


@pytest.fixture(scope="module")
def qwen_config() -> dict:
    path = hf_hub_download(QWEN_REPO, "config.json", revision=QWEN_REVISION, local_files_only=True)
    with open(path) as f:
        return json.load(f)

def test_float32_cache_matches(qwen_config):
    assert kv_cache_shape(qwen_config, PROMPT_TOKENS) == KVCacheShape(
        layer_shape=(1,2,34,64),
        bytes_per_layer=2 * 17_408,
        bytes_per_token=24_576,
        total_bytes=835_584,
    )

def test_bfloat16_halves_cache(qwen_config):
    shape = kv_cache_shape(qwen_config, PROMPT_TOKENS, dtype_bytes=2)
    assert shape.bytes_per_token == 12_288
    assert shape.total_bytes == 835_584 // 2

def test_explicit_head_dim_is_used(qwen_config):
    config = {**qwen_config, "head_dim": 128}
    shape = kv_cache_shape(config, PROMPT_TOKENS)
    assert shape.layer_shape == (1, 2, 34, 128)
    assert shape.bytes_per_token == 2 * 24_576
