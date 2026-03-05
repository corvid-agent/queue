import { describe, test, expect } from "bun:test";
import {
  Queue,
  QueueFullError,
  TaskAbortedError,
  TaskTimeoutError,
  map,
  each,
  filter,
} from "../src/index";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Queue basics ──────────────────────────────────────────────────────

describe("Queue", () => {
  test("processes a single task", async () => {
    const queue = new Queue();
    const result = await queue.add(() => 42);
    expect(result).toBe(42);
  });

  test("processes async tasks", async () => {
    const queue = new Queue();
    const result = await queue.add(async () => {
      await wait(10);
      return "done";
    });
    expect(result).toBe("done");
  });

  test("returns results in order with addAll", async () => {
    const queue = new Queue({ concurrency: 3 });
    const results = await queue.addAll([
      async () => { await wait(30); return "a"; },
      async () => { await wait(10); return "b"; },
      async () => { await wait(20); return "c"; },
    ]);
    expect(results).toEqual(["a", "b", "c"]);
  });

  test("rejects if task throws", async () => {
    const queue = new Queue();
    try {
      await queue.add(() => { throw new Error("boom"); });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("boom");
    }
  });

  test("rejects if async task rejects", async () => {
    const queue = new Queue();
    try {
      await queue.add(async () => { throw new Error("async boom"); });
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toBe("async boom");
    }
  });

  test("throws on concurrency < 1", () => {
    expect(() => new Queue({ concurrency: 0 })).toThrow(RangeError);
  });
});

// ── Concurrency ───────────────────────────────────────────────────────

describe("concurrency", () => {
  test("defaults to concurrency of 1", async () => {
    const queue = new Queue();
    let maxConcurrent = 0;
    let current = 0;

    const tasks = Array.from({ length: 5 }, () =>
      queue.add(async () => {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await wait(10);
        current--;
      })
    );

    await Promise.all(tasks);
    expect(maxConcurrent).toBe(1);
  });

  test("respects concurrency limit", async () => {
    const queue = new Queue({ concurrency: 3 });
    let maxConcurrent = 0;
    let current = 0;

    const tasks = Array.from({ length: 10 }, () =>
      queue.add(async () => {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await wait(10);
        current--;
      })
    );

    await Promise.all(tasks);
    expect(maxConcurrent).toBe(3);
  });

  test("unlimited concurrency with Infinity", async () => {
    const queue = new Queue({ concurrency: Infinity });
    let maxConcurrent = 0;
    let current = 0;

    const tasks = Array.from({ length: 5 }, () =>
      queue.add(async () => {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await wait(10);
        current--;
      })
    );

    await Promise.all(tasks);
    expect(maxConcurrent).toBe(5);
  });
});

// ── Priority ──────────────────────────────────────────────────────────

describe("priority", () => {
  test("higher priority tasks run first", async () => {
    const queue = new Queue({ concurrency: 1, autoStart: false });
    const order: string[] = [];

    queue.add(async () => { order.push("low"); }, { priority: 0 });
    queue.add(async () => { order.push("high"); }, { priority: 10 });
    queue.add(async () => { order.push("medium"); }, { priority: 5 });

    queue.resume();
    await queue.onIdle();

    expect(order).toEqual(["high", "medium", "low"]);
  });

  test("same priority preserves insertion order", async () => {
    const queue = new Queue({ concurrency: 1, autoStart: false });
    const order: number[] = [];

    for (let i = 0; i < 5; i++) {
      queue.add(async () => { order.push(i); });
    }

    queue.resume();
    await queue.onIdle();

    expect(order).toEqual([0, 1, 2, 3, 4]);
  });
});

// ── Backpressure ──────────────────────────────────────────────────────

describe("backpressure", () => {
  test("rejects when queue is full", async () => {
    const queue = new Queue({ concurrency: 1, maxSize: 2 });

    // Fill the queue: 1 running + 2 pending = capacity
    queue.add(() => wait(100));
    queue.add(() => wait(100));
    queue.add(() => wait(100));

    try {
      await queue.add(() => "overflow");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(QueueFullError);
      expect((err as QueueFullError).maxSize).toBe(2);
    }
  });
});

// ── Pause / Resume ────────────────────────────────────────────────────

describe("pause / resume", () => {
  test("autoStart: false pauses the queue", async () => {
    const queue = new Queue({ autoStart: false });
    expect(queue.isPaused).toBe(true);

    let executed = false;
    const promise = queue.add(async () => { executed = true; });

    await wait(20);
    expect(executed).toBe(false);
    expect(queue.size).toBe(1);

    queue.resume();
    await promise;
    expect(executed).toBe(true);
  });

  test("pause stops new tasks from starting", async () => {
    const queue = new Queue({ concurrency: 1 });
    const order: string[] = [];

    queue.add(async () => {
      await wait(20);
      order.push("first");
      queue.pause();
    });

    const second = queue.add(async () => { order.push("second"); });

    await wait(50);
    expect(order).toEqual(["first"]);
    expect(queue.size).toBe(1);

    queue.resume();
    await second;
    expect(order).toEqual(["first", "second"]);
  });

  test("resume is idempotent when not paused", () => {
    const queue = new Queue();
    queue.resume(); // should not throw
    expect(queue.isPaused).toBe(false);
  });
});

// ── Abort ─────────────────────────────────────────────────────────────

describe("abort", () => {
  test("pre-aborted signal rejects immediately", async () => {
    const queue = new Queue();
    const controller = new AbortController();
    controller.abort("cancelled");

    try {
      await queue.add(() => 42, { signal: controller.signal });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TaskAbortedError);
    }
  });

  test("aborting while queued removes the task", async () => {
    const queue = new Queue({ concurrency: 1 });
    const controller = new AbortController();

    // Block the queue
    const blocker = queue.add(() => wait(100));

    const aborted = queue.add(() => "should not run", { signal: controller.signal });
    expect(queue.size).toBe(1);

    controller.abort();

    try {
      await aborted;
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TaskAbortedError);
    }

    expect(queue.size).toBe(0);
    await blocker;
  });
});

// ── Clear ─────────────────────────────────────────────────────────────

describe("clear", () => {
  test("clears all pending tasks", async () => {
    const queue = new Queue({ concurrency: 1 });
    let executed = false;

    // Block the queue
    queue.add(() => wait(100));

    const cleared = queue.add(async () => { executed = true; });
    expect(queue.size).toBe(1);

    queue.clear();
    expect(queue.size).toBe(0);

    try {
      await cleared;
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TaskAbortedError);
    }

    expect(executed).toBe(false);
  });
});

// ── Events ────────────────────────────────────────────────────────────

describe("events", () => {
  test("emits active when task starts", async () => {
    const queue = new Queue();
    let activeFired = false;
    queue.on("active", () => { activeFired = true; });

    await queue.add(() => 1);
    expect(activeFired).toBe(true);
  });

  test("emits idle when queue becomes idle", async () => {
    const queue = new Queue();
    let idleFired = false;
    queue.on("idle", () => { idleFired = true; });

    await queue.add(() => 1);
    // idle fires after task completes and nothing is pending
    await wait(5);
    expect(idleFired).toBe(true);
  });

  test("emits completed with result", async () => {
    const queue = new Queue();
    let result: unknown;
    queue.on("completed", (r) => { result = r; });

    await queue.add(() => "hello");
    await wait(5);
    expect(result).toBe("hello");
  });

  test("emits error when task fails", async () => {
    const queue = new Queue();
    let caught: Error | undefined;
    queue.on("error", (err) => { caught = err; });

    try {
      await queue.add(() => { throw new Error("fail"); });
    } catch {}

    await wait(5);
    expect(caught).toBeInstanceOf(Error);
    expect(caught!.message).toBe("fail");
  });

  test("emits empty when pending queue empties", async () => {
    const queue = new Queue({ concurrency: 10 });
    let emptyFired = false;
    queue.on("empty", () => { emptyFired = true; });

    await queue.add(() => 1);
    await wait(5);
    expect(emptyFired).toBe(true);
  });

  test("off removes listener", async () => {
    const queue = new Queue();
    let count = 0;
    const listener = () => { count++; };

    queue.on("active", listener);
    await queue.add(() => 1);
    expect(count).toBe(1);

    queue.off("active", listener);
    await queue.add(() => 2);
    expect(count).toBe(1);
  });
});

// ── Inspection ────────────────────────────────────────────────────────

describe("inspection", () => {
  test("size tracks pending tasks", async () => {
    const queue = new Queue({ concurrency: 1 });
    expect(queue.size).toBe(0);

    // Block the queue
    queue.add(() => wait(50));
    queue.add(() => wait(10));
    queue.add(() => wait(10));

    expect(queue.size).toBe(2);

    await queue.onIdle();
    expect(queue.size).toBe(0);
  });

  test("active tracks running tasks", async () => {
    const queue = new Queue({ concurrency: 2 });
    expect(queue.active).toBe(0);

    const p1 = queue.add(() => wait(50));
    const p2 = queue.add(() => wait(50));

    // Give microtask a tick to start
    await wait(5);
    expect(queue.active).toBe(2);

    await Promise.all([p1, p2]);
    expect(queue.active).toBe(0);
  });

  test("isIdle is true when nothing running or pending", async () => {
    const queue = new Queue();
    expect(queue.isIdle).toBe(true);

    const p = queue.add(() => wait(20));
    expect(queue.isIdle).toBe(false);

    await p;
    expect(queue.isIdle).toBe(true);
  });
});

// ── onIdle / onEmpty / onDrained ──────────────────────────────────────

describe("waiters", () => {
  test("onIdle resolves immediately when idle", async () => {
    const queue = new Queue();
    await queue.onIdle(); // should not hang
  });

  test("onIdle resolves when all tasks complete", async () => {
    const queue = new Queue({ concurrency: 2 });
    const results: number[] = [];

    queue.add(async () => { await wait(20); results.push(1); });
    queue.add(async () => { await wait(10); results.push(2); });
    queue.add(async () => { await wait(15); results.push(3); });

    await queue.onIdle();
    expect(results.length).toBe(3);
  });

  test("onEmpty resolves when pending queue empties", async () => {
    const queue = new Queue({ concurrency: 2 });

    queue.add(() => wait(50));
    queue.add(() => wait(50));
    queue.add(() => wait(50));

    // 2 running, 1 pending — onEmpty waits for pending to be 0
    await queue.onEmpty();
    expect(queue.size).toBe(0);
    expect(queue.active).toBeGreaterThanOrEqual(0);
  });

  test("onEmpty resolves immediately when already empty", async () => {
    const queue = new Queue();
    await queue.onEmpty(); // should not hang
  });

  test("onDrained resolves when all done", async () => {
    const queue = new Queue({ concurrency: 1 });

    queue.add(() => wait(10));
    queue.add(() => wait(10));

    await queue.onDrained();
    expect(queue.isIdle).toBe(true);
  });
});

// ── map ───────────────────────────────────────────────────────────────

describe("map", () => {
  test("maps items with concurrency", async () => {
    const results = await map(
      [1, 2, 3, 4],
      async (x) => x * 2,
      { concurrency: 2 },
    );
    expect(results).toEqual([2, 4, 6, 8]);
  });

  test("preserves order regardless of completion time", async () => {
    const delays = [30, 10, 20];
    const results = await map(
      delays,
      async (ms, i) => {
        await wait(ms);
        return i;
      },
      { concurrency: 3 },
    );
    expect(results).toEqual([0, 1, 2]);
  });

  test("passes index to callback", async () => {
    const indices = await map([10, 20, 30], async (_, i) => i);
    expect(indices).toEqual([0, 1, 2]);
  });
});

// ── each ──────────────────────────────────────────────────────────────

describe("each", () => {
  test("executes side effects for each item", async () => {
    const results: number[] = [];
    await each([1, 2, 3], async (x) => { results.push(x); }, { concurrency: 2 });
    expect(results.sort()).toEqual([1, 2, 3]);
  });
});

// ── filter ────────────────────────────────────────────────────────────

describe("filter", () => {
  test("filters items concurrently", async () => {
    const result = await filter(
      [1, 2, 3, 4, 5, 6],
      async (x) => x % 2 === 0,
      { concurrency: 3 },
    );
    expect(result).toEqual([2, 4, 6]);
  });

  test("preserves original item order", async () => {
    const result = await filter(
      [5, 3, 1, 4, 2],
      async (x) => {
        await wait(x * 5); // variable delay
        return x > 2;
      },
      { concurrency: 5 },
    );
    expect(result).toEqual([5, 3, 4]);
  });
});

// ── Timeout ──────────────────────────────────────────────────────────

describe("timeout", () => {
  test("rejects with TaskTimeoutError when task exceeds timeout", async () => {
    const queue = new Queue();
    try {
      await queue.add(() => wait(200), { timeout: 20 });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TaskTimeoutError);
      expect((err as TaskTimeoutError).timeout).toBe(20);
    }
  });

  test("succeeds when task completes within timeout", async () => {
    const queue = new Queue();
    const result = await queue.add(async () => {
      await wait(5);
      return "fast";
    }, { timeout: 200 });
    expect(result).toBe("fast");
  });

  test("timeout does not affect tasks without timeout option", async () => {
    const queue = new Queue();
    const result = await queue.add(async () => {
      await wait(30);
      return "no-timeout";
    });
    expect(result).toBe("no-timeout");
  });

  test("timed out tasks are tracked in stats", async () => {
    const queue = new Queue();
    try { await queue.add(() => wait(200), { timeout: 10 }); } catch {}
    expect(queue.stats.timedOut).toBe(1);
    expect(queue.stats.failed).toBe(1);
  });
});

// ── Retry ────────────────────────────────────────────────────────────

describe("retry", () => {
  test("retries on failure up to specified count", async () => {
    const queue = new Queue();
    let attempts = 0;

    const result = await queue.add(async () => {
      attempts++;
      if (attempts < 3) throw new Error("not yet");
      return "success";
    }, { retries: 3 });

    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });

  test("rejects after all retries exhausted", async () => {
    const queue = new Queue();
    let attempts = 0;

    try {
      await queue.add(async () => {
        attempts++;
        throw new Error("always fail");
      }, { retries: 2 });
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toBe("always fail");
    }

    // 1 initial + 2 retries = 3
    expect(attempts).toBe(3);
  });

  test("applies constant retryDelay between attempts", async () => {
    const queue = new Queue();
    const times: number[] = [];

    try {
      await queue.add(async () => {
        times.push(Date.now());
        throw new Error("fail");
      }, { retries: 2, retryDelay: 30 });
    } catch {}

    expect(times.length).toBe(3);
    // Each gap should be ~30ms
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(20);
    }
  });

  test("applies custom backoff function", async () => {
    const queue = new Queue();
    const times: number[] = [];

    try {
      await queue.add(async () => {
        times.push(Date.now());
        throw new Error("fail");
      }, { retries: 2, retryDelay: (attempt) => attempt * 20 });
    } catch {}

    expect(times.length).toBe(3);
    // First retry: 20ms, second retry: 40ms
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(15);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(30);
  });

  test("does not retry on timeout", async () => {
    const queue = new Queue();
    let attempts = 0;

    try {
      await queue.add(async () => {
        attempts++;
        await wait(200);
      }, { timeout: 10, retries: 3 });
    } catch (err) {
      expect(err).toBeInstanceOf(TaskTimeoutError);
    }

    expect(attempts).toBe(1);
  });

  test("does not retry on abort", async () => {
    const queue = new Queue();
    const controller = new AbortController();
    let attempts = 0;

    setTimeout(() => controller.abort(), 10);

    try {
      await queue.add(async () => {
        attempts++;
        await wait(50);
      }, { signal: controller.signal, retries: 3 });
    } catch (err) {
      expect(err).toBeInstanceOf(TaskAbortedError);
    }

    // Only one attempt — abort during execution stops retries
    expect(attempts).toBe(1);
  });

  test("retries are tracked in stats", async () => {
    const queue = new Queue();
    let attempts = 0;

    await queue.add(async () => {
      attempts++;
      if (attempts < 3) throw new Error("not yet");
      return "ok";
    }, { retries: 3 });

    expect(queue.stats.retries).toBe(2);
    expect(queue.stats.succeeded).toBe(1);
  });
});

// ── Stats ────────────────────────────────────────────────────────────

describe("stats", () => {
  test("tracks processed, succeeded, and failed counts", async () => {
    const queue = new Queue({ concurrency: 2 });

    await queue.add(() => "ok");
    await queue.add(() => "ok2");
    try { await queue.add(() => { throw new Error("boom"); }); } catch {}

    expect(queue.stats.processed).toBe(3);
    expect(queue.stats.succeeded).toBe(2);
    expect(queue.stats.failed).toBe(1);
  });

  test("stats are cumulative across tasks", async () => {
    const queue = new Queue();

    for (let i = 0; i < 5; i++) {
      await queue.add(() => i);
    }

    expect(queue.stats.processed).toBe(5);
    expect(queue.stats.succeeded).toBe(5);
    expect(queue.stats.failed).toBe(0);
  });

  test("resetStats clears all counters", async () => {
    const queue = new Queue();
    await queue.add(() => "ok");
    try { await queue.add(() => { throw new Error("fail"); }); } catch {}

    expect(queue.stats.processed).toBe(2);

    queue.resetStats();

    expect(queue.stats.processed).toBe(0);
    expect(queue.stats.succeeded).toBe(0);
    expect(queue.stats.failed).toBe(0);
    expect(queue.stats.retries).toBe(0);
    expect(queue.stats.timedOut).toBe(0);
  });

  test("stats returns a snapshot (not a live reference)", async () => {
    const queue = new Queue();
    const before = queue.stats;
    await queue.add(() => "ok");
    expect(before.processed).toBe(0);
    expect(queue.stats.processed).toBe(1);
  });
});
