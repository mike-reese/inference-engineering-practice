from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

@dataclass(frozen=True)
class KVCacheShape:
    """The predicted KV cache of one model for one batch of sequences."""

    layer_shape: tuple[int, int, int, int]
    """Shape of one layer's keys, equal to its values: (batch, kv_heads, seq_len, head_dim)"""
    bytes_per_layer: int
    """Keys plus values in one layer"""
    bytes_per_token: int
    """Keys plus values across all layers, for one token of one sequence"""
    total_bytes: int
    """The whole cache: bytes_per_token x batch x seq_len"""


def kv_cache_shape(
    config: Mapping[str, Any],
    seq_len: int,
    batch: int = 1,
    dtype_bytes: int = 4,
) -> KVCacheShape:
    """Predict the KV cache's size from a model config without running the model

    config: the fields of the model's config.json.
        Reads num_hidden_layers, num_key_value_heads, and head_dim;
        when head_dim is absent, it is hidden_size / num_attention_heads
    seq_len: tokens per sequence held in the cache
    batch: sequences in the batch
    dtype_bytes: bytes per element of the cached keys and values
        (4 for float32, 2 for bfloat16 or float16)

    Formula:
        head_dim = config["head_dim"] or hidden_size / num_attention_heads
        layer_shape = (batch, num_key_value_heads, seq_len, head_dim)
        bytes_per_layer = 2 x batch x num_key_value_heads x seq_len x head_dim x dtype_bytes
        bytes_per_token = 2 x num_hidden_layers x num_key_value_heads x head_dim x dtype_bytes
        total_bytes = num_hidden_layers x bytes_per_layer

    The 2 counts keys and values: each layer caches one of each.
    """
    num_key_value_heads = config["num_key_value_heads"]
    num_hidden_layers = config["num_hidden_layers"]
    
    if config.get("head_dim"):
        head_dim = config["head_dim"]
    else:
        head_dim= config["hidden_size"] // config["num_attention_heads"]
    layer_shape = (batch, num_key_value_heads, seq_len, head_dim)
    bytes_per_layer = 2 * batch * seq_len * dtype_bytes * head_dim * num_key_value_heads
    bytes_per_token = 2 * dtype_bytes * head_dim * num_key_value_heads * num_hidden_layers
    total_bytes = bytes_per_layer * num_hidden_layers

    return KVCacheShape(
        layer_shape=layer_shape,
        bytes_per_layer=bytes_per_layer,
        bytes_per_token=bytes_per_token,
        total_bytes=total_bytes
    )

