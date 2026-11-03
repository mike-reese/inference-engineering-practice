# I02A-L1 -- Streamed Latency

## Mechanism 
The serving engine (TensorRT-LLM) sends response headers before the engine has a token, then streams one server-sent event per generated token. The engine provides measurements for the requests arrival, first token, and last token on its own clock separately from the times the client records on its own clock. The engine also does not measure anything related to the network.

## Task 
We have a new GPU compared to I01-L2.

We will swap to using TensorRT-LLM as our serving engine, running in a container (the NGC image plus the NVML patch, built from `deploy/server/Dockerfile`), and cut over the I01-L2 Compose stack: server, client and the tcpdump capture sidecar. The stack driver moves to `scripts/compose_stack.py`. We'll send one warm-up request, drain `/perf_metrics`, and then send a measured streamed request. We count the prompt's tokens offline with the tokenizer and then read `/perf_metrics` twice, and decode the capture with `tshark` and `pcap_streams`. A new function (`latency_records`) turns the client record, the engine record and the captured stream into TTFT, ITL, end-to-end latency and the segments between them, each named by its clock. Outputs are the raw records, both `/perf_metrics` reads, the pcap, the offline count and the latency records.

## Configuration

| Item | This rep |
| --- | --- |
| Engine | TensorRT-LLM 1.2.1, PyTorch backend, `trtllm-serve` in a container; image = `nvcr.io/nvidia/tensorrt-llm/release:1.2.1@sha256:33cd085b…f927b9` + NVML patch layer, built from `deploy/server/Dockerfile` (CUDA 13.1, torch 2.10.0a0+b4e4ee81d3.nv25.12, transformers 4.57.3 inside the image) |
| Local engine patch | NVML call in `tensorrt_llm/_utils.py` changed to `byref(cc_settings)` (upstream issue 18816); `_utils.py` sha256 `0619e389…3661c` before, `85570e359efb2e36263e032a6ef7a4c55705c621cbe8143f880a21a53856207e` after |
| Model and revision | `Qwen2.5-0.5B-Instruct` @ `7ae557604adf67be50417f59c2c2f167def9a775`, BF16 weights, local directory `~/.local/share/inference-engineering/models/Qwen2.5-0.5B-Instruct/<revision>` mounted read-only at `/model`; engine and offline tokenizer read the same files |
| Command (`server`) | `trtllm-serve serve /model --backend pytorch --host 0.0.0.0 --port 8080 --max_batch_size 1 --max_seq_len 2048 --config /config/config.yaml`; published on `127.0.0.1`, host port from `docker compose port server 8080` |
| Engine config (YAML) | `return_perf_metrics: true`, `perf_metrics_max_requests: 100`, `kv_cache_config.enable_block_reuse: false`, `kv_cache_config.free_gpu_memory_fraction: 0.5`; written into the run folder, mounted at `/config` |
| Engine environment | `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`; `gpus: all`; healthcheck `curl -sf http://127.0.0.1:8080/health` |
| Capture (`capture`) | `tcpdump --immediate-mode -i eth0 -p -n -s 0 -U --time-stamp-precision=nano -w /cap/<run id>_s<N>.pcap 'tcp port 8080'`, `network_mode: service:server`, `NET_RAW` only; tcpdump 4.99.4, TShark 4.2.5; run folder world-writable |
| Client (`client`) | I01-L2 image rebuilt with the client change: `locust_load.py` running `send_one(..., diagnostic=True)` from `scripts/chat_client.py`; `SERVER_BASE_URL=http://server:8080/v1`; OpenAI SDK 3.35.1, httpx2 2.16.0, Locust 2.47.0 |
| Request | system `You are a concise assistant for an inference team.`; user `Why does decode slow down as the KV cache grows?`; `max_tokens=64`, `temperature=0`, `seed=0`, `stream=True`, `stream_options={"include_usage": True}`, `logprobs=True`, `top_logprobs=1`; `extra_body={"ignore_eos": True, "skip_special_tokens": False}`; header `X-Request-ID` |
| Order | `compose up -d --wait server capture client` → 1 warm-up (not measured) → drain `/perf_metrics` → 1 measured request → read `/perf_metrics` (poll ≤ 2 s) → read again → save server log → `compose down` → decode the pcap |
| Libraries | transformers 5.20.2, httpx 0.28.1, huggingface_hub 2.3.0, pytest 9.1.1, torch 2.15.0+cu134; Python 3.12.14 |
| Docker | Docker 29.9.2, Compose 5.6.1, NVIDIA Container Toolkit 1.20.1 |
| GPU and driver | NVIDIA GeForce RTX 5060 Ti 16 GB (16,311 MiB), compute capability 12.0, driver 615.78.08, CUDA 13.4 |
| Machine state | Recorded by `rep.py` in `results/basis.json`: SM clock, temperature, power and other GPU processes at start and end |

## Inspection Points

One measured request. Times in ms from send on the client clock unless named; engine times converted from seconds; wire times converted from the epoch with the record's `anchor_pair`.

Run `I02A_20261103T164324Z_348959` (2026-11-03), request `…-measured`. Open it in the devtools: `#trace/<run id>`.

| Point | Value | Reported (source) | What it means | How we know (second source) | Difference |
| --- | --- | --- | --- | --- | --- |
| 1 offline | Prompt tokens, offline | 34 (`apply_chat_template`) | Template + system + user | `usage.prompt_tokens` 34 | 0 |
| 2 stream | Raw SSE lines (`curl -N`, hand check) | Not recorded | `hand_check_1` holds a browser GET, not `curl -N` | – | – |
| 2 stream | Response headers (`headers_ns`) | 4.858 ms | Sent before any token | Wire headers 4.463 | −0.395 |
| 2 stream | First body read: time | 34.957 ms | First bytes the SDK reads | Wire first data 34.910 | −0.047 |
| 2 stream | First body read: contents | Role event only, `usage` 0 completion | Not a token | Body read base64 | – |
| 2 stream | First token event (TTFT) | 35.564 ms | Client TTFT | Wire 34.910; engine 29.478 | −0.654; −6.086 |
| 2 stream | Protocol completion, `[DONE]` (end-to-end) | 321.604 ms | Client end-to-end | Wire `[DONE]` 321.134 | −0.469 |
| 2 stream | Client-side first wire byte, transport EOF | 2.123 ms; EOF Unavailable | Headers write starts; SDK closes at `[DONE]` | `transport_trace` | – |
| 3 tokens | Events, total | 66 | Role + 64 tokens + usage | Wire `data:` events | 0 |
| 3 tokens | Token events | 64 | One per token | Wire 64 | 0 |
| 3 tokens | `logprobs.content` records per token event | 1 | Evidence rule holds | – | – |
| 3 tokens | `logprobs.content` records, total | 64 | – | `completion_tokens` 64 | 0 |
| 3 tokens | `usage.prompt_tokens` | 34 | – | Offline 34 | 0 |
| 3 tokens | `usage.completion_tokens`, running and final | 0, 1, …, 64 | Running count per event | Records 64 | 0 |
| 3 tokens | `usage.prompt_tokens_details.cached_tokens` | 0 | Block reuse off | `kv_cache_metrics.num_reused_blocks` 0 | 0 |
| 3 tokens | `finish_reason` | `length` | `ignore_eos`, `max_tokens` 64 | – | – |
| 3 tokens | Token gaps (exact ITL), count and range | 63; 1.706–14.377 ms | Per-token delivery | Wire gaps | – |
| 3 tokens | Mean ITL, client | 4.531 ms | (last − first) / 63 | Engine 4.547 | −0.016 |
| 3 tokens | Perceived tokens per second | 220.7 | 1000 / mean ITL | – | – |
| 4 wire | Chat requests in the captured TCP stream, `X-Request-ID` | 1, `…-measured` | Join by ID | Client record | – |
| 4 wire | Request's last byte at the server | 2.348 ms | Request fully sent | Client send 0 | +2.348 |
| 4 wire | Response headers on the wire | 4.463 ms | Before the first token | Engine first token 29.478 | −25.015 |
| 4 wire | First token event on the wire | 34.910 ms | Wire TTFT | Client 35.564 | +0.654 |
| 4 wire | Token events on the wire (count, frames) | 64, 64 frames | One frame per token | Client 64 | 0 |
| 4 wire | Mean ITL, wire | 4.533 ms | – | Client 4.531 | +0.002 |
| 4 wire | `[DONE]` on the wire | 321.134 ms | Wire end-to-end | Client 321.604 | +0.469 |
| 5 engine | `/perf_metrics` first read: entries | 1 | One request in flight | Drain after warm-up: 1 | – |
| 5 engine | Raw entry (`timing_metrics`, seconds) | arrival 310996.266094 … last 310996.582041 | CLOCK_MONOTONIC s | Client `perf_counter_ns` | – |
| 5 engine | `request_id` | 3 (`int`) | Engine-internal; not the header ID | K10 | – |
| 5 engine | Iterations (`last_iter − first_iter + 1`) | 129 − 66 + 1 = 64 | One token per iteration | `completion_tokens` 64 | 0 |
| 5 engine | `kv_cache_metrics` | 2 allocated, 2 new, 0 reused | 98 tokens in 2 blocks | `cached_tokens` 0 | – |
| 5 engine | Queue (`first_scheduled_time − arrival_time`) | 2.169 ms | Wait for a slot | – | – |
| 5 engine | TTFT, engine (`first_token_time − arrival_time`) | 29.478 ms | Prefill 27.309 + queue | Client 35.564 | −6.086 |
| 5 engine | HTTP-layer TTFT (`server_first_token_time − server_arrival_time`) | 31.370 ms | Handler view | Client 35.564 | −4.194 |
| 5 engine | Decode span (`last_token_time − first_token_time`) | 286.469 ms | 63 gaps | Client 285.468 | −1.001 |
| 5 engine | Mean ITL, engine (span / (completion tokens − 1)) | 4.547 ms | – | Client 4.531 | +0.016 |
| 5 engine | End-to-end, engine (`last_token_time − arrival_time`) | 315.947 ms | – | Client 321.604 | −5.657 |
| 5 engine | Body read, parse, template, tokenization (`arrival_time − server_arrival_time`) | 0.589 ms | Before the executor | – | – |
| 5 engine | Headers parsed (`server_arrival_time`, ASGI middleware) | 2.955 ms | A labeled point, not a boundary | Request's last byte 2.348 | +0.607 |
| 5 engine | `/perf_metrics` second read: entries | 0 | The read drains | – | – |

Segments of client TTFT (each named by the clocks at its two ends; they must sum to client TTFT). `server_arrival_time`
is not a boundary: it is stamped once the headers are parsed, before the body is read, so it can precede the request's
last byte. "wire → `arrival_time`" holds the server-side receive, body read, parse, template and tokenization.

| Segment | Clocks | ms |
| --- | --- | --- |
| send → request's last byte on the wire | client → pcap | 2.348 |
| wire → `arrival_time` | pcap → engine | 1.196 |
| `arrival_time` → `first_scheduled_time` | engine | 2.169 |
| `first_scheduled_time` → `first_token_time` | engine | 27.309 |
| `first_token_time` → `server_first_token_time` | engine | 1.303 |
| `server_first_token_time` → first token on the wire | engine → pcap | 0.584 |
| wire → client first token event | pcap → client | 0.655 |
| sum of the 7 | | 35.564 = client TTFT |
| `last_token_time` → `[DONE]` on the wire (end-to-end tail) | engine → pcap | 1.643 |
| `[DONE]` on the wire → protocol completion (end-to-end tail) | pcap → client | 0.469 |

Where each engine time is stamped (TensorRT-LLM 1.2.1 installed source, `make source`):

| Field | File:line | Stamped when |
| --- | --- | --- |
| `server_arrival_time` | `serve/responses_utils.py:1930` | ASGI middleware: headers parsed, body not yet read |
| `arrival_time` | `llmapi/llm.py:388` | LLM API submits it, after template and tokenization |
| `first_scheduled_time` | `_torch/pyexecutor/seq_slot_manager.py:29` | Scheduler gives it a slot |
| `first_token_time` | `_torch/pyexecutor/py_executor.py:2649` → C++ `updatePerfMetrics` | First response handling after prefill |
| `server_first_token_time` | `serve/openai_server.py:500` (`chat_stream_generator`) | First output reaches the HTTP handler |
| `last_token_time` | `_torch/pyexecutor/py_executor.py:2649` → C++ `updatePerfMetrics` | Every response handling; last one stays |

## Pass Check 
All tests must pass. Five checks (owner ruling 2026-10-31). Measured values: 60 requests, 3 stack starts, 2026-10-31.

### 1. Token counts: usage against the offline tokenizer and the token records

Count the prompt offline with `apply_chat_template`. From the measured record, count the token events and the
`logprobs.content` records, and read the final `usage`.

| Quantity | Must equal | Tol. | Measured | Row |
| --- | --- | --- | --- | --- |
| `prompt_tokens` | offline count | exact | 34 = 34 | K1, K3 |
| records per token event | 1 | exact | 1 | K3 |
| `completion_tokens` | sum of records | exact | 64 = 64 | K3 |
| token events | `completion_tokens` | exact | 64 = 64 | K2, K3 |
| `cached_tokens` | 0 | exact | 0 | K3 |

- **Why exact:** integers, at temperature 0 with a fixed output length.
- **The second row is the evidence rule:** one record per event is what makes each event time a token time.
- **Wrong methods:** counting all events gives 66. Default `skip_special_tokens` on a prompt whose answer ends early
  gives 56 records for 64 tokens (K4), and this table fails.

### 2. Client intervals against the engine's

Build both sides with `latency_records` from the measured record and its `/perf_metrics` entry.

| Quantity | Must equal | Tol. | Measured | Row |
| --- | --- | --- | --- | --- |
| mean ITL, client − engine | 0 | 0.1 ms | −0.052 to −0.003 | K6, K7, K8 |
| TTFT remainder | 0 < r ≤ 10 ms | bound | 3.22 to 5.97 | K8 |
| client TTFT − HTTP-layer TTFT | 0 < r ≤ 10 ms | bound | 2.17 to 2.94 | K8 |
| end-to-end remainder | 0 < r ≤ 10 ms | bound | 2.97 to 3.94 | K8 |

- **Mean ITL row, matching boundaries:** both sides span the same first and last token; delivery delay at the two ends
  nearly cancels. 0.1 ms is about twice the largest measured difference. Using end-to-end / 64 is +0.24 to +0.32 off and
  fails. Dividing by 64 instead of 63 is only about 0.05 off, which this row does not reliably catch; the
  `latency_records` test catches it.
- **Containment rows:** the engine's intervals start later than the client's and its last stamp comes before the last
  delivery, so each remainder must be positive. Check 5 splits the remainder into measured segments.
- **Why 10 ms:** above the largest measured remainder (5.97) and below the smallest engine TTFT (15.77), so a client
  "TTFT" that leaves out prefill, such as the headers time (−17.26 to −13.07), fails the lower bound.

### 3. The hazard: which client time is the first token

From the measured record, compare the headers time, the first body read and the first token event, and read what the
first body read holds.

| Quantity | Must equal | Tol. | Measured | Row |
| --- | --- | --- | --- | --- |
| headers vs first body read | before | exact | 2.69 vs 19.52 (P50) | K5 |
| first body read holds a token | no | exact | role only | K2, K5 |
| first token event vs first body read | after | exact | +0.38 to +0.63 | K5 |
| headers time − engine TTFT | < 0 | exact | −17.26 to −13.07 | K8 |

- **Why it is the hazard:** TensorRT-LLM sends its headers before the engine has a token, so the headers time is about
  3 ms while TTFT is about 20 ms. The first body read is closer, but it holds only the role event; it passes the
  containment bound of check 2 (+2.81 to +5.56, K8), so only reading its content shows it is not the first token.
- **The last row is the negative control:** the headers time used as TTFT is shorter than the engine's own TTFT, which is
  impossible for the real first token.

### 4. The join: one isolated request, one engine record

Drain `/perf_metrics` after the warm-up. After the measured request, read it twice.

| Quantity | Must equal | Tol. | Measured | Row |
| --- | --- | --- | --- | --- |
| entries, first read | 1 | exact | 1 | K9 |
| entries, second read | 0 | exact | 0 | K9 |
| `last_iter − first_iter + 1` | `completion_tokens` | exact | 64 = 64 | K7 |
| `request_id` type | `int` | exact | `int` | K7, K10 |

- **Why this is the join:** no emitted ID links the stream to the engine record (K10), so correlation rests on isolation:
  one request in flight, a drain before it, exactly one record after it. The iteration row ties the record to a 64-token
  request; with `--max_batch_size 1` the engine generates one token per iteration.
- **Wrong method:** reading twice, or letting another reader in, returns `[]`; code that takes element 0 then crashes or,
  with other traffic, joins the wrong request.

### 5. The wire: the capture against the client and the engine

Decode the pcap with `pcap_streams`, take the stream whose `X-Request-ID` is the measured request's, and build the `wire`
and `segments` parts with `latency_records`.

| Quantity | Must equal | Tol. | Measured | Row |
| --- | --- | --- | --- | --- |
| chat requests in the stream | 1 | exact | 1 | K14 |
| token events on the wire | `completion_tokens` | exact | 64 = 64 | K14 |
| mean ITL, wire − client | 0 | 0.05 ms | +0.002 to +0.007 | K15 |
| smallest segment | > 0 | bound | ≥ 0.094 ms | K15, K16 |
| headers on wire − `first_token_time` | < 0 | exact | −19.73 to −15.24 | K15 |

- **First row, the join by ID:** the request ID is in the captured bytes, so this join does not rest on isolation.
- **Second row:** a third reader (`tshark` on the raw bytes) agrees with the SDK and `usage`. It is not independent of the
  engine's output; it is independent of the SDK's parsing.
- **Mean ITL row:** wire and client span the same two token events; 0.05 ms is seven times the largest measured
  difference and below the 0.052 ms that dividing by 64 instead of 63 would add to one side only.
- **Smallest-segment row, the clock join:** the segments chain three clocks (client, capture, engine). A wrong unit, a
  missed `anchor_pair` conversion or a wrong stream makes some segment negative or absurd. Every segment was positive in
  60 of 60; the smallest was 0.094 ms.
- **Last row, the hazard on a third clock:** the headers leave the server's interface about 16 ms before the engine has
  its first token. Check 3 showed it on the client's clock; this shows it at the server, where the network is excluded.


## Results 

**Run:** `I02A_20261103T164324Z_348959`, 2026-11-03. **Pass check:** `make check` 5 of 5 passed on a fresh stack
(project `ie-i02a-l1-test`); `make test-unit` 33 passed.

| Quantity | Client | Wire | Engine |
| --- | --- | --- | --- |
| TTFT, ms | 35.564 | 34.910 | 29.478 |
| Mean ITL, ms | 4.531 | 4.533 | 4.547 |
| End-to-end, ms | 321.604 | 321.134 | 315.947 |

- **Prefill dominates TTFT:** 27.309 of 35.564 ms (77%). Queue 2.169; request's last byte → `arrival_time` (receive,
  body, template, tokenization) 1.196; the two network legs 2.348 and 0.655; engine-to-handler 1.303.
- **Slower than the spec's measurements (2026-10-31):** TTFT 35.6 vs about 20 ms, ITL 4.5 vs about 3.4 ms, and the TTFT
  remainder 6.09 ms is just above the measured range (3.22 to 5.97). The SM clock was 2742 MHz during the request, so a
  low clock does not explain it. Cause not found; `devtools/overhead.json` measures whether the devtools add to it.
- **Decode efficiency:** decode MBU 0.485 (218 GB/s of 448 GB/s Published), from 0.989 GB per step (weights + KV) and
  the engine ITL. Nsight Compute measured 1.013 GB DRAM read for one decode step (`TRACE=kernels`), 2.5% above the
  estimate. Prefill MFU is Unavailable (peak tensor FLOPS not yet sourced; I03); achieved 1.23 TFLOP/s.
- **K4 (`make k4`):** default `skip_special_tokens` gives 58 records for 64 tokens, and check 1 fails; `false` gives
  64 = 64. The spec measured 56; the count depends on where the answer ends.
- **Profiled runs (labeled, not measured):** `TRACE=timeline` (Nsight Systems, CUDA graphs on, 29,891 kernels mapped
  to their iteration and request), `TRACE=code` (PyTorch profiler with Python stacks, iterations 66–129, 211 kernels
  per decode step), `TRACE=kernels` (Nsight Compute, iteration 67, 242 kernels, 12 replay passes each).
- **Iteration numbering:** `/perf_metrics` counts iterations from 1; the executor's NVTX labels and
  `TLLM_PROFILE_START_STOP` count from 0. Checked by time: `first_iter` 66 starts in NVTX label 65.
- **`server_arrival_time` is stamped at the headers, not the full request** (owner ruling 2026-11-03). It is set in an
  ASGI middleware (`serve/responses_utils.py:1930`) once uvicorn has parsed the headers; the body is read later. In run
  `I02A_20261103T173059Z_b3fec0` the warm-up's body frame came 0.43 ms after its headers frame, and the old segment
  "wire → `server_arrival_time`" was −0.187 ms. As in I01-L2, a request arrives when all of it is in: the segments now
  run from the request's last byte straight to `arrival_time` (7 TTFT segments), and `server_arrival_time` is a labeled
  point. This run's `latency.json` was recomputed from its raw records under the revised split.

## Why It Matters 

- **TTFT is a client time that must hold a token.** TensorRT-LLM sends headers about 25 ms before it has a token, and
  the first body read holds only the role event. A load test that times headers or the first read reports a TTFT
  shorter than prefill.
- **Every latency has an owner.** The 7 segments split client TTFT across three clocks. Prefill is 27.3 of 35.6 ms;
  the network and the HTTP layer are under 2 ms each. Tuning targets come from the segment that grows, not the total.
- **`/perf_metrics` drains on read.** Correlation rests on isolation (one request, a drain before, one record after).
  Any other reader, such as a dashboard, breaks the join.
- **The wire is the referee.** The capture agrees with the SDK to 0.002 ms on mean ITL, so client-side parsing is not
  where latency hides.

## Toolkit

| Tool | Use |
| --- | --- |
| `make rep` | One measured run: stack up, warm-up, drain, measured request, analysis, `run.json` |
| `make rep TRACE=timeline` / `code` / `kernels` | Labeled profiled runs: Nsight Systems, PyTorch profiler with stacks, Nsight Compute |
| `make check` | The five pass checks on a fresh stack |
| `make k4`, `make source` | Walkthrough additions 3 and 2 |
| `make devtools` | Devtools at `http://127.0.0.1:7700`: Infrastructure, Lifecycle, Requests, Runs, Trace, Metrics, Logs, Tools |
| `scripts/iectl.py` | Agent CLI: `status`, `wait`, `logs`, `lifecycle`, `runs`, `run`, `spans`, `metrics`, `raw`, `snapshot`, `overhead` |
| `latency_records`, `pcap_streams`, `efficiency` | The analysis functions in `src/inference_analysis/` |
