PY := uv run --no-sync python
IECTL := $(PY) scripts/iectl.py
TRACE ?= off

.PHONY: doctor images devtools devtools-up-quiet devtools-down devtools-restart runner runner-down rep profile k4 source test-unit check \
	snapshot tabs overhead status lifecycle store-check moments-lint

doctor:
	$(IECTL) doctor

# Step 0: the engine image, its trace-only variant (TRACE=code|kernels), the capture, trackers and client images.
images:
	deploy/server/build.sh
	docker build -t ie-tensorrt-llm:1.2.1-nvml-byref-trace -f deploy/server/Dockerfile.trace deploy/server
	RESULTS_DIR=/tmp RUN_ID=none SERVER_START=0 docker compose -f deploy/compose.yaml build capture trackers client

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

profile:
	$(IECTL) profile $(TRACE)

k4:  ## walkthrough addition 3: break check 1 on purpose
	$(PY) reps/I02A-L1_streamed_latency/rep.py --k4

source:  ## walkthrough addition 2: where each engine time is stamped (K18)
	$(PY) reps/I02A-L1_streamed_latency/rep.py --source

test-unit:
	uv run --no-sync pytest -q tests

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

# Steps 1-8: one run. TRACE=timeline|code|kernels makes a labeled, profiled run instead (never measured);
# TRACE=components a labeled run with component stamps, live in the Components tab (deploy/compose.stamps.yaml).
rep:  ## make rep REP=<folder under reps/>; TRACE=timeline|code|kernels where the rep supports it
	@test -n "$(REP)" || { echo "set REP=<folder under reps/>, e.g. make rep REP=I02C-L1_one_slot_queue"; exit 2; }
	TRACE=$(TRACE) $(PY) reps/$(REP)/rep.py

check:  ## make check REP=<folder under reps/>: that rep's pass checks
	@test -n "$(REP)" || { echo "set REP=<folder under reps/>, e.g. make check REP=I02C-L1_one_slot_queue"; exit 2; }
	uv run --no-sync pytest -q reps/$(REP)

# Command center v3 store (ie-run/3 under CC_STORE): CCVB round trip, tier invariant,
# unique eids, schema.py == frontend/cc/store/columns.js. DuckDB and numpy only (the bulk data venv on the data drive).
CC_PY ?= /mnt/ie-data/venvs/cc-v2-proto/bin/python
store-check:
	cd devtools/backend && PYTHONDONTWRITEBYTECODE=1 $(CC_PY) -m store.check

# Every moment of a rep's moments.toml resolves in every store run of that rep with results (REPS= narrows it).
moments-lint:
	cd devtools/backend && REPO=$(CURDIR) PYTHONDONTWRITEBYTECODE=1 $(CC_PY) -m store.reps --lint $(REPS)
