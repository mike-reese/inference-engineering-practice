import pytest
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
import httpx

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "llama_cpp_server.py"
REP_FLAGS = ["--ctx-size", "4096", "--parallel", "1", "--n-gpu-layers", "99", "--jinja"]
SCRIPT_TIMEOUT_S = 120.0

pytestmark = pytest.mark.skipif(
    shutil.which("docker") is None or shutil.which("nvidia-smi") is None,
    reason="Needs Docker and an NVIDIA GPU"
)

def run_script(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True, text=True, timeout=SCRIPT_TIMEOUT_S
    )

def container_listed(name: str) -> bool:
    r = subprocess.run(
        ["docker", "ps", "-aq", "--filter", f"name=^{name}$"],
        capture_output=True, text=True, check=True,
    )
    return r.stdout.strip() != ""

@pytest.fixture
def name():
    n = f"test-llama-{uuid.uuid4().hex[:8]}"
    yield n
    run_script("stop", n)

def test_start_reports_working_url(name):
    r = run_script("start", name, "--", *REP_FLAGS)
    assert r.returncode == 0, r.stderr

    lines = r.stdout.splitlines()
    assert len(lines) == 1, r.stdout
    url = lines[0]
    assert re.fullmatch(r"http://127\.0\.0\.1:\d+", url)
    assert "+ docker run" in r.stderr

def test_stop_cleans_up_and_is_idempotent(name):
    assert run_script("start", name, "--", *REP_FLAGS).returncode == 0

    r = run_script("stop", name)
    assert r.returncode == 0, r.stderr
    assert "stopped" in r.stderr
    assert not container_listed(name)

    r = run_script("stop", name)
    assert r.returncode == 0, r.stderr
    assert "already gone" in r.stderr

def test_name_in_use_is_refused_without_harm(name):
    first = run_script("start", name, "--", *REP_FLAGS)
    assert first.returncode == 0, first.stderr
    url = first.stdout.strip()

    second = run_script("start", name, "--", *REP_FLAGS)
    assert second.returncode == 1
    assert "already in use" in second.stderr
    assert second.stdout == ""

    assert httpx.get(f"{url}/health").status_code == 200

def test_server_that_dies_at_startup_fails_loudly(name, tmp_path):
    fake = tmp_path / "not-a-model.gguf"
    fake.write_bytes(b"this is not a GGUF file")
    
    r = run_script("start", name, "--gguf", str(fake), "--", *REP_FLAGS)
    assert r.returncode == 1
    assert "stopped before it was ready" in r.stderr
    assert r.stdout == ""
    assert not container_listed(name)

def test_missing_gguf_is_refused_before_Docker_runs(name, tmp_path):
    missing = tmp_path / "absent" / "model.gguf"
    r = run_script("start", name, "--gguf", str(missing), "--", *REP_FLAGS)
    assert r.returncode == 1
    assert "GGUF not found" in r.stderr
    assert "+ docker run" not in r.stderr
    assert r.stdout == ""
    assert not container_listed(name)
    assert not missing.parent.exists()
