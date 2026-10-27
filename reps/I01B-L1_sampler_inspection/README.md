# I01B-L1 - Sampler Inspection

## Mechanism
We're validating the sampler behavior, which is the mechanism that sits between the model's forward call and the next token. The sampler takes the raw logit vector and runs an ordered list of rules. Each rule is set by a request field or by the checkpoint's defaults when the field is not set. We'll be examining repetition penalties, temperature, top-k and top-p. Specifically, we are going to be investigating three things: 1) which rules run, 2) their parameters, and 3) the order. All of these 3 items can change the probability distribution of softmax. Engines do not agree on them: transformers applies temperature before top-k and top-p, and llama.cpp applies it last. So the same request, on the same model with the same token IDs, can sample from different token sets on two engines, with no error. That cross-engine difference is what we're validating.

## Task 
Run one generate call (Qwen2.5-0.5B-Instruct, float32, CPU, max_new_tokens=1), seeded with a fixed value of 2, and inspect its sampler at 3 points. 1) Read the checkpoint's generation_config.json and the processer list generate builds (which rules run, parameters, order). 2) APply the processors one at a time to the raw logits and confirm the results equal the processed scores, then recompute the surviving set and its probabilities by hand from the raw logits (once in the library order and once with the temperature applied last). Send the same 36 token IDs and fields to the llama.cpp server and read its own surviving set (`post_sampling_probs`): it must match the temperature-last recomputation and differ from generate's set. 3) Read the drawn token and check that it is in the surviving token set and confirm that a rerun draws it again on the same seed. Finally, we'll rerun without the repetition penalty to show that the default silently changes the distribution and draw.

## Configuration

| Item | This rep |
| --- | --- |
| Model and revision | `Qwen/Qwen2.5-0.5B-Instruct` @ `7ae557604adf67be50417f59c2c2f167def9a775`, local cache, `HF_HUB_OFFLINE=1` |
| Library | transformers 5.20.2, torch 2.14.0+cu126, huggingface_hub 2.3.0; Python 3.12.14 |
| dtype and device | float32, CPU (Intel i9-9900K, 8 torch threads), `model.eval()`; `generate` runs under `torch.no_grad()` itself |
| Request | `SYSTEM` and `USER` constants in `rep.py`: system `You are a concise assistant for an inference team.`; user `The KV cache grows during decode. Why does decode slow down?` (36 tokens after the chat template) |
| Sampling fields | `do_sample=True`, `temperature=0.7`, `top_k=20`, `top_p=0.8`, `repetition_penalty=1.0` |
| Output fields | `max_new_tokens=1`, `output_logits=True`, `output_scores=True`, `return_dict_in_generate=True` |
| Seed | `torch.manual_seed(2)` directly before every `generate` call |
| Hazard call | the same call with `repetition_penalty` left out, so the checkpoint's default (1.1) applies |
| Files read | `generation_config.json` in the revision's snapshot, via `hf_hub_download`, read with `json.load` |
| Engine | llama.cpp server b6500 (commit `a7a98e0fffed`, `build_info` `b6500-a7a98e0fffed+firstfit`), via `scripts/llama_cpp_server.py` |
| Engine image | `telos-llama:b6500-firstfit-cuda12.4-sm61-nsys2023.4.4` (`sha256:8cbe0ac473189ff807a993929ecc952cbf224e17fed15c063bbc5cdfd205b070`) |
| Engine's model file | `Qwen2.5-0.5B-Instruct-f32.gguf`, 1,982,078,784 bytes, sha256 `5398ce9e21beb102f3bac22625596fa8e1a3333a99696a84a6cde43a3c60c53f` |
| Server flags | `--ctx-size 4096 --parallel 1 --n-gpu-layers 99 --jinja` |
| GPU and driver | NVIDIA GeForce GTX 1080 Ti, driver 580.178.04 (llama.cpp only; `transformers` runs on the CPU) |
| Engine request | `POST /completion`: `prompt` = the 36 token IDs, `n_predict` 1, `temperature` 0.7, `top_k` 20, `top_p` 0.8, `min_p` 0, `n_probs` 20, `post_sampling_probs` true, `seed` 2, `cache_prompt` false |

The full `docker run` command, the GPU and driver, the image digest and the GGUF's size and sha256 are recorded at run time in `results/output.txt` and `results/record.json` (`configuration`).

### Why these choices

- **CPU, float32:** the reference precision. On this CPU the forward call repeats bit for bit, so the rerun and the processor-list checks can be exact (`torch.equal`). A GPU would add a different random generator for the draw and no needed speed (one `generate` call takes about 0.1 s).
- **Request:** the reply's most likely first token, `The`, is also the user message's first token. The checkpoint's repetition penalty lowers every prompt token's logit, so it changes this step's surviving set and the hazard is visible. With I01A-L1's request, the penalty changes no token in the top 20 and the hazard stays hidden.
- **Temperature 0.7, top-k 20, top-p 0.8:** the checkpoint's own `generation_config.json` values, the ones `generate` uses when a request sets nothing.
- **`repetition_penalty=1.0`:** turns off the one rule my recomputation does not model. The hazard call puts it back.
- **`max_new_tokens=1`:** one sampling step, generation step 1. Its logits come from the prefill forward call's last position; no decode forward call runs.
- **Output fields:** make `generate` return the raw logits (`logits`, before any rule) and the processed vector (`scores`, after every rule) besides the token IDs.
- **Seed 2:** the first seed in 0–31 that draws a token other than the most likely one (`When`, rank 2), so the inspection shows a true weighted draw.
- **llama.cpp, F32 GGUF, I01A's server:** the engine whose template and token IDs I already matched to `transformers` in I01A-L1, at the same precision, so the sampler is the only thing left to differ.
- **Token IDs as the engine's prompt:** both engines read identical input, with no tokenizer between them.
- **`min_p` 0:** llama.cpp's default 0.05 is a fourth rule `transformers` does not run here; setting it to 0 leaves only the order different.
- **`post_sampling_probs` true, `n_probs` 20:** returns the engine's survivors after its whole chain, with room for every token top-k 20 can leave.

## Inspection Table 

| Point | Value | Library reports | What it means | How we know (second source) | Difference |
| --- | --- | --- | --- | --- | --- |
| 1 rules | Checkpoint defaults (`model.generation_config`) | `do_sample` true, `temperature` 0.7, `top_k` 20, `top_p` 0.8, `repetition_penalty` 1.1, `eos_token_id` [151645, 151643] | The sampler fields `generate` uses for any field the request does not set | raw `generation_config.json`, read with `json.load` | none (all 9 fields equal) |
| 1 rules | Processor classes, in order | 1. `TemperatureLogitsWarper`, 2. `TopKLogitsWarper`, 3. `TopPLogitsWarper` | The rules that run, in the order they run: temperature first, then the two cuts | the list applied in turn to `logits[0]` equals `scores[0]`; the recomputation matches only in this order | none |
| 1 rules | Processor parameters | `temperature` 0.7; `top_k` 20; `top_p` 0.8; both cuts `filter_value` −inf, `min_tokens_to_keep` 1 | Each rule's setting; a removed token's score becomes −inf, so softmax gives it 0 | the request's fields (0.7, 20, 0.8) | none |
| 2 step 1 | `logits[0]` shape and dtype | (1, 151936), float32 | One raw score per vocabulary row at the prompt's last position, before any rule | `vocab_size` in `config.json`; float32 from the load | none |
| 2 step 1 | Finite entries after each processor | 151,936 → 20 → 2 | Temperature rescales and removes nothing; top-k keeps 20; top-p keeps 2 | the recomputation: all, then top 20, then the cut in the cumulative table | none |
| 2 step 1 | List applied in turn against `scores[0]` | equal | The list read at point 1 is the list `generate` ran | `torch.equal` | none (bit-identical) |
| 2 step 1 | Surviving IDs | 785 `The`, 4498 `When` | The only tokens the draw can pick | recomputation from `logits[0]`: ÷ temperature, `topk` 20, `softmax`, `cumsum`, cut at 0.8 | none |
| 2 step 1 | Surviving probabilities | `The` 0.82978559, `When` 0.17021443 | The weights the draw uses, renormalized over the survivors | the same recomputation's renormalized probabilities | 0.0 |
| 2 step 1 | Surviving IDs, temperature last | 785 `The`, 4498 `When`, 32564 `Decode`, 16014 `During` (0.74586773, 0.15300031, 0.05439289, 0.04673906) | The same rules and parameters in a different order keep 4 tokens, not 2. Untempered logits are flatter, so the top-p cut falls later | llama.cpp's surviving set (below) | none |
| 2 engine | Engine's sampler order (`/props` `samplers`) | `penalties`, `dry`, `top_n_sigma`, `top_k`, `typ_p`, `top_p`, `min_p`, `xtc`, `temperature` | llama.cpp's chain: the cuts run on untempered logits and temperature runs last | the order the engine's surviving set reproduces: only the temperature-last recomputation matches it | none |
| 2 engine | Engine's surviving IDs (`top_probs`, `post_sampling_probs`) | 785 `The`, 4498 `When`, 32564 `Decode`, 16014 `During` | The tokens llama.cpp's draw can pick for the same request | the temperature-last recomputation from `transformers`' `logits[0]` | none |
| 2 engine | Engine's surviving probabilities | `The` 0.74495631, `When` 0.15343222, `Decode` 0.05481333, `During` 0.04679811 | The engine's draw weights after its whole chain | the temperature-last recomputation's (tolerance 0.02, from the logit difference) | largest 9.11e-4 (`The`) |
| 2 engine | Engine's set against `generate`'s | 4 tokens against 2 | Same model, same 36 token IDs, same three fields: the two engines sample from different sets, with no error | `scores[0]`'s finite IDs: expected to differ (4 against 2) | differ, as expected |
| 2 engine | Engine's logits against `transformers`' (top-20 log-probabilities, `temperature` 0) | same 20 IDs in the same order; `The` −0.67123 against −0.66986 | The input both orders cut is nearly the same, so the order explains the different sets | `log_softmax(logits[0])`: the input both orders cut | largest 7.52e-3 over the 20; at most 4.9e-3 in the top 4 |
| 3 draw | Drawn token (`sequences[0, -1]`) and piece | 4498 `When` | The token seed 2 picked | membership in the surviving IDs | none (in the set) |
| 3 draw | Its rank and probability | rank 2, 0.17021443 | A weighted draw, not the most likely token | the recomputation's top-20 table | none |
| 3 draw | Rerun at seed 2: token, `logits[0]`, `scores[0]` | 4498; `logits[0]` and `scores[0]` equal | The same seed restores the same random state, and the CPU forward call repeats bit for bit | equal to the first run's (same code, so not independent) | none |
| hazard | Penalty the checkpoint sets | 1.1 (`model.generation_config`) | A rule the request never named, active by default | raw file: 1.1 | none |
| hazard | Default call's processor list | 1. `RepetitionPenaltyLogitsProcessor` (`penalty` 1.1), then temperature, top-k, top-p as at point 1 | The penalty runs first and lowers every prompt token's logit | first entry `RepetitionPenaltyLogitsProcessor`, `penalty` 1.1 | none |
| hazard | Default call's `logits[0]` | equal to the baseline's; `scores[0]` not equal | The forward call is unchanged; the penalty shows only in `scores` | equal to point 2's: the penalty acts after the forward call | none |
| hazard | Default call's surviving set and draw | `When` 0.49682972, `Decode` 0.17662713, `The` 0.17476992, `During` 0.15177326; draws 16014 `During` | `The` is a prompt token, so the penalty drops it from first to third; the set grows to 4 and seed 2 draws a different token | the recomputation without the penalty, the wrong method: a different set | differ, as expected: recomputation keeps `The` 0.82978559, `When` 0.17021443; `During` is not in it |

All values above come from `results/output.txt` and `results/record.json`.

## Pass Check 

**Status: passing.** `HF_HUB_OFFLINE=1 uv run pytest` on 2026-10-27: 17 passed, none skipped (18 s).

- `reps/I01B-L1_sampler_inspection/test_i01b_l1.py`: the five pass checks below; check 5 runs against a live llama.cpp server.
- `reps/I01A-L1_chat_request_inspection/test_i01a_l1.py`, `tests/test_kv_cache.py`, `tests/test_llama_cpp_server.py`: earlier tests, still passing.

All tests must pass:

### 1. The processor list and its order

Build the config on a copy of `model.generation_config` with the request's fields, call `_get_logits_processor`, and apply each processor in turn to `logits[0]` from a seeded `generate` call.

| Quantity | Must equal | Tol. | Measured | Row |
| --- | --- | --- | --- | --- |
| classes, in order | Temperature, TopK, TopP | exact | equal | K3 |
| parameters | 0.7, 20, 0.8 | exact | equal | K3 |
| finite entries after each | 151936, 20, 2 | exact | equal | K5 |
| list applied to `logits[0]` | `scores[0]` | exact | `torch.equal` | K5 |

- **Classes row:** `TemperatureLogitsWarper`, `TopKLogitsWarper`, `TopPLogitsWarper`, and nothing else.
- **Last row:** ties the list read at point 1 to the vector `generate` returned. A list that differed in any rule, parameter or position would give different bits.
- **Why exact:** the list is a deterministic function of the config. The same processors on the same tensor on the same CPU give the same bits.

### 2. The surviving set, recomputed from the raw logits

Recompute from `logits[0]` with `torch.topk`, `torch.softmax` and `torch.cumsum` in the list's order (point 2's second source). Then recompute with temperature moved last.

| Quantity | Must equal | Tol. | Measured | Row |
| --- | --- | --- | --- | --- |
| surviving IDs | finite IDs of `scores[0]` | exact | {785, 4498} | K7, K8 |
| surviving probabilities | `softmax(scores[0])` | 1e-6 | 0.0 | K7, K8 |
| IDs, temperature last | not `scores[0]`'s | exact | 4 vs 2 | K9 |

- **Second row:** compare each recomputed probability with `softmax(scores[0])` at the same ID.
- **Third row:** the order evidence. The same three rules, with the same parameters and the same input, keep four tokens when temperature comes last, as in llama.cpp's default chain.
- **Why 1e-6:** float32 resolves about 1.2e-7 near 1. `softmax(scores[0])` normalizes all 151,936 entries, all but two of them −inf, while the recomputation normalizes the two kept values of a 20-entry list. A different summation order may differ in the last bits; here it measured 0.0. Repeated runs are bit-identical, so 1e-6 is above the run-to-run spread of 0. Set membership is exact: the cut sits 0.058 above and 0.088 below `top_p` (K6), far beyond any float32 difference.

### 3. The drawn token

Read `sequences[0, -1]`. Seed with 2 again and rerun the same call.

| Quantity | Must equal | Tol. | Measured | Row |
| --- | --- | --- | --- | --- |
| drawn token | in the surviving IDs | exact | 4498 in set | K10 |
| rerun's drawn token | first run's | exact | equal | K10 |
| rerun's `logits[0]` | first run's | exact | `torch.equal` | K10 |
| rerun's `scores[0]` | first run's | exact | `torch.equal` | K10 |

- **Why exact:** the same seed restores the same random state, and this CPU's float32 forward call repeats bit for bit, so the probabilities and the draw repeat.
- **What it does not show:** that the draw followed `softmax(scores[0])`. The rerun shares all of `generate`'s code. Membership rules out a token the rules removed, nothing more. The `torch.multinomial` option shows the distribution itself.

### 4. The hazard: the checkpoint's repetition penalty

Seed with 2 and run the same call with `repetition_penalty` left out. Build its processor list the same way, without the field.

| Quantity | Must equal | Tol. | Measured | Row |
| --- | --- | --- | --- | --- |
| file's `repetition_penalty` | 1.1 | exact | 1.1 | K1 |
| first processor | RepetitionPenalty, 1.1 | exact | equal | K12 |
| default call's `logits[0]` | check 1's `logits[0]` | exact | `torch.equal` | K12 |
| default call's surviving IDs | not the recomputed IDs | exact | 4 vs 2 | K12 |

- **First row:** read from the raw file with `json.load`, not from `transformers`.
- **Third row:** the raw logits do not change. The penalty acts after the forward call, inside the processor list, so `logits` cannot show it. Only the list and `scores` do.
- **Fourth row, what the wrong method returns:** the recomputation without the penalty keeps `The` 0.82978559 and `When` 0.17021443. `generate` kept four tokens with `When` 0.49682972 first and `The` 0.17476992 third, and seed 2 drew `During`, which the recomputation excludes.
- **Why:** this is the hazard of this reading. The checkpoint's file sets a field the request never mentioned. It lowers every prompt token's logit, and the reply's natural first word, `The`, is a prompt token. Nothing errors, and the reply still reads well. Greedy decoding is affected too (K15).

### 5. The engine's order: llama.cpp on the same request

Start the server through the fixture. Read `/props`. Send the engine request (Configuration) and read `completion_probabilities[0]["top_probs"]`. Compare with your recomputation with temperature moved last, and with `generate`'s `scores[0]` from a seeded call.

| Quantity | Must equal | Tol. | Measured | Row |
| --- | --- | --- | --- | --- |
| `/props` `samplers`, last | `temperature` | exact | equal | K19 |
| engine IDs | temperature-last IDs | exact | 4 IDs equal | K20 |
| engine probabilities | temperature-last's | 0.02 | 9.11e-4 | K20 |
| engine IDs | not `scores[0]`'s | exact | 4 vs 2 | K20 |

- **First row:** the engine's own statement of its order, read from the running server, not from its source.
- **Second and third rows:** your hand model of llama.cpp's order matches llama.cpp. Compare probabilities at the same ID.
- **Fourth row:** the cross-engine result. Same model, same 36 token IDs, same three fields, logits within 7.5e-3 in log-probability: `transformers` keeps two tokens, llama.cpp keeps four.
- **Why 0.02:** the two engines' logits differ, systematically, not at random. The largest top-20 log-probability difference is 7.52e-3 (K21). Temperature divides it by 0.7, and a probability p moves by at most about 2 · p · Δ. With p = 0.746, that is 2 × 0.746 × 7.52e-3 / 0.7 = 0.016; 0.02 sits above that bound. Measured: 9.11e-4. Three identical engine requests were bit-identical, so the run-to-run spread is 0.
- **Why the sets are exact:** the tightest cut is rank 3's untempered cumulative, 0.7893 on the engine and 0.7895 in `transformers`, 0.0107 below 0.8 (K21). The top-4 log-probability differences, at most 4.9e-3, move it by far less than that.
- **On the new card (2026-10-28):** the image needs the rebuild `I01-L2` does. With a rebuilt image, re-measure K20 and K21; the tolerance formula above still applies to the new logit difference.

## Results 
Every value agreed with its second source, in the `rep.py` run (`results/output.txt`) and in the five pass checks. The two rows expected to differ (the engine's set against `generate`'s, and the hazard) did differ. The two engines sample from different sets for the same request. The cause is the order of the rules: the logits differ by at most 7.52e-3 in log-probability, far too little to move the top-p cut.

| Point | transformers reports | Second source | Result |
| --- | --- | --- | --- |
| 1 rules | Checkpoint defaults 0.7 / 20 / 0.8, penalty 1.1; list Temperature → TopK → TopP | raw `generation_config.json`; the list replayed on `logits[0]` | all fields equal; replayed list equals `scores[0]` bit for bit |
| 2 surviving set | 151,936 → 20 → 2 finite; `The` 0.82978559, `When` 0.17021443 | hand recomputation from `logits[0]` | same 2 IDs; probability difference 0.0 |
| 2 engine | temperature-last recomputation: 4 tokens (`The`, `When`, `Decode`, `During`) | llama.cpp `/completion` `post_sampling_probs`; `/props` `samplers` | same 4 IDs, largest difference 9.11e-4; temperature is last in the engine's chain; 4 against `generate`'s 2 |
| 2 engine logits | `log_softmax(logits[0])`, top 20 | llama.cpp `top_logprobs`, `temperature` 0 | same 20 IDs; largest difference 7.52e-3 |
| 3 draw | 4498 `When`, rank 2, 0.17021443 | membership; seed-2 rerun | in the set; rerun draws 4498 with equal `logits` and `scores` |
| hazard | penalty 1.1 runs first; 4 survivors led by `When` 0.49682972; draws `During` | recomputation without the penalty | raw logits unchanged; surviving set and draw differ; `During` is outside the recomputed set |

## Why It Matters 
Different serving engines can have arithmetic differences in their sampler libraries that affect the final token distribution. As seen in this example, our llama.cpp server orders the temperature adjustment at the end, after top_k and top_p have been calculated, which results in a different distribution of tokens compared to the transformers library, which does temperature adjustment at the start of the order. Understanding the nuances, and being able to quantitatively measure their impact, of these changes (as well as the interaction of the repetition_penalty when set to None -- i.e. resulting in the default selection, which is actually active) allows us to better diagnose model performance that deviates from our expectations.

## Toolkit
- `scripts/llama_cpp_server.py` (from I01A-L1): starts and stops the llama.cpp server for `rep.py` and the test fixture. Reused unchanged.
- No new shared module. The rep's helpers live in `rep.py`, with copies in `test_i01b_l1.py`; none are in `src/inference_analysis` yet:
  - `build_processors(model, encoding, sampling)`: builds the processor list `generate` would run for a request, from a copy of `model.generation_config` and `_get_logits_processor`.
  - `run_generate(model, encoding, sampling)`: seeds with 2 and runs one `generate` call that returns `logits` and `scores`.
  - `recompute_surviving(raw_logits, temperature, top_k, top_p, temperature_last=False)`: the hand model of the temperature, top-k and top-p chain, in either order. Returns the surviving IDs and their probabilities.
