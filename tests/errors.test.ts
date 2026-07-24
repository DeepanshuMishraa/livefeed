import { describe, expect, it } from "vitest";
import { LivefeedError } from "../src/errors";
import { retryDelaySeconds } from "../src/youtube";

describe("error messages", () => {
  it("gives a recovery action and preservation guarantee for disconnects", () => {
    const message = LivefeedError.message({ _tag: "NetworkUnavailable", reason: "offline" });
    expect(message).toContain("Existing messages are preserved");
    expect(message).toContain("retries");
  });

  it("treats not-live as a concrete channel status", () => {
    expect(LivefeedError.message({ _tag: "NoActiveBroadcast", channelTitle: "Example" })).toBe(
      "No active livestream found for Example.",
    );
  });

  it("explains that broker failures do not alter saved credentials", () => {
    expect(
      LivefeedError.message({
        _tag: "AuthServerFailure",
        status: 503,
        reason: "temporarily unavailable",
      }),
    ).toBe(
      "Livefeed authentication returned 503: temporarily unavailable. No credentials were changed; retry shortly.",
    );
  });
});

describe("retryDelaySeconds", () => {
  it("caps exponential reconnect delays at 15 seconds", () => {
    expect([0, 1, 2, 3, 4, 10].map(retryDelaySeconds)).toEqual([1, 2, 4, 8, 15, 15]);
  });
});
