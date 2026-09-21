import { describe, expect, it } from "vite-plus/test";
import { createStreamEventBuffer, STREAM_FLUSH_FALLBACK_MS } from "./stream-event-buffer.ts";

type Event = { kind: "delta" | "barrier"; id: number };

/** Manual scheduler so tests never depend on rAF timing. */
function manualScheduler() {
  const pending = new Set<() => void>();
  return {
    schedule: (flush: () => void) => {
      pending.add(flush);
      return () => pending.delete(flush);
    },
    /** Fire every scheduled flush. */
    runAll: () => {
      const flushes = [...pending];
      pending.clear();
      for (const flush of flushes) flush();
    },
    scheduled: () => pending.size,
  };
}

function createHarness() {
  const applied: Event[] = [];
  const scheduler = manualScheduler();
  const buffer = createStreamEventBuffer<Event>({
    isCoalescible: (event) => event.kind === "delta",
    apply: (event) => applied.push(event),
    schedule: scheduler.schedule,
  });
  return { buffer, applied, scheduler };
}

describe("createStreamEventBuffer", () => {
  it("holds coalescible events until the scheduled flush", () => {
    const { buffer, applied, scheduler } = createHarness();

    buffer.push({ kind: "delta", id: 1 });
    buffer.push({ kind: "delta", id: 2 });
    buffer.push({ kind: "delta", id: 3 });

    expect(applied).toEqual([]);
    expect(buffer.pending()).toBe(3);
    expect(scheduler.scheduled()).toBe(1);

    scheduler.runAll();

    expect(applied).toEqual([
      { kind: "delta", id: 1 },
      { kind: "delta", id: 2 },
      { kind: "delta", id: 3 },
    ]);
    expect(buffer.pending()).toBe(0);
  });

  it("applies coalesced events in arrival order", () => {
    const { buffer, applied, scheduler } = createHarness();

    for (let id = 0; id < 25; id += 1) buffer.push({ kind: "delta", id });
    scheduler.runAll();

    expect(applied.map((event) => event.id)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  it("drains pending text before a barrier event", () => {
    const { buffer, applied, scheduler } = createHarness();

    buffer.push({ kind: "delta", id: 1 });
    buffer.push({ kind: "delta", id: 2 });
    buffer.push({ kind: "barrier", id: 3 });

    // Barrier must not wait for the frame.
    expect(applied).toEqual([
      { kind: "delta", id: 1 },
      { kind: "delta", id: 2 },
      { kind: "barrier", id: 3 },
    ]);
    expect(buffer.pending()).toBe(0);
    expect(scheduler.scheduled()).toBe(0);
  });

  it("cancels the scheduled frame when a barrier drains the queue", () => {
    const { buffer, applied, scheduler } = createHarness();

    buffer.push({ kind: "delta", id: 1 });
    expect(scheduler.scheduled()).toBe(1);

    buffer.push({ kind: "barrier", id: 2 });
    expect(scheduler.scheduled()).toBe(0);

    // A stale frame firing later must not re-apply anything.
    scheduler.runAll();
    expect(applied).toEqual([
      { kind: "delta", id: 1 },
      { kind: "barrier", id: 2 },
    ]);
  });

  it("schedules a single frame for many coalescible events", () => {
    const { buffer, scheduler } = createHarness();

    for (let id = 0; id < 50; id += 1) buffer.push({ kind: "delta", id });

    expect(scheduler.scheduled()).toBe(1);
  });

  it("keeps applying events pushed by apply (nested barrier)", () => {
    const applied: Event[] = [];
    const scheduler = manualScheduler();
    let nested = false;
    const buffer = createStreamEventBuffer<Event>({
      isCoalescible: (event) => event.kind === "delta",
      apply: (event) => {
        applied.push(event);
        if (event.kind === "delta" && !nested) {
          nested = true;
          buffer.push({ kind: "barrier", id: 99 });
        }
      },
      schedule: scheduler.schedule,
    });

    buffer.push({ kind: "delta", id: 1 });
    scheduler.runAll();

    expect(applied).toEqual([
      { kind: "delta", id: 1 },
      { kind: "barrier", id: 99 },
    ]);
    expect(buffer.pending()).toBe(0);
  });

  it("flush applies pending events immediately", () => {
    const { buffer, applied, scheduler } = createHarness();

    buffer.push({ kind: "delta", id: 1 });
    buffer.flush();

    expect(applied).toEqual([{ kind: "delta", id: 1 }]);
    expect(scheduler.scheduled()).toBe(0);
    expect(buffer.pending()).toBe(0);

    scheduler.runAll();
    expect(applied).toEqual([{ kind: "delta", id: 1 }]);
  });

  it("dispose cancels the frame and drops queued events", () => {
    const { buffer, applied, scheduler } = createHarness();

    buffer.push({ kind: "delta", id: 1 });
    buffer.dispose();

    expect(scheduler.scheduled()).toBe(0);
    expect(buffer.pending()).toBe(0);

    scheduler.runAll();
    expect(applied).toEqual([]);
  });

  it("falls back to a timer when no frame is available", async () => {
    const applied: Event[] = [];
    const buffer = createStreamEventBuffer<Event>({
      isCoalescible: (event) => event.kind === "delta",
      apply: (event) => applied.push(event),
    });

    buffer.push({ kind: "delta", id: 1 });
    expect(applied).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, STREAM_FLUSH_FALLBACK_MS + 20));
    expect(applied).toEqual([{ kind: "delta", id: 1 }]);
    buffer.dispose();
  });
});
