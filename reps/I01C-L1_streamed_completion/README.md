# I01C-L1 - Streamed completion

## Mechanism
At load, the llama.cpp server reserves the KV cache for every token position in its context (`--ctx-size 4096`). The cache's size depends on the context size and the cache's dtype (f16), not on the weights' dtype.

For each request, the engine prefills the prompt in one forward call. It then decodes one token per forward call and streams each token as its own event, so each chunk holds one token. The final event carries the engine's counts, its stop reason and its timings.

The engine also exports counters at `/metrics`: prompt tokens, generated tokens and the engine's seconds. `/metrics` holds no TTFT or ITL. The client measures TTFT (time to first token) on its own clock. So three records exist: the engine's final event, the client's clock and `/metrics`. Two of them come from the engine.

Inter-token latency (ITL) is the time between consecutive tokens, in ms per token. Perceived TPS is tokens per second for one user. For a single request it is roughly 1000 / ITL, but it is a different quantity in different units. This rep records each chunk's arrival time. ITL and its percentiles are computed in I02.

The client's interval minus the engine's interval is everything outside the engine: HTTP handling, the network and any queue. This rep cannot separate those parts from one another.

## Task
We'll reuse the server script (`scripts/llama_cpp_server.py`) and the image from I01A, with llama.cpp b6500 and one slot. New here:

- the flags `--temp 0 --seed 0 --metrics`, with no `--jinja`;
- a streaming client: `httpx` with keep-alive off;
- the prompt sent as the rendered string, so the engine tokenizes it and the prompt count is its own reading.

We'll send three requests:

- **A** ends on eos. It sends `cache_prompt: false`.
- **B** ends at the token limit (`n_predict` 12). It sends `cache_prompt: false`.
- **Hazard** is A again with `cache_prompt` at its default (true), so the engine reuses the 18-token prefix A shares with B.

We'll inspect four points. Point 1 is read once, at load. Points 2–4 are read per request.

1. **KV buffer (at load).** The engine's reported KV buffer size. Second source: `kv_cache_shape` at 2 bytes per element.
2. **Chunks.** Each streamed chunk and its arrival time on the client's clock. Second source: our chunk count against the final event's `tokens_predicted`.
3. **Final event.** The engine's counts and stop reason. Second sources: the `transformers` tokenizer's prompt count, the `eos_token` ID and `n_predict`.
4. **Timings.** The engine's timings in the final event. Second sources: the client's clock (independent) and the `/metrics` deltas (not independent; they come from the engine).

## Configuration

| Item | This rep |
| --- | --- |
| Model and revision | `Qwen/Qwen2.5-0.5B-Instruct` @ `7ae557604adf67be50417f59c2c2f167def9a775`; tokenizer and `config.json` from the local cache, `HF_HUB_OFFLINE=1` |
| Libraries | httpx 0.28.1, prometheus-client 0.26.0, transformers 5.20.2, huggingface_hub 2.3.0, pytest 9.1.1; Python 3.12.14 |
| Engine | llama.cpp server b6500 (commit `a7a98e0fffed`), via `scripts/llama_cpp_server.py`; `build_info` `b6500-a7a98e0fffed+firstfit` (`/props`) |
| Engine image | `telos-llama:b6500-firstfit-cuda12.4-sm61-nsys2023.4.4` (the script's default), `sha256:8cbe0ac473189ff807a993929ecc952cbf224e17fed15c063bbc5cdfd205b070` |
| Engine's model file | `Qwen2.5-0.5B-Instruct-f32.gguf` (the script's default), as in I01A-L1; 1,982,078,784 bytes, sha256 `5398ce9e21beb102f3bac22625596fa8e1a3333a99696a84a6cde43a3c60c53f` |
| Server flags | `--ctx-size 4096 --parallel 1 --temp 0 --seed 0 --n-gpu-layers 99 --metrics` |
| Engine defaults kept | `--cache-type-k` and `--cache-type-v` f16; `--flash-attn auto` (log: `Flash Attention was auto, set to enabled`); no `--jinja` |
| GPU and driver | NVIDIA GeForce GTX 1080 Ti, driver 580.178.04 |
| Machine state | Before start: SM clock 1,493 MHz, 36 °C, 9,391 MiB free, load average 0.69. After the requests: 1,987 MHz, 45 °C, 6,993 MiB free, load average 0.72 |
| System message | `You are a concise assistant for an inference team.` |
| Request A | user `In one short sentence, what does the KV cache store?`, `n_predict` 64, `cache_prompt` false |
| Request B | user `Why does decode slow down as the KV cache grows?` (I01A-L1's request), `n_predict` 12, `cache_prompt` false |
| Hazard request | A again, `cache_prompt` left out (default true) |
| Prompt | rendered by the `transformers` chat template with `add_generation_prompt=True`, sent as a string |
| Request body | `{"prompt": <rendered string>, "n_predict": n, "stream": true, "cache_prompt": false}` on `POST /completion` (the hazard omits `cache_prompt`) |
| Order | one server start; A, then B, then the hazard; no warm-up; `/metrics` read before the first request and after each one |
| Client | one `httpx.Client`, `limits=httpx.Limits(max_keepalive_connections=0)`, timeout 60 s |
| Client clock | `time.perf_counter_ns()`; send time read on the line before `with client.stream(...)` |
| `/metrics` parser | `prometheus_client.parser.text_string_to_metric_families`, values looked up by sample name |

The values above come from the `rep.py` run on 2026-10-27. The full `docker run` command and every run-time value are in `results/output.txt` and `results/record.json` (`configuration`, `machine_state_before_start`, `machine_state_after_requests`).

### Why these choices

- **Same checkpoint and GGUF as I01A-L1:** its template and token IDs were matched to llama.cpp there, so the `transformers` tokenizer is a valid second source for the engine's prompt count.
- **`--ctx-size 4096`:** the number of token positions (cells) the KV cache reserves at load.
- **`--parallel 1`:** one slot. The three requests run one after another in the same cache, which makes the hazard's prefix reuse possible.
- **`--temp 0`:** the sampler keeps only the most likely token, so the reply is the same on every run and every count check is exact.
- **`--seed 0`:** changes nothing at temperature 0; fixed so the configuration is complete.
- **`--metrics`:** turns on `GET /metrics`. Without it the endpoint returns 501.
- **No `--jinja`:** `/completion` applies no chat template, so the flag does not matter here.
- **Cache dtype f16 (default):** the KV buffer's size depends on it, not on the F32 weights. The cost model uses `dtype_bytes=2`.
- **Request A:** its greedy reply ends on the end-of-sequence token well inside 64 tokens.
- **Request B:** its greedy reply does not end on its own, so `n_predict` 12 always stops it by the limit.
- **A and B share their first 18 tokens** (the system turn and `<|im_start|>user\n`). The hazard reuses that prefix.
- **`cache_prompt: false` for A and B:** every prompt token is prefill work, so `prompt_n` equals the tokenizer's count. The hazard sends the default on purpose.
- **Prompt as a string, not IDs:** the engine tokenizes it, so its count is its own reading, and the `transformers` count can confirm it.
- **Keep-alive off:** llama-server closes the connection after every streamed response but does not say so in its headers. A pooled client can reuse the closed connection and fail.
- **Send time before `with client.stream(...)`:** the `with` line returns when the headers arrive. A clock started after it misses the header time.
- **No warm-up:** each check compares two readings of the same request, never times across requests. A is the first request after load and is slower.

## Inspection Table

Point 1 is read once, at load. Points 2–4 are read for A, B and the hazard request; where a row holds three values, they are A, B, hazard in that order.

| Point | Value | Engine reports | What it means | How we know (second source) | Difference |
| --- | --- | --- | --- | --- | --- |
| 1 load | KV size, total (`llama_kv_cache: size = ...`) | 48.00 MiB | The whole KV reservation, allocated at load before any request | `kv_cache_shape(config, 4096, dtype_bytes=2).total_bytes` / 2^20: 50,331,648 bytes = 48.00 MiB | 0.0000 MiB |
| 1 load | K and V size | K 24.00 MiB, V 24.00 MiB | Each half of the reservation | `total_bytes` / 2 / 2^20: 24.00 MiB | 0.0000 MiB |
| 1 load | Cells | 4096 | Token positions reserved | `--ctx-size` 4096 | none |
| 1 load | Layers | 24 | One K and one V tensor per layer | `num_hidden_layers` in `config.json`: 24 | none |
| 1 load | K and V dtype | f16, f16 | The cache's dtype, an engine setting | f16 default, 2 bytes (`dtype_bytes=2`); at the weights' 4 bytes the model predicts 96.00 MiB | none |
| 1 load | Sequences | 1/1 seqs | How many sequences share the cache | `--parallel` 1; `/props` `total_slots` 1 | none |
| 1 load | KV buffer (`CUDA0 KV buffer size = ...`) | 48.00 MiB | The device allocation that holds the cache | the size line's total: 48.00 MiB | none |
| 2 chunks | Headers arrive (ms from send) | 2.32, 2.26, 2.30 | Response headers received by httpx; not exact first wire-byte arrival or the first token | client clock only | not checked by a second source |
| 2 chunks | Each chunk: ID, `content`, `tokens_predicted`, arrival (ms from send) | A: `The` at 25.42 ms … `.` at 117.73, then 151645 `''` at 124.33. B: `When` at 15.05 … ` the` at 87.96. Hazard: `The` at 13.55 … 151645 `''` at 113.74. Chunks about 6.6 ms apart | One sampled token per chunk; the end-of-sequence chunk has `content` `""` | running `tokens_predicted` rises by one per chunk: 1…16, 1…12, 1…16 | none |
| 2 chunks | Chunk count (events with `stop` false) | 16, 12, 16 (`data:` events 17, 13, 17) | Tokens streamed to the client | final event's `tokens_predicted` and `timings.predicted_n`: 16, 12, 16 | none |
| 2 chunks | Hazard reply IDs | 785, 84648, 6500, … 13, 151645 (16 IDs) | The reply with a reused prefix | A's first reply IDs | none (all 16 equal) |
| 3 final | `stop_type` | `eos`, `limit`, `eos` | Why generation ended: `eos` or `limit` | A and hazard: last chunk's ID 151645 = `convert_tokens_to_ids("<\|im_end\|>")` 151645. B: 12 chunks = `n_predict` 12 | none |
| 3 final | `stopping_word`, `truncated` | `""`, false (all three) | No stop string matched; the prompt and reply fit the context | no stop strings sent; prompt + reply ≤ 51 < 4096 | none |
| 3 final | `tokens_evaluated` | 35, 34, 35 | The whole prompt's length, cached part included | `transformers` tokenizer count of the same string: 35, 34, 35 | none |
| 3 final | `tokens_predicted` | 16, 12, 16 | Tokens generated, end-of-sequence included | chunk count: 16, 12, 16 | none |
| 3 final | `tokens_cached` | 50, 45, 50 | Cells holding this request's tokens (`n_past`) | tokenizer count + chunk count − 1: 50, 45, 50 | none |
| 4 timings | `cache_n` | 0, 0, 18 | Prompt tokens reused from the cache | A, B: 0 (`cache_prompt` false). Hazard: shared prefix of A's and B's IDs, 18 | none |
| 4 timings | `prompt_n` | 35, 34, 17 | Prompt tokens processed (prefill work) | tokenizer count − `cache_n`: 35, 34, 17; Δ `prompt_tokens_total` (not independent): 35, 34, 17 | none |
| 4 timings | `prompt_ms` | 23.069, 12.770, 11.238 | Prefill forward call plus the first sample, on the engine's clock | client TTFT 25.415, 15.048, 13.553; Δ `prompt_seconds_total` × 1000 (not independent): 23, 12, 11 | TTFT − `prompt_ms`: +2.346, +2.278, +2.315 ms. Counter: −0.069, −0.770, −0.238 ms (floor) |
| 4 timings | `predicted_n` | 16, 12, 16 | Tokens generated | chunk count 16, 12, 16; Δ `tokens_predicted_total` (not independent): 16, 12, 16 | none |
| 4 timings | `predicted_ms` | 98.991, 72.967, 100.217 | First token sampled to last: `predicted_n` − 1 decode steps | client end-to-end 124.388, 88.085, 113.796; Δ `tokens_predicted_seconds_total` × 1000 (not independent): 98, 72, 100 | end-to-end − both: +2.328, +2.348, +2.341 ms. Counter: −0.991, −0.967, −0.217 ms (floor) |

"Not independent": the `/metrics` counters add the same per-request values that `timings` reports, from the same clock. They confirm the export, not the engine's clock or count. The client clock is the independent source.

All values above come from `results/output.txt` and `results/record.json`.

## Pass Check 

**Status: passing.** `HF_HUB_OFFLINE=1 uv run pytest` on 2026-10-28: 24 passed, none skipped (23 s).

- `reps/I01C-L1_streamed_completion/test_i01c_l1.py`: the four pass checks below, against a live llama.cpp server. One module-scoped fixture sends A, B and the hazard request in that order.
- `tests/test_completion.py`: `completion_record` on typed events, no server (3 tests).
- `reps/I01A-L1_chat_request_inspection/test_i01a_l1.py`, `reps/I01B-L1_sampler_inspection/test_i01b_l1.py`, `tests/test_kv_cache.py`, `tests/test_llama_cpp_server.py`: earlier tests, still passing.

The "Measured" column holds the values found when each check was fixed (spec, 13 server starts). The `rep.py` run falls inside every one of them (see Results).

All tests must pass:

### 1. KV buffer at load: the engine's log against the config

Read the `llama_kv_cache: size = ...` line from `docker logs <name>` after the server is ready. Call `kv_cache_shape(config, 4096, dtype_bytes=2)` on the raw `config.json`.

| Quantity | Must equal | Tol. | Measured | Row |
| --- | --- | --- | --- | --- |
| KV size (MiB) | `total_bytes` / 2^20 | 0.005 MiB | 0.00 | K1, K2 |
| K size (MiB) | `total_bytes` / 2 / 2^20 | 0.005 MiB | 0.00 | K1, K2 |
| cells | `--ctx-size`, 4096 | exact | 4096 | K1 |
| layers | `num_hidden_layers`, 24 | exact | 24 | K1, K2 |
| K and V dtype | f16, 2 bytes | exact | f16, f16 | K1 |

- **K size row:** V has the same size; one of the two is enough.
- **Why 0.005 MiB:** the log rounds to two decimals; half a unit in the last place is the most rounding can move it.
- **Why `dtype_bytes=2`:** the weights are F32, but the KV cache type is an engine setting, f16 by default. The cost model must use the cache's dtype. With the default `dtype_bytes=4` it predicts 96.00 MiB, 2× the reservation.

### 2. The stream and the final event: counted twice

Build A's and B's records with `completion_record`. Count the prompts with the `transformers` tokenizer; convert `/props`' `eos_token` with `convert_tokens_to_ids`.

| Quantity | Must equal | Tol. | Measured | Row |
| --- | --- | --- | --- | --- |
| A, B chunks | `predicted_n`, `tokens_predicted` | exact | 16, 12 | K6–K8 |
| A `stop_type`, last ID | `eos`, `eos_token`'s ID | exact | eos, 151645 | K4, K6 |
| B `stop_type`, chunks | `limit`, `n_predict` 12 | exact | limit, 12 | K7, K8 |
| `tokens_evaluated` | tokenizer count | exact | 35, 34 | K5, K8 |
| `tokens_cached` | count + chunks − 1 | exact | 50, 45 | K8 |
| `stopping_word`, `truncated` | `""`, false | exact | `""`, false | K8 |

- **Chunks:** events with `stop` false. All `data:` events give 17 and 13 (one too many: the final event); chunks with text give 15 for A (one too few: the end-of-sequence chunk's content is `""`).
- **`tokens_cached` row:** the last sampled token is returned but never fed back, so it has no cell. The cache holds 35 + 15 positions after A, not 35 + 16.
- **Why exact:** these are integers and strings, and at temperature 0 the reply is the same every run.

### 3. Engine timings against the client clock and `/metrics`

For A and B: the record's TTFT and end-to-end time, its `timings`, and the deltas of `/metrics` read just before and just after the request, parsed with `text_string_to_metric_families`.

| Quantity | Must equal | Tol. | Measured | Row |
| --- | --- | --- | --- | --- |
| TTFT − `prompt_ms` | 0 < r ≤ 10 ms | bound | 2.2 to 6.4 ms | K10 |
| end-to-end − both | 0 < r ≤ 10 ms | bound | 2.2 to 5.4 ms | K10 |
| Δ `prompt_tokens_total` | `prompt_n` | exact | 0 | K11 |
| Δ `tokens_predicted_total` | `predicted_n` | exact | 0 | K11 |
| Δ `prompt_seconds_total` × 1000 | `prompt_ms` | 1 ms | 0 to 0.99 ms | K11 |
| Δ `tokens_predicted_seconds_total` × 1000 | `predicted_ms` | 1 ms | 0 to 0.99 ms | K11 |

- **"Both":** `prompt_ms` + `predicted_ms`.
- **Why greater than 0:** the engine's intervals sit inside the client's. The client sends before the engine starts the prompt and receives the first chunk after the engine sampled the first token; likewise for the final event. A remainder below 0 means the client clock started late (inside `with client.stream(...)`) or an engine phase was counted twice.
- **Why at most 10 ms:** the largest of 126 remainders (63 requests, both images, load average up to 10.5) was 7.3 ms, so 10 ms is above the measured spread. It is below the smallest `prompt_ms` measured, 11.0 ms, so a comparison that leaves out an engine phase (end-to-end against `predicted_ms` alone) fails. On a busier machine the remainder grows: if this row fails above 10 ms, check the load average before the code.
- **On another GPU, fix the bound again:** it must lie above the largest measured remainder and below the smallest measured `prompt_ms` of A and B. A faster GPU shortens `prompt_ms` but not the HTTP remainder, so both are re-measured before the rep runs there; if no such value exists, the upper bound no longer catches a left-out phase and the row is redesigned.
- **Why the send as the anchor:** first chunk to final event, minus `predicted_ms`, ranged from −1.9 to +0.8 ms (K10). Two delivery delays subtract, and the sign is not fixed.
- **Why exact for the token counters:** they add the same integers the final event reports.
- **Why 1 ms for the seconds counters:** they add whole milliseconds, rounded down, so a delta × 1000 is `floor(ms)`, up to 0.999 ms below `timings`.
- **Not independent:** the counters and `timings` come from the same engine values. Their agreement shows the export is right, not the time. The client clock is the independent source.

### 4. The hazard: a cached prefix counted as prefill

After B, send request A again with `cache_prompt` left out (default true). Build its record and read the `/metrics` delta around it.

| Quantity | Must equal | Tol. | Measured | Row |
| --- | --- | --- | --- | --- |
| `cache_n` | shared prefix of A and B | exact | 18 | K5, K12 |
| `prompt_n` | tokenizer count − `cache_n` | exact | 17 | K12 |
| `tokens_evaluated` | tokenizer count | exact | 35 | K12 |
| Δ `prompt_tokens_total` | `prompt_n` | exact | 17 | K12 |
| reply IDs | request A's first reply | exact | equal | K6, K12 |

- **Shared prefix:** the number of leading IDs equal in A's and B's tokenized prompts. The slot still held B's tokens, and the engine reused the longest prefix the new prompt shares with them.
- **The wrong method:** reading `prompt_n` as the prompt's length, or as the prefill work for the whole prompt. It returns 17 of 35 tokens; `prompt_per_second` then describes 17 tokens of work. `tokens_cached` stays 50 and says nothing about reuse.
- **`/metrics` row:** the counter repeats the engine's 17. Only the tokenizer count exposes the difference, which is why it is the second source for prompt length.
- **Reply row:** greedy decoding gave the same 16 IDs with and without the reused prefix (21 of 21 starts). The README warns this is not guaranteed: logits computed in a different batch shape need not be bit-for-bit equal.
- **Why exact:** integers and an ID sequence.
- **Why it matters:** prefix caching (I11) is how production engines skip a shared system prompt. A dashboard or a bill that reads the processed count as the prompt length undercounts every request that hits the cache.

## Results 
Every value agreed with its second source, in the `rep.py` run (`results/output.txt`) and in the four pass checks. The engine's intervals sat inside the client's by 2.28–2.35 ms in all six comparisons. The `/metrics` counters matched `timings` exactly for tokens and to the whole millisecond (rounded down) for time. The hazard request read as the wrong method expects: `prompt_n` 17 against a 35-token prompt, and `/metrics` repeated the 17.

| Point | Engine reports | Second source | Result |
| --- | --- | --- | --- |
| 1 load | KV 48.00 MiB (K and V 24.00 each, f16), 4096 cells, 24 layers, 1/1 seqs | `kv_cache_shape(config, 4096, dtype_bytes=2)`; `--ctx-size`; `config.json`; `/props` | difference 0.0000 MiB; at 4 bytes the model would say 96.00 MiB (2×) |
| 2 chunks | A 16, B 12, hazard 16 chunks; one ID each; A's last is 151645 with `''` | final event's `tokens_predicted`, `predicted_n` | equal; `data:` events are one more (the final event); chunks with text are one fewer for A (15) |
| 3 final | A `eos`, B `limit`; `tokens_evaluated` 35, 34; `tokens_cached` 50, 45 | `eos_token` ID 151645; `n_predict` 12; tokenizer count; count + chunks − 1 | all equal |
| 4 timings, client clock | `prompt_ms` 23.069, 12.770, 11.238; `predicted_ms` 98.991, 72.967, 100.217 | TTFT and end-to-end on `perf_counter_ns` | remainders +2.28 to +2.35 ms, all positive and ≤ 10 ms |
| 4 timings, `/metrics` | `prompt_n` 35, 34, 17; `predicted_n` 16, 12, 16 | per-request counter deltas (not independent) | token deltas equal; seconds deltas × 1000 = `floor(ms)`, up to 0.991 ms below |
| hazard | `cache_n` 18, `prompt_n` 17, `tokens_evaluated` 35 | shared prefix 18; tokenizer count 35 | `prompt_n` covers 17 of 35 tokens (18 of 35, 51%, came from the cache); reply IDs equal A's |

Other readings from the run:

- **First request after load is slower.** A's `prompt_ms` was 23.069 ms for 35 tokens; B's was 12.770 ms for 34. The second request did the same work in about half the time.
- **Prefill time barely moves with prompt length at this size.** The hazard processed 17 tokens in 11.238 ms; B processed 34 in 12.770 ms. So the engine's `prompt_per_second` reads 1,513 tokens/s for the hazard and 2,662 for B. Neither describes the 35-token prompt the client sent.
- **The per-token ratio divides by one step too many.** `predicted_per_token_ms` divides `predicted_ms` by `predicted_n`: 6.19, 6.08, 6.26 ms. The decode steps number `predicted_n` − 1: 6.60, 6.63, 6.68 ms per step. The client's chunk spacing agrees with the second: A's chunks 1 to 16 span 98.91 ms over 15 gaps, 6.59 ms each.
- **`/metrics` totals are not per request.** After B the totals read 69 prompt tokens and 28 generated, the sum of A and B. Only the deltas around one request match its `timings`.

## Why It Matters

The client clock measures what the user waits for. The engine's `prompt_ms` and `predicted_ms` measure intervals inside llama-server. Comparing them shows engine time and a combined HTTP, queue and network remainder. These records cannot isolate network speed or separate queue time from network time.

The first request after load also includes warm-up costs. The separate exploration notebook traces its GPU activity and compares repeated requests and a request after idle. The three requests in this rep alone do not isolate the cause of A's higher prefill time.

Prefix reuse changes how much prefill work the engine performs. In the hazard request, 18 of 35 prompt tokens came from the cache, so `prompt_per_second` describes only the 17 tokens computed. Crediting that time with all 35 tokens overstates computed-token throughput. On this pinned llama.cpp server, leaving out `cache_prompt` enables reuse by default; it does not clear the cache.

## Toolkit
- `inference_analysis.completion.completion_record(events, send_ns)` in `src/inference_analysis/completion.py` (new): builds one request's `CompletionRecord` from the stream's `(t_ns, event)` pairs and the send time. Counts every event with `stop` false as a chunk, the empty end-of-sequence chunk included. Takes the counts, stop reason and `timings` from the event with `stop` true, and raises `ValueError` when there is none. Tested in `tests/test_completion.py`. `I01-L2` and I02 build on it.
- `inference_analysis.kv_cache.kv_cache_shape` (from I01A-L1): reused unchanged, with `dtype_bytes=2` for the f16 cache.
- `scripts/llama_cpp_server.py` (from I01A-L1): starts and stops the server for `rep.py` and the test fixture. Reused unchanged; only the flags differ.
- The rep's other helpers live in `rep.py`, with copies in `test_i01c_l1.py`; the shared chat streaming collector and load generator are introduced in `I01-L2` (owner approval, 2026-10-28); `I02A-L1` later inspects the OpenAI SDK stream:
  - `stream_request` / `stream_completion`: reads the send time before `with client.stream(...)`, records each `data:` line with its arrival time, and builds the record.
  - `read_metrics(client, url)`: parses `/metrics` with `text_string_to_metric_families` into a dict keyed by sample name.
  - `shared_prefix(a, b)` (test file): the number of leading token IDs two prompts share.
