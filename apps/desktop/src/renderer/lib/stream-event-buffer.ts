/**
 * Frame-coalesced buffer for high-frequency host events.
 *
 * Streamed `message.delta` / `thinking.delta` arrive one IPC message per token.
 * Applying each one immediately re-renders the whole shell tree, so a long reply
 * costs one full render per token. This buffer holds coalescible events for at
 * most one animation frame and applies them in arrival order.
 *
 * Ordering contract: any non-coalescible event (barrier) drains the pending queue
 * *first*, then applies itself. Streamed text therefore can never be reordered
 * around `tool.started`, `agent.settled`, `message.completed`, ….
 */

/** Safety net when the window is hidden and `requestAnimationFrame` never fires. */
export const STREAM_FLUSH_FALLBACK_MS = 50;

export type StreamEventBuffer<E> = {
  /** Queue a coalescible event, or drain-then-apply a barrier event. */
  push: (event: E) => void;
  /** Apply every pending event now (no-op when empty). */
  flush: () => void;
  /** Cancel pending work and drop anything still queued. */
  dispose: () => void;
  /** Events waiting for the next flush (diagnostics / tests). */
  pending: () => number;
};

export type StreamEventBufferOptions<E> = {
  /** True when the event may wait for the next frame. */
  isCoalescible: (event: E) => boolean;
  /** Apply one event, in arrival order. */
  apply: (event: E) => void;
  /**
   * Schedule a flush and return its canceller. Defaults to the next animation
   * frame with a timer fallback for hidden windows.
   */
  schedule?: (flush: () => void) => () => void;
};

function defaultSchedule(flush: () => void): () => void {
  let finished = false;
  const run = () => {
    if (finished) return;
    finished = true;
    flush();
  };
  const frame =
    typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : undefined;
  const timer = setTimeout(run, STREAM_FLUSH_FALLBACK_MS);
  return () => {
    finished = true;
    if (frame !== undefined) cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
}

export function createStreamEventBuffer<E>(
  options: StreamEventBufferOptions<E>,
): StreamEventBuffer<E> {
  const schedule = options.schedule ?? defaultSchedule;
  const queue: E[] = [];
  let cancelScheduled: (() => void) | null = null;

  function drain(): void {
    // `apply` may push more events (e.g. a barrier inside a coalesced batch);
    // keep draining until the queue is genuinely empty.
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) return;
      options.apply(next);
    }
  }

  function flush(): void {
    const cancel = cancelScheduled;
    cancelScheduled = null;
    cancel?.();
    drain();
  }

  function scheduleFlush(): void {
    if (cancelScheduled) return;
    cancelScheduled = schedule(flush);
  }

  return {
    push(event) {
      if (options.isCoalescible(event)) {
        queue.push(event);
        scheduleFlush();
        return;
      }
      // Barrier: pending streamed text must land before this event.
      flush();
      options.apply(event);
    },
    flush,
    dispose() {
      const cancel = cancelScheduled;
      cancelScheduled = null;
      cancel?.();
      queue.length = 0;
    },
    pending: () => queue.length,
  };
}
