"""M2 module inference (devtools/backend/store/modules.py): a forward step's device rows get the code run's module
frames only where every row a frame launched pairs, consecutive on one stream."""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "devtools" / "backend"))
from store.modules import infer, match_key, references  # noqa: E402

FRAMES = {"attn": ("modules/attention.py(10): forward", "python/attn"),
          "proj": ("modules/linear.py(20): forward", "python/proj"),
          "norm": ("modules/rms_norm.py(30): forward", "python/norm"),
          "head": ("modules/linear.py(20): forward", "python/head")}
STEP = [("gemm", ["attn", "proj"]), ("bias", ["attn", "proj"]), ("rms", ["attn", "norm"]), ("gemm", ["head"]),
        ("sample", [])]
REFS = references([(7, STEP)], FRAMES)


def inferred(keys, lanes=None):
    m = infer(REFS, keys, lanes or ["s0"] * len(keys))
    return {m.reference.frames[f].eid: pos for f, pos in m.frames}


def test_a_step_equal_to_the_reference_gets_every_frame_that_launched_a_row():
    assert inferred(["gemm", "bias", "rms", "gemm", "sample"]) == {
        "python/attn": (0, 1, 2), "python/proj": (0, 1), "python/norm": (2,), "python/head": (3,)}


def test_an_inserted_kernel_blocks_the_frame_around_it_but_not_its_inner_frames():
    assert inferred(["gemm", "bias", "extra", "rms", "gemm", "sample"]) == {
        "python/proj": (0, 1), "python/norm": (3,), "python/head": (4,)}


def test_a_missing_kernel_blocks_every_frame_that_launched_it():
    assert inferred(["gemm", "rms", "gemm", "sample"]) == {"python/norm": (1,), "python/head": (2,)}


def test_a_frame_split_across_streams_is_not_inferred():
    got = inferred(["gemm", "bias", "rms", "gemm", "sample"], ["s0", "s0", "s1", "s0", "s0"])
    assert got == {"python/proj": (0, 1), "python/norm": (2,), "python/head": (3,)}


def test_a_row_on_another_stream_between_a_frames_rows_does_not_block_it():
    got = inferred(["gemm", "other", "bias", "rms", "gemm"], ["s0", "s1", "s0", "s0", "s0"])
    assert got == {"python/attn": (0, 2, 3), "python/proj": (0, 2), "python/norm": (3,), "python/head": (4,)}


def test_a_pytorch_device_to_device_copy_pairs_with_an_nsys_one_and_not_with_another_direction():
    refs = references([(0, [(match_key("memcpy", "Memcpy DtoD (Device -> Device)"), ["proj"])])], FRAMES)
    same = infer(refs, [match_key("memcpy", "device to device")], ["s0"])
    other = infer(refs, [match_key("memcpy", "host to device")], ["s0"])
    assert [(f, pos) for f, pos in same.frames] == [(0, (0,))]
    assert other.frames == ()


def test_the_reference_is_the_distinct_step_with_the_most_pairs():
    prefill = [("gemm", ["attn"]), ("context_attention", ["attn"]), ("gemm", ["attn"])]
    decode = [("gemm", ["attn"]), ("decode_attention", ["attn"]), ("gemm", ["attn"])]
    refs = references([(1, prefill), (2, decode), (3, decode)], FRAMES)
    assert [r.iteration for r in refs] == [1, 2]
    assert infer(refs, ["gemm", "decode_attention", "gemm"], ["s0"] * 3).reference.iteration == 2
    assert infer(refs, ["gemm", "context_attention", "gemm"], ["s0"] * 3).reference.iteration == 1
