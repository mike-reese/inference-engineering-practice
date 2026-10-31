# I02A-L1 -- Streamed Latency

## Mechanism 
The serving engine (TensorRT-LLM) sends response headers before the engine has a token, then streams one server-sent event per generated token. The engine provides measurements for the requests arrival, first token, and last token on its own clock separately from the times the client records on its own clock. The engine also does not measure anything related to the network.

## Task 
We have a new GPU compared to I01-L2.

We will swap to using TensorRT-LLM as our serving engine, running in a container (the NGC image plus the NVML patch, built from `deploy/tensorrt-llm/Dockerfile`), and cut over the I01-L2 Compose stack: server, client and the tcpdump capture sidecar. The stack driver moves to `scripts/compose_stack.py`. We'll send one warm-up request, drain `/perf_metrics`, and then send a measured streamed request. We count the prompt's tokens offline with the tokenizer and then read `/perf_metrics` twice, and decode the capture with `tshark` and `pcap_streams`. A new function (`latency_records`) turns the client record, the engine record and the captured stream into TTFT, ITL, end-to-end latency and the segments between them, each named by its clock. Outputs are the raw records, both `/perf_metrics` reads, the pcap, the offline count and the latency records.

## Configuration

| Item | This rep |
| --- | --- |
| Engine | TensorRT-LLM 1.2.1, PyTorch backend, `trtllm-serve` in a container; image = `nvcr.io/nvidia/tensorrt-llm/release:1.2.1@sha256:33cd085b…f927b9` + NVML patch layer, built from `deploy/tensorrt-llm/Dockerfile` (CUDA 13.1, torch 2.10.0a0+b4e4ee81d3.nv25.12, transformers 4.57.3 inside the image) |
| Local engine patch | NVML call in `tensorrt_llm/_utils.py` changed to `byref(cc_settings)` (upstream issue 18816); `_utils.py` sha256 `0619e389…3661c` before, `85570e359efb2e36263e032a6ef7a4c55705c621cbe8143f880a21a53856207e` after |
| Model and revision | `Qwen2.5-0.5B-Instruct` @ `7ae557604adf67be50417f59c2c2f167def9a775`, BF16 weights, local directory `~/.local/share/inference-engineering/models/Qwen2.5-0.5B-Instruct/<revision>` mounted read-only at `/model`; engine and offline tokenizer read the same files |
| Command (`server`) | `trtllm-serve serve /model --backend pytorch --host 0.0.0.0 --port 8000 --max_batch_size 1 --max_seq_len 2048 --config /config/config.yaml`; published on `127.0.0.1`, host port from `docker compose port server 8000` |
| Engine config (YAML) | `return_perf_metrics: true`, `perf_metrics_max_requests: 100`, `kv_cache_config.enable_block_reuse: false`, `kv_cache_config.free_gpu_memory_fraction: 0.5`; written into the run folder, mounted at `/config` |
| Engine environment | `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`; `gpus: all`; healthcheck `curl -sf http://127.0.0.1:8000/health` |
| Capture (`capture`) | `tcpdump --immediate-mode -i eth0 -p -n -s 0 -U --time-stamp-precision=nano -w /cap/<run id>_s<N>.pcap 'tcp port 8000'`, `network_mode: service:server`, `NET_RAW` only; tcpdump 4.99.4, TShark 4.2.5; run folder world-writable |
| Client (`client`) | I01-L2 image rebuilt with the client change: `locust_load.py` running `send_one(..., diagnostic=True)` from `scripts/chat_client.py`; `SERVER_BASE_URL=http://server:8000/v1`; OpenAI SDK 3.35.1, httpx2 2.16.0, Locust 2.47.0 |
| Request | system `You are a concise assistant for an inference team.`; user `Why does decode slow down as the KV cache grows?`; `max_tokens=64`, `temperature=0`, `seed=0`, `stream=True`, `stream_options={"include_usage": True}`, `logprobs=True`, `top_logprobs=1`; `extra_body={"ignore_eos": True, "skip_special_tokens": False}`; header `X-Request-ID` |
| Order | `compose up -d --wait server capture client` → 1 warm-up (not measured) → drain `/perf_metrics` → 1 measured request → read `/perf_metrics` (poll ≤ 2 s) → read again → save server log → `compose down` → decode the pcap |
| Libraries | transformers 5.20.2, httpx 0.28.1, huggingface_hub 2.3.0, pytest 9.1.1, torch 2.15.0+cu134; Python 3.12.14 |
| Docker | Docker 29.9.2, Compose 5.6.1, NVIDIA Container Toolkit 1.20.1 |
| GPU and driver | NVIDIA GeForce RTX 5060 Ti 16 GB (16,311 MiB), compute capability 12.0, driver 615.78.08, CUDA 13.4 |
| Machine state | Recorded by `rep.py` in `results/basis.json`: SM clock, temperature, power and other GPU processes at start and end |

## Inspection Points

One measured request. Times in ms from send on the client clock unless named; engine times converted from seconds; wire times converted from the epoch with the record's `anchor_pair`.

| Point | Value | Reported (source) | What it means | How we know (second source) | Difference |
| --- | --- | --- | --- | --- | --- |
| 1 offline | Prompt tokens, offline | | | | |
| 2 stream | Raw SSE lines (`curl -N`, hand check) | | | | |
| 2 stream | Response headers (`headers_ns`) | | | | |
| 2 stream | First body read: time | | | | |
| 2 stream | First body read: contents | | | | |
| 2 stream | First token event (TTFT) | | | | |
| 2 stream | Protocol completion, `[DONE]` (end-to-end) | | | | |
| 2 stream | Client-side first wire byte, transport EOF | | | | |
| 3 tokens | Events, total | | | | |
| 3 tokens | Token events | | | | |
| 3 tokens | `logprobs.content` records per token event | | | | |
| 3 tokens | `logprobs.content` records, total | | | | |
| 3 tokens | `usage.prompt_tokens` | | | | |
| 3 tokens | `usage.completion_tokens`, running and final | | | | |
| 3 tokens | `usage.prompt_tokens_details.cached_tokens` | | | | |
| 3 tokens | `finish_reason` | | | | |
| 3 tokens | Token gaps (exact ITL), count and range | | | | |
| 3 tokens | Mean ITL, client | | | | |
| 3 tokens | Perceived tokens per second | | | | |
| 4 wire | Chat requests in the captured TCP stream, `X-Request-ID` | | | | |
| 4 wire | Request's last byte at the server | | | | |
| 4 wire | Response headers on the wire | | | | |
| 4 wire | First token event on the wire | | | | |
| 4 wire | Token events on the wire (count, frames) | | | | |
| 4 wire | Mean ITL, wire | | | | |
| 4 wire | `[DONE]` on the wire | | | | |
| 5 engine | `/perf_metrics` first read: entries | | | | |
| 5 engine | Raw entry (`timing_metrics`, seconds) | | | | |
| 5 engine | `request_id` | | | | |
| 5 engine | Iterations (`last_iter − first_iter + 1`) | | | | |
| 5 engine | `kv_cache_metrics` | | | | |
| 5 engine | Queue (`first_scheduled_time − arrival_time`) | | | | |
| 5 engine | TTFT, engine (`first_token_time − arrival_time`) | | | | |
| 5 engine | HTTP-layer TTFT (`server_first_token_time − server_arrival_time`) | | | | |
| 5 engine | Decode span (`last_token_time − first_token_time`) | | | | |
| 5 engine | Mean ITL, engine (span / (completion tokens − 1)) | | | | |
| 5 engine | End-to-end, engine (`last_token_time − arrival_time`) | | | | |
| 5 engine | Handler, template, tokenization (`arrival_time − server_arrival_time`) | | | | |
| 5 engine | `/perf_metrics` second read: entries | | | | |

Segments of client TTFT (each named by the clocks at its two ends; they must sum to client TTFT):

| Segment | Clocks | ms |
| --- | --- | --- |
| send → request's last byte on the wire | client → pcap | |
| wire → `server_arrival_time` | pcap → engine | |
| `server_arrival_time` → `arrival_time` | engine | |
| `arrival_time` → `first_scheduled_time` | engine | |
| `first_scheduled_time` → `first_token_time` | engine | |
| `first_token_time` → `server_first_token_time` | engine | |
| `server_first_token_time` → first token on the wire | engine → pcap | |
| wire → client first token event | pcap → client | |
| `last_token_time` → `[DONE]` on the wire (end-to-end tail) | engine → pcap | |
| `[DONE]` on the wire → protocol completion (end-to-end tail) | pcap → client | |

Where each engine time is stamped (TensorRT-LLM 1.2.1 installed source):

| Field | File:line | Stamped when |
| --- | --- | --- |
| `server_arrival_time` | | |
| `arrival_time` | | |
| `first_scheduled_time` | | |
| `first_token_time` | | |
| `server_first_token_time` | | |
| `last_token_time` | | |

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

## Why It Matters 

## Toolkit
