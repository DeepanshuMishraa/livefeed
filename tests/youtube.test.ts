import { afterEach, describe, expect, it, vi } from "vitest";
import { findActiveBroadcast, loadChatHistory } from "../src/youtube";

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

  it("reports an expired access token explicitly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 401 }))),
    );

    await expect(findActiveBroadcast("expired-token")).resolves.toMatchObject({
      error: { _tag: "TokenRejected" },
    });
  });
});

describe("loadChatHistory", () => {
  it("loads the available backlog oldest-first and returns its continuation token", async () => {
    let requestedUrl: URL | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        requestedUrl = new URL(input instanceof Request ? input.url : input);
        return Promise.resolve(
          Response.json({
            nextPageToken: "continue-from-history",
            items: [
              {
                id: "older-message",
                snippet: {
                  type: "textMessageEvent",
                  publishedAt: "2026-07-24T10:00:00Z",
                  displayMessage: "Earlier message",
                },
                authorDetails: {
                  channelId: "older-author",
                  displayName: "Earlier viewer",
                },
              },
              {
                id: "newer-message",
                snippet: {
                  type: "superChatEvent",
                  publishedAt: "2026-07-24T10:01:00Z",
                  displayMessage: "Recent message",
                },
                authorDetails: {
                  channelId: "newer-author",
                  displayName: "Recent viewer",
                },
              },
            ],
          }),
        );
      }),
    );

    const result = await loadChatHistory("access-token", "chat-1");

    expect(result).toMatchObject({
      value: {
        nextPageToken: "continue-from-history",
        events: [
          { id: "older-message", message: "Earlier message", kind: "text" },
          { id: "newer-message", message: "Recent message", kind: "paid" },
        ],
      },
    });
    expect(requestedUrl?.searchParams.get("liveChatId")).toBe("chat-1");
    expect(requestedUrl?.searchParams.get("maxResults")).toBe("2000");
    expect(requestedUrl?.searchParams.has("pageToken")).toBe(false);
  });
});
