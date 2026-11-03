"""The event bus: collectors publish messages, the browser and iectl read them."""
import asyncio
import collections
import time

class Bus:
    def __init__(self, keep_events:int=200):
        self.state = {} # latest message per topic, e.g. "containers", "gpu"
        self.events = collections.deque(maxlen=keep_events)
        self.subscribers = {}

    def publish(self, topic: str, data, key: str | None = None) -> None:
        message = {
            "topic": topic,
            "key": key,  # e.g. the container id for "stats"
            "mono_ns": time.monotonic_ns(),  # the run schema's clock (CLOCK_MONOTONIC)
            "wall_ns": time.time_ns(),  # for display only
            "data": data,
        }
        if topic == "event":
            self.events.append(message)
        else:
            self.state[(topic, key)] = message
        for queue, topics in self.subscribers.items():
            if topics is not None and topic not in topics:
                continue
            if not queue.full():  # a slow browser tab loses messages; the collectors never wait
                queue.put_nowait(message)
   
    def remove(self, topic: str, key: str) -> None:
        """Drop a keyed state entry (a deleted run folder) and tell every subscriber."""
        if self.state.pop((topic, key), None) is None:
            return
        message = {"topic": topic, "key": key, "removed": True, "mono_ns": time.monotonic_ns(),
                   "wall_ns": time.time_ns(), "data": None}
        for queue, topics in self.subscribers.items():
            if (topics is None or topic in topics) and not queue.full():
                queue.put_nowait(message)

    def subscribe(self, topics: set[str] | None = None) -> asyncio.Queue:
        queue = asyncio.Queue(maxsize=2000)
        for message in [*self.state.values(), *self.events]:  # a new subscriber starts from the current picture
            if topics is None or message["topic"] in topics:
                queue.put_nowait(message)
        self.subscribers[queue] = topics
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self.subscribers.pop(queue, None)


    def snapshot(self) -> dict:
        state = {}
        for (topic, key), message in self.state.items():
            if key is None:
                state[topic] = message["data"]
            else:
                state.setdefault(topic, {})[key] = message["data"]
        return {"mono_ns": time.monotonic_ns(), "state": state, "events": [m["data"] for m in self.events]}
