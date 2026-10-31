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

| Row | Check | Must equal | Tol. | Measured |
| --- | --- | --- | --- | --- |
| P1a | Source/build | K1 + own image | Exact | |
| P1b | ISL | 64/256/1024 | Exact | |
| P1c | Greedy output IDs | HF output, K2 | Exact | |
| P1d | Output count | 32 | Exact | |
| P2a | Fixture TTFT, ms | 65.012786 | 1e-6 | |
| P2b | Fixture e2e, ms | 274.035202 | 1e-6 | |
| P2c | Gap sum, ms | 207.8986 | 1e-6 | |
| P2d | Events/usage/status | Raw response | Exact | |
| P2e | Normal exact ITL/EOF | Unavailable | Exact | |
| P2f | Failure completeness | K12 boundaries | Exact | |
| P3a | Requests/errors/usage | Raw totals | Exact | |
| P3b | Bucket/count | Reconstruction | Exact | |
| P3c | Histogram sum, s | Raw sum | 1e-12 | |
| P3d | Engine token counters | Usage totals | Exact | |
| P3e | Engine seconds | Truncated sum | 1e-9 | |
| P3f | Host identity | K13 + live host | Exact | |
| P3g | Targets/rule/recovery | K12/K14 | Exact | |
| P4a | Count/peak per replay | 8 / 1 | Exact | |
| P4b | Locust summary | Matched bucket/rank | Exact | |
| P4c | Half-P50 difference, ms | At most 15 | Condition | |
| P4d | Repeat-P50 range, ms | At most 15 | Condition | |
| P4e | Log/capture P50 difference | Within ±15 ms | Condition | |
| P4f | Observer P50 difference | Within ±15 ms | Condition | |
| P5a | Requests joined | Client count | Exact | |
| P5b | Log prompt tokens | Usage | Exact | |
| P5c | Offset interval, ms | Nonempty, width | ≤ 0.25 | |
| P5d | Smallest segment, ms | ≥ 0 | Exact | |
| P5e | Segment sum − TTFT, e2e, ms | 0 | 1e-9 | |
| P5f | Launch→send − prompt_ms | 0 to 0.1 ms | Condition | |
| P5g | Send→release − predicted_ms | −0.1 to 0 ms | Condition | |

## Results 

## Why It Matters
