# I02C-L1 - One Slot, Queued Requests

## Mechanism
A client can have two requests in flight while an engine schedules one. A long TTFT can therefore include waiting before the request receives GPU Work. Counting clients, executor queue entries, and scheduled requests answer different questions about where serving system delays may live.
## Built by
The driver (`rep.py`), the pair step in `scripts/locust_load.py` and the first-content notification in
`scripts/chat_client.py` were pair-programmed by Mike with the tutor on 2026-11-07. The devtools collector and
replay changes were written by a separate AI agent. The pass checks, this card's inspection, pass-check and result
tables, the trace levels in `rep.py` and the runs of 2026-11-09 are by an AI agent (Claude), 2026-11-09.

## Task 
We don't need any new functions for this. Instead, we'll be reusing our infrastructure but sending two requests from the client container, and the server container will have loaded the model with batch size 1. We'll inspect the visual trace of this interaction in our devtools stack and ensure that we can see the serving metrics at each point to watch the interaction affect them.
## Configuration

| Item | This rep |
| --- | --- |
| Engine | TensorRT-LLM 1.2.1, PyTorch backend, `trtllm-serve` in a container; image `ie-tensorrt-llm:1.2.1-nvml-byref` (the I02A build: NGC 1.2.1 + NVML `byref` patch), image ID `sha256:4c484c8a…7262fb7` at author QA; `rep.py` records the live ID |
| Model and revision | `nvidia/Qwen3-8B-FP8` @ `2cebc4c89e25abc17668c81b01dceaf3d8b914d5`; ModelOpt FP8 weights (`lm_head` not quantized), FP8 KV cache from the checkpoint's metadata, model dtype BF16; local directory `~/.local/share/inference-engineering/models/Qwen3-8B-FP8/<revision>` mounted read-only at `/model` through `MODEL_DIR`; engine and offline tokenizer read the same files |
| Command (`server`) | `trtllm-serve serve /model --backend pytorch --host 0.0.0.0 --port 8080 --max_batch_size 1 --max_seq_len 2048 --config /config/config.yaml`; published on `127.0.0.1`, host port from `docker compose port server 8080` |
| Engine config (YAML) | `dtype: bfloat16`, `max_num_tokens: 1024`, `return_perf_metrics: true`, `perf_metrics_max_requests: 100`, `iter_stats_max_iterations: 1000`, `kv_cache_config.enable_block_reuse: false`, `kv_cache_config.free_gpu_memory_fraction: 0.1`, `kv_cache_config.max_tokens: 2048`, `kv_cache_config.dtype: auto`; written into the run folder, mounted at `/config`. The trace level adds its own settings: `enable_iter_perf_stats: true` at `live`, `cuda_graph_config: null` at `code` and `nographs` |
| Why these limits | `max_batch_size 1`: one scheduled request per iteration, so B must wait. `max_seq_len 2048` and `max_num_tokens 1024`: bounded context and per-iteration token budget. Block reuse off: B's prefill is not shortened by A's cached prefix. Perf metrics on: completed-request records to read. Per-iteration counts come from the `live` run |
| Engine environment | `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`; `gpus: all`; `mem_limit: 8g` (first used with an 8B model here; checked at the first start); healthcheck `curl -sf http://127.0.0.1:8080/health` |
| Capture (`capture`) | Unchanged from I02A: `tcpdump` on the server's network namespace, `tcp port 8080`, nanosecond timestamps, `NET_RAW` only |
| Client (`client`) | I01-L2 image rebuilt after this rep's client changes: `locust_load.py` runs one pair step; `send_one` from `scripts/chat_client.py` with a first-content notification; `SERVER_BASE_URL=http://server:8080/v1`; OpenAI SDK 3.35.1, httpx2 2.16.0, Locust 2.47.0, gevent 26.9.0 |
| Requests A and B | Identical: system `You are a concise assistant for an inference team.`; user `Explain why a second inference request can wait while another request is decoding.`; `max_tokens=128`, `temperature=0`, `seed=0`, `stream=True`, `stream_options={"include_usage": True}`, no logprobs; `extra_body={"ignore_eos": True, "skip_special_tokens": False, "chat_template_kwargs": {"enable_thinking": False}}`; header `X-Request-ID`. ISL 42, OSL 128 each |
| Release rule | B's API call starts only after A's first nonempty content event, and must start before A's protocol completion. A timeout or failure is saved as a failed pair, not retried into success |
| Correctness smoke | `What is 2 plus 2? Reply with only the number.`, thinking off, greedy, `max_tokens=32`, no `ignore_eos`; expected `4`. Doubles as the warm-up and is excluded |
| Order | `compose up -d --wait server capture client` → correctness smoke (excluded) → drain `/perf_metrics` → Prometheus baseline scrape → pair (A, then B on A's first content) → read `/perf_metrics` → read again (expected empty) → final Prometheus scrape → save server log → `compose down` → decode the pcap |
| Readers | `/metrics` (iteration stats, drains; `live` runs only): the devtools engine collector only; `rep.py` copies its raw reads into the run. `/perf_metrics` (drains): `rep.py` only. `/prometheus/metrics`: does not drain |
| Run levels | `off` is the measured run: no profiler, no stamps, no iteration stats. `live` adds iteration stats and is the evidence run for pass check 1. `timeline` (Nsight Systems, iterations 1–290), `code` (PyTorch profiler, CUDA graphs off, iterations 158–166), `kernels`, `nographs` and `components` are labeled and never measured |
| Libraries | transformers 5.20.2, httpx 0.28.1, prometheus-client 0.26.0, NumPy 2.5.4, pytest 9.1.1, torch 2.15.0+cu134; Python 3.12.14 |
| Docker | Docker 29.9.2, Compose 5.6.1 |
| GPU and driver | NVIDIA GeForce RTX 5060 Ti 16 GB (16,311 MiB), driver 615.78.08 |
| Storage | Model weights and Docker data: `/dev/nvme0n1p2` (WD Black SN7100, `/mnt/ie-data`). Practice `.venv`: same device since 2026-11-07. Nothing is written to `/mnt/ie-kv-spill`. `rep.py` saves `findmnt -T` for each path |
| Machine state | Recorded by `rep.py` in `results/<run id>/basis.json`: SM clock, temperature, power and other GPU processes at start and end |

## Inspection Points

Evidence run `I02C-TRACE-live_20261109T220435Z_f54a96` (2026-11-09, `TRACE=live`: the measured setup plus iteration
statistics, labeled not measured), requests `…-A` and `…-B`. Client times are ms from A's send (`perf_counter_ns`);
engine times are converted from the engine's seconds. Command center: `#trace/I02C-TRACE-live_20261109T220435Z_f54a96`.

| Point | Value | Reported (source) | What it means | How we know (second source) | Difference |
| --- | --- | --- | --- | --- | --- |
| 1 basis | Prompt tokens, offline | 42 (`apply_chat_template`, thinking off) | Template + system + user | `usage.prompt_tokens` 42, A and B | 0 |
| 1 basis | KV cache precision realized | FP8 (server log) | The checkpoint's KV metadata, not BF16 | `config.json` `quantization_config` | – |
| 1 basis | Storage device | `/dev/nvme0n1p2` for weights, Docker root, packages | SN7100 NVMe | `findmnt -T` in `basis.json` | – |
| 2 overlap | A's first nonempty content | 43.906 ms (A's record, `release_ns`) | The release signal for B | Order check below | – |
| 2 overlap | B's API call | 44.005 ms (B's record, `send_ns`) | B starts 0.099 ms after the release | After A's content, before A's end | – |
| 2 overlap | A's protocol completion | 2735.206 ms | A held the slot until here | Engine record, end-to-end 2729.707 ms | +5.499 |
| 2 overlap | Client requests in flight, peak | 2 (open client spans) | Both API calls open together | Iteration 35: generation 1, queued 1 | – |
| 2 overlap | B's response headers | 3.134 ms after B's send | The server accepted B at once | – | – |
| 3 engine | `numScheduledRequests`, maximum | 1 (290 iteration records) | One request gets GPU work per iteration | `--max_batch_size 1` (`topology.json`) | 0 |
| 3 engine | `numActiveRequests`, maximum | 1 | One entry in `active_requests` | `maxNumActiveRequests` 1 | 0 |
| 3 engine | `numQueuedRequests` ≥ 1 | Iteration 35 only | A snapshot of `request_queue`, not a wait | Queue time 2687.911 ms (`/perf_metrics`) | – |
| 3 engine | Iteration 35 | generation 1, scheduled 1, queued 1 | A decodes while B sits in the input queue | Inside native window 34–290 | – |
| 3 engine | Iteration records | 290 saved, 289 distinct `iter` | Reader order kept; IDs can repeat | 84 collector reads, 0 dropped | – |
| 4 population | `/perf_metrics` first read | 2 records, native IDs 3 and 4 | The pair's completed population | 2 client successes | 0 |
| 4 population | `/perf_metrics` second read | 0 entries | The first read drained the deque | – | – |
| 4 population | Native iteration ranges | 34–161 and 163–290 | 128 iterations each, one after the other | `completion_tokens` 128 each | 0 |
| 4 population | Queue intervals (`first_scheduled_time − arrival_time`) | 2.826 ms and 2687.911 ms | An unpaired set | – | – |
| 4 population | Queue sum | 2.690737 s over 2 | Sum of positive intervals | Histogram sum delta 2.690737 s | 0.0 ms |
| 4 population | Queue count delta, success delta | 2, 2 (`/prometheus/metrics`, final − baseline) | The same population | Native records 2; client successes 2 | 0, 0 |
| 4 population | Client/native join | None | Native IDs are integers; SDK event IDs change per event | – | – |
| 4 population | A's and B's engine queue interval | Unavailable | No validated join | Reversed list: same sum, other assignment | 0 ms |

## Pass Check

`make check REP=I02C-L1_one_slot_queue` runs `test_i02c_l1.py` on the newest saved run that carries iteration
statistics and no profiler (a `TRACE=live` run). The tests read the saved raw records; they start no server. The
values below are from run `I02C-TRACE-live_20261109T220435Z_f54a96`.

### 1. Two client requests respect one scheduled slot

| Quantity | Must equal | Tolerance | Measured | Pass |
| --- | --- | --- | --- | --- |
| Release order | A content < B send < A done | exact | 43.906 < 44.005 < 2735.206 ms | yes |
| Peak client in flight | 2 | exact | 2 | yes |
| Scheduled maximum | ≤ 1 (`max_batch_size`) | exact | 1 | yes |
| Generation + queued input in one iteration | ≥ 1 iteration in the native window | exact | 1 (iteration 35 of 34–290) | yes |
| Completed clients | 2 successes | exact | 2 | yes |
| Prompt-token difference from the offline count | 0 tokens | exact | 0, 0 | yes |

### 2. The native queue total agrees with the completed histogram population

| Quantity | Must equal | Tolerance | Measured | Pass |
| --- | --- | --- | --- | --- |
| Native records | 2 | exact | 2 | yes |
| Success delta | 2 | exact | 2 | yes |
| Queue count delta | Positive native count | exact | 2 against 2 | yes |
| Queue sum delta | Native queue sum | 0.001 ms | 0.0 ms | yes |
| Second deque read | Empty | exact | 0 entries | yes |

The tolerance covers float serialization and subtraction in a same-population identity. Both sides come from the
engine's own timestamps, so agreement checks the export, not the clock.

### 3. An unsupported concurrent join stays unavailable

| Quantity | Must equal | Tolerance | Measured | Pass |
| --- | --- | --- | --- | --- |
| Validated client/native joins | 0 | exact | 0 | yes |
| A's native queue interval | Unavailable | exact | Unavailable | yes |
| B's native queue interval | Unavailable | exact | Unavailable | yes |
| Reordered aggregate difference | 0 ms | 0.001 ms | 0 ms | yes |

## Results

Passed: 3 of 3 checks on the evidence run. The latencies below are from the measured run
`I02C_20261109T214947Z_f4f425` (`TRACE=off`, 2026-11-09). One request each, ISL 42, OSL 128, greedy, identical
prompts; every latency is a single request's value, not a percentile.

| Request | Status | TTFT (first nonempty content) | End-to-end |
| --- | --- | --- | --- |
| A | 200 | 45.0 ms | 2922.3 ms |
| B | 200 | 2910.8 ms | 5726.1 ms |

| Engine, unpaired (measured run) | Value |
| --- | --- |
| Queue intervals | 4.076 ms, 2873.555 ms |
| Queue sum, `/perf_metrics` | 2.877631 s |
| Queue sum delta, `/prometheus/metrics` | 2.877631 s |
| Native iteration ranges | 34–161, 163–290 |

B's TTFT is 2865.8 ms longer than A's for the same prompt, and B's headers arrived 2.9 ms after its send: the wait
is inside the engine, after the server accepted the request. The engine ran A's 128 iterations (34–161) before
B's (163–290). On the evidence run the scheduled maximum was 1, and the executor's input queue showed B in one
iteration record only (35), so a queue-depth snapshot understates a 2.69 s wait; the queue-time histogram holds it.
The histogram and `/perf_metrics` agree to 0.0 ms in every run, and neither says which client waited.

Runs, all kept:

| Run | Level | Note |
| --- | --- | --- |
| `I02C_20261109T214947Z_f4f425` | `off` | The measured run |
| `I02C-TRACE-live_20261109T220435Z_f54a96` | `live` | The evidence run for the pass checks; B's TTFT 2725.1 ms |
| `I02C-TRACE-timeline_20261109T215304Z_96d3d8` | `timeline` | Nsight Systems, iterations 1–290: 123,648 GPU spans. B's end-to-end is 13.7 s here, cause not established. Modules are inferred from the code run: 285 of 288 forward steps match reference iteration 158 (421 of 423 device rows paired), 3 match B's prefill at 163 (one with 455 of 491 paired) |
| `I02C-TRACE-code_20261109T220240Z_15e00d` | `code` | PyTorch profiler, CUDA graphs off, iterations 158–166: 3,470 kernels with ops, shapes and stacks; B's prefill at 163 |
| `I02C-TRACE-code_20261109T213328Z_39a18c` | `code` | First code run, recorded with iteration statistics on; its `run.json` numbers B's prefill 162 (old adapter) |
| `I02C-TRACE-live_20261109T215123Z_b42679` | `live` | No iteration reads: the devtools collector had stopped. Not an evidence run |
| `I02C_20261107T181629Z_c37c3e` | `off`, iteration statistics on | Recorded before the levels were separated; passes the three checks |
| `I02C_20261107T181031Z_5626f7` | same | Failed pair: B's API call timed out on the client after 2.0 s with no headers |
| `I02C_20261107T180301Z_e0e4f0` | same | Stopped before the pair; no records |

## Why It Matters

- **A long TTFT can include waiting.** B is sent on A's first content and gets GPU work only when A completes. In the measured
  run `I02C_20261109T214947Z_f4f425`, B's TTFT was 2910.8 ms against A's 45.0 ms, for the same prompt.
- **Two requests in flight, one scheduled.** The client holds A and B open together, while the engine
  (`--max_batch_size 1`) schedules one request per iteration.
- **Clients, queue entries and scheduled requests answer different questions.** Each points to a different place a
  delay can live. In the same run, the engine's queue time summed to 2.88 s over 2 requests, and
  `/prometheus/metrics` agreed with `/perf_metrics` to 0.0 ms. Which request waited is unavailable: there is no
  validated client/native join.

## Toolkit

No new `inference_analysis` function. Imported: `chat_durations(record: dict) -> dict` (I01-L2), which returns one
client record's `headers_ms`, `ttft_ms`, `e2e_ms` and `attempt_ms` with an `unavailable` map of reasons.

| Tool | Use |
| --- | --- |
| `make rep REP=I02C-L1_one_slot_queue` | The measured run: smoke and warm-up, the pair, the engine reads, stop, `run.json` |
| `make rep REP=I02C-L1_one_slot_queue TRACE=live` | The same pair with iteration statistics: the evidence run for the pass checks |
| `make rep REP=… TRACE=timeline` / `code` / `kernels` / `nographs` / `components` | Labeled runs: Nsight Systems, PyTorch profiler, Nsight Compute, graphs off, component stamps |
| `make check REP=I02C-L1_one_slot_queue` | The three pass checks on the newest saved `live` run |
| `make devtools` | The command center; its engine collector is the only `/metrics` reader and must be up before a `live` run |
