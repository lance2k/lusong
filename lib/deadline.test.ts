import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beforeDeadline } from "./deadline";

describe("beforeDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is not late while the clock still reads before the deadline, even when its timer fires early (#18)", async () => {
    const deadline = Date.now() + 10;
    let result: unknown;
    void beforeDeadline(new Promise(() => {}), deadline).then((r) => (result = r));

    // Node can run a timer 1 ms before Date.now() reaches its target (measured: 66 of 3,000 on Node 24).
    vi.setSystemTime(Date.now() - 1);
    await vi.advanceTimersByTimeAsync(10);
    expect(Date.now()).toBe(deadline - 1);
    expect(result).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe("late");
  });

  it("gives the work's result when it lands first", async () => {
    const result = beforeDeadline(Promise.resolve("done"), Date.now() + 10);
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timer behind when the work lands after an early timer re-armed it", async () => {
    let finish!: (v: string) => void;
    const result = beforeDeadline(new Promise<string>((r) => (finish = r)), Date.now() + 10);
    vi.setSystemTime(Date.now() - 1);
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.getTimerCount()).toBe(1);

    finish("done");
    expect(await result).toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timer behind when the work fails", async () => {
    const result = beforeDeadline(Promise.reject(new Error("boom")), Date.now() + 10);
    await expect(result).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("past the deadline, work already done still wins, and work not yet done is late", async () => {
    const past = Date.now() - 1;
    expect(await beforeDeadline(Promise.resolve("done"), past)).toBe("done");
    expect(await beforeDeadline(Promise.resolve().then(() => "done"), past)).toBe("late");
    expect(vi.getTimerCount()).toBe(0);
  });
});
