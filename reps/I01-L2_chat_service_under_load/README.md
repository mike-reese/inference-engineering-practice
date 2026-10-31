# I01-L2 -- Chat service under load

## Mechanism 
As input sequence length increases, we will see an interaction where the prefill stage of model serving grows but the decode stage of model serving largely doesn't grow. We'll see that end-to-end latency changes with prompt length specifically in this section of the pipeline. Given that we are still doing relatively small context sizes (maximum of 1024) we will not see a material increase in decode time. The effect is there, but the realized impact is not yet visible at these context sizes.
## Task 
We are building a containerized production client/server inference infrastructure (hosted locally) focused on measuring production serving metrics including TTFT and content-event gaps (we will not be measuring server-side ITL here with llama.cpp -- and client-side chunk receipt is not single-token since it's text and we will not conflate the two measurements. We will measure the chunk receipt intervals but we will refer to it as content-event gaps).

Specifically, we would like to validate and observe what changes in TTFT and end-to-end latency as the ISL prompt length grows in three intervals from 64 to 256 to 1024 tokens at concurrency 1. We need to identify which component spends each millisecond and how the interaction of increasing input sequence length impacts those metrics.

We'll be building a seven-service deployment; containers for the client (using the OpenAI SDK to send messages), the server (using llama.cpp), prometheus (to store provided quantile / p50/90/95/99 / histogram bucket measurement counts), grafana (to display the measurements in a monitoring dashboard), NVIDIA DCGM (to measure GPU hardware metrics), and Node Exporter (to measure CPU hardware metrics), and a capture sidecar (tcpdump in the server's network namespace for network metrics).

In order to validate this, we'll get repeated measurements over the same prompts (3 replay blocks, each running all three ISLs in a rotated order) and validate a number of different prompt input sequence lengths and simulate server failure and recovery. The intention is to provide a very small scale, but realistic, monitoring and serving infrastructure on our local hardware.
## Configuration 

Fixed by the spec (`practice/specs/I01-L2.md`, Configuration). Rows marked *at run* are filled from the run's saved records.

| Item | This rep |
| --- | --- |
| Model and revision | `Qwen/Qwen2.5-0.5B-Instruct` @ `7ae557604adf67be50417f59c2c2f167def9a775` |
| Engine's model file | `Qwen2.5-0.5B-Instruct-f32.gguf` (as in I01A-L1), mounted read-only; 1,982,078,784 bytes, sha256 `5398ce9e21beb102f3bac22625596fa8e1a3333a99696a84a6cde43a3c60c53f` |
| Engine image | built from upstream llama.cpp b6500, commit `a7a98e0fffed794396b3fbad4dcdbbc184963645`, `.devops/cuda.Dockerfile`, target `server`, `CUDA_VERSION=12.4.0`, `UBUNTU_VERSION=22.04`, `CUDA_DOCKER_ARCH=61`; image ID, base digests and build log *at run* |
| GPU and driver | NVIDIA GeForce GTX 1080 Ti, compute capability 6.1, UUID `GPU-2204ae42-2bdf-1439-aa06-59c98ac3b546`, driver 580.178.04 (checked 2026-10-29) |
| Server flags | `--ctx-size 4096 --parallel 1 --temp 0 --seed 0 --n-gpu-layers 99 --metrics -lv 1 --log-timestamps --log-prefix --log-file /logs/<run id>_s<N>.log`; `<N>` counts server starts within the run |
| Capture sidecar | `tcpdump -i eth0 -p -n -s 0 -U --time-stamp-precision=nano -w /cap/<run id>_s<N>.pcap 'tcp port 8080'`; `network_mode: service:server`, `cap_drop: [ALL]`, `cap_add: [NET_RAW]`, writable `/cap` |
| ISLs | 64, 256, 1024 tokens; concurrency 1 |
| Messages | system `You are a concise assistant for an inference team.`; user `Read these words:` + ` red` × 28 / 220 / 988, newline, `Write a numbered list with ten observations.` |
| Output policy | OSL 32 (`max_tokens`), temperature 0, seed 0; `extra_body` `cache_prompt: false`, `ignore_eos: true`; normal calls `logprobs: false` |
| Diagnostic calls | `logprobs: true`, `top_logprobs: 1`; kept out of normal results |
| Workload | 3 replay blocks: 64/256/1024, 256/1024/64, 1024/64/256; per setting 3 warm-ups (saved, excluded) + 8 measured; 24 measured per ISL, 72 total |
| Stability guard | per 8-request replay, first-four vs last-four e2e P50 ≤ 15 ms; across 3 blocks per ISL, e2e P50 range ≤ 15 ms |
| Overhead controls | ISL 256; 3 pairs per control; each condition 3 warm-ups (saved, excluded) + 4 measured; order on→off in pairs 1 and 3, off→on in pair 2. **Diagnostic:** `logprobs` on vs off. **Observer:** Prometheus, Grafana, Node and DCGM running with dashboard polling every 5 s vs those four stopped and client events/metrics off. **Logging:** server restarted with debug log + capture vs restarted without log flags (`deploy/compose.logoff.yaml`) and capture stopped |
| Client connection | one SDK client; `max_retries=0`, transport retries 0, HTTP/1.1, no env proxy; max connections 1, keep-alive 1, expiry 30 s; timeout 10 s, connect/pool 2 s; phase bound `max(30 s, requests × 10 s)` |
| Client clocks | `time.perf_counter_ns()`; anchor pair `time.time_ns()` + `time.perf_counter_ns()` at each send; `X-Request-ID` header on every request |
| Client image | Python 3.12 slim `sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea`; `openai==3.35.1`, `httpx2==2.16.0`, `locust==2.47.0`, `prometheus-client==0.26.0`; resolved list and image ID *at run* |
| Histogram buckets (s) | 0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1, 2, 5, +Inf |
| Prometheus | `prom/prometheus:v3.13.5` `sha256:aafa9d694e6a883c02db516d9f6e5b84e14195f49a2a6456a4cca815edda72b9`; scrape and rule evaluation every 1 s; retention 2 h or 128 MB |
| Grafana | `grafana/grafana:13.3.0` `sha256:488984b716c0862639f91a698adbe2862677a5a07bad42da5f03f3030883b205` |
| Node Exporter | `prom/node-exporter:v1.12.1` `sha256:1b4e4438faca4dd7e001dd445d161a4a2091b0fededa84093b3a8dfeae1f1be0` |
| DCGM Exporter | `nvidia/dcgm-exporter:4.3.1-4.4.1-ubuntu22.04` `sha256:64f322a826599664a1fe5ea4e3f76b7b0984142050e7047d63ae1d6687b4b1aa`; `-c 1000`; fields `SM_CLOCK`, `MEM_CLOCK`, `GPU_TEMP`, `POWER_USAGE`, `GPU_UTIL`, `MEM_COPY_UTIL`, `FB_USED`, `FB_FREE` (`DCGM_FI_DEV_` prefix) + driver-version label |
| Memory limits | server 8 GiB; client and Prometheus 512 MiB each; Node Exporter 128 MiB; Grafana and DCGM Exporter 1 GiB each |
| Lab budgets | client TTFT P95 150 ms; complete-response P95 400 ms (reference lines, not SLOs) |
| Machine state | GPU clocks left at the driver default (GPU Boost, not locked); clocks, temperature, power, memory and host load before and after each phase *at run* |

### Why these choices

- **One model, one GGUF, one slot, concurrency 1:** only prompt length changes between settings.
- **`cache_prompt: false`, `ignore_eos: true`, OSL 32:** every request prefills its whole prompt and decodes exactly 32 tokens, so decode work is the same at every ISL.
- **`-lv 1`, not `-v`:** `-v` sets verbosity above 9, which turns on `params.verbose` and changes the response objects. `--log-prefix` is what prints the timestamps.
- **New log and pcap filename per start:** llama.cpp opens `--log-file` with mode `"w"` and `tcpdump -w` truncates, so a restart erases the previous file.
- **Capture in the server's network namespace:** the server's interface is where network time ends and server time begins.
- **`max_retries=0`:** every attempt, including failures, stays visible as one record.
- **Rotated block order:** a slow drift in the machine doesn't land on one ISL only.
- **Warm-ups saved, not deleted:** first-call costs stay inspectable but out of measured summaries.
- **GPU clocks not locked:** the rep measures the service as it normally runs. Boost clock changes stay in the evidence (DCGM `SM_CLOCK`) and in the results, not removed by host tuning.

## Inspection Points 

| Point | What I read | Second source | Independent or accounting-only | Limits |
| --- | --- | --- | --- | --- |
| 1. Build and deployment | `evidence/server_image.json` (source commit, Dockerfile sha256, build args, image ID); resolved Compose config; `containers_inspect.json` (images, mounts, memory limits) | The running server container's `Image` equals the built image ID; `host_identity.json` (hostname, CPUs, memory, GPU UUID, driver) against the Node and DCGM series | Independent: Docker's view of the running container versus the build record; `nvidia-smi` and `/proc` versus the exporters | Configuration shows intent; only inspection of the running containers shows execution |
| 2. Ordinary chat response | One normal record: messages, SDK events on the monotonic clock, status, finish, usage, timings (`example_request` in `analysis/summary.json`) | `X-Request-ID` joins the record to its pcap stream and its server-log task; the engine's `timings` | The pcap is an independent clock for response boundaries. The engine `timings` are not an independent client clock | Exact ITL and transport EOF are unavailable. SDK close is not EOF. A content event is not a token |
| 3. Token diagnostic and offline parity | Diagnostic records' `logprobs` token IDs and receive groups; `audit/hf_parity.json` (HF input and output IDs, float32, `cuda:0`) | Hugging Face transformers: another runtime, run offline by `audit.py` | Output IDs: independent runtimes. Input length: shares the tokenizer files, so not independent of tokenization | Diagnostic calls carry `logprobs` overhead; reported separately (K8). Normal calls carry no IDs |
| 4. Collection and failure | Client and server `/metrics` at three checkpoints (`after_replay`, `before_failure`, `final`); histogram buckets; Prometheus exports; rule states; health checks; dashboard | Raw records rebuild every counter, bucket and sum; host and device checks | Counters versus records: accounting-only (same source). Host and device identity: independent | The failure request's pcap is incomplete: the kill can't wait for tcpdump to receive its last packet block, so packets from about the last second are lost. Failure evidence comes from the client record. Histogram quantiles are estimates. `up=1` is scrape success only |
| 5. Prompt-length effect | Per-replay TTFT and e2e P50 by ISL; whole-block bootstrap interval; engine `prompt_ms`; control differences; per-request segments | Locust statistics rebuilt from raw records; engine prompt time; segment decomposition from client, capture and server-log clocks, each segment's clock named | Locust: accounting-only. Engine prompt time: same direction required, shares the server. Segments: independent clocks joined by a bounded offset | N = 3 blocks; the interval is descriptive. GPU clocks are not locked, so decode time can shift by about 13 ms between boost bands and show up in control differences |

## Protocol (frozen)

Frozen at the commit that adds this section, before the measured run. Changing any of it after the measured run requires a new run.

**Fixed inputs:** the constants in `rep.py` (messages, ISLs, OSL, block orders, warm-up and measured counts, control design, guard, budgets, quantiles), `deploy/`, `monitoring/`, `scripts/chat_client.py`, `scripts/locust_load.py`, `audit.py` and `test_i01_l2.py`.

**Run order (one `rep.py` process):**

1. Record host identity and a host snapshot; start the stack with `--wait`.
2. Diagnostic audit: one `logprobs` request per ISL.
3. Replay: 3 blocks in the fixed rotated order; per ISL 3 warm-ups, then 8 measured. Checkpoint `after_replay`.
4. Controls at ISL 256: diagnostic, observer, logging (3 pairs each).
5. Failure: wait for the rule to be inactive, checkpoint `before_failure`, kill the server mid-stream, send one request while it is down, recover, send 3 recovery requests, wait for the rule to clear.
6. Checkpoint `final`; save host, container, Prometheus, Grafana and log evidence; `compose down`; check cleanup; analyze.

**Commands:**

```
uv run python reps/I01-L2_chat_service_under_load/rep.py
uv run python reps/I01-L2_chat_service_under_load/audit.py <RUN_ID>
I01L2_RUN_ID=<RUN_ID> uv run pytest reps/I01-L2_chat_service_under_load/test_i01_l2.py -v
uv run pytest tests/
```

**Decision rule (spec P4):** mean paired per-block TTFT P50, ISL 1024 minus 64. "Supported" needs the 95% whole-block bootstrap interval above zero and the engine prompt-time change in the same direction. Otherwise: inconclusive or contradicted. Failed stability (P4c/P4d) blocks the comparison.

**Guard failures are reported, not retuned.** The 15 ms guards stay as written. If P4c–P4f fail in the measured run, the card reports the failure and its evidence.

**Pre-freeze exposure.** These runs tested the code and are not evidence: `test-001`, `smoke-002`, `I01L2_20261030T223304Z_60b17a`, `…224747Z_b5b950`, `…225125Z_773485`, `…225349Z_9d6ea1`, `…231734Z_9fdad5` (short counts) and the full-count rehearsal `I01L2_20261030T233636Z_0adebd`. The rehearsal passed 46 of 47 run checks. P4e logging pair 2 was −17.08 ms (logging off was slower). Its engine decode time fell into two bands, about 206 and 219 ms, regardless of condition, while DCGM showed the SM clock mostly at 1974 MHz with drops to 1733 and 1569 MHz.

**Provenance.** The spec's pair-programming rule says Mike types every line. In this build, Claude Code applied the tutor's pasted designs and wrote `audit.py`, `test_i01_l2.py`, the analysis section of `rep.py` and the later `chat_records.py` summary functions. Mike directed the work. The tutor review (spec Build order step 8) is still due.

## Pass Check 

Fixture rows (P2a–P2c, and the methods behind P3e, P4b–P4d, P5c–P5e) are tested in `tests/test_chat_records.py` against K5, K6/K7, K11, K15 and K16. Run rows are tested in `test_i01_l2.py` against the measured run's saved evidence.

Measured run `I01L2_20261031T000505Z_b7369e`, protocol commit `bce7031`. **45 of 47 run checks pass; P4c and P4d fail.** All fixture tests pass (57).

| Row | Check | Must equal | Tol. | Measured | Pass |
| --- | --- | --- | --- | --- | --- |
| P1a | Source/build | K1 + own image | Exact | commit `a7a98e0f…3645`, Dockerfile sha256 and build args equal K1; running server image `sha256:b0aa24d3a8f2…1c51` equals the built image | Yes |
| P1b | ISL | 64/256/1024 | Exact | HF input 64/256/1024; `prompt_tokens` = ISL in all 231 records with usage | Yes |
| P1c | Greedy output IDs | HF output, K2 | Exact | HF output = K2 at each ISL; server IDs equal HF in 24/24 diagnostic records | Yes |
| P1d | Output count | 32 | Exact | 32 HF and server IDs per ISL; `completion_tokens` = 32 in all 231 complete records | Yes |
| P2a | Fixture TTFT, ms | 65.012786 | 1e-6 | 65.012786 (K5 fixture) | Yes |
| P2b | Fixture e2e, ms | 274.035202 | 1e-6 | 274.035202 (K5 fixture) | Yes |
| P2c | Gap sum, ms | 207.8986 | 1e-6 | 207.8986 over 31 gaps (K5 fixture) | Yes |
| P2d | Events/usage/status | Raw response | Exact | 210 complete records with saved events: status 200, role-only first event, first content at `first_content_ns`, one finish, final usage and timings, ordered clocks | Yes |
| P2e | Normal exact ITL/EOF | Unavailable | Exact | unavailable with reasons in all 233 records; none of the 186 normal-path records carries `logprobs` | Yes |
| P2f | Failure completeness | K12 boundaries | Exact | mid-stream kill: HTTP 200, incomplete, `APIConnectionError`, no usage, TTFT 40.101 ms, attempt 439.328 ms, e2e null. Server down: no status or headers, `APIConnectionError` after 2.114 ms | Yes |
| P3a | Requests/errors/usage | Raw totals | Exact | per phase and outcome at 3 checkpoints (102, 207, 212 exported records) | Yes |
| P3b | Bucket/count | Reconstruction | Exact | TTFT and e2e buckets and counts per phase at 3 checkpoints | Yes |
| P3c | Histogram sum, s | Raw sum | 1e-12 | TTFT and e2e sums per phase at 3 checkpoints | Yes |
| P3d | Engine token counters | Usage totals | Exact | `after_replay` 45,696 prompt / 3,264 predicted; `final` 192 / 96. `before_failure` 0 / 0 (see note) | Yes |
| P3e | Engine seconds | Truncated sum | 1e-9 | `after_replay` 5.486 / 22.920 s; `final` 0.080 / 0.651 s; `before_failure` 0 / 0 | Yes |
| P3f | Host identity | K13 + live host | Exact | `omarchy-desktop`, 16 CPUs, 67,340,988,416 bytes, GPU `GPU-2204ae42…c3b546`, driver 580.178.04; same in Node and DCGM series | Yes |
| P3g | Targets/rule/recovery | K12/K14 | Exact | 4 targets up; rule inactive → pending → firing → inactive; health 503 ×5 then 200; 3/3 recovery requests complete | Yes |
| P4a | Count/peak per replay | 8 / 1 | Exact | 9 replays × 8 complete; 3 warm-ups each; no request overlaps another | Yes |
| P4b | Locust summary | Matched bucket/rank | Exact | 60/60 steps rebuild exactly | Yes |
| P4c | Half-P50 difference, ms | At most 15 | Condition | max \|difference\| 22.179 (ISL 256, block 2, step 20); next 14.170 (ISL 256, block 1) | **No** |
| P4d | Repeat-P50 range, ms | At most 15 | Condition | ISL 64: 9.355; 256: 12.271; 1024: **15.145** | **No** |
| P4e | Log/capture P50 difference | Within ±15 ms | Condition | −11.974, +0.801, +1.197 | Yes |
| P4f | Observer P50 difference | Within ±15 ms | Condition | −14.983, −2.328, −7.804 | Yes |
| P5a | Requests joined | Client count | Exact | 186/186 server-start-0 records joined; 165 decomposed (the 21 observer-off records save no events) | Yes |
| P5b | Log prompt tokens | Usage | Exact | 165/165 | Yes |
| P5c | Offset interval, ms | Nonempty, width | ≤ 0.25 | width 0.055884 (half-width 0.027942) | Yes |
| P5d | Smallest segment, ms | ≥ 0 | Exact | 0.027942 | Yes |
| P5e | Segment sum − TTFT, e2e, ms | 0 | 1e-9 | max \|difference\| 1.1e-13 | Yes |
| P5f | Launch→send − prompt_ms | 0 to 0.1 ms | Condition | 0.009 to 0.086 over 72 measured requests | Yes |
| P5g | Send→release − predicted_ms | −0.1 to 0 ms | Condition | −0.082 to −0.006 over 72 measured requests | Yes |

- **P3d/P3e at `before_failure`:** that snapshot is of server start 7, the server freshly restarted after the logging control, before it served any request. Its 0 = 0 agreement is true but tests nothing. The other two checkpoints carry the comparison.
- **P4c/P4d failures** are reported, not retuned (spec P4). Results below.

## Results

**Run:** `I01L2_20261031T000505Z_b7369e`, 2026-10-31 00:05:05–00:08:13 UTC, protocol commit `bce7031`. 233 requests: 231 complete, 2 failed on purpose (failure test). Cleanup left no project containers.

### Verdict: TTFT increase measured; e2e stability guard failed

TTFT P50 rises by 91.0 ms from ISL 64 to 1024, with nearly the same value in all three blocks, and engine prompt time rises with it. The e2e stability guard failed (P4c, P4d). Under the frozen rule the failures are reported, not retuned. The guard measures e2e, and the variation it caught is in decode time, which TTFT does not include (next section).

| Contrast | Per-block differences, ms | Mean, ms | 95% bootstrap (N = 3 blocks) |
| --- | --- | --- | --- |
| TTFT P50, ISL 1024 − 64 | 94.905, 88.966, 89.033 | 90.968 | [88.966, 94.905] |
| Engine `prompt_ms` P50, ISL 1024 − 64 | 91.021, 87.606, 87.688 | 88.771 | — |

Both rise in the same direction. Had the guard passed, this would have met the "supported" rule.

### Why the guard failed

The guard is on e2e, and the e2e spread comes from decode, not prefill:

| ISL, block | TTFT P50 | e2e P50 | Half-P50 diff | Engine decode P50 |
| --- | --- | --- | --- | --- |
| 64, 0 | 24.331 | 240.481 | −4.726 | 216.081 |
| 64, 1 | 24.045 | 231.126 | +2.508 | 206.837 |
| 64, 2 | 24.114 | 234.507 | +11.984 | 209.083 |
| 256, 0 | 35.014 | 250.362 | +7.146 | 214.286 |
| 256, 1 | 35.485 | 257.009 | −14.170 | 219.558 |
| 256, 2 | 34.795 | 244.738 | **−22.179** | 209.694 |
| 1024, 0 | 119.236 | **342.113** | +2.606 | 220.404 |
| 1024, 1 | 113.011 | 326.968 | +3.312 | 213.048 |
| 1024, 2 | 113.147 | 330.930 | −9.259 | 215.562 |

All values in ms. In step 20 (ISL 256, block 2), per-request decode times were 211, 236, 219, 225, 207, 209, 207, 207 ms, and e2e followed them. Across blocks, TTFT P50 moved at most 0.29 ms (ISL 64), 0.69 ms (256) and 6.23 ms (1024); e2e moved 9.4, 12.3 and 15.1 ms. Per-request decode times cluster at 205–212 ms, with others spread from 213 to 258 ms. In the pre-freeze rehearsal, DCGM showed the SM clock mostly at 1974 MHz with drops to 1733 and 1569 MHz. The GPU clocks were not locked (Configuration). The 1 s DCGM samples can't attribute individual requests to a clock state, so this explanation is likely but unproven.

### Pooled measured requests (24 per ISL)

| ISL | TTFT P50 / P95 / P99 | e2e P50 / P95 / P99 | Locust P50 / P95 / P99 | Engine prompt / decode P50 |
| --- | --- | --- | --- | --- |
| 64 | 24.154 / 29.052 / 30.065 | 236.362 / 248.783 / 261.736 | 240 / 250 / 270 | 20.338 / 210.724 |
| 256 | 34.882 / 40.998 / 41.661 | 250.362 / 275.328 / 275.523 | 250 / 280 / 280 | 30.782 / 214.287 |
| 1024 | 114.466 / 129.400 / 134.551 | 334.288 / 368.856 / 372.966 | 330 / 370 / 370 | 108.943 / 217.927 |

All values in ms. Raw values use NumPy linear quantiles; Locust's use its 2-significant-digit buckets. All ISLs are within the lab budgets (TTFT P95 150 ms, e2e P95 400 ms).

**Held-back ISL 256:** the line through ISL 64 and 1024 TTFT P50s predicts 42.357 ms; observed 35.098; miss −7.259 ms. TTFT is not linear in ISL between these points.

### Where each millisecond goes (medians, ms, measured requests)

| Segment | Clock | ISL 64 | ISL 256 | ISL 1024 |
| --- | --- | --- | --- | --- |
| client before connect | client | 0.839 | 0.847 | 0.880 |
| network to server | client → pcap | 0.499 | 0.506 | 0.524 |
| server receive | pcap → log | 0.041 | 0.047 | 0.047 |
| template + tokenize | log | 1.859 | 2.059 | 3.058 |
| queue | log | 0.126 | 0.141 | 0.161 |
| launch → first result (prefill) | log | 20.352 | 30.794 | 108.966 |
| server send | log → pcap | 0.061 | 0.081 | 0.082 |
| network to client | pcap → client | 0.271 | 0.337 | 0.327 |
| client parse | client | 0.114 | 0.116 | 0.114 |
| decode (first send → release) | log | 210.711 | 214.272 | 217.911 |
| send rest + network/client rest | log → pcap → client | 0.687 | 0.706 | 0.718 |

Cross-clock segments carry the log-offset bound of ±0.028 ms. Prefill grows by 88.6 ms from ISL 64 to 1024 and accounts for nearly all the TTFT change. Template/tokenize grows by 1.2 ms. Decode grows by 7.2 ms, well inside its own band spread. Network and client segments stay below 1 ms each.

### Controls (ISL 256, on − off or diagnostic − normal, P50 ms)

| Control | e2e, pairs 1/2/3 | TTFT, pairs 1/2/3 |
| --- | --- | --- |
| Diagnostic (`logprobs`) | +279.731 / +288.055 / +292.500 | +10.425 / +8.437 / +11.182 |
| Observers | −14.983 / −2.328 / −7.804 | −3.195 / −0.335 / −2.610 |
| Debug log + capture | −11.974 / +0.801 / +1.197 | −3.028 / −0.332 / +0.353 |

`logprobs` more than doubles e2e, so diagnostic records stay out of the normal results (K8). The observer and logging differences have mixed signs and sit within the decode-band spread. They show no cost, but they are not proof that instrumentation is free.

### Histogram estimates versus raw (normal phase, all ISLs, N = 72)

| Quantile | TTFT raw / estimate / diff | e2e raw / estimate / diff |
| --- | --- | --- |
| P50 | 34.882 / 40.323 / +5.440 | 251.877 / 253.846 / +1.969 |
| P95 | 121.969 / 142.500 / +20.531 | 349.205 / 385.000 / +35.795 |
| P99 | 131.896 / 148.500 / +16.604 | 372.456 / 397.000 / +24.544 |

All values in ms. Prometheus `histogram_quantile` interpolates linearly inside a bucket, so tail estimates land far from the raw values when a bucket is wide (0.1–0.15 s for the TTFT tail, 0.3–0.4 s for the e2e tail). The bucket counts themselves are exact (P3b).

### Failure and recovery

The server was killed 0.3 s into a 512-token generation. The client saw HTTP 200, first content at 40.1 ms, then `APIConnectionError` at 439.3 ms: a stream can start successfully and still fail. With the server down, the next request failed to connect after 2.1 ms. The `InferenceServerDown` rule went pending 1.0 s and firing 3.0 s after the kill. After the recreate, health returned 503 five times (model loading) and 200 at 4.8 s. All 3 recovery requests completed, and the rule returned to inactive at 6.1 s.

### Limits

- The e2e stability guard failed, so the TTFT contrast does not carry the formal "supported" label. The contrast itself is consistent across blocks (above).
- GPU clocks were not locked. Decode bands are visible in the engine timings, but individual requests can't be tied to a clock state.
- The spec's Task step 6 figures (distributions/CDFs, request timelines, per-ISL segment timelines) are not drawn yet.
- The failure request's pcap is incomplete (Inspection point 4).

## Why It Matters
