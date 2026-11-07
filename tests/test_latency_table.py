
import numpy as np

from inference_analysis.latency import latency_table


def test_latency_table_methods():
    ttft_ms = np.asarray(
        [
            40, 14, 180, 19, 12, 26, 55, 16, 21, 500,
            18, 29, 13, 90, 22, 15, 33, 20, 17, 24,
        ],
        dtype=np.float64,
    )
    percentiles = np.asarray([50, 90, 95, 99])

    expected_by_method = {
        "inverted_cdf": [21, 90, 180, 500],
        "linear": [21.5, 99, 196, 439.2],
    }

    for method, expected in expected_by_method.items():
        actual = latency_table(ttft_ms, percentiles, method=method)
        assert actual.shape == percentiles.shape
        np.testing.assert_allclose(
            actual, expected, rtol=0, atol=1e-10, err_msg=method
        )
