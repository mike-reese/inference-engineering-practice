"""A code run's _forward_step frames take their iteration from the forward stamps, not from their count."""
import json

from inference_analysis.trace.adapters.torch_trace import forward_stamps, step_iterations

# I02C-TRACE-code_20261109T213328Z_39a18c, profile range 158-166: loop counter 161 (iteration 162) ran no forward step.
FORWARD = [(18001270457088, 158), (18001322842002, 159), (18001372173344, 160), (18001420352726, 161),
           (18001471566649, 163), (18001524420425, 164), (18001572524242, 165), (18001622749119, 166)]
STEPS = [t + 7_000 for t, _ in FORWARD]  # a frame starts microseconds from its stamp


def test_a_step_takes_the_iteration_of_its_forward_stamp_across_an_iteration_with_no_forward_step():
    assert step_iterations(STEPS, 158, FORWARD) == [158, 159, 160, 161, 163, 164, 165, 166]


def test_stamps_outside_the_profiled_range_do_not_shift_the_steps():
    before, after = (FORWARD[0][0] - 50_000_000, 157), (FORWARD[-1][0] + 50_000_000, 167)
    assert step_iterations(STEPS, 158, [before, *FORWARD, after]) == [158, 159, 160, 161, 163, 164, 165, 166]


def test_without_stamps_the_steps_are_counted_from_the_first_profiled_iteration():
    assert step_iterations(STEPS, 66, []) == list(range(66, 74))


def test_forward_stamps_reads_only_forward_boxes_and_adds_one_to_the_loop_counter(tmp_path):
    path = tmp_path / "server_stamps.jsonl"
    path.write_text("\n".join(json.dumps(s) for s in [
        {"box": "scheduler", "iter": 162, "t0": 5}, {"box": "forward", "iter": 162, "t0": 9},
        {"box": "forward", "iter": 160, "t0": 2}, {"box": "forward", "t0": 1}]))
    assert forward_stamps(path) == [(2, 161), (9, 163)]
    assert forward_stamps(tmp_path / "absent.jsonl") == []
