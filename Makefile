PY := uv run --no-sync python
IECTL := $(PY) scripts/iectl.py
TRACE ?= off

.PHONY: doctor images devtools devtools-up-quiet devtools-down devtools-restart runner runner-down rep profile k4 source test-unit check \
	snapshot tabs overhead status lifecycle

doctor:
	$(IECTL) doctor

# Step 0: the engine image, its trace-only variant (TRACE=code|kernels), the capture and client images.
images:
	deploy/server/build.sh
	docker build -t ie-tensorrt-llm:1.2.1-nvml-byref-trace -f deploy/server/Dockerfile.trace deploy/server
	RESULTS_DIR=/tmp RUN_ID=none SERVER_START=0 docker compose -f deploy/compose.yaml build capture client

# The devtools and the monitoring it hosts (own project ie-devtools): http://127.0.0.1:7700
devtools:
	REPO_HOST=$(CURDIR) docker compose -f deploy/devtools.yaml up -d --build
	@$(MAKE) --no-print-directory runner
	@echo "devtools: http://127.0.0.1:7700"

devtools-up-quiet:
	REPO_HOST=$(CURDIR) docker compose -f deploy/devtools.yaml up -d --wait
	@$(MAKE) --no-print-directory runner

devtools-down: runner-down
	docker compose -f deploy/devtools.yaml down

# The host runner behind the Run tab (scripts/runner.py, 127.0.0.1:7701): runs the commands reps/*/rep.toml declare.
RUNNER_STATE := $(HOME)/.local/state/inference-engineering
runner:
	@mkdir -p $(RUNNER_STATE)
	@if curl -sf http://127.0.0.1:7701/runner/health >/dev/null; then echo "runner: already up"; \
	else nohup $(PY) scripts/runner.py >> $(RUNNER_STATE)/runner.log 2>&1 & \
	echo "runner: http://127.0.0.1:7701 (log $(RUNNER_STATE)/runner.log)"; fi

runner-down:  ## a running job keeps running (own session); restart with make runner after a runner change
	@if [ -f $(RUNNER_STATE)/runner.pid ] && kill $$(cat $(RUNNER_STATE)/runner.pid) 2>/dev/null; then \
	echo "runner: stopped"; else echo "runner: not running"; fi; rm -f $(RUNNER_STATE)/runner.pid

devtools-restart:  ## after a backend change (the code runs from the mounted repo)
	REPO_HOST=$(CURDIR) docker compose -f deploy/devtools.yaml restart devtools

# Steps 1-8: one run. TRACE=timeline|code|kernels makes a labeled, profiled run instead (never measured).
rep:
	TRACE=$(TRACE) $(PY) reps/I02A-L1_streamed_latency/rep.py

profile:
	$(IECTL) profile $(TRACE)

k4:  ## walkthrough addition 3: break check 1 on purpose
	$(PY) reps/I02A-L1_streamed_latency/rep.py --k4

source:  ## walkthrough addition 2: where each engine time is stamped (K18)
	$(PY) reps/I02A-L1_streamed_latency/rep.py --source

test-unit:
	uv run --no-sync pytest -q tests

check:  ## step 9: the five pass checks on a fresh stack
	uv run --no-sync pytest -q reps/I02A-L1_streamed_latency/test_i02a_l1.py

snapshot:  ## make snapshot VIEW=trace/<run>
	$(IECTL) snapshot "$(VIEW)" --out devtools.png

tabs:  ## click every devtools tab in headless Chromium (CDP); fails on a tab that does not render
	$(IECTL) snapshot --tabs --wait 2 --out devtools.png

overhead:
	$(IECTL) overhead --runs 2

status:
	$(IECTL) status

lifecycle:
	$(IECTL) lifecycle
