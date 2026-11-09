# inference-engineering-practice

Exercises and experiments I wrote while studying inference engineering: serving generative models in production.

The tasks were set by an AI tutor (Claude). Reps are exercises that teach the concepts. Only the items under Experiments are findings from real information using the concepts.

## Reps

| Rep | Mechanism | Level | Status | Checked against |
| --- | --- | --- | --- | --- |
| [I01A-L1](reps/I01A-L1_chat_request_inspection/) | One chat request in `transformers` (Qwen2.5-0.5B-Instruct, float32), read at four points: chat template, token IDs, model config, KV cache after prefill | 1 (Inspect) | Complete, 2026-10-27 | llama.cpp b6500 server (`/apply-template`, `/tokenize`, `/props`); the `safetensors` header bytes; the `kv_cache_shape` cost model |
| [I01B-L1](reps/I01B-L1_sampler_inspection/) | One sampling step in `transformers` `generate` (Qwen2.5-0.5B-Instruct, float32), read at three points: the processor list and its order, the surviving token set, the drawn token; plus the checkpoint's hidden repetition penalty | 1 (Inspect) | Complete, 2026-10-27 | the raw `generation_config.json`; the recomputation from the raw logits; llama.cpp b6500 server (`/props` `samplers`, `/completion` with `post_sampling_probs`) |
| [I01C-L1](reps/I01C-L1_streamed_completion/) | Streamed completions in llama.cpp: KV reservation, token and cache counts, stop reasons, and engine timings against the client clock | 1 (Inspect) | Complete, 2026-10-28 | `kv_cache_shape`; tokenizer and chunk counts; client monotonic clock; `/metrics` deltas (same engine source) |
| [I01-L2](reps/I01-L2_chat_service_under_load/) | A chat service under load at concurrency 1 (OpenAI SDK + Locust client, own upstream llama.cpp b6500 server, Prometheus/Grafana, Node and DCGM exporters, tcpdump sidecar): TTFT and e2e as prompt length grows from 64 to 1024 tokens, with each request split into client, network, server and engine segments | 2 (Configure under load) | Complete, 2026-10-30; TTFT +91.0 ms from ISL 64 to 1024, the same in all three blocks; e2e stability guard failed (decode-time variation) | offline Hugging Face greedy IDs; Prometheus histograms and engine counters against raw records; packet capture and server log against client clocks; nvidia-smi, Docker stats and Node Exporter |
| [I02A-L1](reps/I02A-L1_streamed_latency/) | Streamed latency on TensorRT-LLM 1.2.1 (RTX 5060 Ti, Qwen2.5-0.5B-Instruct BF16): one isolated request's TTFT, ITL and end-to-end on the client, the wire and the engine, with client TTFT split into 8 segments across three clocks; devtools for live and traced inspection | 1 (Inspect) | Complete, 2026-11-03; client TTFT 35.6 ms (prefill 27.3), mean ITL 4.53 ms; 5 of 5 pass checks | offline tokenizer count; `/perf_metrics` engine record (drained, joined by isolation); packet capture decoded with `tshark` (joined by `X-Request-ID`); Nsight Systems, PyTorch profiler and Nsight Compute traces |
| [I02B-L1](reps/I02B-L1_TTFT_percentiles_and_bootstrap/) | NumPy percentile methods (`inverted_cdf`, `linear`), mean versus P50, and SciPy P50/P99 bootstrap intervals on 20 chosen synthetic TTFT values | 1 (Inspect) | Complete, 2026-11-06; 4 of 4 numerical checks | explicit sorted ranks and scalar interpolation; complete sum/count; pandas corroboration (shares NumPy); interval endpoints reconstructed from the saved bootstrap distribution |
| [I02C-L1](reps/I02C-L1_one_slot_queue/) | Two streamed requests on one engine slot (TensorRT-LLM 1.2.1, `--max_batch_size 1`, Qwen3-8B-FP8, RTX 5060 Ti): B is sent on A's first content and waits for A; client in-flight count, the executor's queued and scheduled counts, and the engine's queue time read as three different observations | 1 (Inspect) | Built and checked, 2026-11-09; B's TTFT 2910.8 ms against A's 45.0 ms (one request each, measured run); 3 of 3 pass checks; teach session pending | client clock and completion count; configured `max_batch_size`; offline tokenizer count; `/metrics` iteration statistics; `/prometheus/metrics` queue histogram against `/perf_metrics` (same engine clock: checks the export, not the clock) |

## Experiments

| Experiment | Finding | Verdict | Units | Status |
| --- | --- | --- | --- | --- |
