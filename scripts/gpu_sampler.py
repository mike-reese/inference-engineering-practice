"""nvidia-smi every 100 ms, each line stamped on read with CLOCK_MONOTONIC (the run's clock) -> gpu.csv."""
import subprocess
import threading
import time
from pathlib import Path

GPU_QUERY = "utilization.gpu,utilization.memory,memory.used,power.draw,clocks.sm,temperature.gpu,pcie.link.gen.current"


class GpuSampler:
    def __init__(self, path: Path):
        self.path = path
        self.process = subprocess.Popen(["nvidia-smi", f"--query-gpu={GPU_QUERY}", "--format=csv,noheader,nounits",
                                         "-lms", "100"], stdout=subprocess.PIPE, text=True, bufsize=1)
        self.thread = threading.Thread(target=self.read, daemon=True)
        self.thread.start()

    def read(self) -> None:
        with self.path.open("w") as out:
            for line in self.process.stdout:
                out.write(f"{time.monotonic_ns()},{','.join(v.strip() for v in line.split(','))}\n")
                out.flush()

    def stop(self) -> None:
        self.process.terminate()
        self.thread.join(timeout=5)
