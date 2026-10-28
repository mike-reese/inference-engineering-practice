from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class CompletionRecord:
    """One streamed /completion request, read from the client's side and the engine's final event."""

    tokens: list[int]
    """Each chunk's token ID, in arrival order"""
    contents: list[str]
    """Each chunk's text; empty for the end-of-sequence token"""
    chunk_ms: list[float]
    """Each chunk's arrival time, in ms after the send"""
    n_chunks: int
    """Events with stop false: one per generated token, including an empty one"""
    ttft_ms: float
    """Time to first token: the first chunk's arrival, in ms after the send"""
    e2e_ms: float
    """End-to-end time: the final event's arrival, in ms after the send"""
    stop_type: str
    """Why generation ended, from the final event: eos, limit or word"""
    stopping_word: str
    """The stop string that matched, from the final event; empty when none did"""
    truncated: bool
    """Whether the engine cut the prompt to fit the context, from the final event"""
    tokens_evaluated: int
    """Prompt tokens the engine read, from the final event"""
    tokens_predicted: int
    """Tokens the engine generated, from the final event"""
    tokens_cached: int
    """Tokens left in the slot's KV cache at the end, from the final event"""
    timings: dict[str, Any]
    """The engine's own timings, from the final event, as sent"""


def completion_record(
    events: Sequence[tuple[int, Mapping[str, Any]]],
    send_ns: int,
) -> CompletionRecord:
    """Build one request's record from its streamed events, without any network access

    events: the stream's events in arrival order, each a pair (t_ns, event):
        t_ns is the time.perf_counter_ns() reading when its "data:" line arrived,
        and event is that line's parsed JSON
    send_ns: the time.perf_counter_ns() reading taken just before the request was sent

    Rules:
        a chunk is every event with "stop" false, also when its content is ""
        the end-of-request fields come from the one event with "stop" true;
            it is not a chunk and carries no token
        times are (t_ns - send_ns) / 1e6, in ms

    Raises ValueError when no event has "stop" true: the stream was cut short,
    and every count would be wrong.
    """
    chunks = [(t_ns, event) for t_ns, event in events if not event["stop"]]
    finals = [(t_ns, event) for t_ns, event in events if event["stop"]]
    if not finals:
        raise ValueError(
            f"no final event (stop true) among {len(events)} events: the stream was cut short"
        )
    final_ns, final = finals[0]

    def ms_since_send(t_ns: int) -> float:
        return (t_ns - send_ns) / 1e6

    chunk_ms = [ms_since_send(t_ns) for t_ns, _ in chunks]
    return CompletionRecord(
        tokens=[event["tokens"][0] for _, event in chunks],
        contents=[event["content"] for _, event in chunks],
        chunk_ms=chunk_ms,
        n_chunks=len(chunks),
        ttft_ms=chunk_ms[0],
        e2e_ms=ms_since_send(final_ns),
        stop_type=final["stop_type"],
        stopping_word=final["stopping_word"],
        truncated=final["truncated"],
        tokens_evaluated=final["tokens_evaluated"],
        tokens_predicted=final["tokens_predicted"],
        tokens_cached=final["tokens_cached"],
        timings=dict(final["timings"]),
    )
