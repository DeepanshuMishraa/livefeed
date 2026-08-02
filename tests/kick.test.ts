import { describe, expect, it } from "vitest";
import { findActiveKickBroadcast, loadKickChatHistory } from "../src/kick";
import type { KickCredentials } from "../src/kick-auth";

const credentials: KickCredentials = {
  refreshToken: "refresh-token",
  userId: "42",
  displayName: "Streamer",
  relayToken: "relay-token-with-at-least-thirty-two-characters",
  subscriptionIds: [],
};

describe("findActiveKickBroadcast", () => {
  it("maps the authorized creator's active stream", async () => {
    const result = await findActiveKickBroadcast("access-token", credentials, async () =>
      Response.json({
        data: [
          {
            id: "stream-id",
            title: "Building livefeed",
            started_at: "2026-08-02T00:00:00Z",
            broadcaster_user: { id: 42, username: "streamer" },
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      value: {
        id: "stream-id",
        title: "Building livefeed",
        liveChatId: "stream-id",
      },
    });
  });

  it("reports an offline channel", async () => {
    const result = await findActiveKickBroadcast("access-token", credentials, async () =>
      Response.json({ data: [] }),
    );

    expect(result).toMatchObject({ error: { _tag: "NoActiveBroadcast" } });
  });
});

describe("loadKickChatHistory", () => {
  it("loads relayed messages with the relay token", async () => {
    let authorization = "";
    const result = await loadKickChatHistory(
      credentials,
      async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return Response.json({ events: [], nextPageToken: "" });
      },
      "https://auth.livefeed.test",
    );

    expect(result).toMatchObject({ value: { events: [] } });
    expect(authorization).toBe(`Bearer ${credentials.relayToken}`);
  });
});
