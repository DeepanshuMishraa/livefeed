import { describe, expect, it, vi } from "vitest";
import { demoFeed } from "../src/demo";
import type { ChatStreamCallbacks } from "../src/feed";

describe("demoFeed", () => {
  it.each([
    [0, 3_000],
    [1, 4_000],
  ])("schedules messages between three and four seconds", (random, expectedDelay) => {
    const delays: number[] = [];
    const feed = demoFeed("youtube", {
      random: () => random,
      schedule: (_callback, delayMilliseconds) => {
        delays.push(delayMilliseconds);
        return () => undefined;
      },
    });

    feed.openChatStream("", "", "", callbacks());

    expect(delays).toEqual([expectedDelay]);
  });

  it("emits synthetic chat until cancelled", () => {
    const scheduled: Array<() => void> = [];
    const onMessages = vi.fn();
    const onResponse = vi.fn();
    const cancelScheduled = vi.fn();
    const feed = demoFeed("kick", {
      now: () => "2026-08-02T12:00:00.000Z",
      random: () => 0,
      schedule: (callback) => {
        scheduled.push(callback);
        return cancelScheduled;
      },
    });

    const connection = feed.openChatStream("", "", "", callbacks({ onMessages, onResponse }));
    scheduled[0]?.();

    expect(onResponse).toHaveBeenCalledWith("demo");
    expect(onMessages).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "kick-demo-1",
        authorName: "aurora42",
        message: "This setup is so clean",
        publishedAt: "2026-08-02T12:00:00.000Z",
      }),
    ]);

    connection.cancel();
    scheduled[1]?.();

    expect(onMessages).toHaveBeenCalledTimes(1);
    expect(cancelScheduled).toHaveBeenCalledOnce();
  });
});

function callbacks(overrides: Partial<ChatStreamCallbacks> = {}): ChatStreamCallbacks {
  return {
    onMessages: () => undefined,
    onResponse: () => undefined,
    onClose: () => undefined,
    onEnd: () => undefined,
    onError: () => undefined,
    ...overrides,
  };
}
