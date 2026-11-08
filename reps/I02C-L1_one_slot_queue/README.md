# I02C-L1 - One Slot, Queued Requests

## Mechanism
A client can have two requests in flight while an engine schedules one. A long TTFT can therefore include waiting before the request receives GPU Work. Counting clients, executor queue entries, and scheduled requests answer different questions about where serving system delays may live.
## Task 
We don't need any new functions for this. Instead, we'll be reusing our infrastructure but sending two requests from the client container, and the server container will have loaded the model with batch size 1. We'll inspect the visual trace of this interaction in our devtools stack and ensure that we can see the serving metrics at each point to watch the interaction affect them.
## Configuration

| Item | This rep |
| --- | --- |
| Engine | TensorRT-LLM 1.2.1, PyTorch backend, `trtllm-serve` in a container; image `ie-tensorrt-llm:1.2.1-nvml-byref` (the I02A build: NGC 1.2.1 + NVML `byref` patch), image ID `sha256:4c484c8a…7262fb7` at author QA; `rep.py` records the live ID |
| Model and revision | `nvidia/Qwen3-8B-FP8` @ `2cebc4c89e25abc17668c81b01dceaf3d8b914d5`; ModelOpt FP8 weights (`lm_head` not quantized), FP8 KV cache from the checkpoint's metadata, model dtype BF16; local directory `~/.local/share/inference-engineering/models/Qwen3-8B-FP8/<revision>` mounted read-only at `/model` through `MODEL_DIR`; engine and offline tokenizer read the same files |
| Command (`server`) | `trtllm-serve serve /model --backend pytorch --host 0.0.0.0 --port 8080 --max_batch_size 1 --max_seq_len 2048 --config /config/config.yaml`; published on `127.0.0.1`, host port from `docker compose port server 8080` |
| Engine config (YAML) | `dtype: bfloat16`, `max_num_tokens: 1024`, `return_perf_metrics: true`, `perf_metrics_max_requests: 100`, `enable_iter_perf_stats: true`, `iter_stats_max_iterations: 1000`, `kv_cache_config.enable_block_reuse: false`, `kv_cache_config.free_gpu_memory_fraction: 0.1`, `kv_cache_config.max_tokens: 2048`, `kv_cache_config.dtype: auto`; written into the run folder, mounted at `/config` |
| Why these limits | `max_batch_size 1`: one scheduled request per iteration, so B must wait. `max_seq_len 2048` and `max_num_tokens 1024`: bounded context and per-iteration token budget. Block reuse off: B's prefill is not shortened by A's cached prefix. Perf metrics and iteration stats on: completed-request records and per-iteration counts to read |
| Engine environment | `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`; `gpus: all`; `mem_limit: 8g` (first used with an 8B model here; checked at the first start); healthcheck `curl -sf http://127.0.0.1:8080/health` |
| Capture (`capture`) | Unchanged from I02A: `tcpdump` on the server's network namespace, `tcp port 8080`, nanosecond timestamps, `NET_RAW` only |
| Client (`client`) | I01-L2 image rebuilt after this rep's client changes: `locust_load.py` runs one pair step; `send_one` from `scripts/chat_client.py` with a first-content notification; `SERVER_BASE_URL=http://server:8080/v1`; OpenAI SDK 3.35.1, httpx2 2.16.0, Locust 2.47.0, gevent 26.9.0 |
| Requests A and B | Identical: system `You are a concise assistant for an inference team.`; user `Explain why a second inference request can wait while another request is decoding.`; `max_tokens=128`, `temperature=0`, `seed=0`, `stream=True`, `stream_options={"include_usage": True}`, no logprobs; `extra_body={"ignore_eos": True, "skip_special_tokens": False, "chat_template_kwargs": {"enable_thinking": False}}`; header `X-Request-ID`. ISL 42, OSL 128 each |
| Release rule | B's API call starts only after A's first nonempty content event, and must start before A's protocol completion. A timeout or failure is saved as a failed pair, not retried into success |
| Correctness smoke | `What is 2 plus 2? Reply with only the number.`, thinking off, greedy, `max_tokens=32`, no `ignore_eos`; expected `4`. Doubles as the warm-up and is excluded |
| Order | `compose up -d --wait server capture client` → correctness smoke (excluded) → drain `/perf_metrics` → Prometheus baseline scrape → pair (A, then B on A's first content) → read `/perf_metrics` → read again (expected empty) → final Prometheus scrape → save server log → `compose down` → decode the pcap |
| Readers | `/metrics` (iteration stats, drains): the devtools engine collector only, saving raw batches to the run. `/perf_metrics` (drains): `rep.py` only. `/prometheus/metrics`: does not drain |
| Instrumentation | Perf metrics and iteration stats on; no profiler. Timings describe this instrumented workload, not uninstrumented capacity |
| Libraries | transformers 5.20.2, httpx 0.28.1, prometheus-client 0.26.0, NumPy 2.5.4, pytest 9.1.1, torch 2.15.0+cu134; Python 3.12.14 |
| Docker | Docker 29.9.2, Compose 5.6.1 |
| GPU and driver | NVIDIA GeForce RTX 5060 Ti 16 GB (16,311 MiB), driver 615.78.08 |
| Storage | Model weights and Docker data: `/dev/nvme0n1p2` (WD Black SN7100, `/mnt/ie-data`). Practice `.venv`: same device since 2026-11-07. Nothing is written to `/mnt/ie-kv-spill`. `rep.py` saves `findmnt -T` for each path |
| Machine state | Recorded by `rep.py` in `results/<run id>/basis.json`: SM clock, temperature, power and other GPU processes at start and end |



