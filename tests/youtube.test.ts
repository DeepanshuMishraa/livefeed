import { afterEach, describe, expect, it, vi } from "vitest";
import { findActiveBroadcast } from "../src/youtube";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("findActiveBroadcast", () => {
  it.each(["public", "unlisted", "private"] as const)(
    "finds an active %s broadcast without filtering by visibility",
    async (privacyStatus) => {
      let requestedUrl: URL | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL | Request) => {
          requestedUrl = new URL(input instanceof Request ? input.url : input);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                items: [
                  {
                    id: `${privacyStatus}-broadcast`,
                    snippet: {
                      title: "Test stream",
                      channelId: "channel-1",
                      actualStartTime: "2026-07-24T10:00:00Z",
                      liveChatId: "chat-1",
                    },
                    status: { privacyStatus },
                  },
                ],
              }),
            ),
          );
        }),
      );

      const result = await findActiveBroadcast("access-token");

      expect(result).toMatchObject({
        value: { id: `${privacyStatus}-broadcast`, liveChatId: "chat-1" },
      });
      expect(requestedUrl?.searchParams.get("broadcastStatus")).toBe("active");
      expect(requestedUrl?.searchParams.get("broadcastType")).toBe("all");
      expect(requestedUrl?.searchParams.has("privacyStatus")).toBe(false);
    },
  );
});
