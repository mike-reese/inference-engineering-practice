"""One adapter per saved file. The order matters: the client adapter stores the clock joins the wire and trace
adapters use; the engine adapter gives the iteration windows the GPU adapters assign kernels by."""
from .client import client
from .docker import topology
from .engine import engine
from .gpu import gpu_samples
from .metrics import efficiency, latency
from .ncu import ncu
from .nsys import nsys
from .torch_trace import torch_trace
from .wire import wire

ADAPTERS = [
    ("topology.json", topology),
    ("client/*.json", client),
    ("engine_records.json", engine),
    ("frames.tsv", wire),
    ("gpu.csv", gpu_samples),
    ("trace/*.sqlite", nsys),
    ("trace/torch_trace.json", torch_trace),
    ("trace/kernels.csv", ncu),
    ("latency.json", latency),
    ("efficiency.json", efficiency),
]
