# I01A-L1 -- Chat Request Inspection Points

## Mechanism
We are studying what a chat request turns into before a model generates anything.

## Task
We will inspect a chat request at 4 points, using the transformers library and validating with separate checks for each point from an independent source.

1. Message request -> Template. Inspected in transformers, validated by llama.cpp's serving engine.
2. Template -> Tokens. Inspected in transformers, validated by llama.cpp's tokenizer.
3. Config. Inspected in transformers' config.json, validated via the safetensors header bytes.
4. KV Cache. Inspected from a prefill forward pass from the model in transformers, validated via handcoded KV Cache arithmetic.

## Configuration

| Item | This rep |
| --- | --- |
| Model and revision | `Qwen/Qwen2.5-0.5B-Instruct` @ `7ae557604adf67be50417f59c2c2f167def9a775`, local cache, `HF_HUB_OFFLINE=1` |
| Reference library | transformers 5.20.2, torch 2.14.0+cu126, safetensors 0.8.0, httpx 0.28.1; Python 3.12.14 |
| dtype and device | float32, CPU (Intel i9-9900K, 8 torch threads), `model.eval()`, `torch.no_grad()` |
| Engine | llama.cpp b6500 (commit `a7a98e0fffed`, `build_info` `b6500-a7a98e0fffed+firstfit`) |
| Engine image | `telos-llama:b6500-firstfit-cuda12.4-sm61-nsys2023.4.4` (`sha256:8cbe0ac473189ff807a993929ecc952cbf224e17fed15c063bbc5cdfd205b070`) |
| Engine's model file | `Qwen2.5-0.5B-Instruct-f32.gguf`, 1,982,078,784 bytes, sha256 `5398ce9e21beb102f3bac22625596fa8e1a3333a99696a84a6cde43a3c60c53f` |
| Server flags | `--ctx-size 4096 --parallel 1 --n-gpu-layers 99 --jinja` |
| GPU | GTX 1080 Ti (llama.cpp only; transformers runs on CPU) |
| Request | `SYSTEM` and `USER` constants in `rep.py`: system `You are a concise assistant for an inference team.`; user `Why does decode slow down as the KV cache grows?` |

The full `docker run` command is recorded in `results/output.txt` and `results/record.json` (`configuration.docker_run`).

## Reproducing The Server
- Docker Image: `telos-llama:b6500-firstfit-cuda12.4-sm61-nsys2023.4.4`, built in three layers. The Dockerfiles are in the course repo's `tools/docker/`.
  1. `telos-llama:b6500-cuda12.4-sm61`: llama.cpp b6500 built with upstream's `.devops/cuda.Dockerfile`: target server, CUDA 12.4.0, Ubuntu 22.04, architecture 61.
  2. `telos-llama:b6500-cuda12.4-sm61-nsys2023.4.4`: `llama-nsys.Dockerfile` adds the Nsight Systems 2023.4.4 CLI.
  3. `telos-llama:b6500-firstfit-cuda12.4-sm61-nsys2023.4.4`: `llama-firstfit.Dockerfile` adds a `llama-server` built from b6500 with a first-fit option in ggml's graph allocator (`ggml/src/ggml-alloc.c`, `GGML_ALLOC_POLICY=first_fit` by default). It shrinks the compute buffer and leaves replies and speed unchanged. Upstream's binary stays at `/app/llama-server`.
- GGUF: llama.cpp provides a convert_hf_to_gguf.py script. We ran that on our Qwen2.5-0.5B-Instruct in F32 so that llama.cpp's results can be compared with PyTorch's float32 run. We chose FP32 because the 1080TI is an older card and doesn't support fast FP16 or BF16 (the native format for Qwen) - its native full-speed type is FP32.

## Server Script
`scripts/llama_cpp_server.py`, with `start <name> -- <flags>` and `stop <name>` subcommands. `rep.py` and the test fixture call it through `subprocess.run`.

- **Start:** prints the full `docker run` command to stderr, publishes container port 8080 on `127.0.0.1` with the host port assigned by Docker, reads it back with `docker port`, and prints the base URL as the last line of stdout.
- **Ready:** polls `GET /health` every 0.1 s. `httpx.TransportError` and 503 both mean "not yet". Fails with the last 20 log lines if the container stops first or the timeout passes.
- **Ready timeout, 30 s:** the measured warm start is about 0.8–1.2 s. A cold start after a reboot reads 1.9 GB from disk, which is several seconds. 30 s covers that with margin and still fails fast on a hung start.
- **Stop:** succeeds when the container is already gone. After `docker stop`, it waits (up to 15 s) until `docker ps -a --filter name=^<name>$` is empty, because `--rm` removal finishes after `docker stop` returns.
- **Design choice: `--rm`.** Cleanup is automatic, and a leftover container cannot hold the name or ~2.4 GB of GPU memory. The cost is that a failed start loses its log. The most common cause of that, a wrong GGUF path, is checked on the host before `docker run`, so it fails with a clear message (`GGUF not found: ...`) instead of an empty log.

## Inspection Table

| Point | Value | Library reports | What it means | How we know (second source) | Difference |
| --- | --- | --- | --- | --- | --- |
| 1 rendering | Rendered input string | 178-character ChatML string (full `repr` below) | The one string the engine feeds the model: each message wrapped in turn markers, then the opening of the assistant's turn | llama.cpp `POST /apply-template` `prompt` | none (equal) |
| 1 rendering | Special tokens in the string (`<\|im_start\|>`, `<\|im_end\|>`) | `<\|im_start\|>` at characters 0, 80, 156; `<\|im_end\|>` at 69, 145 | Turn markers. Each opens or closes one role's turn | the same positions in llama.cpp's render (strings are equal) | none |
| 1 rendering | Generation prompt (suffix from `add_generation_prompt=True`) | `'<\|im_start\|>assistant\n'` | Opens the assistant's turn, so the model answers instead of continuing the user's message | render minus the `add_generation_prompt=False` render | none |
| 1 rendering | System message when the request has none | `You are Qwen, created by Alibaba Cloud. You are a helpful assistant.` | The template's `{%- else %}` branch (under `{%- if tools %}` → `else`) adds a default system message | llama.cpp's user-only render contains the same text | none |
| 1 rendering | Chat template (GGUF against `tokenizer_config.json`) | 2,507 characters in `tokenizer_config.json` | The Jinja program that turns messages into the string | GGUF's `chat_template` from `GET /props`, 2,507 characters | none (equal) |
| 2 tokenization | Token count | 34 | The sequence length the model sees; it sets the KV cache's T | llama.cpp `POST /tokenize` returns 34 | none |
| 2 tokenization | Token IDs and pieces | K5's 34 IDs; byte-level pieces (`Ġ` = leading space, `Ċ` = newline) | Each piece is one vocabulary row | `/tokenize` with `with_pieces: true`: same IDs; pieces show a plain space and `\n` | none in IDs; pieces differ only in display |
| 2 tokenization | Special-token IDs | 151644 `<\|im_start\|>` ×3, 151645 `<\|im_end\|>` ×2 | Each marker is one reserved ID, not text | same IDs and counts from `/tokenize` | none |
| 2 tokenization | Special tokens parsed as plain text | `split_special_tokens=True`: 55 IDs, highest 84648; starts `<`, `\|`, `im`, `_start`, `\|`, `>` | The hazard: the model never sees its turn markers, and nothing errors | `/tokenize` with `parse_special: false`: the same 55 IDs | none |
| 3 config | Layers | 24 (`num_hidden_layers`) | The number of layers in the transformer | header layer indices 0–23 | none |
| 3 config | Attention heads | 14 (`num_attention_heads`) | The number of attention heads (specifically Q) in each layer | `q_proj.weight` [896, 896] = 14 × 64 rows | none |
| 3 config | KV heads | 2 (`num_key_value_heads`) | The number of KV head pairs per layer (K, V); 7 query heads share each one (grouped-query attention) | `k_proj.weight`, `v_proj.weight` [128, 896] = 2 × 64 rows | none |
| 3 config | Head size | 64 (no `head_dim` in `config.json`; 896 / 14) | The slice of the hidden size that each attention head (Q) gets at each layer | `q_proj` 896 / 14 heads and `k_proj` 128 / 2 heads both give 64 | none |
| 3 config | Hidden size | 896 (`hidden_size`) | The width of the vectors flowing through the model (the activations) | `embed_tokens.weight` columns = 896 | none |
| 3 config | Intermediate size | 4864 (`intermediate_size`) | The width of the vectors inside the MLP, after the up proj and before the down proj | `gate_proj.weight` [4864, 896], `down_proj.weight` [896, 4864] | none |
| 3 config | Vocabulary size | 151936 (`vocab_size`) | The number of rows in the embedding table, one per possible token ID | `embed_tokens.weight` rows = 151,936 | none |
| 3 config | Context window | 32768 (`max_position_embeddings`) | The maximum number of positions the model was trained for (the largest RoPE position used) | none in the header: RoPE has no stored weights | not checked by a second source |
| 3 config | `tie_word_embeddings` | true | The model uses the same matrix at both ends: the embedding lookup on input and the lm_head that makes the logits on output. Untied means two separate learned matrices | no `lm_head.weight` in the header | none |
| 3 config | Stored dtype | bfloat16 (`torch_dtype`) | The dtype of the weights in the checkpoint on disk. We load float32 for this exercise | header: all 290 tensors `BF16`; data bytes = 2 × parameters | none |
| 3 config | Parameter count and file size | 494,032,768 (`sum(p.numel())`) | The model's size; at 2 bytes each, 988 MB of weights | header shapes sum to 494,032,768; file 988,097,824 = 8 + 32,280 + 988,065,536 | none |
| 4 after prefill | Logits shape | (1, 34, 151936) | One score per vocabulary row at each of the 34 positions | (batch, T, `vocab_size`) from K5 and the config | none |
| 4 after prefill | Logits dtype | float32 | Follows the model's load dtype | `dtype=torch.float32` at load | none |
| 4 after prefill | Logits width against tokenizer length | 151,936 against `len(tokenizer)` 151,665 | 271 embedding rows have no token: padding of the matrix | embedding matrix rows − `len(tokenizer)` = 271 | none |
| 4 after prefill | Keys and values shape, per layer | (1, 2, 34, 64) in all 24 layers | (batch, KV heads, T, head size) | `kv_cache_shape(config, 34).layer_shape` | none |
| 4 after prefill | Cache dtype | float32 | Follows the model's load dtype; without `dtype` it would be bfloat16 | `dtype_bytes=4` in `kv_cache_shape` | none |
| 4 after prefill | Cache bytes per layer | 34,816 (17,408 K + 17,408 V) | 2 × 2 heads × 34 tokens × 64 × 4 bytes | `kv_cache_shape(...).bytes_per_layer` | none |
| 4 after prefill | Cache bytes per token | 24,576 | 2 × 24 layers × 2 KV heads × 64 × 4 bytes; the number every capacity plan starts from | `kv_cache_shape(...).bytes_per_token` | none |
| 4 after prefill | Cache bytes in total | 835,584 | 24,576 × 34 tokens | `kv_cache_shape(...).total_bytes` | none |

The rendered input string (K1), one string shown with `repr` split by line:

```
'<|im_start|>system\n'
'You are a concise assistant for an inference team.<|im_end|>\n'
'<|im_start|>user\n'
'Why does decode slow down as the KV cache grows?<|im_end|>\n'
'<|im_start|>assistant\n'
```

All values above come from `results/output.txt` and `results/record.json`.

## Pass Check

**Status: passing.** `HF_HUB_OFFLINE=1 uv run pytest` on 2026-10-27: 12 passed, none skipped (16 s).

- `reps/I01A-L1_chat_request_inspection/test_i01a_l1.py`: the four pass checks below, against a live llama.cpp server.
- `tests/test_kv_cache.py`: 3 tests (K12, K13, and an explicit `head_dim`).
- `tests/test_llama_cpp_server.py`: the server script's tests.

The checks, from the spec:

| # | Check | Rows |
| --- | --- | --- |
| 1 | Template: one rendered string, two implementations | K1–K4 |
| 2 | Token IDs: one string, two tokenizers | K5–K7 |
| 3 | Config against the stored tensors | K8–K10 |
| 4 | The KV cache after prefill, including the no-`dtype` hazard | K11–K13 |

## Result
Every value matched its second source exactly, in the `rep.py` run (`results/output.txt`) and in the four pass checks. Pass check 4 also confirms K13: loaded without `dtype`, the cache is bfloat16 at 12,288 bytes per token, half the float32 figure.

| Point | transformers reports | Second source | Result |
| --- | --- | --- | --- |
| 1 rendering | 178-character ChatML string, 5 special tokens, generation prompt `<\|im_start\|>assistant\n` | llama.cpp `/apply-template`; GGUF template from `/props` | identical string; identical template (2,507 characters each); both add Qwen's default system message when none is given |
| 2 tokenization | 34 IDs (151644 ×3, 151645 ×2) | llama.cpp `/tokenize` | same 34 IDs. Hazard shown: parsed as plain text, the specials become 55 ordinary IDs in both |
| 3 config | 24 layers, 14 heads, 2 KV heads, hidden 896, intermediate 4,864, vocabulary 151,936, tied, BF16 | safetensors header read from raw bytes | all 9 checked shapes match; no `lm_head.weight`; 494,032,768 parameters; file = 8 + header + data exactly |
| 4 after prefill | cache (1, 2, 34, 64) per layer, f32, 835,584 bytes; logits (1, 34, 151936) | `kv_cache_shape` arithmetic; `len(tokenizer)` | equal; 24,576 bytes per token; 271 embedding rows with no token |

## Why It Matters
This shows us that A) we can accurately predict the KV cache size just from the published config.json of the model (which is what will allow us to estimate and plan inference infrastructure) and B) that the transformers library matches our served llama.cpp engine configuration for this model, in the template and the token IDs.

### Beyond this rep: decode speed
The two engines agree on the values, but not on speed. The course repo's `notebooks/Practice_Exploration/I01A-L1.ipynb` (cells 62, 69 and 71, 2026-10-26) profiled one decode step in each engine. Both ran on the GTX 1080 Ti; this rep runs transformers on the CPU. These numbers are not in `results/`.

This is not a controlled comparison. Each table has its own conditions:

| Engine | Cached tokens | Cache dtype |
| --- | --- | --- |
| transformers | about 2,054 | float32 |
| llama.cpp | 8,192 + 5 | float16 |

- **The matmuls are nearly identical.** In decode, both engines process one query row. The matmuls take 5.48 ms against 5.43 ms, at 74% against 75% of peak bandwidth.
- **The gap is attention and launch overhead.**
  - transformers ran `fmha_cutlassF_f32_aligned_64x64`, a kernel whose tile holds 64 query rows. In decode it held 1, and it launched 14 blocks on 28 SMs: 9.88 ms at 5 GB/s.
  - llama.cpp switches to `flash_attn_vec_ext_f32`, its one-query decode kernel, with 112 blocks: 1.34 ms at 75 GB/s.
  - The idle gaps between kernel launches were 2.81 ms against 0.23 ms.
- **Arithmetic intensity is the same.** The same bytes and FLOPs give the same intensity. The difference is the bandwidth the attention kernel achieved.

transformers, one decode step (cell 62):

```
part                                   kernels     bytes      time       rate  of 484 GB/s
matmuls (read every weight)                166  1.976 GB   5.48 ms   360 GB/s          74%
attention (read the KV cache)               24  0.051 GB   9.88 ms     5 GB/s           1%
torch.cat (the cache copy, + rotary)        93  0.101 GB   0.41 ms   248 GB/s          51%
everything else (norms, adds)              616         -   1.46 ms          -            -
gaps between launches (GPU idle)                       -   2.81 ms
whole step                                 899            20.05 ms   floor at 484 GB/s: 4.19 ms
```

One launch of each kind (cell 62): attention ran 14 blocks over the 28 SMs, 0.5 per SM.

llama.cpp, one decode step (step 5, cell 71; kernel sources in cell 69):

```
part                                   kernels     bytes      time       rate  of 484 GB/s
matmuls (read every weight)                169  1.976 GB   5.43 ms   364 GB/s          75%
attention (read the KV cache)               48  0.101 GB   1.34 ms    75 GB/s          16%
KV write (new token's row only)             48   12.3 KB   0.16 ms     0 GB/s           0%
mask cast (f32 -> f16, once a step)          1         -   0.05 ms          -            -
everything else (norms, adds)              243         -   0.53 ms          -            -
gaps between launches (GPU idle)                       -   0.23 ms
whole step (GPU timeline)                  509             7.74 ms   floor at 484 GB/s: 4.29 ms
```

One launch of each kind (cell 71): `flash_attn_vec_ext_f32` ran 112 blocks, 4 per SM. Its source is `ggml/src/ggml-cuda/fattn-vec-f32.cuh:14`.

## Toolkit
- `inference_analysis.kv_cache.kv_cache_shape(config, seq_len, batch=1, dtype_bytes=4)`: predicts one layer's K/V shape and the cache's bytes per layer, per token and in total from the raw `config.json`, without the model. Derives the head size when `head_dim` is absent. Tested in `tests/test_kv_cache.py`. Reused for the VRAM budget (I05), context capacity (I11) and the GPU count (I12).
- `scripts/llama_cpp_server.py`: starts llama.cpp server in Docker with given flags and a Docker-assigned port, waits for `/health`, and stops it cleanly. Reused by every later llama.cpp rep.
