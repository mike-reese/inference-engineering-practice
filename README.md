# inference-engineering-practice

Exercises and experiments I wrote while studying inference engineering: serving generative models in production.

The tasks were set by an AI tutor (Claude). Reps are exercises that teach the concepts. Only the items under Experiments are findings from real information using the concepts.

## Reps

| Rep | Mechanism | Level | Status | Checked against |
| --- | --- | --- | --- | --- |
| [I01A-L1](reps/I01A-L1_chat_request_inspection/) | One chat request in `transformers` (Qwen2.5-0.5B-Instruct, float32), read at four points: chat template, token IDs, model config, KV cache after prefill | 1 (Inspect) | Complete, 2026-10-27 | llama.cpp b6500 server (`/apply-template`, `/tokenize`, `/props`); the `safetensors` header bytes; the `kv_cache_shape` cost model |

## Experiments

| Experiment | Finding | Verdict | Units | Status |
| --- | --- | --- | --- | --- |
