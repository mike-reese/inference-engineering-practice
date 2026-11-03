import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import iectl  # noqa: E402


def test_help_lists_doctor(capsys):
    with pytest.raises(SystemExit) as exit_info:
        iectl.main(["--help"])
    assert exit_info.value.code == 0
    assert "doctor" in capsys.readouterr().out


def test_doctor_fails_with_a_fix_when_docker_is_missing(monkeypatch, capsys):
    def no_programs(*cmd):
        return subprocess.CompletedProcess(cmd, 127, "", f"[Errno 2] No such file or directory: '{cmd[0]}'")

    monkeypatch.setattr(iectl, "run", no_programs)
    assert iectl.main(["doctor"]) == 1
    report = json.loads(capsys.readouterr().out)
    failed = {c["check"]: c for c in report["checks"] if not c["ok"]}
    assert {"gpu", "docker", "images"} <= set(failed)
    assert all(c["fix"] for c in failed.values())
