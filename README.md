# inference-engineering-practice

Exercises and experiments I wrote while studying inference engineering: serving generative models in production.

The tasks were set by an AI tutor (Claude). Reps are exercises that teach the concepts. Only the items under Experiments are findings from real information using the concepts.

## Reps

| Rep | Mechanism | Level | Status | Checked against |
| --- | --- | --- | --- | --- |
| [I01A-L1](reps/I01A-L1_chat_request_inspection/) | One chat request in `transformers` (Qwen2.5-0.5B-Instruct, float32), read at four points: chat template, token IDs, model config, KV cache after prefill | 1 (Inspect) | Complete, 2026-10-27 | llama.cpp b6500 server (`/apply-template`, `/tokenize`, `/props`); the `safetensors` header bytes; the `kv_cache_shape` cost model |
| [I01B-L1](reps/I01B-L1_sampler_inspection/) | One sampling step in `transformers` `generate` (Qwen2.5-0.5B-Instruct, float32), read at three points: the processor list and its order, the surviving token set, the drawn token; plus the checkpoint's hidden repetition penalty | 1 (Inspect) | Complete, 2026-10-27 | the raw `generation_config.json`; the recomputation from the raw logits; llama.cpp b6500 server (`/props` `samplers`, `/completion` with `post_sampling_probs`) |

| [I01C-L1](reps/I01C-L1_streamed_completion/) | Streamed completions in llama.cpp: KV reservation, token and cache counts, stop reasons, and engine timings against the client clock | 1 (Inspect) | Complete, 2026-10-28 | `kv_cache_shape`; tokenizer and chunk counts; client monotonic clock; `/metrics` deltas (same engine source) |

## Experiments

| Experiment | Finding | Verdict | Units | Status |
| --- | --- | --- | --- | --- |
