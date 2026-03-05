/**
 * @corvid-agent/queue
 *
 * Async task queue with concurrency control, priority, pause/resume, and backpressure.
 * Zero dependencies. TypeScript-first.
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface QueueOptions {
  /** Maximum number of tasks running concurrently (default: 1) */
  concurrency?: number;
  /** Maximum number of tasks allowed in the queue (default: Infinity) */
  maxSize?: number;
  /** Start processing immediately when tasks are added (default: true) */
  autoStart?: boolean;
}

export interface TaskOptions {
  /** Priority — higher values run first (default: 0) */
  priority?: number;
  /** AbortSignal to cancel this task */
  signal?: AbortSignal;
  /** Timeout in milliseconds — rejects with TaskTimeoutError if exceeded */
  timeout?: number;
  /** Number of retry attempts on failure (default: 0) */
  retries?: number;
  /** Delay between retries in ms, or a function for custom backoff (default: 0) */
  retryDelay?: number | ((attempt: number) => number);
}

export type TaskFunction<T> = () => Promise<T> | T;

export interface QueueEvent {
  active: () => void;
  idle: () => void;
  empty: () => void;
  error: (error: Error, task: TaskFunction<unknown>) => void;
  completed: (result: unknown, task: TaskFunction<unknown>) => void;
  drained: () => void;
}

type EventName = keyof QueueEvent;

// ── Errors ─────────────────────────────────────────────────────────────

export class QueueFullError extends Error {
  readonly maxSize: number;

  constructor(maxSize: number) {
    super(`Queue is full: maximum size of ${maxSize} reached`);
    this.name = "QueueFullError";
    this.maxSize = maxSize;
  }
}

export class TaskAbortedError extends Error {
  constructor(reason?: string) {
    super(reason ?? "Task was aborted");
    this.name = "TaskAbortedError";
  }
}

export class TaskTimeoutError extends Error {
  readonly timeout: number;

  constructor(timeout: number) {
    super(`Task timed out after ${timeout}ms`);
    this.name = "TaskTimeoutError";
    this.timeout = timeout;
  }
}

// ── Internal Types ─────────────────────────────────────────────────────

interface QueueEntry<T> {
  fn: TaskFunction<T>;
  priority: number;
  signal?: AbortSignal;
  timeout?: number;
  retries: number;
  retryDelay: number | ((attempt: number) => number);
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/** Cumulative queue statistics */
export interface QueueStats {
  /** Total tasks that have finished (success + failure) */
  processed: number;
  /** Tasks that completed successfully */
  succeeded: number;
  /** Tasks that failed (after all retries exhausted) */
  failed: number;
  /** Total retry attempts across all tasks */
  retries: number;
  /** Tasks that timed out (subset of failed) */
  timedOut: number;
}

// ── Queue ──────────────────────────────────────────────────────────────

/**
 * Async task queue with concurrency control, priority, and backpressure.
 *
 * @example
 * ```ts
 * import { Queue } from "@corvid-agent/queue";
 *
 * const queue = new Queue({ concurrency: 3 });
 *
 * const result = await queue.add(async () => {
 *   const res = await fetch("/api/data");
 *   return res.json();
 * });
 * ```
 */
export class Queue {
  private pending: Array<QueueEntry<any>> = [];
  private running = 0;
  private paused: boolean;
  private listeners = new Map<EventName, Set<Function>>();
  private _stats: QueueStats = { processed: 0, succeeded: 0, failed: 0, retries: 0, timedOut: 0 };

  readonly concurrency: number;
  readonly maxSize: number;

  constructor(options: QueueOptions = {}) {
    this.concurrency = options.concurrency ?? 1;
    this.maxSize = options.maxSize ?? Infinity;
    this.paused = options.autoStart === false;

    if (this.concurrency < 1) {
      throw new RangeError("Concurrency must be at least 1");
    }
  }

  // ── Core API ───────────────────────────────────────────────────────

  /**
   * Add a task to the queue. Returns a promise that resolves with the task result.
   *
   * @example
   * ```ts
   * const result = await queue.add(() => fetchData(), { priority: 10 });
   * ```
   */
  add<T>(fn: TaskFunction<T>, options: TaskOptions = {}): Promise<T> {
    const { priority = 0, signal, timeout, retries = 0, retryDelay = 0 } = options;

    // Check if already aborted
    if (signal?.aborted) {
      return Promise.reject(new TaskAbortedError(signal.reason));
    }

    // Check backpressure
    if (this.pending.length >= this.maxSize) {
      return Promise.reject(new QueueFullError(this.maxSize));
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = { fn, priority, signal, timeout, retries, retryDelay, resolve, reject };

      // Handle abort while queued
      if (signal) {
        const onAbort = () => {
          const index = this.pending.indexOf(entry);
          if (index !== -1) {
            this.pending.splice(index, 1);
            reject(new TaskAbortedError(signal.reason));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      // Insert by priority (higher priority = earlier in array)
      this.insertByPriority(entry);

      // Try to process
      if (!this.paused) {
        this.process();
      }
    });
  }

  /**
   * Add multiple tasks at once. Returns results in order.
   *
   * @example
   * ```ts
   * const results = await queue.addAll([
   *   () => fetchUser(1),
   *   () => fetchUser(2),
   *   () => fetchUser(3),
   * ]);
   * ```
   */
  addAll<T>(fns: TaskFunction<T>[], options: TaskOptions = {}): Promise<T[]> {
    return Promise.all(fns.map((fn) => this.add(fn, options)));
  }

  /**
   * Wait until the queue is idle (all tasks completed).
   */
  onIdle(): Promise<void> {
    if (this.running === 0 && this.pending.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.on("idle", resolve);
    });
  }

  /**
   * Wait until the queue is empty (no pending tasks, but may still have running tasks).
   */
  onEmpty(): Promise<void> {
    if (this.pending.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.on("empty", resolve);
    });
  }

  /**
   * Wait until the queue has drained (all added tasks so far have completed).
   */
  onDrained(): Promise<void> {
    if (this.running === 0 && this.pending.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.on("drained", resolve);
    });
  }

  // ── Control ────────────────────────────────────────────────────────

  /** Pause the queue — running tasks will finish but no new tasks will start */
  pause(): void {
    this.paused = true;
  }

  /** Resume the queue — start processing pending tasks */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.process();
  }

  /** Clear all pending tasks. Running tasks are not affected. */
  clear(): void {
    for (const entry of this.pending) {
      entry.reject(new TaskAbortedError("Queue was cleared"));
    }
    this.pending = [];
  }

  // ── Inspection ─────────────────────────────────────────────────────

  /** Number of tasks currently running */
  get active(): number {
    return this.running;
  }

  /** Number of tasks waiting in the queue */
  get size(): number {
    return this.pending.length;
  }

  /** Whether the queue is paused */
  get isPaused(): boolean {
    return this.paused;
  }

  /** Whether the queue is idle (nothing running and nothing pending) */
  get isIdle(): boolean {
    return this.running === 0 && this.pending.length === 0;
  }

  /** Cumulative statistics for this queue */
  get stats(): Readonly<QueueStats> {
    return { ...this._stats };
  }

  /** Reset all statistics to zero */
  resetStats(): void {
    this._stats = { processed: 0, succeeded: 0, failed: 0, retries: 0, timedOut: 0 };
  }

  // ── Events ─────────────────────────────────────────────────────────

  /**
   * Listen for queue events.
   *
   * - `active` — a task started running
   * - `idle` — queue became idle (nothing running or pending)
   * - `empty` — pending queue became empty
   * - `error` — a task threw an error
   * - `completed` — a task completed successfully
   * - `drained` — all tasks have been processed
   */
  on<K extends EventName>(event: K, listener: QueueEvent[K]): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return this;
  }

  /** Remove an event listener */
  off<K extends EventName>(event: K, listener: QueueEvent[K]): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  // ── Internals ──────────────────────────────────────────────────────

  private emit<K extends EventName>(event: K, ...args: Parameters<QueueEvent[K]>): void {
    const listeners = this.listeners.get(event);
    if (!listeners) return;
    for (const listener of listeners) {
      (listener as Function)(...args);
    }
  }

  private insertByPriority(entry: QueueEntry<any>): void {
    // Find insertion point — higher priority goes first
    let i = 0;
    while (i < this.pending.length && this.pending[i].priority >= entry.priority) {
      i++;
    }
    this.pending.splice(i, 0, entry);
  }

  private process(): void {
    while (this.running < this.concurrency && this.pending.length > 0 && !this.paused) {
      const entry = this.pending.shift()!;

      // Skip aborted tasks
      if (entry.signal?.aborted) {
        entry.reject(new TaskAbortedError(entry.signal.reason));
        continue;
      }

      this.running++;
      this.emit("active");

      if (this.pending.length === 0) {
        this.emit("empty");
      }

      this.run(entry);
    }
  }

  private async run<T>(entry: QueueEntry<T>): Promise<void> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= entry.retries; attempt++) {
      // Wait before retry (not before first attempt)
      if (attempt > 0) {
        this._stats.retries++;
        const delay = typeof entry.retryDelay === "function"
          ? entry.retryDelay(attempt)
          : entry.retryDelay;
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      }

      // Check abort before each attempt
      if (entry.signal?.aborted) {
        this._stats.processed++;
        this._stats.failed++;
        entry.reject(new TaskAbortedError(entry.signal.reason));
        this.finish();
        return;
      }

      try {
        const result = await this.executeWithTimeout(entry.fn, entry.timeout);

        // Check if aborted during execution
        if (entry.signal?.aborted) {
          this._stats.processed++;
          this._stats.failed++;
          entry.reject(new TaskAbortedError(entry.signal.reason));
          this.finish();
          return;
        }

        this._stats.processed++;
        this._stats.succeeded++;
        entry.resolve(result);
        this.emit("completed", result, entry.fn);
        this.finish();
        return;
      } catch (error) {
        lastError = error;

        // Don't retry timeouts or aborts
        if (error instanceof TaskTimeoutError || error instanceof TaskAbortedError) {
          break;
        }
      }
    }

    // All attempts exhausted
    this._stats.processed++;
    this._stats.failed++;
    if (lastError instanceof TaskTimeoutError) {
      this._stats.timedOut++;
    }
    entry.reject(lastError);
    this.emit("error", lastError instanceof Error ? lastError : new Error(String(lastError)), entry.fn);
    this.finish();
  }

  private executeWithTimeout<T>(fn: TaskFunction<T>, timeout?: number): Promise<T> {
    const task = Promise.resolve().then(fn);
    if (!timeout) return task;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new TaskTimeoutError(timeout)), timeout);
      task.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  private finish(): void {
    this.running--;

    if (this.running === 0 && this.pending.length === 0) {
      this.emit("idle");
      this.emit("drained");
    }

    // Process next
    if (!this.paused) {
      this.process();
    }
  }
}

// ── Convenience ────────────────────────────────────────────────────────

/**
 * Run tasks with limited concurrency. Returns results in order.
 *
 * @example
 * ```ts
 * import { map } from "@corvid-agent/queue";
 *
 * const urls = ["/api/a", "/api/b", "/api/c", "/api/d"];
 * const results = await map(urls, (url) => fetch(url).then(r => r.json()), {
 *   concurrency: 2,
 * });
 * ```
 */
export async function map<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R> | R,
  options: { concurrency?: number } = {},
): Promise<R[]> {
  const queue = new Queue({ concurrency: options.concurrency ?? Infinity });
  return queue.addAll(items.map((item, i) => () => fn(item, i)));
}

/**
 * Run tasks with limited concurrency, executing a side effect for each.
 *
 * @example
 * ```ts
 * import { each } from "@corvid-agent/queue";
 *
 * await each(userIds, async (id) => {
 *   await sendEmail(id);
 * }, { concurrency: 5 });
 * ```
 */
export async function each<T>(
  items: T[],
  fn: (item: T, index: number) => Promise<void> | void,
  options: { concurrency?: number } = {},
): Promise<void> {
  await map(items, fn, options);
}

/**
 * Filter items with limited concurrency.
 *
 * @example
 * ```ts
 * import { filter } from "@corvid-agent/queue";
 *
 * const alive = await filter(servers, async (server) => {
 *   const res = await fetch(server.healthUrl);
 *   return res.ok;
 * }, { concurrency: 10 });
 * ```
 */
export async function filter<T>(
  items: T[],
  fn: (item: T, index: number) => Promise<boolean> | boolean,
  options: { concurrency?: number } = {},
): Promise<T[]> {
  const results = await map(items, fn, options);
  return items.filter((_, i) => results[i]);
}
