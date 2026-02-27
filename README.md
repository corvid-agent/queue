# @corvid-agent/queue

[![CI](https://github.com/corvid-agent/queue/actions/workflows/ci.yml/badge.svg)](https://github.com/corvid-agent/queue/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@corvid-agent/queue)](https://www.npmjs.com/package/@corvid-agent/queue)
![zero deps](https://img.shields.io/badge/dependencies-0-brightgreen)

Async task queue with concurrency control, priority, pause/resume, and backpressure. Zero dependencies. TypeScript-first.

## Install

```bash
npm install @corvid-agent/queue
```

## Usage

### Queue

Run async tasks with controlled concurrency:

```ts
import { Queue } from "@corvid-agent/queue";

const queue = new Queue({ concurrency: 3 });

// Add tasks — returns a promise with the result
const result = await queue.add(async () => {
  const res = await fetch("/api/data");
  return res.json();
});

// Add multiple tasks at once
const results = await queue.addAll([
  () => fetchUser(1),
  () => fetchUser(2),
  () => fetchUser(3),
]);
```

### Priority

Higher priority tasks run first:

```ts
const queue = new Queue({ concurrency: 1 });

queue.add(() => lowPriorityWork());                    // priority: 0 (default)
queue.add(() => urgentWork(), { priority: 10 });       // runs first
queue.add(() => mediumWork(), { priority: 5 });        // runs second
```

### Backpressure

Limit queue size to prevent unbounded memory growth:

```ts
const queue = new Queue({ concurrency: 2, maxSize: 100 });

try {
  await queue.add(() => work());
} catch (err) {
  // QueueFullError when queue exceeds maxSize
}
```

### Pause / Resume

```ts
const queue = new Queue({ autoStart: false }); // starts paused

queue.add(() => task1());
queue.add(() => task2());

queue.resume();  // start processing
queue.pause();   // stop starting new tasks (running tasks finish)
queue.resume();  // continue
```

### Abort

Cancel tasks with `AbortController`:

```ts
const controller = new AbortController();

const promise = queue.add(() => fetchData(), {
  signal: controller.signal,
});

controller.abort(); // removes from queue, rejects with TaskAbortedError
```

### Events

```ts
const queue = new Queue({ concurrency: 5 });

queue.on("active", () => console.log(`Task started. Active: ${queue.active}`));
queue.on("completed", (result) => console.log("Task done:", result));
queue.on("error", (err) => console.error("Task failed:", err));
queue.on("idle", () => console.log("All done"));
queue.on("empty", () => console.log("Pending queue empty"));

// Wait for specific states
await queue.onIdle();    // all tasks completed
await queue.onEmpty();   // pending queue empty
await queue.onDrained(); // everything processed
```

### Convenience Functions

Map, filter, and iterate with concurrency control:

```ts
import { map, each, filter } from "@corvid-agent/queue";

// Concurrent map — preserves order
const users = await map(userIds, (id) => fetchUser(id), { concurrency: 5 });

// Concurrent side effects
await each(emails, (email) => sendNotification(email), { concurrency: 10 });

// Concurrent filter
const alive = await filter(servers, async (server) => {
  const res = await fetch(server.healthUrl);
  return res.ok;
}, { concurrency: 20 });
```

## API

### `new Queue(options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `concurrency` | `number` | `1` | Max concurrent tasks |
| `maxSize` | `number` | `Infinity` | Max pending tasks (backpressure) |
| `autoStart` | `boolean` | `true` | Start processing on add |

### `queue.add(fn, options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `priority` | `number` | `0` | Higher = runs first |
| `signal` | `AbortSignal` | - | Cancel the task |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `queue.size` | `number` | Pending tasks |
| `queue.active` | `number` | Running tasks |
| `queue.isPaused` | `boolean` | Whether paused |
| `queue.isIdle` | `boolean` | Nothing running or pending |

### Methods

| Method | Description |
|--------|-------------|
| `add(fn, opts?)` | Add a task, returns `Promise<T>` |
| `addAll(fns, opts?)` | Add multiple tasks |
| `pause()` | Stop starting new tasks |
| `resume()` | Resume processing |
| `clear()` | Remove all pending tasks |
| `onIdle()` | Wait until idle |
| `onEmpty()` | Wait until pending is empty |
| `onDrained()` | Wait until all processed |
| `on(event, listener)` | Add event listener |
| `off(event, listener)` | Remove event listener |

### `map(items, fn, options?)`

Concurrent map preserving order.

### `each(items, fn, options?)`

Concurrent iteration.

### `filter(items, fn, options?)`

Concurrent filter preserving order.

### Error Classes

- `QueueFullError` — thrown when `maxSize` is exceeded
- `TaskAbortedError` — thrown when a task is aborted or queue is cleared

## License

MIT
