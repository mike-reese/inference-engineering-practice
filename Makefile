PY := uv run --no-sync python
IECTL := $(PY) scripts/iectl.py
TRACE ?= off

.PHONY: doctor images devtools devtools-up-quiet devtools-down devtools-restart rep profile k4 source test-unit check \
	snapshot overhead status lifecycle

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
	@echo "devtools: http://127.0.0.1:7700"

devtools-up-quiet:
	REPO_HOST=$(CURDIR) docker compose -f deploy/devtools.yaml up -d --wait

devtools-down:
	docker compose -f deploy/devtools.yaml down

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

overhead:
	$(IECTL) overhead --runs 2

status:
	$(IECTL) status

lifecycle:
	$(IECTL) lifecycle
