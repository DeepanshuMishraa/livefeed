import { describe, expect, it, vi } from "vitest";
import { findActiveTwitchBroadcast, twitchChatEvent } from "../src/twitch";
import type { TwitchCredentials } from "../src/twitch-auth";

const credentials: TwitchCredentials = {
  refreshToken: "refresh-token",
  clientId: "public-client-id",
  userId: "broadcaster-1",
  login: "streamer",
  displayName: "Streamer",
};

describe("findActiveTwitchBroadcast", () => {
  it("finds the authenticated user's active stream", async () => {
    let requestedUrl: URL | undefined;
    let requestedHeaders: Headers | undefined;
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        requestedUrl = new URL(input instanceof Request ? input.url : input);
        requestedHeaders = new Headers(init?.headers);
        return Response.json({
          data: [
            {
              id: "stream-1",
              title: "Building livefeed",
              started_at: "2026-07-25T10:00:00Z",
              user_id: "broadcaster-1",
            },
          ],
        });
      },
    );

    const result = await findActiveTwitchBroadcast("access-token", credentials, fetcher);

    expect(result).toMatchObject({
      value: {
        id: "stream-1",
        title: "Building livefeed",
        liveChatId: "broadcaster-1",
      },
    });
    expect(requestedUrl?.searchParams.get("user_id")).toBe("broadcaster-1");
    expect(requestedHeaders?.get("client-id")).toBe("public-client-id");
    expect(requestedHeaders?.get("authorization")).toBe("Bearer access-token");
  });

  it("reports an offline channel without treating it as a failure", async () => {
    const fetcher = vi.fn(async (): Promise<Response> => Response.json({ data: [] }));

    await expect(
      findActiveTwitchBroadcast("access-token", credentials, fetcher),
    ).resolves.toMatchObject({
      error: { _tag: "NoActiveBroadcast", channelTitle: "Streamer" },
    });
  });
});

describe("twitchChatEvent", () => {
  it("maps Twitch chat messages and broadcaster roles", () => {
    expect(
      twitchChatEvent(
        {
          broadcaster_user_id: "broadcaster-1",
          chatter_user_id: "broadcaster-1",
          chatter_user_name: "Streamer",
          message_id: "message-1",
          message: { text: "hello chat 👋" },
          badges: [{ set_id: "broadcaster" }],
        },
        "2026-07-25T10:01:00Z",
      ),
    ).toEqual({
      id: "message-1",
      authorChannelId: "broadcaster-1",
      authorName: "Streamer",
      role: "owner",
      verified: false,
      message: "hello chat 👋",
      publishedAt: "2026-07-25T10:01:00Z",
      kind: "text",
    });
  });

  it("rejects malformed chat payloads", () => {
    expect(twitchChatEvent({ message_id: "missing-fields" }, "")).toBeNull();
  });
});
